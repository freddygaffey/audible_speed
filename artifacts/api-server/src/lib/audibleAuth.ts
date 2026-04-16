import crypto from "crypto";

// Marketplace configurations
export const MARKETPLACES: Record<string, { domain: string; region: string; clientId: string }> = {
  us: {
    domain: "www.amazon.com",
    region: "us-east-1",
    clientId: "MaoKgCUuCnP4AxMc5HQPsQgIkiT6hFBN",
  },
  uk: {
    domain: "www.amazon.co.uk",
    region: "eu-west-1",
    clientId: "MaoKgCUuCnP4AxMc5HQPsQgIkiT6hFBN",
  },
  de: {
    domain: "www.amazon.de",
    region: "eu-west-1",
    clientId: "MaoKgCUuCnP4AxMc5HQPsQgIkiT6hFBN",
  },
  fr: {
    domain: "www.amazon.fr",
    region: "eu-west-1",
    clientId: "MaoKgCUuCnP4AxMc5HQPsQgIkiT6hFBN",
  },
  ca: {
    domain: "www.amazon.ca",
    region: "us-east-1",
    clientId: "MaoKgCUuCnP4AxMc5HQPsQgIkiT6hFBN",
  },
  au: {
    domain: "www.amazon.com.au",
    region: "us-east-1",
    clientId: "MaoKgCUuCnP4AxMc5HQPsQgIkiT6hFBN",
  },
  jp: {
    domain: "www.amazon.co.jp",
    region: "us-west-2",
    clientId: "MaoKgCUuCnP4AxMc5HQPsQgIkiT6hFBN",
  },
  it: {
    domain: "www.amazon.it",
    region: "eu-west-1",
    clientId: "MaoKgCUuCnP4AxMc5HQPsQgIkiT6hFBN",
  },
  es: {
    domain: "www.amazon.es",
    region: "eu-west-1",
    clientId: "MaoKgCUuCnP4AxMc5HQPsQgIkiT6hFBN",
  },
};

export const AUDIBLE_API_DOMAINS: Record<string, string> = {
  us: "api.audible.com",
  uk: "api.audible.co.uk",
  de: "api.audible.de",
  fr: "api.audible.fr",
  ca: "api.audible.ca",
  au: "api.audible.com.au",
  jp: "api.audible.co.jp",
  it: "api.audible.it",
  es: "api.audible.es",
};

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  username: string;
  email: string;
  marketplace: string;
  activationBytes?: string;
}

// In-memory auth session (single user - personal use)
let currentSession: AuthSession | null = null;

export function getSession(): AuthSession | null {
  return currentSession;
}

export function setSession(session: AuthSession): void {
  currentSession = session;
}

export function clearSession(): void {
  currentSession = null;
}

// Generate PKCE code verifier and challenge
export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(48).toString("base64url").slice(0, 96);
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function buildOAuthUrl(marketplace: string, codeChallenge: string): string {
  const config = MARKETPLACES[marketplace] ?? MARKETPLACES.us;
  const params = new URLSearchParams({
    client_id: config.clientId,
    scope: "device_auth_access",
    response_type: "code",
    redirect_uri: `https://${config.domain}/ap/maplanding`,
    oa_entry_point: "exit",
    language: "en-US",
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
  });
  return `https://${config.domain}/ap/oa?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  marketplace: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const config = MARKETPLACES[marketplace] ?? MARKETPLACES.us;
  const body = new URLSearchParams({
    client_id: config.clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: `https://${config.domain}/ap/maplanding`,
  });

  const resp = await fetch("https://api.amazon.com/auth/O2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
  marketplace: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const config = MARKETPLACES[marketplace] ?? MARKETPLACES.us;
  const body = new URLSearchParams({
    client_id: config.clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const resp = await fetch("https://api.amazon.com/auth/O2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    throw new Error(`Token refresh failed: ${resp.status}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

export async function getAccountInfo(
  accessToken: string
): Promise<{ username: string; email: string }> {
  const resp = await fetch("https://api.amazon.com/user/profile", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0",
    },
  });

  if (!resp.ok) {
    // Fallback if profile API fails
    return { username: "Audible User", email: "" };
  }

  const data = (await resp.json()) as { name?: string; email?: string };
  return {
    username: data.name ?? "Audible User",
    email: data.email ?? "",
  };
}

export async function getValidAccessToken(): Promise<string | null> {
  const session = getSession();
  if (!session) return null;

  // Refresh if expired or expiring in 5 min
  if (session.expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    try {
      const { accessToken, expiresIn } = await refreshAccessToken(
        session.refreshToken,
        session.marketplace
      );
      session.accessToken = accessToken;
      session.expiresAt = new Date(Date.now() + expiresIn * 1000);
    } catch {
      return null;
    }
  }

  return session.accessToken;
}
