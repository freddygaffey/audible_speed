import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { getDownloadUrl } from "./audibleClient.js";
import { flushSession, getSession } from "./audibleAuth.js";
import { fetchWithRetry } from "./fetchWithRetry.js";
import { resolveWidevineDecryption } from "./widevine.js";

const FFMPEG_STDERR_CAP = 48 * 1024;
const FILE_HEAD_SCAN_BYTES = 512;
const PREVIEW_HEX_BYTES = 32;
const AUDIBLE_HTTP_UA = "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0";
const STRICT_OUTPUT_DECODE_VERIFY = process.env.SPEED_STRICT_OUTPUT_DECODE_VERIFY === "1";
const SKIP_OUTPUT_DECODE_VERIFY = process.env.SPEED_SKIP_OUTPUT_DECODE_VERIFY === "1";
const STREAM_CONVERT_ENABLED =
  process.env.SPEED_STREAM_CONVERT !== "0" && process.env.SPEED_STREAM_CONVERT !== "false";

function formatFfmpegFailure(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const trimmed = stderr.replace(/\s+/g, " ").trim().slice(-4000);
  const head = signal
    ? `ffmpeg terminated by signal ${signal}`
    : `ffmpeg exited with code ${code ?? "?"}`;
  if (!trimmed) return head;
  // Newline so callers can split stderr from the summary line reliably.
  return `${head}\n${trimmed}`;
}

/**
 * Run ffmpeg with stderr capped (only kept for error messages). Progress spam is avoided
 * via -nostats -loglevel error; on failure we attach the real ffmpeg text for debugging.
 */
interface RunFfmpegOptions {
  onOutTimeMs?: (outTimeMs: number) => void;
  onProgressState?: (state: string) => void;
}

function runFfmpeg(args: string[], options: RunFfmpegOptions = {}): Promise<void> {
  // warning: enough context on failure; error often omits lines that explain exit 69 / DRM.
  const fullArgs = [
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "warning",
    "-progress",
    "pipe:1",
    ...args,
  ];
  return new Promise((resolve, reject) => {
    let stdoutRemainder = "";
    const chunks: Buffer[] = [];
    let stderrBytes = 0;

    const child = spawn("ffmpeg", fullArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutRemainder += chunk.toString("utf8");
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("progress=")) {
          options.onProgressState?.(line.slice("progress=".length).trim());
          continue;
        }
        if (!line.startsWith("out_time_ms=")) continue;
        const outTimeMs = Number.parseInt(line.slice("out_time_ms=".length), 10);
        if (!Number.isFinite(outTimeMs) || outTimeMs < 0) continue;
        options.onOutTimeMs?.(outTimeMs);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= FFMPEG_STDERR_CAP) return;
      const n = Math.min(chunk.length, FFMPEG_STDERR_CAP - stderrBytes);
      chunks.push(n === chunk.length ? chunk : chunk.subarray(0, n));
      stderrBytes += n;
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error("spawn ffmpeg ENOENT"));
        return;
      }
      reject(err);
    });
    child.on("close", (code, signal) => {
      const stderr = Buffer.concat(chunks).toString("utf8");
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(formatFfmpegFailure(code, signal, stderr)));
    });
  });
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  sample_rate?: string;
}

interface ProbeFormat {
  format_name?: string;
  duration?: string;
}

interface ProbeResult {
  ok: boolean;
  stderr: string;
  format?: ProbeFormat;
  audioStream?: ProbeStream;
}

function runFfprobe(pathToFile: string): Promise<ProbeResult> {
  const isRemote = /^https?:\/\//i.test(pathToFile);
  const args = [
    ...(isRemote ? ["-user_agent", AUDIBLE_HTTP_UA] : []),
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    pathToFile,
  ];
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const child = spawn("ffprobe", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      resolve({
        ok: false,
        stderr: `ffprobe spawn error: ${(e as Error).message}`,
      });
    });
    child.on("close", (code) => {
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code !== 0) {
        resolve({ ok: false, stderr: stderr || `ffprobe exited with code ${code}` });
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(out).toString("utf8")) as {
          streams?: ProbeStream[];
          format?: ProbeFormat;
        };
        const audioStream = (parsed.streams ?? []).find((s) => s.codec_type === "audio");
        resolve({
          ok: true,
          stderr,
          format: parsed.format,
          audioStream,
        });
      } catch (e) {
        resolve({
          ok: false,
          stderr: `ffprobe parse error: ${(e as Error).message}`,
        });
      }
    });
  });
}

function summarizeProbe(probe: ProbeResult | undefined): string {
  if (!probe) return "probe=none";
  if (!probe.ok) return `probe=failed (${probe.stderr || "unknown"})`;
  const fmt = probe.format?.format_name ?? "unknown";
  const codec = probe.audioStream?.codec_name ?? "unknown";
  const ch = probe.audioStream?.channels ?? 0;
  const rate = probe.audioStream?.sample_rate ?? "?";
  return `probe=format:${fmt},audio:${codec},ch:${ch},rate:${rate}`;
}

function expectedRuntimeMsFromLicenseChapterInfo(
  chapterInfo:
    | {
        runtimeLengthMs?: number;
        isAccurate?: boolean;
        chapters: Array<{ title: string; startOffsetMs: number; lengthMs: number }>;
      }
    | undefined,
): number | null {
  if (!chapterInfo) return null;
  const runtimeLengthMs =
    typeof chapterInfo.runtimeLengthMs === "number" && Number.isFinite(chapterInfo.runtimeLengthMs)
      ? Math.max(0, Math.floor(chapterInfo.runtimeLengthMs))
      : 0;
  if (runtimeLengthMs > 0) return runtimeLengthMs;
  const summed = chapterInfo.chapters.reduce((acc, c) => {
    if (typeof c.lengthMs !== "number" || !Number.isFinite(c.lengthMs) || c.lengthMs <= 0) return acc;
    return acc + Math.floor(c.lengthMs);
  }, 0);
  return summed > 0 ? summed : null;
}

