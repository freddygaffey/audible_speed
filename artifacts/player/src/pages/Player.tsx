import { useRef, useState, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { ArrowLeft, Play, Pause, SkipBack, SkipForward, BookOpen, List, X } from "lucide-react";
import { useDownloads } from "../hooks/useDownloads";
import { getBook, upsertBookProgress } from "../lib/libraryCache";
import { useAuth } from "../lib/authContext";
import { getApiBaseUrl, getStoredServerUrl, isNative } from "../lib/platformConfig";
import { getChapterInfo, type ChapterInfo, getListeningProgress, syncListeningProgress } from "../lib/apiClient";
import { ensureVaultCopy, getLocalPlaybackUrl } from "../lib/audioVault";

const SPEED_MIN = 0.5;
const SPEED_MAX = 16;
const SPEED_STEP = 0.1;
const SPEED_KEY = "speed_player_speed";

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function clampSpeed(speed: number): number {
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, speed));
}

function quantizeSpeed(speed: number): number {
  return Math.round(speed / SPEED_STEP) * SPEED_STEP;
}

function loadSavedSpeed(): number {
  const saved = parseFloat(localStorage.getItem(SPEED_KEY) ?? "");
  if (!isFinite(saved)) return 1;
  return clampSpeed(quantizeSpeed(saved));
}

