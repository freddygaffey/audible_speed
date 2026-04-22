import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const STORAGE_KEY = "speed_mobile_layout_preview";

type MobilePreviewContextValue = {
  mobilePreview: boolean;
  setMobilePreview: (value: boolean) => void;
  toggleMobilePreview: () => void;
};

const MobilePreviewContext = createContext<MobilePreviewContextValue | null>(null);

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeStored(value: boolean): void {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

export function MobilePreviewProvider({ children }: { children: ReactNode }) {
  const [mobilePreview, setMobilePreviewState] = useState(readStored);

  const setMobilePreview = useCallback((value: boolean) => {
    setMobilePreviewState(value);
    writeStored(value);
  }, []);

  const toggleMobilePreview = useCallback(() => {
    setMobilePreviewState((prev) => {
      const next = !prev;
      writeStored(next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ mobilePreview, setMobilePreview, toggleMobilePreview }),
    [mobilePreview, setMobilePreview],
  );

  return (
    <MobilePreviewContext.Provider value={value}>{children}</MobilePreviewContext.Provider>
  );
}

export function useMobilePreview(): MobilePreviewContextValue {
  const ctx = useContext(MobilePreviewContext);
  if (!ctx) {
    throw new Error("useMobilePreview must be used within MobilePreviewProvider");
  }
  return ctx;
}
