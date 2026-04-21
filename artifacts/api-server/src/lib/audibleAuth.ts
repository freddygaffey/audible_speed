import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { pyCompleteLogin, pyInitLogin } from "./pythonBridge.js";

/** `artifacts/api-server` — stable when bundled as `dist/index.mjs` (do not use `process.cwd()`). */
function apiServerRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(here) === "dist"
    ? path.resolve(here, "..")
    : path.resolve(here, "..", "..");
}

// ---------------------------------------------------------------------------
// Marketplace configs
// ---------------------------------------------------------------------------

export const MARKETPLACES: Record<
  string,
  {
    domain: string;
    topDomain: string;
    audibleDomain: string;
    marketPlaceId: string;
    language: string;
  }
> = {
  us: {
    domain: "www.amazon.com",
    topDomain: "com",
    audibleDomain: "api.audible.com",
    marketPlaceId: "AF2M0KC94RCEA",
    language: "en-US",
  },
  uk: {
    domain: "www.amazon.co.uk",
    topDomain: "co.uk",
    audibleDomain: "api.audible.co.uk",
    marketPlaceId: "A2I9A3Q2GNFNGQ",
    language: "en-GB",
  },
  de: {
    domain: "www.amazon.de",
    topDomain: "de",
    audibleDomain: "api.audible.de",
    marketPlaceId: "AN7V1F1VY261K",
    language: "de-DE",
  },
  fr: {
    domain: "www.amazon.fr",
    topDomain: "fr",
    audibleDomain: "api.audible.fr",
    marketPlaceId: "A2728XDNODOQ8T",
    language: "fr-FR",
  },
  ca: {
    domain: "www.amazon.ca",
    topDomain: "ca",
    audibleDomain: "api.audible.ca",
    marketPlaceId: "A2CQZ5RBY40XE",
    language: "en-CA",
  },
  au: {
    domain: "www.amazon.com.au",
    topDomain: "com.au",
    audibleDomain: "api.audible.com.au",
    marketPlaceId: "AN7EY7DTAW63G",
    language: "en-AU",
  },
  jp: {
    domain: "www.amazon.co.jp",
    topDomain: "co.jp",
    audibleDomain: "api.audible.co.jp",
    marketPlaceId: "A1QAP3MOU4173J",
    language: "ja-JP",
  },
  it: {
    domain: "www.amazon.it",
    topDomain: "it",
    audibleDomain: "api.audible.it",
    marketPlaceId: "A2N7FU2W2BU2ZC",
    language: "it-IT",
  },
  es: {
    domain: "www.amazon.es",
    topDomain: "es",
    audibleDomain: "api.audible.es",
    marketPlaceId: "ALMIKO4SZCSAR",
    language: "es-ES",
  },
};

export const AUDIBLE_API_DOMAINS: Record<string, string> = Object.fromEntries(
  Object.entries(MARKETPLACES).map(([k, v]) => [k, v.audibleDomain]),
);

// ---------------------------------------------------------------------------
// Auth session
// ---------------------------------------------------------------------------

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  username: string;
  email: string;
  marketplace: string;
  activationBytes?: string;
  /** MAC DMS — required for Audible 1.0 API signing (e.g. licenserequest). */
  adpToken?: string;
  devicePrivateKey?: string;
}

const SESSION_FILE = path.join(apiServerRoot(), ".audible-session.json");
const LEGACY_SESSION_FILE = path.resolve(process.cwd(), ".audible-session.json");

function isAuthSession(v: unknown): v is AuthSession {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.accessToken === "string" &&
    typeof o.refreshToken === "string" &&
    typeof o.expiresAt === "string" &&
    typeof o.username === "string" &&
    typeof o.email === "string" &&
    typeof o.marketplace === "string" &&
    (o.activationBytes === undefined || typeof o.activationBytes === "string") &&
    (o.adpToken === undefined || typeof o.adpToken === "string") &&
    (o.devicePrivateKey === undefined || typeof o.devicePrivateKey === "string")
  );
}

function parseSessionFile(raw: string, file: string): AuthSession | null {
  const parsed = JSON.parse(raw) as unknown;
  if (!isAuthSession(parsed)) {
    logger.warn({ sessionFile: file }, "Audible session file invalid");
    return null;
  }
  return { ...parsed, expiresAt: new Date(parsed.expiresAt) };
}

