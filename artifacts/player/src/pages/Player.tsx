import { useRef, useState, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { ArrowLeft, Play, Pause, SkipBack, SkipForward, BookOpen } from "lucide-react";
import { useDownloads } from "../hooks/useDownloads";
import { getBook } from "../lib/libraryCache";

// 17-step speed ladder matching the Expo player reference
const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10, 12, 14, 16];
const SPEED_KEY = "speed_player_speed";

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function loadSavedSpeed(): number {
  const saved = parseFloat(localStorage.getItem(SPEED_KEY) ?? "");
  return SPEED_STEPS.includes(saved) ? saved : 1;
}

export default function Player() {
  const params = useParams<{ asin: string }>();
  const [, navigate] = useLocation();
  const { byAsin } = useDownloads();
  const audioRef = useRef<HTMLAudioElement>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(loadSavedSpeed);
  const [speedIdx, setSpeedIdx] = useState(() => {
    const s = loadSavedSpeed();
    return SPEED_STEPS.indexOf(s) === -1 ? 2 : SPEED_STEPS.indexOf(s);
  });

  const asin = params.asin ?? "";
  const job = byAsin.get(asin);
  const book = getBook(asin);
  const fileUrl = job?.status === "done" ? `/api/audible/download/${job.id}/file` : null;
  const title = book?.title ?? job?.title ?? "Audiobook";
  const author = book?.authors.join(", ") ?? "";
  const coverUrl = book?.coverUrl ?? null;

  const skip = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + seconds));
  }, [duration]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }, []);

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
    if (!audio) return;
    const onTime = () => {
      setCurrentTime(audio.currentTime);
      if ("mediaSession" in navigator && duration > 0) {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate: speed,
          position: audio.currentTime,
        });
      }
    };
    const onLoaded = () => { setDuration(audio.duration); audio.playbackRate = speed; };
    const onPlay = () => {
      setPlaying(true);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    };
    const onPause = () => {
      setPlaying(false);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, [speed, duration]);

  function changeSpeed(delta: number) {
    const nextIdx = Math.max(0, Math.min(SPEED_STEPS.length - 1, speedIdx + delta));
    setSpeedIdx(nextIdx);
    setSpeed(SPEED_STEPS[nextIdx]);
  }

  function onSeekbar(e: React.ChangeEvent<HTMLInputElement>) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Number(e.target.value);
  }

  if (!fileUrl) {
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
        <div className="flex items-center gap-3">
          <button
            onClick={() => changeSpeed(-1)}
            disabled={speedIdx === 0}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-gray-700 text-sm text-gray-400 hover:border-gray-500 hover:text-white disabled:opacity-30"
          >
            −
          </button>
          <div className="w-14 text-center">
            <span className="text-lg font-bold text-orange-400">{speed}×</span>
          </div>
          <button
            onClick={() => changeSpeed(1)}
            disabled={speedIdx === SPEED_STEPS.length - 1}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-gray-700 text-sm text-gray-400 hover:border-gray-500 hover:text-white disabled:opacity-30"
          >
            +
          </button>
        </div>

        {/* Speed step dots */}
        <div className="flex gap-1">
          {SPEED_STEPS.map((s, i) => (
            <button
              key={s}
              onClick={() => { setSpeedIdx(i); setSpeed(s); }}
              className={`h-1.5 rounded-full transition-all ${
                i === speedIdx ? "w-4 bg-orange-500" : "w-1.5 bg-gray-700 hover:bg-gray-500"
              }`}
              title={`${s}×`}
            />
          ))}
        </div>
      </div>

      {/* Hidden audio element */}
      <audio ref={audioRef} src={fileUrl} preload="metadata" />
    </div>
  );
}
