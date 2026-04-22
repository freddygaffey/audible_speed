import { AUDIBLE_API_DOMAINS, getSession } from "./audibleAuth.js";
import { adpSignHeaders } from "./audibleAdpSign.js";
import { fetchWithRetry } from "./fetchWithRetry.js";
import { logger } from "./logger.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_UA = "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0";
const DEFAULT_CDM_URLS_LIST =
  "https://raw.githubusercontent.com/rmcrackan/Libation/refs/heads/master/.cdmurls.json";

export interface WidevineKeyRecord {
  kid?: string;
  keyHex: string;
  ivHex?: string;
}

export interface WidevineMpdMetadata {
  manifestUrl: string;
  psshBase64?: string;
  defaultKid?: string;
  contentUrl?: string;
}

export interface WidevineResolution {
  contentUrl: string;
  keyHex: string;
  ivHex?: string;
  kid?: string;
  candidateKeys: WidevineKeyRecord[];
  provider: "bridge";
  mpd: WidevineMpdMetadata;
  cookieHeader?: string;
}

interface CdmUrlListResponse {
  CdmUrls?: string[];
  cdmUrls?: string[];
}

interface ResolveWidevineParams {
  asin: string;
  marketplace: string;
  licenseResponseUrl: string;
  fallbackContentUrl?: string;
}

interface PythonWidevineResult {
  keys?: Array<{ kid?: string; keyHex?: string; ivHex?: string }>;
  cookieHeader?: string;
  error?: string;
}

function normalizeHex(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return s.toLowerCase();
  try {
    const b = Buffer.from(s, "base64");
    if (b.length > 0) return b.toString("hex");
  } catch {
    /* ignore */
  }
  return undefined;
}

function normalizeKid(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().replace(/[{}-]/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(s)) return s;
  return undefined;
}

function extractMpdMetadata(xml: string, manifestUrl: string): WidevineMpdMetadata {
  const pssh = xml.match(/<cenc:pssh[^>]*>\s*([^<\s][^<]*)\s*<\/cenc:pssh>/i)?.[1]?.trim();
  const kidRaw =
    xml.match(/(?:cenc:)?default_KID="([^"]+)"/i)?.[1] ??
    xml.match(/(?:cenc:)?default_KID='([^']+)'/i)?.[1];
  const kid = normalizeKid(kidRaw);
  const baseUrlRaw = xml.match(/<BaseURL[^>]*>\s*([^<\s][^<]*)\s*<\/BaseURL>/i)?.[1]?.trim();
  let contentUrl: string | undefined;
  if (baseUrlRaw) {
    try {
      contentUrl = new URL(baseUrlRaw, manifestUrl).toString();
    } catch {
      contentUrl = undefined;
    }
  }
  return {
    manifestUrl,
    psshBase64: pssh,
    defaultKid: kid,
    contentUrl,
  };
}

function pickKey(records: WidevineKeyRecord[], mpd: WidevineMpdMetadata): WidevineKeyRecord | undefined {
  if (records.length === 0) return undefined;
  if (mpd.defaultKid) {
    const exact = records.find((k) => normalizeKid(k.kid) === mpd.defaultKid);
    if (exact) return exact;
  }
  return records.find((k) => k.keyHex.length >= 32) ?? records[0];
}

function parseBridgeKeys(input: unknown): WidevineKeyRecord[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;

  const singleKey = normalizeHex(obj.keyHex ?? obj.key ?? obj.decryption_key);
  const singleIv = normalizeHex(obj.ivHex ?? obj.iv ?? obj.decryption_iv);
  const singleKid = normalizeKid(obj.kid ?? obj.keyId ?? obj.defaultKid);
  const out: WidevineKeyRecord[] = [];
  if (singleKey) out.push({ keyHex: singleKey, ivHex: singleIv, kid: singleKid });

  const arr = Array.isArray(obj.keys) ? obj.keys : [];
  for (const k of arr) {
    if (!k || typeof k !== "object") continue;
    const entry = k as Record<string, unknown>;
    const keyHex = normalizeHex(entry.keyHex ?? entry.key ?? entry.decryption_key);
    if (!keyHex) continue;
    out.push({
      keyHex,
      ivHex: normalizeHex(entry.ivHex ?? entry.iv ?? entry.decryption_iv),
      kid: normalizeKid(entry.kid ?? entry.keyId),
    });
  }

  return out;
}