function loadSession(): AuthSession | null {
  const candidates = [SESSION_FILE, LEGACY_SESSION_FILE].filter(
    (p, i, a) => a.indexOf(p) === i,
  );
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const session = parseSessionFile(raw, file);
      if (!session) continue;
      if (file !== SESSION_FILE) {
        saveSession(session);
        try {
          fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
        logger.info({ from: file, to: SESSION_FILE }, "Migrated Audible session to api-server dir");
      }
      logger.info(
        { sessionFile: SESSION_FILE, email: session.email, marketplace: session.marketplace },
        "Restored Audible session",
      );
      return session;
    } catch {
      /* try next */
    }
  }
  logger.info({ sessionFile: SESSION_FILE, cwd: process.cwd() }, "No persisted Audible session found");
  return null;
}

function saveSession(session: AuthSession | null): void {
  try {
    if (!session) {
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
      return;
    }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session), "utf8");
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "Failed to persist Audible session");
  }
}

let currentSession: AuthSession | null = loadSession();
export function getSession(): AuthSession | null {
  return currentSession;
}
export function setSession(s: AuthSession): void {
  currentSession = s;
  saveSession(currentSession);
  logger.info({ sessionFile: SESSION_FILE, email: s.email, marketplace: s.marketplace }, "Saved Audible session");
}
export function clearSession(): void {
  currentSession = null;
  saveSession(null);
  logger.info({ sessionFile: SESSION_FILE }, "Cleared Audible session");
}

/** Persist the current in-memory session (e.g. after mutating activationBytes). */
export function flushSession(): void {
  if (currentSession) saveSession(currentSession);
}

// ---------------------------------------------------------------------------
// Pending login state
// ---------------------------------------------------------------------------

interface PendingLogin {
  marketplace: string;
  pythonState: string;
  createdAt: number;
}

const PENDING_FILE = path.join(apiServerRoot(), ".pending-sessions.json");
const LEGACY_PENDING_FILE = path.resolve(process.cwd(), ".pending-sessions.json");

function isPendingLogin(v: unknown): v is PendingLogin {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.marketplace === "string" &&
    typeof o.pythonState === "string" &&
    typeof o.createdAt === "number"
  );
}

function readPendingMapFromFile(file: string): Map<string, PendingLogin> {
  const raw = fs.readFileSync(file, "utf8");
  const obj = JSON.parse(raw) as Record<string, unknown>;
  const map = new Map<string, PendingLogin>();
  for (const [id, entry] of Object.entries(obj)) {
    if (isPendingLogin(entry)) map.set(id, entry);
  }
  return map;
}

function loadPendingLogins(): Map<string, PendingLogin> {
  const candidates = [PENDING_FILE, LEGACY_PENDING_FILE].filter((p, i, a) => a.indexOf(p) === i);
  for (const file of candidates) {
    try {
      const map = readPendingMapFromFile(file);
      if (map.size === 0) continue;
      if (file !== PENDING_FILE) {
        savePendingLogins(map);
        try {
          fs.unlinkSync(file);
        } catch {
          /* ignore */
        }
        logger.info({ from: file, to: PENDING_FILE }, "Migrated pending Audible logins to api-server dir");
      }
      return map;
    } catch {
      /* try next */
    }
  }
  return new Map();
}

function savePendingLogins(map: Map<string, PendingLogin>): void {
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(Object.fromEntries(map)), "utf8");
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "Failed to persist pending sessions");
  }
}

const pendingLogins = loadPendingLogins();

function makePendingId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function prune() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, p] of pendingLogins) {
    if (p.createdAt < cutoff) pendingLogins.delete(id);
  }
  savePendingLogins(pendingLogins);
}

// ---------------------------------------------------------------------------
// Login flow (Python audible package)
// ---------------------------------------------------------------------------

