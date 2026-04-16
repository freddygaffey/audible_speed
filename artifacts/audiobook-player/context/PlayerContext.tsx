import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

export interface Audiobook {
  id: string;
  title: string;
  author: string;
  narrator?: string;
  duration: number;
  coverColor: string;
  progress: number;
  addedAt: number;
  fileUri?: string;
  description?: string;
  chapter?: string;
  totalChapters?: number;
  currentChapter?: number;
}

interface PlayerState {
  isPlaying: boolean;
  position: number;
  duration: number;
  speed: number;
  isLoading: boolean;
}

interface PlayerContextValue {
  library: Audiobook[];
  currentBook: Audiobook | null;
  playerState: PlayerState;
  addBook: (book: Omit<Audiobook, "id" | "addedAt" | "progress">) => void;
  removeBook: (id: string) => void;
  updateProgress: (id: string, progress: number) => void;
  openBook: (book: Audiobook) => void;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  setSpeed: (speed: number) => void;
  skipForward: () => void;
  skipBack: () => void;
  closePlayer: () => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

const LIBRARY_KEY = "audiobook_library";
const COVER_COLORS = [
  "#2d4a7a",
  "#4a2d7a",
  "#7a2d4a",
  "#2d7a4a",
  "#7a4a2d",
  "#2d7a7a",
  "#4a7a2d",
  "#7a2d2d",
  "#2d4a7a",
  "#6a3d2d",
];

const DEMO_BOOKS: Audiobook[] = [
  {
    id: "demo1",
    title: "The Great Gatsby",
    author: "F. Scott Fitzgerald",
    narrator: "Jake Gyllenhaal",
    duration: 19200,
    coverColor: "#2d4a7a",
    progress: 0.35,
    addedAt: Date.now() - 86400000 * 3,
    description:
      "A story of the fabulously wealthy Jay Gatsby and his love for the beautiful Daisy Buchanan.",
    chapter: "Chapter 4: The Party",
    totalChapters: 9,
    currentChapter: 4,
  },
  {
    id: "demo2",
    title: "Dune",
    author: "Frank Herbert",
    narrator: "Simon Vance",
    duration: 78000,
    coverColor: "#7a4a2d",
    progress: 0.12,
    addedAt: Date.now() - 86400000 * 7,
    description:
      "A mythic and emotionally profound story set on the desert planet Arrakis.",
    chapter: "Book One: Dune",
    totalChapters: 48,
    currentChapter: 6,
  },
  {
    id: "demo3",
    title: "Sapiens",
    author: "Yuval Noah Harari",
    narrator: "Derek Perkins",
    duration: 57600,
    coverColor: "#2d7a4a",
    progress: 0.68,
    addedAt: Date.now() - 86400000 * 14,
    description:
      "A brief history of humankind from the Stone Age to the present.",
    chapter: "Part 3: The Unification",
    totalChapters: 20,
    currentChapter: 14,
  },
  {
    id: "demo4",
    title: "Atomic Habits",
    author: "James Clear",
    narrator: "James Clear",
    duration: 32400,
    coverColor: "#4a2d7a",
    progress: 0,
    addedAt: Date.now() - 86400000,
    description:
      "An easy and proven way to build good habits and break bad ones.",
    chapter: "Introduction",
    totalChapters: 21,
    currentChapter: 1,
  },
];

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [library, setLibrary] = useState<Audiobook[]>(DEMO_BOOKS);
  const [currentBook, setCurrentBook] = useState<Audiobook | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState>({
    isPlaying: false,
    position: 0,
    duration: 0,
    speed: 1,
    isLoading: false,
  });
  const positionInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadLibrary();
    return () => {
      cleanup();
    };
  }, []);

  const cleanup = useCallback(() => {
    if (positionInterval.current) {
      clearInterval(positionInterval.current);
      positionInterval.current = null;
    }
  }, []);

  const loadLibrary = async () => {
    try {
      const stored = await AsyncStorage.getItem(LIBRARY_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Audiobook[];
        if (parsed.length > 0) {
          setLibrary(parsed);
        }
      }
    } catch {}
  };

  const saveLibrary = async (books: Audiobook[]) => {
    try {
      await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(books));
    } catch {}
  };

  const addBook = useCallback(
    (book: Omit<Audiobook, "id" | "addedAt" | "progress">) => {
      const newBook: Audiobook = {
        ...book,
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        addedAt: Date.now(),
        progress: 0,
        coverColor:
          COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)],
      };
      setLibrary((prev) => {
        const updated = [newBook, ...prev];
        saveLibrary(updated);
        return updated;
      });
    },
    []
  );

  const removeBook = useCallback(
    (id: string) => {
      if (currentBook?.id === id) {
        closePlayer();
      }
      setLibrary((prev) => {
        const updated = prev.filter((b) => b.id !== id);
        saveLibrary(updated);
        return updated;
      });
    },
    [currentBook]
  );

  const updateProgress = useCallback((id: string, progress: number) => {
    setLibrary((prev) => {
      const updated = prev.map((b) =>
        b.id === id ? { ...b, progress } : b
      );
      saveLibrary(updated);
      return updated;
    });
  }, []);

  const openBook = useCallback(
    async (book: Audiobook) => {
      cleanup();
      setCurrentBook(book);
      setPlayerState((prev) => ({
        ...prev,
        isPlaying: false,
        position: book.progress * book.duration,
        duration: book.duration,
        isLoading: false,
      }));
    },
    [cleanup]
  );

  const play = useCallback(async () => {
    if (!currentBook) return;
    setPlayerState((prev) => ({ ...prev, isPlaying: true }));
    positionInterval.current = setInterval(() => {
      setPlayerState((prev) => {
        const newPos = Math.min(prev.position + prev.speed, prev.duration);
        if (currentBook && prev.duration > 0) {
          const progress = newPos / prev.duration;
          updateProgress(currentBook.id, progress);
        }
        return { ...prev, position: newPos };
      });
    }, 1000);
  }, [currentBook, updateProgress]);

  const pause = useCallback(() => {
    setPlayerState((prev) => ({ ...prev, isPlaying: false }));
    if (positionInterval.current) {
      clearInterval(positionInterval.current);
      positionInterval.current = null;
    }
  }, []);

  const seek = useCallback(
    (seconds: number) => {
      setPlayerState((prev) => {
        const newPos = Math.max(0, Math.min(prev.position + seconds, prev.duration));
        if (currentBook && prev.duration > 0) {
          updateProgress(currentBook.id, newPos / prev.duration);
        }
        return { ...prev, position: newPos };
      });
    },
    [currentBook, updateProgress]
  );

  const setSpeed = useCallback((speed: number) => {
    setPlayerState((prev) => ({ ...prev, speed }));
  }, []);

  const skipForward = useCallback(() => seek(30), [seek]);
  const skipBack = useCallback(() => seek(-15), [seek]);

  const closePlayer = useCallback(() => {
    pause();
    setCurrentBook(null);
  }, [pause]);

  return (
    <PlayerContext.Provider
      value={{
        library,
        currentBook,
        playerState,
        addBook,
        removeBook,
        updateProgress,
        openBook,
        play,
        pause,
        seek,
        setSpeed,
        skipForward,
        skipBack,
        closePlayer,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used inside PlayerProvider");
  return ctx;
}
