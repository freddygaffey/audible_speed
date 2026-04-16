import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "./logger.js";
import { getDownloadUrl } from "./audibleClient.js";
import { getSession } from "./audibleAuth.js";

const execFileAsync = promisify(execFile);

// Downloads directory
const DOWNLOADS_DIR = path.join(process.cwd(), "downloads");
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "converting"
  | "done"
  | "error";

export interface DownloadJob {
  id: string;
  asin: string;
  title: string;
  status: DownloadStatus;
  progress: number;
  format: string;
  outputPath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const jobs = new Map<string, DownloadJob>();

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function update(job: DownloadJob, patch: Partial<DownloadJob>): void {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

export function listJobs(): DownloadJob[] {
  return Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function getJob(id: string): DownloadJob | undefined {
  return jobs.get(id);
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  jobs.delete(id);
  // Try to clean up files
  try {
    const aaxPath = path.join(DOWNLOADS_DIR, `${job.asin}.aax`);
    if (fs.existsSync(aaxPath)) fs.unlinkSync(aaxPath);
  } catch {}
  return true;
}

export async function startDownload(
  asin: string,
  title: string,
  format: "mp3" | "m4b" = "mp3"
): Promise<DownloadJob> {
  // Check for existing job
  for (const job of jobs.values()) {
    if (job.asin === asin && (job.status === "queued" || job.status === "downloading" || job.status === "converting")) {
      return job;
    }
  }

  const id = makeId();
  const now = new Date().toISOString();
  const job: DownloadJob = {
    id,
    asin,
    title,
    status: "queued",
    progress: 0,
    format,
    outputPath: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(id, job);

  // Run asynchronously
  runDownload(job).catch((err) => {
    logger.error({ err, jobId: id, asin }, "Download job failed");
    update(job, { status: "error", error: String(err.message ?? err) });
  });

  return job;
}

async function runDownload(job: DownloadJob): Promise<void> {
  const aaxPath = path.join(DOWNLOADS_DIR, `${job.asin}.aax`);
  const ext = job.format === "m4b" ? "m4b" : "mp3";
  const outPath = path.join(DOWNLOADS_DIR, `${job.asin}.${ext}`);

  // Phase 1: Get download URL
  update(job, { status: "downloading", progress: 2 });

  let downloadUrl: string;
  try {
    downloadUrl = await getDownloadUrl(job.asin);
  } catch (err: any) {
    throw new Error(`Failed to get download URL: ${err.message}`);
  }

  // Phase 2: Download the .aax file
  update(job, { progress: 5 });
  await downloadFile(downloadUrl, aaxPath, job);

  // Phase 3: Convert with ffmpeg
  update(job, { status: "converting", progress: 80 });
  await convertAax(aaxPath, outPath, job);

  // Clean up source .aax
  try {
    fs.unlinkSync(aaxPath);
  } catch {}

  update(job, {
    status: "done",
    progress: 100,
    outputPath: outPath,
  });

  logger.info({ jobId: job.id, asin: job.asin, outPath }, "Download complete");
}

async function downloadFile(
  url: string,
  destPath: string,
  job: DownloadJob
): Promise<void> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0",
    },
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} downloading file`);
  }

  const totalSize = parseInt(resp.headers.get("content-length") ?? "0", 10);
  const fileStream = fs.createWriteStream(destPath);
  let downloaded = 0;

  if (!resp.body) {
    throw new Error("No response body");
  }

  const reader = resp.body.getReader();

  return new Promise((resolve, reject) => {
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fileStream.write(Buffer.from(value));
          downloaded += value.length;
          if (totalSize > 0) {
            const pct = Math.min(75, Math.floor(5 + (downloaded / totalSize) * 70));
            update(job, { progress: pct });
          }
        }
        fileStream.end();
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
      } catch (err) {
        fileStream.destroy();
        reject(err);
      }
    };
    pump();
  });
}

async function convertAax(
  aaxPath: string,
  outPath: string,
  job: DownloadJob
): Promise<void> {
  const session = getSession();
  const activationBytes = session?.activationBytes;

  const ffmpegArgs: string[] = [];

  if (activationBytes) {
    ffmpegArgs.push("-activation_bytes", activationBytes);
  }

  ffmpegArgs.push("-i", aaxPath);

  if (job.format === "m4b") {
    ffmpegArgs.push("-c", "copy", "-vn");
  } else {
    // MP3
    ffmpegArgs.push("-c:a", "libmp3lame", "-q:a", "2", "-vn");
  }

  ffmpegArgs.push("-y", outPath);

  try {
    await execFileAsync("ffmpeg", ffmpegArgs, { maxBuffer: 10 * 1024 * 1024 });
  } catch (err: any) {
    // If activation bytes failed, try without (some books may not need them)
    if (activationBytes) {
      logger.warn({ err: err.message }, "ffmpeg with activation_bytes failed, retrying without");
      const retryArgs = ["-i", aaxPath];
      if (job.format === "m4b") {
        retryArgs.push("-c", "copy", "-vn");
      } else {
        retryArgs.push("-c:a", "libmp3lame", "-q:a", "2", "-vn");
      }
      retryArgs.push("-y", outPath);
      await execFileAsync("ffmpeg", retryArgs, { maxBuffer: 10 * 1024 * 1024 });
    } else {
      throw new Error(
        `ffmpeg conversion failed: ${err.message}. You may need to set your Audible activation bytes in Settings.`
      );
    }
  }
}

export function getOutputPath(id: string): string | null {
  return jobs.get(id)?.outputPath ?? null;
}

export function setActivationBytes(bytes: string): void {
  const session = getSession();
  if (session) {
    session.activationBytes = bytes.trim().toLowerCase();
  }
}