function requireWidevineBridgeUrl(): string {
  const v = process.env.AUDIBLE_WIDEVINE_KEYSERVICE_URL?.trim();
  if (v) return v;
  throw new Error(
    "Widevine/CDM decode required but AUDIBLE_WIDEVINE_KEYSERVICE_URL is not configured. " +
      "Configure a CDM bridge service that returns decryption keys.",
  );
}

async function getCdmUrisHint(): Promise<string[]> {
  const env = process.env.AUDIBLE_WIDEVINE_CDM_URLS?.trim();
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  const listUrl = process.env.AUDIBLE_WIDEVINE_CDM_URLS_JSON?.trim() || DEFAULT_CDM_URLS_LIST;
  try {
    const resp = await fetchWithRetry(listUrl, { method: "GET" }, { label: "CDM URI list", attempts: 2 });
    if (!resp.ok) return [];
    const parsed = (await resp.json()) as CdmUrlListResponse;
    const urls = parsed.CdmUrls ?? parsed.cdmUrls ?? [];
    return urls.filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch {
    return [];
  }
}

function resolveWidevinePythonScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "../scripts/widevine_resolve.py"),
    path.join(here, "../../scripts/widevine_resolve.py"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return path.resolve(p);
  }
  throw new Error(`widevine_resolve.py not found; tried: ${candidates.join(", ")}`);
}

async function runPythonWidevineResolve(input: {
  asin: string;
  marketplace: string;
  accessToken: string;
  adpToken: string;
  devicePrivateKey: string;
  psshBase64: string;
  cdmBlobBase64: string;
}): Promise<{ keys: WidevineKeyRecord[]; cookieHeader?: string }> {
  const script = resolveWidevinePythonScript();
  return await new Promise<{ keys: WidevineKeyRecord[]; cookieHeader?: string }>((resolve, reject) => {
    const proc = spawn("python3", [script], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => (stdout += d));
    proc.stderr.on("data", (d: string) => (stderr += d));
    proc.stdin.write(JSON.stringify(input), "utf8");
    proc.stdin.end();
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `widevine_resolve.py exited ${code}: ${stderr.trim() || stdout.trim() || "unknown error"}`,
          ),
        );
        return;
      }
      let parsed: PythonWidevineResult;
      try {
        parsed = JSON.parse(stdout) as PythonWidevineResult;
      } catch {
        reject(new Error(`Invalid JSON from widevine_resolve.py: ${stdout.slice(0, 300)}`));
        return;
      }
      if (parsed.error) {
        reject(new Error(parsed.error));
        return;
      }
      const records = parseBridgeKeys({ keys: parsed.keys ?? [] });
      if (records.length === 0) {
        reject(new Error("widevine_resolve.py returned no usable keys"));
        return;
      }
      resolve({ keys: records, cookieHeader: parsed.cookieHeader });
    });
    proc.on("error", (err) => reject(new Error(`Failed to spawn python3: ${err.message}`)));
  });
}

function buildSignedAccountInfoRequest(marketplace: string): { Url: string; Headers: Record<string, string> } {
  const session = getSession();
  if (!session?.adpToken || !session.devicePrivateKey || !session.accessToken) {
    throw new Error(
      "Missing ADP signing material in session (adpToken/devicePrivateKey/accessToken). " +
        "Re-authenticate Audible to use Widevine CDM decode.",
    );
  }
  const domain = AUDIBLE_API_DOMAINS[marketplace] ?? AUDIBLE_API_DOMAINS.us;
  const pathWithQuery = "/1.0/account/information";
  const headers = {
    Accept: "application/json",
    "Accept-Charset": "utf-8",
    "User-Agent": API_UA,
    Authorization: `Bearer ${session.accessToken}`,
    "client-id": "0",
    ...adpSignHeaders({
      method: "GET",
      pathWithQuery,
      bodyUtf8: "",
      adpToken: session.adpToken,
      privateKeyPem: session.devicePrivateKey,
    }),
  };
  return {
    Url: `https://${domain}${pathWithQuery}`,
    Headers: headers,
  };
}

