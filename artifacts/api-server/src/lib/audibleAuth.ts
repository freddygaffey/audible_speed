import crypto from "crypto";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Marketplace configs — used only for Audible API domain routing after auth
// ---------------------------------------------------------------------------

export const MARKETPLACES: Record<string, { domain: string; assocHandle: string; audibleDomain: string }> = {
  us: { domain: "www.amazon.com",    assocHandle: "amzn_audible_ios_us", audibleDomain: "api.audible.com"     },
  uk: { domain: "www.amazon.co.uk",  assocHandle: "amzn_audible_ios_uk", audibleDomain: "api.audible.co.uk"   },
  de: { domain: "www.amazon.de",     assocHandle: "amzn_audible_ios_de", audibleDomain: "api.audible.de"      },
  fr: { domain: "www.amazon.fr",     assocHandle: "amzn_audible_ios_fr", audibleDomain: "api.audible.fr"      },
  ca: { domain: "www.amazon.ca",     assocHandle: "amzn_audible_ios_ca", audibleDomain: "api.audible.ca"      },
  au: { domain: "www.amazon.com.au", assocHandle: "amzn_audible_ios_au", audibleDomain: "api.audible.com.au"  },
  jp: { domain: "www.amazon.co.jp",  assocHandle: "amzn_audible_ios_jp", audibleDomain: "api.audible.co.jp"   },
  it: { domain: "www.amazon.it",     assocHandle: "amzn_audible_ios_it", audibleDomain: "api.audible.it"      },
  es: { domain: "www.amazon.es",     assocHandle: "amzn_audible_ios_es", audibleDomain: "api.audible.es"      },
};

export const AUDIBLE_API_DOMAINS: Record<string, string> = Object.fromEntries(
  Object.entries(MARKETPLACES).map(([k, v]) => [k, v.audibleDomain])
);

const IOS_UA = "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0";

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
}

let currentSession: AuthSession | null = null;
export function getSession(): AuthSession | null { return currentSession; }
export function setSession(s: AuthSession): void  { currentSession = s; }
export function clearSession(): void              { currentSession = null; }

// ---------------------------------------------------------------------------
// Pending login state (for OTP / captcha continuation)
// ---------------------------------------------------------------------------

interface PendingLogin {
  marketplace: string;
  domain: string;
  cookies: string[];         // accumulated Set-Cookie values
  codeVerifier: string;
  returnTo: string;
  formAction: string;
  hiddenFields: Record<string, string>;
  createdAt: number;
}

const pendingLogins = new Map<string, PendingLogin>();

function makePendingId(): string {
  return crypto.randomBytes(16).toString("hex");
}

// Prune stale pending logins (older than 10 min)
function prune() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, p] of pendingLogins) {
    if (p.createdAt < cutoff) pendingLogins.delete(id);
  }
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(48).toString("base64url").slice(0, 96);
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

// ---------------------------------------------------------------------------
// Simple cookie jar helpers
// ---------------------------------------------------------------------------

function parseCookies(setCookieHeaders: string[]): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const header of setCookieHeaders) {
    const part = header.split(";")[0].trim();
    const eq = part.indexOf("=");
    if (eq > 0) jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return jar;
}

