import { z } from "zod";
import { getApiBaseUrl } from "./platformConfig";

const CHAPTER_CACHE_KEY = "speed_chapter_cache_v1";
const PROGRESS_CACHE_KEY = "speed_progress_cache_v1";
const PROGRESS_QUEUE_KEY = "speed_progress_queue_v1";
const CHAPTER_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROGRESS_CACHE_MAX_AGE_MS = 2 * 60 * 1000;

function parseJsonResponse(text: string, status: number): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    if (status >= 400) throw new Error(`HTTP ${status} (empty body)`);
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    if (status >= 400) throw new Error(trimmed.slice(0, 400) || `HTTP ${status}`);
    throw new Error(`Invalid JSON from API: ${trimmed.slice(0, 200)}`);
  }
}

async function apiFetch<T>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<T> {
  const url = `${getApiBaseUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network request failed";
    throw new Error(`Network error contacting ${url}: ${msg}`);
  }
  const text = await res.text();
  const json = parseJsonResponse(text, res.status);
  if (!res.ok) {
    const body = json as { error?: string; message?: string; status?: string };
    const msg =
      body.error ??
      body.message ??
      (typeof body === "object" && body !== null && "status" in body
        ? JSON.stringify(body).slice(0, 400)
        : null) ??
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(parsed.error.message || "Unexpected API response");
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const AuthStatusSchema = z.object({
  authenticated: z.boolean(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  marketplace: z.string().nullable(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

const LoginSuccessSchema = z.object({
  status: z.literal("success"),
  username: z.string(),
  email: z.string(),
  marketplace: z.string(),
});
const LoginErrorSchema = z.object({ status: z.literal("error"), error: z.string() });
const LoginResultSchema = z.discriminatedUnion("status", [LoginSuccessSchema, LoginErrorSchema]);
export type LoginResult = z.infer<typeof LoginResultSchema>;

const InitLoginSchema = z.object({
  loginUrl: z.string(),
  pendingId: z.string(),
});
export type InitLoginResult = z.infer<typeof InitLoginSchema>;

// ---------------------------------------------------------------------------
// Auth API calls
// ---------------------------------------------------------------------------

export function getAuthStatus() {
  return apiFetch(AuthStatusSchema, "/audible/auth/status");
}

export function initLogin(marketplace: string) {
  return apiFetch(InitLoginSchema, "/audible/auth/login", {
    method: "POST",
    body: JSON.stringify({ marketplace }),
  });
}

export function completeFromUrl(pendingId: string, maplandingUrl: string) {
  return apiFetch(LoginResultSchema, "/audible/auth/complete-url", {
    method: "POST",
    body: JSON.stringify({ pendingId, maplandingUrl }),
  });
}

export function logout() {
  return apiFetch(z.object({ message: z.string() }), "/audible/auth/logout", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export const BookSchema = z.object({
  asin: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  authors: z.array(z.string()),
  narrators: z.array(z.string()),
  coverUrl: z.string().nullable(),
  runtimeMinutes: z.number().nullable(),
  purchaseDate: z.string().nullable(),
  seriesTitle: z.string().nullable(),
  seriesPosition: z.string().nullable(),
  releaseDate: z.string().nullable(),
  description: z.string().nullable(),
  lastPositionMs: z.number().nullable(),
  lastPositionUpdated: z.string().nullable(),
  status: z.enum(["available", "downloaded", "downloading"]),
});
export type Book = z.infer<typeof BookSchema>;

const LibraryResponseSchema = z.object({
  books: z.array(BookSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

export type LibraryResponse = z.infer<typeof LibraryResponseSchema>;

export function fetchLibrary(page = 1, pageSize = 50) {
  return apiFetch(LibraryResponseSchema, `/audible/library?page=${page}&pageSize=${pageSize}`);
}

/**
 * Loads every library page. Audible often omits or misreports `total_records` (e.g. equals
 * first page size), so we must not stop early on `books.length >= total`. We stop on an
 * empty page, a short page, or a page that adds no new ASINs (duplicate guard).
 */
export async function fetchLibraryAll(chunkSize = 50): Promise<LibraryResponse> {
  const books: Book[] = [];
  const seenAsins = new Set<string>();
  let page = 1;
  let apiTotalHint = 0;

  for (;;) {
    const res = await fetchLibrary(page, chunkSize);
    if (typeof res.total === "number" && res.total > 0) {
      apiTotalHint = Math.max(apiTotalHint, res.total);
    }

    if (res.books.length === 0) break;

    let added = 0;
    for (const b of res.books) {
      if (!seenAsins.has(b.asin)) {
        seenAsins.add(b.asin);
        books.push(b);
        added++;
      }
    }

    if (added === 0) break;
    if (res.books.length < chunkSize) break;

    page += 1;
    if (page > 500) {
      throw new Error("Library is too large to load (stopped after 500 pages).");
    }
  }

  return {
    books,
    total: Math.max(apiTotalHint, books.length),
    page: 1,
    pageSize: books.length,
  };
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

export const DownloadJobSchema = z.object({
  id: z.string(),
  asin: z.string(),
  title: z.string(),
  status: z.enum(["queued", "downloading", "converting", "done", "error"]),
  progress: z.number(),
  format: z.string(),
  outputPath: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DownloadJob = z.infer<typeof DownloadJobSchema>;

export function startDownload(asin: string, title: string, format: "mp3" | "m4b" = "m4b") {
  return apiFetch(DownloadJobSchema, "/audible/download", {
    method: "POST",
    body: JSON.stringify({ asin, title, format }),
  });
}

export function listDownloadJobs() {
  return apiFetch(z.array(DownloadJobSchema), "/audible/downloads");
}

const DeleteAsinResponseSchema = z.object({
  message: z.string(),
  jobsRemoved: z.number().optional(),
});

export function deleteDownloadForAsin(asin: string) {
  return apiFetch(
    DeleteAsinResponseSchema,
    `/audible/downloads/asin/${encodeURIComponent(asin)}`,
    { method: "DELETE" },
  );
}

const MarkTransferredResponseSchema = z.object({
  message: z.string(),
  asin: z.string().nullable().optional(),
});

export function markDownloadTransferred(jobId: string) {
  return apiFetch(
    MarkTransferredResponseSchema,
    `/audible/download/${encodeURIComponent(jobId)}/transferred`,
    { method: "POST" },
  );
}

const DeleteAllDownloadsResponseSchema = z.object({
  message: z.string(),
  jobsRemoved: z.number(),
  filesRemoved: z.number(),
});

export function deleteAllDownloadedFiles() {
  return apiFetch(DeleteAllDownloadsResponseSchema, "/audible/downloads", { method: "DELETE" });
}

export const DownloadDiagnosticsSchema = z.object({
  activeJobs: z.number(),
  doneJobs: z.number(),
  errorJobs: z.number(),
  queuedJobs: z.number(),
  tempBytes: z.number(),
  freeDiskBytes: z.number().nullable(),
  doneTtlMs: z.number(),
});

export type DownloadDiagnostics = z.infer<typeof DownloadDiagnosticsSchema>;

export function getDownloadDiagnostics() {
  return apiFetch(DownloadDiagnosticsSchema, "/audible/diagnostics");
}

export function syncListeningProgress(asin: string, positionMs: number) {
  return apiFetch(z.object({ ok: z.boolean() }), "/audible/progress", {
    method: "POST",
    body: JSON.stringify({ asin, positionMs }),
  });
}

const ListeningProgressSchema = z.object({
  positionMs: z.number().nullable(),
  updatedAt: z.string().nullable(),
});
export type ListeningProgress = z.infer<typeof ListeningProgressSchema>;

export function getListeningProgress(asin: string) {
  return apiFetch(
    ListeningProgressSchema,
    `/audible/progress/${encodeURIComponent(asin)}`,
  );
}

const ChapterSchema = z.object({
  title: z.string(),
  startOffsetMs: z.number(),
  lengthMs: z.number(),
});

const ChapterInfoSchema = z.object({
  runtimeLengthMs: z.number().optional(),
  isAccurate: z.boolean().optional(),
  chapters: z.array(ChapterSchema),
});

export type ChapterInfo = z.infer<typeof ChapterInfoSchema>;

export function getChapterInfo(asin: string) {
  return apiFetch(ChapterInfoSchema, `/audible/chapters/${encodeURIComponent(asin)}`);
}

type CachedChapterEntry = {
  asin: string;
  data: ChapterInfo;
  savedAt: number;
  version: number;
  source: "server";
};

type CachedProgressEntry = {
  asin: string;
  data: ListeningProgress;
  savedAt: number;
  version: number;
  source: "server" | "local";
};

export type CachedValue<T> = {
  data: T;
  savedAt: number;
  source: "server" | "local";
  version: number;
  stale: boolean;
};

type ProgressQueueItem = {
  asin: string;
  positionMs: number;
  queuedAt: number;
  retries: number;
};

function readJsonStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore local storage quota issues
  }
}

function readChapterCache(): Record<string, CachedChapterEntry> {
  return readJsonStorage(CHAPTER_CACHE_KEY, {} as Record<string, CachedChapterEntry>);
}

function writeChapterCache(next: Record<string, CachedChapterEntry>): void {
  writeJsonStorage(CHAPTER_CACHE_KEY, next);
}

function readProgressCache(): Record<string, CachedProgressEntry> {
  return readJsonStorage(PROGRESS_CACHE_KEY, {} as Record<string, CachedProgressEntry>);
}

function writeProgressCache(next: Record<string, CachedProgressEntry>): void {
  writeJsonStorage(PROGRESS_CACHE_KEY, next);
}

function readProgressQueue(): ProgressQueueItem[] {
  return readJsonStorage(PROGRESS_QUEUE_KEY, [] as ProgressQueueItem[]);
}

function writeProgressQueue(next: ProgressQueueItem[]): void {
  writeJsonStorage(PROGRESS_QUEUE_KEY, next);
}

export function getCachedChapterInfo(asin: string): CachedValue<ChapterInfo> | null {
  const cache = readChapterCache()[asin];
  if (!cache) return null;
  const stale = Date.now() - cache.savedAt > CHAPTER_CACHE_MAX_AGE_MS;
  return {
    data: cache.data,
    savedAt: cache.savedAt,
    source: cache.source,
    version: cache.version,
    stale,
  };
}

export async function getChapterInfoWithCache(asin: string): Promise<CachedValue<ChapterInfo>> {
  const cached = getCachedChapterInfo(asin);
  if (cached && !cached.stale) return cached;
  const fresh = await getChapterInfo(asin);
  const now = Date.now();
  const next = readChapterCache();
  next[asin] = { asin, data: fresh, savedAt: now, version: 1, source: "server" };
  writeChapterCache(next);
  return { data: fresh, savedAt: now, source: "server", version: 1, stale: false };
}

export function getCachedListeningProgress(asin: string): CachedValue<ListeningProgress> | null {
  const cache = readProgressCache()[asin];
  if (!cache) return null;
  const stale = Date.now() - cache.savedAt > PROGRESS_CACHE_MAX_AGE_MS;
  return {
    data: cache.data,
    savedAt: cache.savedAt,
    source: cache.source,
    version: cache.version,
    stale,
  };
}

function saveProgressCache(
  asin: string,
  progress: ListeningProgress,
  source: "server" | "local",
): CachedValue<ListeningProgress> {
  const now = Date.now();
  const next = readProgressCache();
  next[asin] = { asin, data: progress, savedAt: now, version: 1, source };
  writeProgressCache(next);
  return { data: progress, savedAt: now, source, version: 1, stale: false };
}

export async function getListeningProgressWithCache(asin: string): Promise<CachedValue<ListeningProgress>> {
  const cached = getCachedListeningProgress(asin);
  if (cached && !cached.stale) return cached;
  const fresh = await getListeningProgress(asin);
  return saveProgressCache(asin, fresh, "server");
}

function enqueueProgressSync(asin: string, positionMs: number) {
  const queue = readProgressQueue();
  const deduped = queue.filter((item) => item.asin !== asin);
  deduped.push({
    asin,
    positionMs,
    queuedAt: Date.now(),
    retries: 0,
  });
  writeProgressQueue(deduped);
}

export function getProgressQueueDepth(): number {
  return readProgressQueue().length;
}

export async function flushProgressQueue(): Promise<void> {
  const queue = readProgressQueue();
  if (queue.length === 0) return;
  const pending: ProgressQueueItem[] = [];
  for (const item of queue) {
    try {
      await syncListeningProgress(item.asin, item.positionMs);
      saveProgressCache(
        item.asin,
        { positionMs: item.positionMs, updatedAt: new Date().toISOString() },
        "server",
      );
    } catch {
      pending.push({ ...item, retries: item.retries + 1 });
    }
  }
  writeProgressQueue(pending);
}

export async function syncListeningProgressQueued(
  asin: string,
  positionMs: number,
): Promise<{ queued: boolean }> {
  try {
    await syncListeningProgress(asin, positionMs);
    saveProgressCache(
      asin,
      { positionMs, updatedAt: new Date().toISOString() },
      "server",
    );
    return { queued: false };
  } catch {
    enqueueProgressSync(asin, positionMs);
    saveProgressCache(
      asin,
      { positionMs, updatedAt: new Date().toISOString() },
      "local",
    );
    return { queued: true };
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function setActivationBytes(activationBytes: string) {
  return apiFetch(
    z.object({ message: z.string() }),
    "/audible/settings/activation-bytes",
    { method: "POST", body: JSON.stringify({ activationBytes }) }
  );
}