export async function resolveWidevineDecryption(params: ResolveWidevineParams): Promise<WidevineResolution> {
  const mpdResp = await fetchWithRetry(
    params.licenseResponseUrl,
    { method: "GET" },
    { label: "Widevine MPD fetch", attempts: 3 },
  );
  if (!mpdResp.ok) {
    const txt = (await mpdResp.text()).slice(0, 400);
    throw new Error(`Failed to fetch Widevine MPD: HTTP ${mpdResp.status} ${txt}`);
  }
  const mpdXml = await mpdResp.text();
  const mpd = extractMpdMetadata(mpdXml, params.licenseResponseUrl);

  const bridgeUrl = requireWidevineBridgeUrl();
  const cdmUris = await getCdmUrisHint();
  const accountInfoRequest = buildSignedAccountInfoRequest(params.marketplace);
  const bridgePayload = {
    // The hosted AudibleCdm endpoint expects top-level Url/Headers fields.
    ...accountInfoRequest,
    asin: params.asin,
    marketplace: params.marketplace,
    licenseResponseUrl: params.licenseResponseUrl,
    psshBase64: mpd.psshBase64,
    defaultKid: mpd.defaultKid,
    fallbackContentUrl: params.fallbackContentUrl,
    cdmUris,
  };
  const bridgeResp = await fetchWithRetry(
    bridgeUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bridgePayload),
    },
    { label: "Widevine CDM bridge", attempts: 2 },
  );
  if (!bridgeResp.ok) {
    const txt = (await bridgeResp.text()).slice(0, 800);
    throw new Error(`Widevine key service failed: HTTP ${bridgeResp.status} ${txt}`);
  }
  const bridgeBody = Buffer.from(await bridgeResp.arrayBuffer());
  let keys: WidevineKeyRecord[] = [];
  let bridgeJson: Record<string, unknown> | undefined;
  try {
    bridgeJson = JSON.parse(bridgeBody.toString("utf8")) as Record<string, unknown>;
    keys = parseBridgeKeys(bridgeJson);
  } catch {
    /* not json; may be raw WVD blob */
  }

  if (keys.length === 0) {
    if (!mpd.psshBase64) {
      throw new Error("Widevine MPD does not contain a PSSH box.");
    }
    const session = getSession();
    if (!session?.accessToken || !session.adpToken || !session.devicePrivateKey) {
      throw new Error(
        "Missing session auth material required for local Widevine resolution.",
      );
    }
    const py = await runPythonWidevineResolve({
      asin: params.asin,
      marketplace: params.marketplace,
      accessToken: session.accessToken,
      adpToken: session.adpToken,
      devicePrivateKey: session.devicePrivateKey,
      psshBase64: mpd.psshBase64,
      cdmBlobBase64: bridgeBody.toString("base64"),
    });
    keys = py.keys;
    if (py.cookieHeader) {
      bridgeJson = { ...(bridgeJson ?? {}), cookieHeader: py.cookieHeader };
    }
  }

  const chosen = pickKey(keys, mpd);
  if (!chosen?.keyHex) {
    throw new Error("Widevine key service returned no usable content key.");
  }

  const contentUrlRaw =
    (bridgeJson && typeof bridgeJson.contentUrl === "string" ? bridgeJson.contentUrl : undefined) ??
    mpd.contentUrl ??
    params.fallbackContentUrl;
  if (!contentUrlRaw) {
    throw new Error("Widevine MPD and key service did not provide a downloadable audio content URL.");
  }
  const contentUrl = new URL(contentUrlRaw, params.licenseResponseUrl).toString();

  logger.info(
    {
      asin: params.asin,
      defaultKid: mpd.defaultKid,
      selectedKid: chosen.kid,
      keyCount: keys.length,
      hasIv: !!chosen.ivHex,
    },
    "Resolved Widevine decryption material",
  );

  return {
    contentUrl,
    keyHex: chosen.keyHex,
    ivHex: chosen.ivHex,
    kid: chosen.kid,
    candidateKeys: keys,
    provider: "bridge",
    mpd,
    cookieHeader:
      bridgeJson && typeof bridgeJson.cookieHeader === "string"
        ? bridgeJson.cookieHeader
        : undefined,
  };
}
