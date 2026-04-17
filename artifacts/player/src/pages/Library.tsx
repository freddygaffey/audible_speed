import { useQuery } from "@tanstack/react-query";
import { Clock, BookOpen, WifiOff, Settings } from "lucide-react";
import { Link } from "wouter";
import { fetchLibrary, type Book } from "../lib/apiClient";
import { saveLibrary, loadLibrary } from "../lib/libraryCache";

function formatRuntime(minutes: number | null) {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function BookCard({ book }: { book: Book }) {
  return (
    <div className="group flex flex-col gap-2 rounded-xl bg-gray-900 p-3 transition-colors hover:bg-gray-800">
      <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-gray-800">
        {book.coverUrl ? (
          <img
            src={book.coverUrl}
            alt={book.title}
            className="h-full w-full object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <BookOpen className="h-12 w-12 text-gray-600" />
          </div>
        )}
        {book.status !== "available" && (
          <div className="absolute bottom-1 right-1 rounded bg-orange-500 px-1.5 py-0.5 text-xs font-medium text-white">
            {book.status === "downloaded" ? "✓" : "↓"}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-white">{book.title}</p>
        <p className="truncate text-xs text-gray-400">{book.authors.join(", ")}</p>
        {book.runtimeMinutes && (
          <p className="mt-1 flex items-center gap-1 text-xs text-gray-500">
            <Clock className="h-3 w-3" />
            {formatRuntime(book.runtimeMinutes)}
          </p>
        )}
      </div>
    </div>
  );
}

export default function Library() {
  const cached = loadLibrary();

  const { data, error, isLoading, isFetching } = useQuery({
    queryKey: ["library"],
    queryFn: async () => {
      const result = await fetchLibrary();
      saveLibrary(result.books, result.total);
      return result;
    },
    initialData: cached ? { books: cached.books, total: cached.total, page: 1, pageSize: 50 } : undefined,
    staleTime: 5 * 60 * 1000,
  });

  const isOffline = !!error && !!cached;
  const books = data?.books ?? [];

  return (
    <div className="min-h-screen bg-gray-950 px-4 pb-8 pt-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">My Library</h1>
            {data && (
              <p className="mt-0.5 text-sm text-gray-400">
                {data.total} {data.total === 1 ? "book" : "books"}
                {isFetching && !isLoading && <span className="ml-2 text-xs text-gray-500">Refreshing…</span>}
              </p>
            )}
          </div>
          <Link
            href="/settings"
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white"
          >
            <Settings className="h-5 w-5" />
          </Link>
        </div>

        {isOffline && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-yellow-800 bg-yellow-900/20 px-3 py-2 text-sm text-yellow-400">
            <WifiOff className="h-4 w-4 flex-shrink-0" />
            Offline — showing cached library
          </div>
        )}

        {isLoading && !cached && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="animate-pulse rounded-xl bg-gray-900 p-3">
                <div className="mb-2 aspect-square w-full rounded-lg bg-gray-800" />
                <div className="h-3 w-3/4 rounded bg-gray-800" />
                <div className="mt-1 h-2.5 w-1/2 rounded bg-gray-800" />
              </div>
            ))}
          </div>
        )}

        {!isLoading && !isOffline && error && (
          <p className="text-sm text-red-400">
            {error instanceof Error ? error.message : "Failed to load library"}
          </p>
        )}

        {books.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {books.map((book) => (
              <BookCard key={book.asin} book={book} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
