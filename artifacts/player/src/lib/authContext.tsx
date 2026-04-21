import { createContext, useCallback, useContext, useEffect, useReducer, type ReactNode } from "react";
import { z } from "zod";
import { getAuthStatus, logout, setActivationBytes } from "./apiClient";
import { loadActivationBytes } from "./activationBytes";
import { clearLibrary } from "./libraryCache";

const StoredSessionSchema = z.object({
  username: z.string(),
  email: z.string(),
  marketplace: z.string(),
});
type StoredSession = z.infer<typeof StoredSessionSchema>;

interface AuthState {
  status: "loading" | "authenticated" | "unauthenticated";
  session: StoredSession | null;
}

type AuthAction =
  | { type: "SET_SESSION"; session: StoredSession }
  | { type: "CLEAR" }
  | { type: "READY" };

const STORAGE_KEY = "speed_auth_session";

function loadStored(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return StoredSessionSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function reducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case "SET_SESSION":
      localStorage.setItem(STORAGE_KEY, JSON.stringify(action.session));
      return { status: "authenticated", session: action.session };
    case "CLEAR":
      localStorage.removeItem(STORAGE_KEY);
      return { status: "unauthenticated", session: null };
    case "READY":
      return state.status === "loading"
        ? { status: "unauthenticated", session: null }
        : state;
  }
}

interface AuthContextValue extends AuthState {
  setSession: (s: StoredSession) => void;
  refreshFromServer: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const initialState: AuthState = { status: "loading", session: loadStored() };
  const [state, dispatch] = useReducer(reducer, initialState);

  const refreshFromServer = useCallback(async () => {
    try {
      const s = await getAuthStatus();
      if (s.authenticated && s.username && s.marketplace) {
        const prev = loadStored();
        const next = { username: s.username, email: s.email ?? "", marketplace: s.marketplace };
        if (
          prev &&
          (prev.username !== next.username || prev.marketplace !== next.marketplace)
        ) {
          clearLibrary();
        }
        dispatch({
          type: "SET_SESSION",
          session: next,
        });
        const stored = loadActivationBytes();
        if (stored) setActivationBytes(stored).catch(() => {});
      } else {
        dispatch({ type: "CLEAR" });
      }
    } catch {
      const cached = loadStored();
      if (cached) {
        dispatch({ type: "SET_SESSION", session: cached });
      } else {
        dispatch({ type: "CLEAR" });
      }
    }
  }, []);

  useEffect(() => {
    void refreshFromServer();
  }, [refreshFromServer]);

  const setSession = (session: StoredSession) => dispatch({ type: "SET_SESSION", session });

  const signOut = async () => {
    await logout().catch(() => {});
    clearLibrary();
    dispatch({ type: "CLEAR" });
  };

  const value: AuthContextValue = {
    status: state.status,
    session: state.session,
    setSession,
    refreshFromServer,
    signOut,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
