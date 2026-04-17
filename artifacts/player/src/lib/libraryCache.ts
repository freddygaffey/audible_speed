import { z } from "zod";
import { BookSchema, type Book } from "./apiClient";

const CACHE_KEY = "speed_library_cache";

const CacheSchema = z.object({
  books: z.array(BookSchema),
  total: z.number(),
  savedAt: z.number(),
});

export function saveLibrary(books: Book[], total: number) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ books, total, savedAt: Date.now() }));
  } catch {
    // localStorage full or unavailable — ignore
  }
}

export function getBook(asin: string): Book | null {
  const cache = loadLibrary();
  return cache?.books.find((b) => b.asin === asin) ?? null;
}

export function loadLibrary(): { books: Book[]; total: number } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = CacheSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return { books: parsed.data.books, total: parsed.data.total };
  } catch {
    return null;
  }
}