async function verifyDecodableAudio(pathToFile: string): Promise<void> {
  const args = [
    "-v",
    "error",
    "-xerror",
    "-i",
    pathToFile,
    "-map",
    "0:a:0",
    "-f",
    "null",
    "-",
  ];
  await runFfmpeg(args);
}

async function verifyDecodableAudioSample(
  pathToFile: string,
  durationSec: number | null,
): Promise<void> {
  const sampleSec = 15;
  // Decode a short segment near the start.
  await runFfmpeg([
    "-v",
    "error",
    "-xerror",
    "-ss",
    "5",
    "-t",
    String(sampleSec),
    "-i",
    pathToFile,
    "-map",
    "0:a:0",
    "-f",
    "null",
    "-",
  ]);
  // Decode a short segment near the end for tail corruption checks.
  if (durationSec != null && Number.isFinite(durationSec) && durationSec > 120) {
    const tailStart = Math.max(0, Math.floor(durationSec - sampleSec - 5));
    await runFfmpeg([
      "-v",
      "error",
      "-xerror",
      "-ss",
      String(tailStart),
      "-t",
      String(sampleSec),
      "-i",
      pathToFile,
      "-map",
      "0:a:0",
      "-f",
      "null",
      "-",
    ]);
  }
}

interface DownloadArtifact {
  filePath: string;
  finalUrl: string;
  contentType: string;
  contentLength: number;
  bytesWritten: number;
}

function isDemuxFailure(detail: string): boolean {
  const d = detail.toLowerCase();
  return (
    d.includes("invalid data") ||
    d.includes("moov atom not found") ||
    d.includes("invalid argument") ||
    d.includes("error reading header") ||
    d.includes("could not find codec parameters") ||
    d.includes("unknown format") ||
    d.includes("exited with code 69")
  );
}

function hexPreview(buf: Buffer, bytes = PREVIEW_HEX_BYTES): string {
  return buf.subarray(0, Math.min(bytes, buf.length)).toString("hex");
}

function textPreview(buf: Buffer, bytes = 120): string {
  return buf
    .subarray(0, Math.min(bytes, buf.length))
    .toString("utf8")
    .replace(/\s+/g, " ")
    .trim();
}

/** Heuristics for common Audible / AAX ffmpeg failures (exit 69 is often EX_UNAVAILABLE / demux). */
function explainAaxFailure(stderr: string, hasActivationBytes: boolean): string | null {
  const s = stderr.toLowerCase();
  if (
    s.includes("activation_bytes") ||
    s.includes("checksum") ||
    s.includes("decrypt") ||
    s.includes("drm")
  ) {
    return hasActivationBytes
      ? "Audible DRM/decrypt failed — re-check activation bytes in Settings (must match this Audible account), then retry."
      : "This title looks encrypted — add activation bytes in Settings (from audible-activator / your PC’s Audible app), then retry.";
  }
  if (s.includes("invalid data") || s.includes("moov atom not found") || s.includes("invalid argument")) {
    return "ffmpeg could not read the downloaded file — it may be a non-AAX format or a bad CDN response; try download again.";
  }
  if (s.includes("unknown encoder")) {
    return "Your ffmpeg build may lack a working AAC encoder; reinstall ffmpeg (e.g. brew install ffmpeg).";
  }
  return null;
}

function resolvedDownloadsDir(): string {
  const envDir = process.env.SPEED_DOWNLOADS_DIR?.trim();
  if (envDir) return path.resolve(envDir);

  // Primary: service WorkingDirectory should be api-server root.
  const cwdDir = path.join(process.cwd(), "downloads");
  if (fs.existsSync(process.cwd())) return cwdDir;

  // Fallback for unusual launch contexts.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "downloads");
}

const DOWNLOADS_DIR = resolvedDownloadsDir();
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
  outputBytes: number | null;
  error: string | null;
  errorClass: "network" | "drm" | "disk" | "decode" | "other" | null;
  expiresAt: string | null;
  transferredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const jobs = new Map<string, DownloadJob>();
const DONE_TTL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.SPEED_DOWNLOAD_DONE_TTL_MS ?? 2 * 60 * 60 * 1000),
);
const SWEEP_INTERVAL_MS = Math.max(
  30 * 1000,
  Number(process.env.SPEED_DOWNLOAD_SWEEP_INTERVAL_MS ?? 60 * 1000),
);

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function makeDiskJobId(asin: string, format: "mp3" | "m4b"): string {
  return `disk-${asin.toLowerCase()}-${format}`;
}

