import { z } from "zod";
import { getApiBaseUrl } from "./platformConfig";

async function apiFetch<T>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const json: unknown = await res.json();
  if (!res.ok) {
    const msg = (json as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return schema.parse(json);
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

const DeleteAllDownloadsResponseSchema = z.object({
  message: z.string(),
  jobsRemoved: z.number(),
  filesRemoved: z.number(),
});

export function deleteAllDownloadedFiles() {
  return apiFetch(DeleteAllDownloadsResponseSchema, "/audible/downloads", { method: "DELETE" });
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