export async function initLogin(
  marketplace: string,
): Promise<{ pendingId: string; loginUrl: string }> {
  prune();
  const mkt = MARKETPLACES[marketplace] ? marketplace : "us";
  if (mkt !== marketplace) {
    logger.warn({ marketplace, fallback: mkt }, "initLogin: unknown marketplace key");
  }
  const { loginUrl, pythonState } = await pyInitLogin(mkt);
  const pendingId = makePendingId();
  pendingLogins.set(pendingId, { marketplace: mkt, pythonState, createdAt: Date.now() });
  savePendingLogins(pendingLogins);
  logger.debug({ marketplace: mkt, pendingId }, "initLogin: Python bridge");
  return { pendingId, loginUrl };
}

export type LoginResult =
  | {
      status: "success";
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      username: string;
      email: string;
      marketplace: string;
      adpToken: string;
      devicePrivateKey: string;
    }
  | { status: "otp"; pendingId: string }
  | { status: "captcha"; message: string }
  | { status: "error"; message: string };

export async function completeFromUrl(
  pendingId: string,
  maplandingUrl: string,
): Promise<LoginResult> {
  const pending = pendingLogins.get(pendingId);
  if (!pending)
    return { status: "error", message: "Login session expired. Please try again." };
  pendingLogins.delete(pendingId);
  savePendingLogins(pendingLogins);
  try {
    const {
      accessToken,
      refreshToken,
      expiresIn,
      username,
      email,
      adpToken,
      devicePrivateKey,
    } = await pyCompleteLogin(pending.pythonState, maplandingUrl);
    return {
      status: "success",
      accessToken,
      refreshToken,
      expiresIn,
      username,
      email,
      marketplace: pending.marketplace,
      adpToken,
      devicePrivateKey,
    };
  } catch (err: unknown) {
    return { status: "error", message: (err as Error).message };
  }
}

export async function submitOtp(_pendingId: string, _otp: string): Promise<LoginResult> {
  return { status: "error", message: "OTP not yet supported in Python bridge" };
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

const APP_UA =
  "com.audible.playersdk.player/3.96.1 (Linux;Android 14) AndroidXMedia3/1.3.0";

export async function refreshAccessToken(
  refreshToken: string,
  marketplace: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const cfg = MARKETPLACES[marketplace] ?? MARKETPLACES.us;
  // Match mkb79/audible `refresh_access_token` (NOT LWA /auth/O2/token).
  const body = new URLSearchParams({
    app_name: "Audible",
    app_version: "3.56.2",
    source_token: refreshToken,
    requested_token_type: "access_token",
    source_token_type: "refresh_token",
  });

  const resp = await fetch(`https://api.amazon.${cfg.topDomain}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": APP_UA },
    body: body.toString(),
  });

  if (!resp.ok) {
    const snippet = (await resp.text()).slice(0, 240);
    throw new Error(`Token refresh failed: ${resp.status}${snippet ? ` — ${snippet}` : ""}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number | string };
  const expiresIn =
    typeof data.expires_in === "string" ? parseInt(data.expires_in, 10) : data.expires_in;
  return { accessToken: data.access_token, expiresIn };
}

// ---------------------------------------------------------------------------
// Account info
// ---------------------------------------------------------------------------

export async function getAccountInfo(
  accessToken: string,
  marketplace = "us",
): Promise<{ username: string; email: string }> {
  const cfg = MARKETPLACES[marketplace] ?? MARKETPLACES.us;
  const resp = await fetch(`https://api.amazon.${cfg.topDomain}/user/profile`, {
    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": APP_UA },
  });
  if (!resp.ok) return { username: "Audible User", email: "" };
  const data = (await resp.json()) as { name?: string; email?: string };
  return { username: data.name ?? "Audible User", email: data.email ?? "" };
}

// ---------------------------------------------------------------------------
// Get valid access token (with auto-refresh)
// ---------------------------------------------------------------------------

export async function getValidAccessToken(): Promise<string | null> {
  const session = getSession();
  if (!session) return null;
  if (session.expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    try {
      const { accessToken, expiresIn } = await refreshAccessToken(
        session.refreshToken,
        session.marketplace,
      );
      session.accessToken = accessToken;
      session.expiresAt = new Date(Date.now() + expiresIn * 1000);
      saveSession(session);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, marketplace: session.marketplace },
        "Audible token refresh failed; clearing session",
      );
      clearSession();
      return null;
    }
  }
  return session.accessToken;
}
