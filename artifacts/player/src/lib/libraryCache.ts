import { z } from "zod";
import { BookSchema, type Book } from "./apiClient";

const CACHE_KEY = "speed_library_cache";
const CACHE_VERSION = 2;
export const LIBRARY_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

/** Matches `StoredSession` fields used to scope cached library rows per Audible account. */
export type LibraryIdentity = { username: string; marketplace: string };

const CacheSchema = z.object({
  books: z.array(BookSchema),
  total: z.number(),
  savedAt: z.number(),
  version: z.number().default(CACHE_VERSION),
  source: z.enum(["server", "local"]).default("server"),
  username: z.string().optional(),
  marketplace: z.string().optional(),
});

export type LibraryCacheMeta = {
  savedAt: number;
  version: number;
  source: "server" | "local";
};

export type LibraryCache = {
  books: Book[];
  total: number;
  meta: LibraryCacheMeta;
};

export function clearLibrary() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}

export function saveLibrary(books: Book[], total: number, identity: LibraryIdentity) {
  saveLibraryWithMeta(books, total, identity, "server");
}

export function saveLibraryWithMeta(
  books: Book[],
  total: number,
  identity: LibraryIdentity,
  source: "server" | "local",
) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        books,
        total,
        savedAt: Date.now(),
        version: CACHE_VERSION,
        source,
        username: identity.username,
        marketplace: identity.marketplace,
      }),
    );
  } catch {
    // localStorage full or unavailable — ignore
  }
}

export function upsertBookProgress(
  asin: string,
  positionMs: number,
  updatedAt: string,
  identity: LibraryIdentity,
) {
  try {
    const cache = loadLibrary(identity);
    if (!cache) return;
    const idx = cache.books.findIndex((b) => b.asin === asin);
    if (idx < 0) return;
    const next = [...cache.books];
    next[idx] = {
      ...next[idx],
      lastPositionMs: Math.max(0, Math.floor(positionMs)),
      lastPositionUpdated: updatedAt,
    };
    saveLibraryWithMeta(next, cache.total, identity, "local");
  } catch {
    // ignore cache write failures
  }
}

export function getBook(asin: string, identity: LibraryIdentity): Book | null {
  const cache = loadLibrary(identity);
  return cache?.books.find((b) => b.asin === asin) ?? null;
}

export function loadLibrary(identity: LibraryIdentity | null): LibraryCache | null {
  if (!identity) return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = CacheSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const { books, total, username, marketplace, savedAt, source, version } = parsed.data;
    if (username == null || marketplace == null) return null;
    if (username !== identity.username || marketplace !== identity.marketplace) return null;
    return {
      books,
      total,
      meta: {
        savedAt,
        source,
        version,
      },
    };
  } catch {
    return null;
  }
}

export function shouldRefreshLibrary(cache: LibraryCache | null, maxAgeMs = LIBRARY_CACHE_MAX_AGE_MS): boolean {
  if (!cache) return true;
  return Date.now() - cache.meta.savedAt > maxAgeMs;
}
