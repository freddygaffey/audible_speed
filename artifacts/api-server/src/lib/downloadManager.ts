import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { logger } from "./logger.js";
import { getDownloadUrl } from "./audibleClient.js";
import { flushSession, getSession } from "./audibleAuth.js";
import { fetchWithRetry } from "./fetchWithRetry.js";
import { resolveWidevineDecryption } from "./widevine.js";

const FFMPEG_STDERR_CAP = 48 * 1024;
const FILE_HEAD_SCAN_BYTES = 512;
const PREVIEW_HEX_BYTES = 32;
const AUDIBLE_HTTP_UA = "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0";

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
function runFfmpeg(args: string[]): Promise<void> {
  // warning: enough context on failure; error often omits lines that explain exit 69 / DRM.
  const fullArgs = ["-hide_banner", "-nostats", "-loglevel", "warning", ...args];
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stderrBytes = 0;

    const child = spawn("ffmpeg", fullArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
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
  return Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function getJob(id: string): DownloadJob | undefined {
  pruneMissingDoneJobs();
  return jobs.get(id);
}

function unlinkSafe(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    logger.warn({ filePath, err }, "Failed to delete file");
  }
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
        error: null,
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
  const useActivationBytes = (licenseDrmType ?? "").toLowerCase() !== "mpeg";
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
  );

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 512) {
    throw new Error("Conversion produced no usable output file (disk full or ffmpeg failed).");
  }
  const outputProbe = await runFfprobe(outPath);
  if (!outputProbe.ok || !outputProbe.audioStream) {
    throw new Error(`Converted output is invalid. ${summarizeProbe(outputProbe)}`);
  }

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
        fileStream.on("finish", () =>
          resolve({
            filePath: destPath,
            finalUrl,
            contentType,
            contentLength: totalSize,
            bytesWritten: downloaded,
          }),
        );
        fileStream.on("error", reject);
      } catch (err) {
        fileStream.destroy();
        reject(err);
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
): Promise<void> {
  const isRemote = /^https?:\/\//i.test(aaxPath);
  const cencPrefix: string[] = [];
  if (cencKeyHex) {
    cencPrefix.push("-decryption_key", cencKeyHex);
    if (cencIvHex) cencPrefix.push("-decryption_iv", cencIvHex);
  }
  const args = [
    ...(isRemote ? ["-user_agent", AUDIBLE_HTTP_UA] : []),
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
  await runFfmpeg(args);
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

  if (job.format === "m4b") {
    let lastErr: string | undefined;
    const looksAaxc = context.inputFingerprint.toLowerCase().includes("ftypaaxc");
    if (looksAaxc && !cencKeyHex) {
      throw new Error(
        "AAXC input requires decryption key/iv; conversion aborted before ffmpeg decode attempts.",
      );
    }
    if (cencKeyHex) {
      try {
        attemptsTried.push("m4b_with_cenc_key");
        await transcodeToM4b(
          aaxPath,
          outPath,
          undefined,
          undefined,
          false,
          cencKeyHex,
          cencIvHex,
        );
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
      );
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
          );
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
  const isRemote = /^https?:\/\//i.test(aaxPath);
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
    ...(isRemote ? ["-user_agent", AUDIBLE_HTTP_UA] : []),
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
    await runFfmpeg(ffmpegArgs);
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
        ...(isRemote ? ["-user_agent", AUDIBLE_HTTP_UA] : []),
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
        await runFfmpeg(retryArgs);
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