function update(job: DownloadJob, patch: Partial<DownloadJob>): void {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function pruneMissingDoneJobs(): void {
  for (const [id, job] of jobs) {
    if (job.status !== "done") continue;
    if (!job.outputPath || !fs.existsSync(job.outputPath)) {
      jobs.delete(id);
    }
  }
}

export function listJobs(): DownloadJob[] {
  pruneMissingDoneJobs();
  sweepExpiredFinishedJobs();
  return Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function getJob(id: string): DownloadJob | undefined {
  pruneMissingDoneJobs();
  sweepExpiredFinishedJobs();
  return jobs.get(id);
}

function unlinkSafe(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    logger.warn({ filePath, err }, "Failed to delete file");
  }
}

function classifyDownloadError(message: string): DownloadJob["errorClass"] {
  const m = message.toLowerCase();
  if (m.includes("network") || m.includes("http ")) return "network";
  if (m.includes("widevine") || m.includes("drm") || m.includes("activation_bytes")) return "drm";
  if (m.includes("insufficient server disk space") || m.includes("disk is full") || m.includes("enospc")) {
    return "disk";
  }
  if (m.includes("ffmpeg") || m.includes("decode") || m.includes("invalid data")) return "decode";
  return "other";
}

function computeExpiryIso(baseMs = Date.now()): string {
  return new Date(baseMs + DONE_TTL_MS).toISOString();
}

function sweepExpiredFinishedJobs(): number {
  const now = Date.now();
  let removed = 0;
  for (const [id, job] of [...jobs.entries()]) {
    if (job.status !== "done") continue;
    if (!job.expiresAt) continue;
    if (Date.parse(job.expiresAt) > now) continue;
    if (job.outputPath) unlinkSafe(job.outputPath);
    jobs.delete(id);
    removed++;
  }
  return removed;
}

function getFreeDiskBytes(): number | null {
  try {
    const st = fs.statfsSync(DOWNLOADS_DIR);
    const bavail = Number(st.bavail ?? 0);
    const bsize = Number(st.bsize ?? 0);
    if (!Number.isFinite(bavail) || !Number.isFinite(bsize) || bavail <= 0 || bsize <= 0) {
      return null;
    }
    return Math.floor(bavail * bsize);
  } catch {
    return null;
  }
}

function pruneOldestFinishedDownloadsForSpace(targetFreeBytes: number): number {
  let free = getFreeDiskBytes();
  if (free == null || free >= targetFreeBytes) return 0;

  const candidates = Array.from(jobs.values())
    .filter((j) => j.status === "done" && j.outputPath && fs.existsSync(j.outputPath))
    .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());

  let removed = 0;
  for (const job of candidates) {
    if (!job.outputPath) continue;
    unlinkSafe(job.outputPath);
    jobs.delete(job.id);
    removed++;
    free = getFreeDiskBytes();
    if (free != null && free >= targetFreeBytes) break;
  }
  return removed;
}

/** Remove on-disk media for an ASIN (finished or partial download). */
function unlinkMediaForAsin(asin: string): void {
  for (const ext of [".m4b", ".mp3", ".aax"] as const) {
    unlinkSafe(path.join(DOWNLOADS_DIR, `${asin}${ext}`));
  }
}

/**
 * Remove all download jobs for this ASIN and delete any local .m4b / .mp3 / .aax for it.
 * Returns how many job rows were removed (0 if only orphan files were deleted).
 */
export function removeDownloadForAsin(asin: string): { jobsRemoved: number } {
  sweepExpiredFinishedJobs();
  let jobsRemoved = 0;
  for (const [id, job] of [...jobs.entries()]) {
    if (job.asin === asin) {
      jobs.delete(id);
      jobsRemoved++;
    }
  }
  unlinkMediaForAsin(asin);
  return { jobsRemoved };
}

/** Delete every job and every .m4b / .mp3 / .aax under the downloads directory. */
export function removeAllDownloads(): { jobsRemoved: number; filesRemoved: number } {
  sweepExpiredFinishedJobs();
  const jobsRemoved = jobs.size;
  jobs.clear();

  let filesRemoved = 0;
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    return { jobsRemoved, filesRemoved: 0 };
  }
  for (const name of fs.readdirSync(DOWNLOADS_DIR)) {
    if (!/\.(m4b|mp3|aax)$/i.test(name)) continue;
    try {
      fs.unlinkSync(path.join(DOWNLOADS_DIR, name));
      filesRemoved++;
    } catch (err) {
      logger.warn({ name, err }, "Failed to delete download file");
    }
  }
  return { jobsRemoved, filesRemoved };
}

export function cancelJob(id: string): boolean {
  sweepExpiredFinishedJobs();
  const job = jobs.get(id);
  if (!job) return false;
  removeDownloadForAsin(job.asin);
  return true;
}

function rehydrateDoneJobsFromDisk(): void {
  if (!fs.existsSync(DOWNLOADS_DIR)) return;
  const names = fs.readdirSync(DOWNLOADS_DIR);
  for (const name of names) {
    const m = /^([A-Z0-9]{8,32})\.(m4b|mp3)$/i.exec(name);
    if (!m) continue;
    const asin = m[1]!;
    const format = m[2]!.toLowerCase() as "mp3" | "m4b";
    const outputPath = path.join(DOWNLOADS_DIR, name);
    try {
      const st = fs.statSync(outputPath);
      if (!st.isFile() || st.size < 512) continue;
        const probe = spawnSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            outputPath,
          ],
          { encoding: "utf8" },
        );
        const probeOut = (probe.stdout ?? "").toString().trim().toLowerCase();
        if (probe.status !== 0 || probeOut !== "audio") {
          logger.warn(
            {
              outputPath,
              probeStatus: probe.status,
              probeErr: (probe.stderr ?? "").toString().trim().slice(0, 400),
            },
            "Skipping corrupted media artifact during rehydrate",
          );
          continue;
        }
      const id = makeDiskJobId(asin, format);
      if (jobs.has(id)) continue;
      const ts = st.mtime.toISOString();
      jobs.set(id, {
        id,
        asin,
        title: asin,
        status: "done",
        progress: 100,
        format,
        outputPath,
        outputBytes: st.size,
        error: null,
        errorClass: null,
        transferredAt: null,
        expiresAt: computeExpiryIso(st.mtimeMs),
        createdAt: ts,
        updatedAt: ts,
      });
    } catch (err) {
      logger.warn({ name, err }, "Skipping invalid downloaded file during rehydrate");
    }
  }
}

rehydrateDoneJobsFromDisk();

