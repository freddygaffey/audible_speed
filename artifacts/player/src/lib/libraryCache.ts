import { z } from "zod";
import { BookSchema, type Book } from "./apiClient";

const CACHE_KEY = "speed_library_cache";

/** Matches `StoredSession` fields used to scope cached library rows per Audible account. */
export type LibraryIdentity = { username: string; marketplace: string };

const CacheSchema = z.object({
  books: z.array(BookSchema),
  total: z.number(),
  savedAt: z.number(),
  username: z.string().optional(),
  marketplace: z.string().optional(),
});

export function clearLibrary() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}

export function saveLibrary(books: Book[], total: number, identity: LibraryIdentity) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        books,
        total,
        savedAt: Date.now(),
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
    saveLibrary(next, cache.total, identity);
  } catch {
    // ignore cache write failures
  }
}

export function getBook(asin: string, identity: LibraryIdentity): Book | null {
  const cache = loadLibrary(identity);
  return cache?.books.find((b) => b.asin === asin) ?? null;
}

export function loadLibrary(identity: LibraryIdentity | null): { books: Book[]; total: number } | null {
  if (!identity) return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = CacheSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const { books, total, username, marketplace } = parsed.data;
    if (username == null || marketplace == null) return null;
    if (username !== identity.username || marketplace !== identity.marketplace) return null;
    return { books, total };
  } catch {
    return null;
  }
}
