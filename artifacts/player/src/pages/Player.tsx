import { useRef, useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { ArrowLeft, Play, Pause, SkipBack, SkipForward } from "lucide-react";
import { useDownloads } from "../hooks/useDownloads";

function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function Player() {
  const params = useParams<{ asin: string }>();
  const [, navigate] = useLocation();
  const { byAsin } = useDownloads();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const job = byAsin.get(params.asin ?? "");
  const fileUrl = job?.status === "done" ? `/api/audible/download/${job.id}/file` : null;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentTime(audio.currentTime);
    const onLoaded = () => setDuration(audio.duration);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
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
  }, []);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }

  function seek(seconds: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + seconds));
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
      <div className="flex items-center gap-3 px-4 pt-6">
        <button
          onClick={() => navigate("/library")}
          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-800 hover:text-white"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="truncate text-base font-medium">{job?.title ?? "Audiobook"}</h1>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-8">
        <div className="flex h-48 w-48 items-center justify-center rounded-2xl bg-gray-800">
          <span className="text-6xl">🎧</span>
        </div>

        <div className="w-full max-w-sm space-y-4">
          <div className="space-y-2">
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={1}
              value={currentTime}
              onChange={onSeekbar}
              className="w-full accent-orange-500"
            />
            <div className="flex justify-between text-xs text-gray-400">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          <div className="flex items-center justify-center gap-6">
            <button onClick={() => seek(-30)} className="text-gray-400 hover:text-white">
              <SkipBack className="h-7 w-7" />
            </button>
            <button
              onClick={togglePlay}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-orange-500 hover:bg-orange-600"
            >
              {playing ? <Pause className="h-7 w-7" /> : <Play className="h-7 w-7 translate-x-0.5" />}
            </button>
            <button onClick={() => seek(30)} className="text-gray-400 hover:text-white">
              <SkipForward className="h-7 w-7" />
            </button>
          </div>
        </div>
      </div>

      {/* Hidden audio element */}
      <audio ref={audioRef} src={fileUrl} preload="metadata" />
    </div>
  );
}
