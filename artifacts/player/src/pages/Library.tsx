import { useQuery } from "@tanstack/react-query";
import { Clock, BookOpen, WifiOff, Settings, Download, CheckCircle, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { fetchLibrary, type Book, type DownloadJob } from "../lib/apiClient";
import { saveLibrary, loadLibrary } from "../lib/libraryCache";
import { useDownloads } from "../hooks/useDownloads";

function formatRuntime(minutes: number | null) {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function DownloadButton({ book, job, onDownload }: {
  book: Book;
  job: DownloadJob | undefined;
  onDownload: () => void;
}) {
  if (job?.status === "done" || book.status === "downloaded") {
    return (
      <div className="flex items-center gap-1 text-xs text-green-400">
        <CheckCircle className="h-3.5 w-3.5" />
        Downloaded
      </div>
    );
  }

  if (job && ["queued", "downloading", "converting"].includes(job.status)) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1 text-xs text-orange-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          {job.status === "converting" ? "Converting…" : `${job.progress}%`}
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-gray-700">
          <div
            className="h-full rounded-full bg-orange-500 transition-all"
            style={{ width: `${job.progress}%` }}
          />
        </div>
      </div>
    );
  }

  if (job?.status === "error") {
    return (
      <button
        onClick={onDownload}
        className="text-xs text-red-400 hover:text-red-300"
        title={job.error ?? "Download failed"}
      >
        Retry
      </button>
    );
  }

  return (
    <button
      onClick={onDownload}
      className="flex items-center gap-1 text-xs text-gray-400 hover:text-orange-400 transition-colors"
    >
      <Download className="h-3.5 w-3.5" />
      Download
    </button>
  );
}

function BookCard({ book, job, onDownload }: {
  book: Book;
  job: DownloadJob | undefined;
  onDownload: () => void;
}) {
  const isDone = job?.status === "done" || book.status === "downloaded";

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-gray-900 p-3 transition-colors hover:bg-gray-800">
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
        {isDone && (
          <div className="absolute bottom-1 right-1 rounded-full bg-green-500/90 p-0.5">
            <CheckCircle className="h-3.5 w-3.5 text-white" />
          </div>
        )}
      </div>
      <div className="min-w-0 space-y-1">
        <p className="truncate text-sm font-medium text-white">{book.title}</p>
        <p className="truncate text-xs text-gray-400">{book.authors.join(", ")}</p>
        {book.runtimeMinutes && (
          <p className="flex items-center gap-1 text-xs text-gray-500">
            <Clock className="h-3 w-3" />
            {formatRuntime(book.runtimeMinutes)}
          </p>
        )}
        <DownloadButton book={book} job={job} onDownload={onDownload} />
      </div>
    </div>
  );
}

export default function Library() {
  const cached = loadLibrary();
  const { byAsin, download } = useDownloads();

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
                {isFetching && !isLoading && (
                  <span className="ml-2 text-xs text-gray-500">Refreshing…</span>
                )}
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
              <BookCard
                key={book.asin}
                book={book}
                job={byAsin.get(book.asin)}
                onDownload={() => download(book.asin, book.title)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