function cookieJarToHeader(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

function mergeCookies(existing: string[], newHeaders: string[]): string[] {
  const jar = parseCookies(existing);
  const updates = parseCookies(newHeaders);
  Object.assign(jar, updates);
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`);
}

// ---------------------------------------------------------------------------
// HTML form field extractor
// ---------------------------------------------------------------------------

function extractHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re = /<input[^>]+type=["']hidden["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const nameM = /name=["']([^"']+)["']/.exec(tag);
    const valueM = /value=["']([^"']*)["']/.exec(tag);
    if (nameM) fields[nameM[1]] = valueM ? valueM[1] : "";
  }
  return fields;
}

function extractFormAction(html: string, fallback: string): string {
  const m = /action=["']([^"']+)["']/.exec(html);
  return m ? (m[1].startsWith("http") ? m[1] : `https://www.amazon.com${m[1]}`) : fallback;
}

function extractInputByName(html: string, name: string): string {
  const re = new RegExp(`<input[^>]+name=["']${name}["'][^>]*>`, "i");
  const tag = re.exec(html)?.[0] ?? "";
  return /value=["']([^"']*)["']/.exec(tag)?.[1] ?? "";
}

// Detect what type of page Amazon returned
type PageType = "otp" | "captcha" | "maplanding" | "error" | "unknown";

function detectPage(html: string, url: string): PageType {
  if (url.includes("maplanding")) return "maplanding";
  if (html.includes("auth-mfa-otpcode") || html.includes("cvf-input-code") || html.includes("otpCode")) return "otp";
  if (html.includes("captcha") || html.includes("Captcha")) return "captcha";
  if (html.includes("ap_error") || html.includes("error-box")) return "error";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Step 1: Fetch the Amazon login page for the given marketplace
// ---------------------------------------------------------------------------

export async function fetchLoginPage(
  marketplace: string
): Promise<{ pendingId: string }> {
  prune();
  const cfg = MARKETPLACES[marketplace] ?? MARKETPLACES.us;
  const { codeVerifier, codeChallenge } = generatePKCE();
  const returnTo = `https://${cfg.domain}/ap/maplanding`;

  const params = new URLSearchParams({
    "openid.pape.preferred_auth_policies": "MultiFactor",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    "pageId": cfg.assocHandle,
    "openid.mode": "checkid_setup",
    "openid.ns.pape": "http://specs.openid.net/extensions/pape/1.0",
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.assoc_handle": cfg.assocHandle,
    "openid.return_to": returnTo,
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.pape.max_auth_age": "0",
    "openid.oa2.code_challenge_method": "S256",
    "openid.oa2.code_challenge": codeChallenge,
    "openid.oa2.response_type": "code",
  });

  const loginUrl = `https://${cfg.domain}/ap/signin?${params}`;

  const resp = await fetch(loginUrl, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": IOS_UA, "Accept-Language": "en-US,en;q=0.9" },
  });

  const setCookies = resp.headers.getSetCookie?.() ?? [];
  const html = await resp.text();

  const hiddenFields = extractHiddenFields(html);
  const formAction = extractFormAction(html, `https://${cfg.domain}/ap/signin`);

  const pendingId = makePendingId();
  pendingLogins.set(pendingId, {
    marketplace,
    domain: cfg.domain,
    cookies: setCookies,
    codeVerifier,
    returnTo,
    formAction,
    hiddenFields,
    createdAt: Date.now(),
  });

  return { pendingId };
}

// ---------------------------------------------------------------------------
// Step 2: Submit email + password
// ---------------------------------------------------------------------------

export type LoginResult =
  | { status: "success"; accessToken: string; refreshToken: string; expiresIn: number; username: string; email: string }
  | { status: "otp";     pendingId: string }
  | { status: "captcha"; message: string }
  | { status: "error";   message: string };

export async function submitCredentials(
  pendingId: string,
  email: string,
  password: string
): Promise<LoginResult> {
  const pending = pendingLogins.get(pendingId);
  if (!pending) return { status: "error", message: "Login session expired. Please try again." };

  const cookieJar = parseCookies(pending.cookies);
  const body = new URLSearchParams({
    ...pending.hiddenFields,
    email,
    password,
    appAction: "SIGNIN",
  });

  const resp = await fetch(pending.formAction, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": IOS_UA,
      "Cookie": cookieJarToHeader(cookieJar),
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": `https://${pending.domain}/ap/signin`,
    },
    body: body.toString(),
  });

  const newCookies = resp.headers.getSetCookie?.() ?? [];
  pending.cookies = mergeCookies(pending.cookies, newCookies);

  // Follow redirect manually so we can inspect the URL
  if (resp.status === 302 || resp.status === 301) {
    const location = resp.headers.get("location") ?? "";
    if (location.includes("maplanding")) {
      return handleMaplandingRedirect(location, pending);
    }
    // Follow the redirect
    return followRedirect(location, pending, pendingId);
  }

  const html = await resp.text();
  const pageType = detectPage(html, resp.url);

  logger.debug({ pageType, url: resp.url, status: resp.status, htmlSnippet: html.slice(0, 500) }, "submitCredentials page");

  if (pageType === "otp") {
    // Extract OTP form details
    const otpFields = extractHiddenFields(html);
    const otpAction = extractFormAction(html, `https://${pending.domain}/ap/cvf/verify`);
    pending.hiddenFields = otpFields;
    pending.formAction = otpAction;
    return { status: "otp", pendingId };
  }

  if (pageType === "captcha") {
    return { status: "captcha", message: "Amazon is showing a CAPTCHA. Please try again in a few minutes." };
  }

  if (pageType === "maplanding") {
    return handleMaplandingRedirect(resp.url, pending);
  }

  // Check for error messages in the page
  const errMatch = /<div[^>]+id="auth-error-message-box"[^>]*>.*?<p[^>]*>(.*?)<\/p>/s.exec(html);
  const errMsg = errMatch ? errMatch[1].replace(/<[^>]+>/g, "").trim() : "Login failed. Check your credentials.";
  return { status: "error", message: errMsg };
}