export async function startDownload(
  asin: string,
  title: string,
  format: "mp3" | "m4b" = "mp3"
): Promise<DownloadJob> {
  pruneMissingDoneJobs();
  sweepExpiredFinishedJobs();
  // Keep headroom so ffmpeg temp/outputs don't crash the process on tiny disks.
  const minFreeBytes = 800 * 1024 * 1024;
  const pruned = pruneOldestFinishedDownloadsForSpace(minFreeBytes);
  if (pruned > 0) {
    logger.warn({ pruned, minFreeBytes }, "Pruned old finished downloads to recover disk space");
  }
  // Check for existing job
  for (const job of jobs.values()) {
    if (job.asin === asin && job.status === "done" && job.outputPath && fs.existsSync(job.outputPath)) {
      return job;
    }
    if (job.asin === asin && (job.status === "queued" || job.status === "downloading" || job.status === "converting")) {
      return job;
    }
  }

  // Drop stale failed jobs for this ASIN so retries/UI map stay unambiguous
  for (const [id, job] of [...jobs.entries()]) {
    if (job.asin === asin && job.status === "error") {
      jobs.delete(id);
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
    outputBytes: null,
    error: null,
    errorClass: null,
    expiresAt: null,
    transferredAt: null,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(id, job);

  // Run asynchronously
  runDownload(job).catch((err) => {
    logger.error({ err, jobId: id, asin }, "Download job failed");
    const message = String(err.message ?? err);
    update(job, {
      status: "error",
      error: message,
      errorClass: classifyDownloadError(message),
    });
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
  let licenseKeyHex: string | undefined;
  let licenseCencKeyHex: string | undefined;
  let licenseCencIvHex: string | undefined;
  let licenseDrmType: string | undefined;
  let licenseResponseUrl: string | undefined;
  let widevineCookieHeader: string | undefined;
  let resolvedAsinForLicense: string = job.asin;
  let cencSource: "voucher" | "widevine-bridge" | "none" = "none";
  let widevineDefaultKid: string | undefined;
  let widevineSelectedKid: string | undefined;
  let widevineError: string | undefined;
  let cencCandidateKeys: CencCandidateKey[] = [];
  let expectedRuntimeMs: number | null = null;
  try {
    const lic = await getDownloadUrl(job.asin);
    downloadUrl = lic.offlineUrl;
    licenseKeyHex = lic.drmKeyHex;
    licenseCencKeyHex = lic.drmCencKeyHex;
    licenseCencIvHex = lic.drmCencIvHex;
    licenseResponseUrl = lic.licenseResponseUrl;
    resolvedAsinForLicense = lic.resolvedAsin;
    cencSource = licenseCencKeyHex ? "voucher" : "none";
    licenseDrmType = lic.drmType;
    expectedRuntimeMs = expectedRuntimeMsFromLicenseChapterInfo(lic.chapterInfo);
    if (licenseKeyHex) {
      const s = getSession();
      if (s && !s.activationBytes) {
        s.activationBytes = licenseKeyHex;
        flushSession();
        logger.info({ asin: job.asin }, "Saved activation bytes from Audible license (Settings was empty)");
      }
    }

    if (licenseDrmType === "widevine" && licenseResponseUrl) {
      logger.info({ asin: job.asin, resolvedAsin: resolvedAsinForLicense }, "Resolving Widevine CDM keys");
      try {
        const widevine = await resolveWidevineDecryption({
          asin: resolvedAsinForLicense,
          marketplace: getSession()?.marketplace ?? "us",
          licenseResponseUrl,
          fallbackContentUrl: lic.offlineUrl,
        });
        downloadUrl = widevine.contentUrl;
        widevineCookieHeader = widevine.cookieHeader;
        widevineDefaultKid = widevine.mpd.defaultKid;
        widevineSelectedKid = widevine.kid;
        cencCandidateKeys = widevine.candidateKeys.map((k) => ({
          keyHex: k.keyHex,
          ivHex: k.ivHex,
          kid: k.kid,
        }));
        if (!licenseCencKeyHex) {
          licenseCencKeyHex = widevine.keyHex;
          licenseCencIvHex = widevine.ivHex ?? licenseCencIvHex;
          cencSource = "widevine-bridge";
        }
      } catch (err: unknown) {
        widevineError = err instanceof Error ? err.message : String(err);
        logger.error({ asin: job.asin, err: widevineError }, "Widevine key resolution failed");
        const failFast =
          process.env.AUDIBLE_WIDEVINE_FAIL_FAST !== "0" &&
          process.env.AUDIBLE_WIDEVINE_FAIL_FAST !== "false";
        if (!licenseCencKeyHex || failFast) {
          throw new Error(
            `Widevine key retrieval failed before conversion: ${widevineError}. ` +
              "Set AUDIBLE_WIDEVINE_KEYSERVICE_URL and re-authenticate if ADP keys are stale.",
          );
        }
      }
    }
  } catch (err: any) {
    throw new Error(`Failed to get download URL: ${err.message}`);
  }

  const verifyAndFinalizeOutput = async () => {
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 512) {
      throw new Error("Conversion produced no usable output file (disk full or ffmpeg failed).");
    }
    const outputProbe = await runFfprobe(outPath);
    if (!outputProbe.ok || !outputProbe.audioStream) {
      throw new Error(`Converted output is invalid. ${summarizeProbe(outputProbe)}`);
    }
    const outputDurationSec = Number.parseFloat(outputProbe.format?.duration ?? "");
    const outputDurationMs =
      Number.isFinite(outputDurationSec) && outputDurationSec > 0 ? Math.floor(outputDurationSec * 1000) : null;
    if (
      expectedRuntimeMs != null &&
      expectedRuntimeMs >= 30 * 60 * 1000 &&
      outputDurationMs != null &&
      outputDurationMs > 0
    ) {
      // Guard against long-title truncation (e.g. only first part returned by source URL).
      const ratio = outputDurationMs / expectedRuntimeMs;
      if (ratio < 0.75) {
        throw new Error(
          `Converted output duration is too short (${Math.floor(outputDurationMs / 60000)}m vs expected ${Math.floor(
            expectedRuntimeMs / 60000,
          )}m; ratio=${ratio.toFixed(3)}). Source likely returned a partial title asset; retrying should request a full download URL.`,
        );
      }
    }
    if (!SKIP_OUTPUT_DECODE_VERIFY) {
      try {
        if (STRICT_OUTPUT_DECODE_VERIFY) {
          await verifyDecodableAudio(outPath);
        } else {
          await verifyDecodableAudioSample(
            outPath,
            outputDurationMs != null ? outputDurationMs / 1000 : null,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Converted output failed decode verification. ${msg.slice(0, 1200)}`);
      }
    }
    update(job, {
      status: "done",
      progress: 100,
      outputPath: outPath,
      outputBytes: fs.statSync(outPath).size,
      errorClass: null,
      expiresAt: computeExpiryIso(),
    });
    logger.info({ jobId: job.id, asin: job.asin, outPath }, "Download complete");
  };

  const streamInputHeaders =
    (licenseDrmType ?? "").toLowerCase() === "widevine" && widevineCookieHeader
      ? { Cookie: widevineCookieHeader }
      : undefined;
  const useActivationBytes = (licenseDrmType ?? "").toLowerCase() !== "mpeg";
  if (STREAM_CONVERT_ENABLED) {
    update(job, { status: "converting", progress: 80 });
    try {
      await convertAax(
        downloadUrl,
        outPath,
        job,
        licenseKeyHex,
        useActivationBytes,
        {
          inputFingerprint: "remote-stream",
          inputProbe: { ok: false, stderr: "probe=remote-stream" },
          sourceUrl: downloadUrl,
          sourceContentType: "remote-stream",
          cencKeyPresent: !!licenseCencKeyHex,
          cencIvPresent: !!licenseCencIvHex,
          cencSource,
          widevineDefaultKid,
          widevineSelectedKid,
          widevineError,
        },
        licenseCencKeyHex,
        licenseCencIvHex,
        cencCandidateKeys,
        streamInputHeaders,
      );
      await verifyAndFinalizeOutput();
      return;
    } catch (err: unknown) {
      // Stream-first path is a performance optimization; keep robust fallback behavior.
      logger.warn(
        { asin: job.asin, err: err instanceof Error ? err.message : String(err) },
        "Stream-convert failed, falling back to staged download+convert",
      );
      try {
        fs.unlinkSync(outPath);
      } catch {
        /* ignore */
      }
      update(job, { status: "downloading", progress: 5 });
    }
  }

  // Phase 2: Download source payload
  update(job, { progress: 5 });
  const artifact = await downloadFile(
    downloadUrl,
    aaxPath,
    job,
    (licenseDrmType ?? "").toLowerCase() === "widevine"
      ? {
          Range: "bytes=0-",
          ...(widevineCookieHeader ? { Cookie: widevineCookieHeader } : {}),
        }
      : undefined,
  );
  const inputFingerprint = assertDownloadedPayloadLooksAudio(artifact);
  const inputProbe = await runFfprobe(aaxPath);
  if (!inputProbe.ok || !inputProbe.audioStream) {
    throw new Error(
      [
        "Downloaded file is not a parseable audio stream.",
        `source=${artifact.finalUrl}`,
        `contentType=${artifact.contentType || "unknown"}`,
        `bytes=${artifact.bytesWritten}`,
        `fingerprint=${inputFingerprint}`,
        summarizeProbe(inputProbe),
      ].join(" "),
    );
  }
  const sourceUrl = artifact.finalUrl;
  const sourceContentType = artifact.contentType;
  const looksAaxc = inputFingerprint.toLowerCase().includes("ftypaaxc");
  if (looksAaxc && !licenseCencKeyHex) {
    throw new Error(
      [
        "AAXC decryption key missing; refusing activation-bytes fallback.",
        `drmType=${licenseDrmType || "unknown"}`,
        `licenseResponseUrl=${licenseResponseUrl ? "present" : "missing"}`,
        `aaxc_key_source=${cencSource}`,
        widevineError ? `widevine_error=${widevineError}` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  // Phase 3: Convert with ffmpeg (can take a long time for full-book AAC transcode)
  update(job, { status: "converting", progress: 80 });
  await convertAax(
    aaxPath,
    outPath,
    job,
    licenseKeyHex,
    useActivationBytes,
    {
      inputFingerprint,
      inputProbe,
      sourceUrl,
      sourceContentType,
      cencKeyPresent: !!licenseCencKeyHex,
      cencIvPresent: !!licenseCencIvHex,
      cencSource,
      widevineDefaultKid,
      widevineSelectedKid,
      widevineError,
    },
    licenseCencKeyHex,
    licenseCencIvHex,
    cencCandidateKeys,
  );

  // Clean up source .aax
  try {
    fs.unlinkSync(aaxPath);
  } catch {}
  await verifyAndFinalizeOutput();
}

async function downloadFile(
  url: string,
  destPath: string,
  job: DownloadJob,
  extraHeaders?: Record<string, string>,
): Promise<DownloadArtifact> {
  const resp = await fetchWithRetry(
    url,
    {
      headers: {
        "User-Agent": "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0",
        ...(extraHeaders ?? {}),
      },
    },
    { label: "Audible CDN download", attempts: 4 },
  );

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} downloading file`);
  }
  const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
  const finalUrl = resp.url || url;
  if (
    contentType.includes("application/json") ||
    contentType.includes("text/html") ||
    contentType.includes("application/xml") ||
    contentType.includes("text/xml") ||
    contentType.includes("application/dash+xml") ||
    contentType.includes("application/vnd.apple.mpegurl") ||
    contentType.includes("audio/mpegurl") ||
    finalUrl.toLowerCase().includes(".mpd") ||
    finalUrl.toLowerCase().includes(".m3u8")
  ) {
    const text = (await resp.text()).slice(0, 300);
    throw new Error(`CDN returned ${contentType || "text"} instead of audio: ${text}`);
  }

  const totalSize = parseInt(resp.headers.get("content-length") ?? "0", 10);
  if (totalSize > 0) {
    const free = getFreeDiskBytes();
    const reserveBytes = 200 * 1024 * 1024;
    const required = totalSize + reserveBytes;
    if (free != null && free < required) {
      const pruned = pruneOldestFinishedDownloadsForSpace(required);
      const freeAfterPrune = getFreeDiskBytes();
      if (freeAfterPrune != null && freeAfterPrune < required) {
        throw new Error(
          `Insufficient server disk space (${Math.floor(freeAfterPrune / (1024 * 1024))}MB free; ` +
            `${Math.floor(required / (1024 * 1024))}MB required). ` +
            (pruned > 0
              ? "Some old downloads were auto-removed; retry if needed."
              : "Remove old downloads on server and retry."),
        );
      }
    }
  }
  const fileStream = fs.createWriteStream(destPath);
  let downloaded = 0;

  if (!resp.body) {
    throw new Error("No response body");
  }

  const reader = resp.body.getReader();

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      fileStream.destroy();
      reject(err);
    };
    fileStream.on("error", (err) => {
      const msg = (err as NodeJS.ErrnoException).code === "ENOSPC"
        ? "Server disk is full while downloading source file"
        : `File write failed: ${(err as Error).message}`;
      fail(new Error(msg));
    });
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
        fileStream.on("finish", () => {
          if (settled) return;
          settled = true;
          resolve({
            filePath: destPath,
            finalUrl,
            contentType,
            contentLength: totalSize,
            bytesWritten: downloaded,
          });
        });
      } catch (err) {
        fail(err);
      }
    };
    pump();
  });
}

/** Prefer key from this title's license voucher, then saved session activation bytes. */
function ffmpegActivationPrefix(
  licenseKeyHex: string | undefined,
  storedActivation: string | undefined,
  useActivationBytes: boolean,
): string[] {
  if (!useActivationBytes) return [];
  const key = licenseKeyHex ?? storedActivation;
  const prefix: string[] = [];
  if (key) {
    prefix.push("-activation_bytes", key);
  }
  return prefix;
}

function ffmpegHttpInputPrefix(inputPath: string, extraHeaders?: Record<string, string>): string[] {
  if (!/^https?:\/\//i.test(inputPath)) return [];
  const args: string[] = ["-user_agent", AUDIBLE_HTTP_UA];
  const headerLines = Object.entries(extraHeaders ?? {})
    .filter(([k, v]) => k.toLowerCase() !== "user-agent" && typeof v === "string" && v.trim().length > 0)
    .map(([k, v]) => `${k}: ${v.trim()}`);
  if (headerLines.length > 0) {
    args.push("-headers", `${headerLines.join("\r\n")}\r\n`);
  }
  return args;
}

/**
 * M4B for web playback: re-encode to AAC instead of stream copy. Audible often
 * uses HE-AAC / odd MP4 layouts that decode in ffmpeg but fail in Safari/WebKit
 * with MEDIA_ERR_DECODE. Podcast-style AAX can contain MP3; transcode handles both.
 */
async function transcodeToM4b(
  aaxPath: string,
  outPath: string,
  licenseKeyHex: string | undefined,
  storedActivation: string | undefined,
  useActivationBytes: boolean,
  cencKeyHex?: string,
  cencIvHex?: string,
  onOutTimeMs?: (outTimeMs: number) => void,
  inputHeaders?: Record<string, string>,
): Promise<void> {
  const cencPrefix: string[] = [];
  if (cencKeyHex) {
    cencPrefix.push("-decryption_key", cencKeyHex);
    if (cencIvHex) cencPrefix.push("-decryption_iv", cencIvHex);
  }
  const args = [
    ...ffmpegHttpInputPrefix(aaxPath, inputHeaders),
    ...cencPrefix,
    ...ffmpegActivationPrefix(licenseKeyHex, storedActivation, useActivationBytes),
    "-i",
    aaxPath,
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-threads",
    "0",
    "-movflags",
    "+faststart",
    "-y",
    outPath,
  ];
  await runFfmpeg(args, { onOutTimeMs });
}

interface ConversionContext {
  inputFingerprint: string;
  inputProbe: ProbeResult;
  sourceUrl: string;
  sourceContentType: string;
  cencKeyPresent: boolean;
  cencIvPresent: boolean;
  cencSource: "voucher" | "widevine-bridge" | "none";
  widevineDefaultKid?: string;
  widevineSelectedKid?: string;
  widevineError?: string;
}

interface CencCandidateKey {
  keyHex: string;
  ivHex?: string;
  kid?: string;
}

function splitFfmpegMessage(msg: string): { head: string; stderr: string } {
  const nl = msg.indexOf("\n");
  if (nl < 0) return { head: msg, stderr: "" };
  return {
    head: msg.slice(0, nl),
    stderr: msg.slice(nl + 1),
  };
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderConversionFailure(
  ffmpegMessage: string,
  ctx: ConversionContext,
  attempts: string[],
  hasActivation: boolean,
): string {
  const { head, stderr } = splitFfmpegMessage(ffmpegMessage);
  const looksAaxc = ctx.inputFingerprint.toLowerCase().includes("ftypaaxc");
  const hint = explainAaxFailure(stderr, hasActivation);
  const details = [
    hint,
    looksAaxc
      ? "input appears to be AAXC (encrypted AAC-in-MP4); activation_bytes alone may be insufficient for this title"
      : undefined,
    looksAaxc
      ? `aaxc_license_material=key:${ctx.cencKeyPresent ? "present" : "missing"},iv:${ctx.cencIvPresent ? "present" : "missing"}`
      : undefined,
    looksAaxc ? `aaxc_key_source=${ctx.cencSource}` : undefined,
    ctx.widevineDefaultKid ? `widevine_default_kid=${ctx.widevineDefaultKid}` : undefined,
    ctx.widevineSelectedKid ? `widevine_selected_kid=${ctx.widevineSelectedKid}` : undefined,
    ctx.widevineError ? `widevine_error=${ctx.widevineError}` : undefined,
    `attempts=${attempts.join(" -> ")}`,
    `source=${ctx.sourceUrl}`,
    `contentType=${ctx.sourceContentType || "unknown"}`,
    `input=${ctx.inputFingerprint}`,
    summarizeProbe(ctx.inputProbe),
    stderr ? `ffmpeg=${stderr.slice(0, 1500)}` : undefined,
  ]
    .filter(Boolean)
    .join(" | ");
  return `${head}. ${details}`;
}

async function convertAax(
  aaxPath: string,
  outPath: string,
  job: DownloadJob,
  licenseKeyHex?: string,
  useActivationBytes = true,
  ctx?: ConversionContext,
  cencKeyHex?: string,
  cencIvHex?: string,
  cencCandidateKeys: CencCandidateKey[] = [],
  inputHeaders?: Record<string, string>,
): Promise<void> {
  const session = getSession();
  const storedActivation = session?.activationBytes;
  const context =
    ctx ??
    ({
      inputFingerprint: "unknown",
      inputProbe: { ok: false, stderr: "probe=missing" },
      sourceUrl: "unknown",
      sourceContentType: "",
      cencKeyPresent: false,
      cencIvPresent: false,
      cencSource: "none",
    } satisfies ConversionContext);

  const attemptsTried: string[] = [];
  const parsedDurationSec = Number.parseFloat(context.inputProbe.format?.duration ?? "");
  const durationMs =
    Number.isFinite(parsedDurationSec) && parsedDurationSec > 0
      ? Math.floor(parsedDurationSec * 1000)
      : null;
  let highestConversionProgress = Math.max(job.progress, 80);
  const markFinishing = () => {
    if (highestConversionProgress >= 99) return;
    highestConversionProgress = 99;
    update(job, { progress: 99 });
  };
  const onOutTimeMs = (outTimeMs: number) => {
    if (!durationMs || durationMs <= 0) return;
    const ratio = Math.max(0, Math.min(1, outTimeMs / durationMs));
    const next = Math.max(80, Math.min(95, 80 + Math.floor(ratio * 15)));
    if (next <= highestConversionProgress) return;
    highestConversionProgress = next;
    update(job, { progress: next });
  };
  const onProgressState = (state: string) => {
    if (state === "end") markFinishing();
  };

  if (job.format === "m4b") {
    let lastErr: string | undefined;
    const looksAaxc = context.inputFingerprint.toLowerCase().includes("ftypaaxc");
    if (looksAaxc && !cencKeyHex) {
      throw new Error(
        "AAXC input requires decryption key/iv; conversion aborted before ffmpeg decode attempts.",
      );
    }
    const cencAttempts: CencCandidateKey[] = [];
    if (cencKeyHex) {
      cencAttempts.push({ keyHex: cencKeyHex, ivHex: cencIvHex });
    }
    for (const candidate of cencCandidateKeys) {
      if (
        cencAttempts.some(
          (a) => a.keyHex === candidate.keyHex && (a.ivHex ?? "") === (candidate.ivHex ?? ""),
        )
      ) {
        continue;
      }
      cencAttempts.push(candidate);
    }
    for (const [idx, candidate] of cencAttempts.entries()) {
      try {
        const label = candidate.kid
          ? `m4b_with_cenc_key_${idx + 1}_kid_${candidate.kid}`
          : `m4b_with_cenc_key_${idx + 1}`;
        attemptsTried.push(label);
        await transcodeToM4b(
          aaxPath,
          outPath,
          undefined,
          undefined,
          false,
          candidate.keyHex,
          candidate.ivHex,
          onOutTimeMs,
          inputHeaders,
        );
        markFinishing();
        return;
      } catch (err: unknown) {
        lastErr = toErrorMessage(err);
      }
    }
    try {
      attemptsTried.push(useActivationBytes ? "m4b_aac_with_activation" : "m4b_aac_no_activation");
      await transcodeToM4b(
        aaxPath,
        outPath,
        licenseKeyHex,
        storedActivation,
        useActivationBytes,
        undefined,
        undefined,
        onOutTimeMs,
        inputHeaders,
      );
      markFinishing();
      return;
    } catch (err: unknown) {
      const msg = toErrorMessage(err);
      lastErr = msg;
      if (msg.includes("spawn ffmpeg ENOENT")) {
        throw new Error(
          "ffmpeg is not installed or not in PATH. Install ffmpeg (macOS: `brew install ffmpeg`) and retry.",
        );
      }
      // Demux/code69 path: retry once without activation bytes for ambiguous payloads.
      if (useActivationBytes && isDemuxFailure(msg)) {
        logger.warn({ asin: job.asin, reason: splitFfmpegMessage(msg).head }, "Retrying m4b conversion without activation bytes");
        try {
          attemptsTried.push("m4b_aac_no_activation_fallback");
          await transcodeToM4b(
            aaxPath,
            outPath,
            licenseKeyHex,
            storedActivation,
            false,
            undefined,
            undefined,
            onOutTimeMs,
            inputHeaders,
          );
          markFinishing();
          return;
        } catch (e2: unknown) {
          lastErr = toErrorMessage(e2);
        }
      }
      throw new Error(
        renderConversionFailure(
          lastErr ?? msg,
          context,
          attemptsTried,
          !!(licenseKeyHex ?? storedActivation),
        ),
      );
    }
  }

  const cencPrefix: string[] = [];
  const looksAaxc = context.inputFingerprint.toLowerCase().includes("ftypaaxc");
  if (looksAaxc && !cencKeyHex) {
    throw new Error(
      "AAXC input requires decryption key/iv; MP3 conversion aborted before ffmpeg decode attempts.",
    );
  }
  if (cencKeyHex) {
    cencPrefix.push("-decryption_key", cencKeyHex);
    if (cencIvHex) cencPrefix.push("-decryption_iv", cencIvHex);
  }
  const ffmpegArgs = [
    ...ffmpegHttpInputPrefix(aaxPath, inputHeaders),
    ...cencPrefix,
    ...ffmpegActivationPrefix(licenseKeyHex, storedActivation, useActivationBytes),
    "-i",
    aaxPath,
    "-c:a",
    "libmp3lame",
    "-q:a",
    "2",
    "-vn",
    "-y",
    outPath,
  ];

  let lastErr: string | undefined;
  try {
    attemptsTried.push(useActivationBytes ? "mp3_with_activation" : "mp3_no_activation");
    await runFfmpeg(ffmpegArgs, { onOutTimeMs, onProgressState });
    markFinishing();
    return;
  } catch (err: unknown) {
    const msg = toErrorMessage(err);
    lastErr = msg;
    if (msg.includes("spawn ffmpeg ENOENT")) {
      throw new Error(
        "ffmpeg is not installed or not in PATH. Install ffmpeg (macOS: `brew install ffmpeg`) and retry.",
      );
    }
    if (useActivationBytes && isDemuxFailure(msg)) {
      const retryArgs = [
        ...ffmpegHttpInputPrefix(aaxPath, inputHeaders),
        ...cencPrefix,
        ...ffmpegActivationPrefix(licenseKeyHex, storedActivation, false),
        "-i",
        aaxPath,
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        "-vn",
        "-y",
        outPath,
      ];
      try {
        attemptsTried.push("mp3_no_activation_fallback");
        await runFfmpeg(retryArgs, { onOutTimeMs, onProgressState });
        markFinishing();
        return;
      } catch (e2: unknown) {
        lastErr = toErrorMessage(e2);
      }
    }
  }
  throw new Error(
    renderConversionFailure(
      lastErr ?? "ffmpeg conversion failed",
      context,
      attemptsTried,
      !!(licenseKeyHex ?? storedActivation),
    ),
  );
}

function assertDownloadedPayloadLooksAudio(artifact: DownloadArtifact): string {
  try {
    const fd = fs.openSync(artifact.filePath, "r");
    const buf = Buffer.alloc(FILE_HEAD_SCAN_BYTES);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (read <= 0) {
      throw new Error("Downloaded file is empty.");
    }
    const head = buf.subarray(0, read);
    const text = head.toString("utf8").trimStart().slice(0, 120).toLowerCase();
    const fingerprint = `hex:${hexPreview(head)} text:${textPreview(head)}`;
    if (
      text.startsWith("<!doctype") ||
      text.startsWith("<html") ||
      text.startsWith("{") ||
      text.startsWith("#extm3u") ||
      text.startsWith("<?xml") ||
      text.includes("<mpd")
    ) {
      throw new Error(
        `Downloaded payload is not a direct audio file (got HTML/JSON/playlist). ${fingerprint}`,
      );
    }
    if (artifact.contentLength > 0 && artifact.bytesWritten > 0 && artifact.bytesWritten < artifact.contentLength) {
      throw new Error(
        `Downloaded file is truncated (${artifact.bytesWritten}/${artifact.contentLength} bytes). ${fingerprint}`,
      );
    }
    return fingerprint;
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error(`Failed to validate downloaded file: ${String(err)}`);
  }
}

export interface DownloadDiagnostics {
  activeJobs: number;
  doneJobs: number;
  errorJobs: number;
  queuedJobs: number;
  tempBytes: number;
  freeDiskBytes: number | null;
  doneTtlMs: number;
}

export function getDownloadDiagnostics(): DownloadDiagnostics {
  sweepExpiredFinishedJobs();
  let activeJobs = 0;
  let doneJobs = 0;
  let errorJobs = 0;
  let queuedJobs = 0;
  let tempBytes = 0;
  for (const job of jobs.values()) {
    if (job.status === "done") {
      doneJobs++;
      if (job.outputPath && fs.existsSync(job.outputPath)) {
        try {
          tempBytes += fs.statSync(job.outputPath).size;
        } catch {
          // ignore
        }
      }
      continue;
    }
    if (job.status === "error") {
      errorJobs++;
      continue;
    }
    if (job.status === "queued") queuedJobs++;
    activeJobs++;
  }
  return {
    activeJobs,
    doneJobs,
    errorJobs,
    queuedJobs,
    tempBytes,
    freeDiskBytes: getFreeDiskBytes(),
    doneTtlMs: DONE_TTL_MS,
  };
}

export function confirmTransferredDownload(id: string): { removed: boolean; asin?: string } {
  sweepExpiredFinishedJobs();
  const job = jobs.get(id);
  if (!job || job.status !== "done") return { removed: false };
  const asin = job.asin;
  removeDownloadForAsin(job.asin);
  return { removed: true, asin };
}

export function getOutputPath(id: string): string | null {
  return jobs.get(id)?.outputPath ?? null;
}

export function setActivationBytes(bytes: string): void {
  const session = getSession();
  if (session) {
    session.activationBytes = bytes.trim().toLowerCase();
    flushSession();
  }
}

setInterval(() => {
  const removed = sweepExpiredFinishedJobs();
  if (removed > 0) {
    logger.info({ removed, doneTtlMs: DONE_TTL_MS }, "Swept expired temporary downloads");
  }
}, SWEEP_INTERVAL_MS).unref();
