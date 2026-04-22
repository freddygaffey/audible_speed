import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Clock,
  BookOpen,
  WifiOff,
  Settings,
  Smartphone,
  Download,
  CheckCircle,
  Loader2,
  Play,
  Search,
  Trash2,
  CheckSquare,
  Square,
  X,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { fetchLibraryAll, type Book, type DownloadJob } from "../lib/apiClient";
import { saveLibrary, loadLibrary, shouldRefreshLibrary } from "../lib/libraryCache";
import { useDownloads } from "../hooks/useDownloads";
import { useAuth } from "../lib/authContext";
import { useMobilePreview } from "../lib/mobilePreviewContext";
import { isNative } from "../lib/platformConfig";

type SortMode = "recent" | "az" | "downloaded";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

function isNetworkLikeError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes("network error contacting") ||
    msg.includes("failed to fetch") ||
    msg.includes("load failed") ||
    msg.includes("network request failed") ||
    msg.includes("timed out")
  );
}

function formatRuntime(minutes: number | null) {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatResume(positionMs: number | null, runtimeMinutes: number | null): string | null {
  if (positionMs == null || positionMs <= 0) return null;
  const totalMs = runtimeMinutes != null && runtimeMinutes > 0 ? runtimeMinutes * 60_000 : null;
  const pct =
    totalMs && totalMs > 0 ? Math.max(0, Math.min(100, Math.floor((positionMs / totalMs) * 100))) : null;
  const totalSec = Math.floor(positionMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const stamp = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  return pct != null ? `Resume ${stamp} (${pct}%)` : `Resume ${stamp}`;
}

function isNonRetriableDownloadError(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  const msg = errorText.toLowerCase();
  return (
    msg.includes("non_audio asset") ||
    msg.includes("podcastparent") ||
    msg.includes("must specify either drm_type")
  );
}

function DownloadButton({ book, job, onDownload }: {
  book: Book;
  job: DownloadJob | undefined;
  onDownload: () => void;
}) {
  if (job?.status === "done" || book.status === "downloaded") {
    return (
      <button
        type="button"
        onClick={onDownload}
        className="flex min-h-9 items-center gap-1 rounded-md px-1 py-1.5 text-xs text-green-400 touch-manipulation transition-colors hover:text-orange-400 active:text-orange-300"
        title="Play"
      >
        <Play className="h-3.5 w-3.5" />
        Play
      </button>
    );
  }

  if (job && ["queued", "downloading", "converting"].includes(job.status)) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1 text-xs text-orange-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          {job.status === "converting" ? `Converting… ${Math.max(80, Math.min(99, job.progress))}%` : `${job.progress}%`}
        </div>
        {job.status === "converting" && (
          <p className="text-[10px] leading-tight text-gray-500">
            Re-encoding for playback can take several minutes on long titles; progress stays here until done.
          </p>
        )}
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
    if (isNonRetriableDownloadError(job.error)) {
      return (
        <div className="space-y-1">
          <span className="text-xs text-yellow-400" title={job.error ?? "Not downloadable"}>
            Not downloadable
          </span>
          {job.error && (
            <p className="text-[10px] leading-tight text-yellow-500/90">
              {job.error}
            </p>
          )}
        </div>
      );
    }
    return (
      <div className="space-y-1">
        <button
          type="button"
          onClick={onDownload}
          className="min-h-9 rounded-md px-2 py-1.5 text-xs text-red-400 touch-manipulation transition-colors hover:text-red-300 active:text-red-200"
          title={job.error ?? "Download failed"}
        >
          Retry
        </button>
        {job.error && (
          <p className="text-[10px] leading-tight text-red-400/90">
            {job.error}
          </p>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onDownload}
      className="flex min-h-9 items-center gap-1 rounded-md px-1 py-1.5 text-xs text-gray-400 touch-manipulation transition-colors hover:text-orange-400 active:text-orange-300"
    >
      <Download className="h-3.5 w-3.5" />
      Download
    </button>
  );
}

function BookCard({ book, job, onDownload, onRemoveDownload, selectMode = false, selected = false, onToggleSelect }: {
  book: Book;
  job: DownloadJob | undefined;
  onDownload: () => void;
  onRemoveDownload?: () => void;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const isDone = job?.status === "done" || book.status === "downloaded";
  const resumeLabel = formatResume(book.lastPositionMs, book.runtimeMinutes);

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-gray-900 p-3 touch-manipulation transition duration-150 ease-out hover:bg-gray-800 active:scale-[0.98]">
      <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-gray-800">
        {selectMode && (
          <button
            type="button"
            onClick={onToggleSelect}
            className="absolute left-1 top-1 z-10 flex h-9 w-9 items-center justify-center rounded-lg bg-black/55 text-white touch-manipulation hover:bg-black/70 active:scale-95"
            title={selected ? "Deselect" : "Select"}
          >
            {selected ? <CheckSquare className="h-4 w-4 text-orange-300" /> : <Square className="h-4 w-4" />}
          </button>
        )}
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
        {resumeLabel && <p className="text-xs text-orange-400">{resumeLabel}</p>}
        <div className="flex items-center justify-between gap-2">
          {selectMode ? (
            <button
              type="button"
              onClick={onToggleSelect}
              className="min-h-9 rounded-md px-1 py-1.5 text-left text-xs text-gray-300 touch-manipulation hover:text-white active:text-white"
            >
              {selected ? "Selected" : "Select"}
            </button>
          ) : (
            <DownloadButton book={book} job={job} onDownload={onDownload} />
          )}
          {job && onRemoveDownload && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveDownload();
              }}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-gray-500 touch-manipulation hover:bg-gray-800 hover:text-red-400 active:scale-95"
              title="Remove from device"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function sortBooks(books: Book[], mode: SortMode, byAsin: Map<string, DownloadJob>): Book[] {
  return [...books].sort((a, b) => {
    if (mode === "downloaded") {
      const aDone = byAsin.get(a.asin)?.status === "done" || a.status === "downloaded";
      const bDone = byAsin.get(b.asin)?.status === "done" || b.status === "downloaded";
      if (aDone !== bDone) return aDone ? -1 : 1;
    }
    if (mode === "az") {
      return a.title.localeCompare(b.title);
    }
    // recent: match Audible-style "continue listening" intent first, then purchase recency.
    const aListen = a.lastPositionUpdated ?? "";
    const bListen = b.lastPositionUpdated ?? "";
    if (aListen !== bListen) return bListen.localeCompare(aListen);
    const aDate = a.purchaseDate ?? "";
    const bDate = b.purchaseDate ?? "";
    return bDate.localeCompare(aDate);
  });
}

export default function Library() {
  const { session } = useAuth();
  const { mobilePreview, toggleMobilePreview } = useMobilePreview();
  const cached = session ? loadLibrary(session) : null;
  const { jobs, byAsin, download, downloadBatch, removeDownload, removeAllDownloads } = useDownloads();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("recent");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedAsins, setSelectedAsins] = useState<Set<string>>(new Set());

  const accountKey = session ? [session.username, session.marketplace] as const : ["", ""] as const;

  const { data, error, isLoading, isFetching } = useQuery({
    queryKey: ["library", ...accountKey],
    queryFn: async () => {
      if (!session) throw new Error("Not signed in");
      const result = await fetchLibraryAll();
      saveLibrary(result.books, result.total, session);
      return result;
    },
    enabled: !!session,
    initialData: cached
      ? {
          books: cached.books,
          total: cached.total,
          page: 1,
          pageSize: cached.books.length,
        }
      : undefined,
    staleTime: 60 * 1000,
    refetchOnMount: shouldRefreshLibrary(cached) ? "always" : false,
  });

  const isOffline = !!error && !!cached && isNetworkLikeError(error);
  const allBooks = data?.books ?? [];

  const filteredBooks = useMemo(() => {
    const q = search.toLowerCase().trim();
    const filtered = q
      ? allBooks.filter(
          (b) =>
            b.title.toLowerCase().includes(q) ||
            b.authors.some((a) => a.toLowerCase().includes(q))
        )
      : allBooks;
    return sortBooks(filtered, sort, byAsin);
  }, [allBooks, search, sort, byAsin]);

  const selectableBooks = useMemo(
    () =>
      filteredBooks.filter((book) => {
        const job = byAsin.get(book.asin);
        const isDone = job?.status === "done" || book.status === "downloaded";
        const isBusy = !!job && ["queued", "downloading", "converting"].includes(job.status);
        return !isDone && !isBusy;
      }),
    [filteredBooks, byAsin],
  );

  const selectedCount = selectedAsins.size;

  function toggleSelect(asin: string) {
    setSelectedAsins((prev) => {
      const next = new Set(prev);
      if (next.has(asin)) next.delete(asin);
      else next.add(asin);
      return next;
    });
  }

  function toggleSelectAllEligible() {
    const eligible = selectableBooks.map((b) => b.asin);
    setSelectedAsins((prev) => {
      const allSelected = eligible.length > 0 && eligible.every((asin) => prev.has(asin));
      if (allSelected) return new Set();
      return new Set(eligible);
    });
  }

  return (
    <div className="min-h-screen bg-gray-950 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-white">My Library</h1>
            {data && (
              <p className="mt-0.5 text-sm text-gray-400">
                {filteredBooks.length !== allBooks.length
                  ? `${filteredBooks.length} of ${allBooks.length}`
                  : `${allBooks.length}`}{" "}
                {allBooks.length === 1 ? "book" : "books"}
                {isFetching && !isLoading && (
                  <span className="ml-2 text-xs text-gray-500">Refreshing…</span>
                )}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {!selectMode ? (
                <button
                  type="button"
                  onClick={() => {
                    setSelectMode(true);
                    setSelectedAsins(new Set());
                  }}
                  className="min-h-10 rounded-lg px-2 py-2 text-left text-xs text-gray-400 touch-manipulation hover:bg-gray-900 hover:text-white active:bg-gray-900"
                >
                  Select for batch download
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={toggleSelectAllEligible}
                    className="min-h-10 rounded-lg px-2 py-2 text-xs text-gray-300 touch-manipulation hover:bg-gray-900 hover:text-white active:bg-gray-900"
                  >
                    {selectableBooks.length > 0 &&
                    selectableBooks.every((b) => selectedAsins.has(b.asin))
                      ? "Clear selection"
                      : "Select all"}
                  </button>
                  <button
                    type="button"
                    disabled={selectedCount === 0}
                    onClick={() => {
                      const batch = filteredBooks
                        .filter((b) => selectedAsins.has(b.asin))
                        .map((b) => ({ asin: b.asin, title: b.title }));
                      void downloadBatch(batch).then(() => {
                        setSelectMode(false);
                        setSelectedAsins(new Set());
                      });
                    }}
                    className="min-h-10 rounded-lg px-2 py-2 text-xs text-orange-400 touch-manipulation hover:text-orange-300 active:text-orange-200 disabled:text-gray-600 disabled:active:scale-100"
                  >
                    Download selected ({selectedCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectMode(false);
                      setSelectedAsins(new Set());
                    }}
                    className="flex min-h-10 items-center gap-1 rounded-lg px-2 py-2 text-xs text-gray-500 touch-manipulation hover:bg-gray-900 hover:text-gray-300 active:bg-gray-900"
                  >
                    <X className="h-3 w-3" />
                    Cancel
                  </button>
                </>
              )}
            </div>
            {jobs.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (
                    !confirm(
                      "Remove every downloaded file from this server? Active downloads will be cancelled. This cannot be undone.",
                    )
                  ) {
                    return;
                  }
                  void removeAllDownloads();
                }}
                className="mt-2 min-h-10 rounded-lg px-2 py-2 text-left text-xs text-gray-500 touch-manipulation hover:bg-gray-900 hover:text-red-400 active:bg-gray-900"
              >
                Remove all downloads…
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {!isNative() && (
              <button
                type="button"
                onClick={toggleMobilePreview}
                className={`inline-flex h-11 w-11 items-center justify-center rounded-xl touch-manipulation transition duration-150 hover:bg-gray-800 active:scale-95 ${
                  mobilePreview
                    ? "bg-orange-500/15 text-orange-400"
                    : "text-gray-400 hover:text-white"
                }`}
                title={
                  mobilePreview
                    ? "Turn off mobile width preview"
                    : "Mobile width preview (~390px) — good for phone / offline layout checks"
                }
                aria-pressed={mobilePreview}
              >
                <Smartphone className="h-5 w-5" />
              </button>
            )}
            <Link
              href="/settings"
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-gray-400 touch-manipulation transition duration-150 hover:bg-gray-800 hover:text-white active:scale-95"
              aria-label="Settings"
            >
              <Settings className="h-5 w-5" />
            </Link>
          </div>
        </div>

        {/* Search + sort */}
        <div className="mb-5 flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title or author…"
              className="min-h-11 w-full rounded-lg border border-gray-700 bg-gray-900 py-2.5 pl-10 pr-4 text-base text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none sm:text-sm"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
            className="min-h-11 min-w-[7.5rem] rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-300 focus:border-orange-500 focus:outline-none"
          >
            <option value="recent">Recent</option>
            <option value="az">A–Z</option>
            <option value="downloaded">Downloaded</option>
          </select>
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
            {error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : "Failed to load library"}
          </p>
        )}

        {search && filteredBooks.length === 0 && (
          <p className="text-center text-sm text-gray-500 mt-8">No books match "{search}"</p>
        )}

        {filteredBooks.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {filteredBooks.map((book) => {
              const job = byAsin.get(book.asin);
              const isDone = job?.status === "done" || book.status === "downloaded";
              return (
                <BookCard
                  key={book.asin}
                  book={book}
                  job={job}
                  onDownload={
                    selectMode
                      ? () => toggleSelect(book.asin)
                      : isDone
                        ? () => navigate(`/player/${book.asin}`)
                        : () => download(book.asin, book.title)
                  }
                  onRemoveDownload={
                    job
                      ? () => {
                          const label =
                            job.status === "done" || book.status === "downloaded"
                              ? `Remove "${book.title}" from this device?`
                              : `Cancel download and delete partial files for "${book.title}"?`;
                          if (!confirm(label)) return;
                          void removeDownload(book.asin);
                        }
                      : undefined
                  }
                  selectMode={selectMode}
                  selected={selectedAsins.has(book.asin)}
                  onToggleSelect={() => toggleSelect(book.asin)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