async function followRedirect(url: string, pending: PendingLogin, pendingId: string): Promise<LoginResult> {
  const fullUrl = url.startsWith("http") ? url : `https://${pending.domain}${url}`;

  if (fullUrl.includes("maplanding")) {
    return handleMaplandingRedirect(fullUrl, pending);
  }

  const cookieJar = parseCookies(pending.cookies);
  const resp = await fetch(fullUrl, {
    method: "GET",
    redirect: "manual",
    headers: {
      "User-Agent": IOS_UA,
      "Cookie": cookieJarToHeader(cookieJar),
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const newCookies = resp.headers.getSetCookie?.() ?? [];
  pending.cookies = mergeCookies(pending.cookies, newCookies);

  const location = resp.headers.get("location") ?? "";
  if (resp.status === 301 || resp.status === 302) {
    if (location.includes("maplanding")) return handleMaplandingRedirect(location, pending);
    return followRedirect(location, pending, pendingId);
  }

  const html = await resp.text();
  const pageType = detectPage(html, resp.url ?? fullUrl);

  if (pageType === "otp") {
    pending.hiddenFields = extractHiddenFields(html);
    pending.formAction = extractFormAction(html, `https://${pending.domain}/ap/cvf/verify`);
    return { status: "otp", pendingId };
  }

  if (pageType === "maplanding") {
    return handleMaplandingRedirect(resp.url ?? fullUrl, pending);
  }

  return { status: "error", message: "Unexpected response from Amazon." };
}

// ---------------------------------------------------------------------------
// Step 2b (optional): Submit OTP
// ---------------------------------------------------------------------------

export async function submitOtp(pendingId: string, otp: string): Promise<LoginResult> {
  const pending = pendingLogins.get(pendingId);
  if (!pending) return { status: "error", message: "Login session expired. Please try again." };

  const cookieJar = parseCookies(pending.cookies);
  const body = new URLSearchParams({
    ...pending.hiddenFields,
    "otpCode": otp,
    "cvf_captcha_input": otp,
    "code": otp,
    "rememberDevice": "",
  });

  const resp = await fetch(pending.formAction, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": IOS_UA,
      "Cookie": cookieJarToHeader(cookieJar),
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: body.toString(),
  });

  const newCookies = resp.headers.getSetCookie?.() ?? [];
  pending.cookies = mergeCookies(pending.cookies, newCookies);

  const location = resp.headers.get("location") ?? "";
  if ((resp.status === 301 || resp.status === 302) && location.includes("maplanding")) {
    return handleMaplandingRedirect(location, pending);
  }
  if (resp.status === 301 || resp.status === 302) {
    return followRedirect(location, pending, pendingId);
  }

  const html = await resp.text();
  if (detectPage(html, resp.url) === "maplanding") {
    return handleMaplandingRedirect(resp.url, pending);
  }

  return { status: "error", message: "OTP verification failed. Check the code and try again." };
}

// ---------------------------------------------------------------------------
// Extract code from maplanding URL and exchange for tokens
// ---------------------------------------------------------------------------

async function handleMaplandingRedirect(url: string, pending: PendingLogin): Promise<LoginResult> {
  // url may be relative or absolute
  const fullUrl = url.startsWith("http") ? url : `https://${pending.domain}${url}`;
  const parsed = new URL(fullUrl);

  const code = parsed.searchParams.get("openid.oa2.authorization_code");
  if (!code) {
    return { status: "error", message: `No auth code in redirect URL. URL: ${fullUrl.slice(0, 200)}` };
  }

  return exchangeCodeForTokens(code, pending.codeVerifier, pending.returnTo, pending.marketplace);
}

// ---------------------------------------------------------------------------
// Token exchange (called by handleMaplandingRedirect)
// ---------------------------------------------------------------------------

async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  marketplace: string
): Promise<LoginResult> {
  const cfg = MARKETPLACES[marketplace] ?? MARKETPLACES.us;

  const body = new URLSearchParams({
    "client_id": cfg.assocHandle,
    "code": code,
    "code_verifier": codeVerifier,
    "grant_type": "authorization_code",
    "redirect_uri": redirectUri,
  });

  const resp = await fetch("https://api.amazon.com/auth/O2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": IOS_UA },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { status: "error", message: `Token exchange failed: ${resp.status} ${text}` };
  }

  const data = (await resp.json()) as { access_token: string; refresh_token: string; expires_in: number };
  const info = await getAccountInfo(data.access_token);

  return {
    status: "success",
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    username: info.username,
    email: info.email,
  };
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

export async function refreshAccessToken(
  refreshToken: string,
  marketplace: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const cfg = MARKETPLACES[marketplace] ?? MARKETPLACES.us;
  const body = new URLSearchParams({
    client_id: cfg.assocHandle,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const resp = await fetch("https://api.amazon.com/auth/O2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": IOS_UA },
    body: body.toString(),
  });

  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

// ---------------------------------------------------------------------------
// Account info
// ---------------------------------------------------------------------------

export async function getAccountInfo(accessToken: string): Promise<{ username: string; email: string }> {
  const resp = await fetch("https://api.amazon.com/user/profile", {
    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": IOS_UA },
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
      const { accessToken, expiresIn } = await refreshAccessToken(session.refreshToken, session.marketplace);
      session.accessToken = accessToken;
      session.expiresAt = new Date(Date.now() + expiresIn * 1000);
    } catch { return null; }
  }
  return session.accessToken;
}