export default function Player() {
  const params = useParams<{ asin: string }>();
  const [, navigate] = useLocation();
  const { session } = useAuth();
  const { byAsin } = useDownloads();
  const audioRef = useRef<HTMLAudioElement>(null);
  const resumeAppliedRef = useRef(false);
  const lastSyncedPositionMsRef = useRef(0);
  const lastSyncAtRef = useRef(0);
  const syncInFlightRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(loadSavedSpeed);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [remoteResumeMs, setRemoteResumeMs] = useState<number | null>(null);
  const [chapterInfo, setChapterInfo] = useState<ChapterInfo | null>(null);
  const [chaptersModalOpen, setChaptersModalOpen] = useState(false);

  const asin = params.asin ?? "";
  const job = byAsin.get(asin);
  const book = session ? getBook(asin, session) : null;
  const remoteFileUrl =
    job?.status === "done" ? `${getApiBaseUrl()}/audible/download/${job.id}/file` : null;
  const [localPlaybackUrl, setLocalPlaybackUrl] = useState<string | null>(null);

  useEffect(() => {
    setLocalPlaybackUrl(null);
    if (!remoteFileUrl || !session) return;
    if (!isNative()) return;
    const jobId = job?.id;
    if (!jobId) return;
    let cancelled = false;
    const asinNow = asin;
    const serverUrl = getStoredServerUrl();
    if (!serverUrl) return;
    void getLocalPlaybackUrl({
      serverUrl,
      username: session.username,
      marketplace: session.marketplace,
      asin: asinNow,
      jobId,
    }).then((url) => {
      if (!cancelled && asin === asinNow) setLocalPlaybackUrl(url);
    });
    void ensureVaultCopy({
      serverUrl,
      username: session.username,
      marketplace: session.marketplace,
      asin: asinNow,
      jobId,
      remoteUrl: remoteFileUrl,
    });
    return () => {
      cancelled = true;
    };
  }, [remoteFileUrl, session, asin, job?.id]);

  const displaySrc = localPlaybackUrl ?? remoteFileUrl;
  const title = book?.title ?? job?.title ?? "Audiobook";
  const author = book?.authors.join(", ") ?? "";
  const coverUrl = book?.coverUrl ?? null;
  const lastPositionMs = book?.lastPositionMs ?? null;
  const effectiveResumeMs = remoteResumeMs ?? lastPositionMs;

  const skip = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + seconds));
  }, [duration]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setMediaError(msg || "Playback failed");
      });
    } else {
      audio.pause();
    }
  }, []);

  const pushProgress = useCallback(
    (force: boolean) => {
      if (!session || !asin) return;
      const audio = audioRef.current;
      if (!audio) return;
      const positionMs = Math.max(0, Math.floor(audio.currentTime * 1000));
      if (!Number.isFinite(positionMs)) return;
      const now = Date.now();
      if (!force) {
        if (positionMs < 5000) return;
        if (Math.abs(positionMs - lastSyncedPositionMsRef.current) < 15000) return;
        if (now - lastSyncAtRef.current < 15000) return;
      } else if (positionMs < 1000) {
        return;
      }
      if (syncInFlightRef.current) return;
      syncInFlightRef.current = true;
      void syncListeningProgress(asin, positionMs)
        .then(() => {
          lastSyncedPositionMsRef.current = positionMs;
          lastSyncAtRef.current = Date.now();
          if (session) {
            upsertBookProgress(asin, positionMs, new Date().toISOString(), session);
          }
        })
        .catch(() => {
          // keep playback uninterrupted if sync fails transiently
        })
        .finally(() => {
          syncInFlightRef.current = false;
        });
    },
    [asin, session],
  );

  // Apply speed + preservesPitch when audio or speed changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = speed;
    // preservesPitch is the standard; webkitPreservesPitch for older Safari
    (audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    audio.preservesPitch = true;
    localStorage.setItem(SPEED_KEY, String(speed));
  }, [speed]);

  // Set MediaSession metadata for lock-screen controls
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: author,
      artwork: coverUrl ? [{ src: coverUrl, sizes: "500x500", type: "image/jpeg" }] : [],
    });
    navigator.mediaSession.setActionHandler("play", () => audioRef.current?.play());
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
    navigator.mediaSession.setActionHandler("seekbackward", () => skip(-30));
    navigator.mediaSession.setActionHandler("seekforward", () => skip(30));
    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("seekbackward", null);
      navigator.mediaSession.setActionHandler("seekforward", null);
    };
  }, [title, author, coverUrl, skip]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !displaySrc) return;

    const onTime = () => {
      setCurrentTime(audio.currentTime);
      if ("mediaSession" in navigator && duration > 0) {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate: speed,
          position: audio.currentTime,
        });
      }
      pushProgress(false);
    };
    const onLoaded = () => {
      const d = audio.duration;
      setDuration(Number.isFinite(d) && d > 0 ? d : 0);
      audio.playbackRate = speed;
      if (!resumeAppliedRef.current && effectiveResumeMs != null && effectiveResumeMs > 0) {
        audio.currentTime = Math.floor(effectiveResumeMs / 1000);
        setCurrentTime(audio.currentTime);
        resumeAppliedRef.current = true;
      }
      setMediaError(null);
    };
    const onPlay = () => {
      setPlaying(true);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    };
    const onPause = () => {
      setPlaying(false);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
      pushProgress(true);
    };
    const onEnded = () => {
      pushProgress(true);
    };
    const onError = () => {
      const err = audio.error;
      const code = err?.code;
      const map: Record<number, string> = {
        1: "Playback aborted",
        2: "Network error loading audio",
        3:
          "Decode error — this file may be an older download. Remove it from the library and download again (new copies use a browser-safe format).",
        4: "Format not supported",
      };
      const fallback = map[code ?? 0] ?? err?.message ?? "Could not load audio";
      if (code === 4 && remoteFileUrl) {
        // Code 4 can also happen when backend/file endpoint is unavailable, not only codec issues.
        void fetch(remoteFileUrl, { headers: { Range: "bytes=0-1" } })
          .then((resp) => {
            if (!resp.ok) {
              setMediaError(
                `Audio file endpoint unavailable (HTTP ${resp.status}). ` +
                  "If the server just restarted, refresh and try again.",
              );
              return;
            }
            const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
            if (!ct.includes("audio/")) {
              setMediaError(
                "Audio response was not a playable media type. " +
                  "Refresh and retry; if it persists, remove and re-download this title.",
              );
              return;
            }
            setMediaError(
              "Format not supported by this browser for this file. " +
                "Try removing and re-downloading the title.",
            );
          })
          .catch(() => {
            setMediaError(
              "Could not reach audio endpoint (server unavailable). " +
                "Refresh after the API server is up.",
            );
          });
      } else {
        setMediaError(fallback);
      }
      setPlaying(false);
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("durationchange", onLoaded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("durationchange", onLoaded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("ended", onEnded);
    };
  }, [speed, duration, displaySrc, remoteFileUrl, effectiveResumeMs, pushProgress]);

  useEffect(() => {
    resumeAppliedRef.current = false;
    lastSyncedPositionMsRef.current = 0;
    lastSyncAtRef.current = 0;
    setRemoteResumeMs(null);
  }, [asin, displaySrc]);

  useEffect(() => {
    let cancelled = false;
    if (!asin || !session) return;
    void getListeningProgress(asin)
      .then((progress) => {
        if (cancelled) return;
        if (progress.positionMs != null) {
          setRemoteResumeMs(progress.positionMs);
          upsertBookProgress(
            asin,
            progress.positionMs,
            progress.updatedAt ?? new Date().toISOString(),
            session,
          );
        }
      })
      .catch(() => {
        // keep player usable if cloud progress read fails
      });
    return () => {
      cancelled = true;
    };
  }, [asin, session]);

  useEffect(() => {
    let cancelled = false;
    if (!asin || !session) return;
    void getChapterInfo(asin)
      .then((info) => {
        if (!cancelled) setChapterInfo(info);
      })
      .catch(() => {
        if (!cancelled) setChapterInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [asin, session]);

  const chapterList = chapterInfo?.chapters ?? [];
  const currentMs = Math.floor(currentTime * 1000);
  const activeChapterIdx =
    chapterList.length === 0
      ? -1
      : chapterList.findIndex((ch, idx) => {
          const next = chapterList[idx + 1];
          const end = next ? next.startOffsetMs : Number.MAX_SAFE_INTEGER;
          return currentMs >= ch.startOffsetMs && currentMs < end;
        });

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) pushProgress(true);
    };
    const onBeforeUnload = () => pushProgress(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      pushProgress(true);
    };
  }, [pushProgress]);

  useEffect(() => {
    if (!chaptersModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChaptersModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chaptersModalOpen]);

  useEffect(() => {
    if (!chaptersModalOpen || activeChapterIdx < 0) return;
    const id = `player-chapter-${activeChapterIdx}`;
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }, [chaptersModalOpen, activeChapterIdx]);

  function changeSpeed(delta: number) {
    setSpeed((prev) => clampSpeed(quantizeSpeed(prev + delta)));
  }

  function onSeekbar(e: React.ChangeEvent<HTMLInputElement>) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Number(e.target.value);
  }

  if (!remoteFileUrl) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-950 text-white">
        <p className="text-gray-400">Book not downloaded yet.</p>
        <button onClick={() => navigate("/library")} className="text-sm text-orange-400 hover:text-orange-300">
          ← Back to library
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-950 text-white">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-6 pb-2">
        <button
          onClick={() => navigate("/library")}
          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{title}</p>
          {author && <p className="truncate text-xs text-gray-400">{author}</p>}
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
        {/* Cover */}
        <div className="flex h-56 w-56 items-center justify-center overflow-hidden rounded-2xl bg-gray-800 shadow-2xl">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={title}
              className="h-full w-full object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <BookOpen className="h-20 w-20 text-gray-600" />
          )}
        </div>

        {mediaError && (
          <p className="max-w-sm text-center text-sm text-red-400">{mediaError}</p>
        )}

        {/* Progress */}
        <div className="w-full max-w-sm space-y-1">
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={1}
            value={currentTime}
            onChange={onSeekbar}
            className="w-full cursor-pointer accent-orange-500"
          />
          <div className="flex justify-between text-xs text-gray-400">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Transport controls */}
        <div className="flex items-center gap-8">
          <button onClick={() => skip(-30)} className="flex flex-col items-center gap-0.5 text-gray-400 hover:text-white">
            <SkipBack className="h-7 w-7" />
            <span className="text-[10px]">30s</span>
          </button>
          <button
            onClick={togglePlay}
            className="flex h-16 w-16 items-center justify-center rounded-full bg-orange-500 shadow-lg hover:bg-orange-600 active:scale-95 transition-transform"
          >
            {playing
              ? <Pause className="h-8 w-8" />
              : <Play className="h-8 w-8 translate-x-0.5" />
            }
          </button>
          <button onClick={() => skip(30)} className="flex flex-col items-center gap-0.5 text-gray-400 hover:text-white">
            <SkipForward className="h-7 w-7" />
            <span className="text-[10px]">30s</span>
          </button>
        </div>

        {/* Speed control */}
        <div className="w-full max-w-sm space-y-2">
          <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => changeSpeed(-SPEED_STEP)}
            disabled={speed <= SPEED_MIN}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-gray-700 text-sm text-gray-400 hover:border-gray-500 hover:text-white disabled:opacity-30"
          >
            −
          </button>
          <div className="w-14 text-center">
            <span className="text-lg font-bold text-orange-400">{speed.toFixed(1)}×</span>
          </div>
          <button
            onClick={() => changeSpeed(SPEED_STEP)}
            disabled={speed >= SPEED_MAX}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-gray-700 text-sm text-gray-400 hover:border-gray-500 hover:text-white disabled:opacity-30"
          >
            +
          </button>
        </div>
          <input
            type="range"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={SPEED_STEP}
            value={speed}
            onChange={(e) => {
              setSpeed(clampSpeed(quantizeSpeed(Number(e.target.value))));
            }}
            className="w-full cursor-pointer accent-orange-500"
            aria-label="Playback speed"
          />
          <div className="flex justify-between text-[10px] text-gray-500">
            <span>{SPEED_MIN.toFixed(1)}×</span>
            <span>{SPEED_MAX.toFixed(1)}×</span>
          </div>
        </div>

        {chapterList.length > 0 && (
          <button
            type="button"
            onClick={() => setChaptersModalOpen(true)}
            className="flex w-full max-w-sm items-center justify-center gap-2 rounded-xl border border-gray-700 bg-gray-900/80 py-3 text-sm font-medium text-gray-200 transition-colors hover:border-gray-500 hover:bg-gray-800 hover:text-white"
          >
            <List className="h-4 w-4 text-orange-400" aria-hidden />
            Chapters
            <span className="ml-1 rounded-full bg-gray-800 px-2 py-0.5 text-[11px] font-normal text-gray-400">
              {chapterList.length}
            </span>
          </button>
        )}
      </div>

      {chaptersModalOpen && chapterList.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
          role="presentation"
        >
          <button
            type="button"
            aria-label="Close chapters"
            className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
            onClick={() => setChaptersModalOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="chapters-modal-title"
            className="relative flex max-h-[min(78dvh,560px)] w-full max-w-sm flex-col rounded-t-2xl border border-gray-800 bg-gray-900 shadow-2xl sm:max-h-[min(85vh,560px)] sm:rounded-2xl"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-gray-800 px-4 py-3">
              <h2 id="chapters-modal-title" className="text-base font-semibold text-white">
                Chapters
              </h2>
              <button
                type="button"
                onClick={() => setChaptersModalOpen(false)}
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <div className="space-y-1">
                {chapterList.map((ch, idx) => {
                  const isActive = idx === activeChapterIdx;
                  return (
                    <button
                      id={`player-chapter-${idx}`}
                      key={`${ch.startOffsetMs}-${idx}`}
                      type="button"
                      onClick={() => {
                        const audio = audioRef.current;
                        if (!audio) return;
                        audio.currentTime = Math.max(0, Math.floor(ch.startOffsetMs / 1000));
                        setChaptersModalOpen(false);
                      }}
                      className={`w-full rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                        isActive
                          ? "bg-orange-500/15 text-orange-200 ring-1 ring-orange-500/40"
                          : "text-gray-200 hover:bg-gray-800 hover:text-white"
                      }`}
                    >
                      <div className="truncate font-medium">{ch.title || `Chapter ${idx + 1}`}</div>
                      <div className="mt-0.5 text-xs text-gray-500">
                        {formatTime(Math.floor(ch.startOffsetMs / 1000))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Hidden audio element — key forces reload when job/url changes; playsInline helps iOS WebView */}
      <audio
        ref={audioRef}
        key={`${asin}:${displaySrc}`}
        src={displaySrc ?? undefined}
        preload="metadata"
        playsInline
      />
    </div>
  );
}
