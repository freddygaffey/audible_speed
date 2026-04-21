import { AUDIBLE_API_DOMAINS, getValidAccessToken, getSession } from "./audibleAuth.js";
import { adpSignHeaders } from "./audibleAdpSign.js";
import { fetchWithRetry } from "./fetchWithRetry.js";

export interface AudibleBook {
  asin: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  narrators: string[];
  coverUrl: string | null;
  runtimeMinutes: number | null;
  purchaseDate: string | null;
  seriesTitle: string | null;
  seriesPosition: string | null;
  releaseDate: string | null;
  description: string | null;
  status: "available" | "downloaded" | "downloading";
}

const API_UA = "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0";
const LIBRARY_RESPONSE_GROUPS =
  "product_desc,product_attrs,relationships,series,rating,media,customer_rights,contributors,product_extended_attrs";

/**
 * Classic ADRM licenserequest includes a voucher with a 4-byte key (same role as
 * "activation bytes" for ffmpeg). Base64 or 8-hex string.
 */
export function extractAdrmVoucherKeyHex(license: unknown): string | undefined {
  if (!license || typeof license !== "object") return undefined;
  const lic = license as Record<string, unknown>;
  const voucher = lic.voucher;
  if (!voucher || typeof voucher !== "object") return undefined;
  const v = voucher as Record<string, unknown>;
  const keyRaw = v.key ?? v.Key;
  if (typeof keyRaw !== "string" || keyRaw.length === 0) return undefined;
  const hex = keyRaw.trim();
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return hex.toLowerCase();
  try {
    const buf = Buffer.from(hex, "base64");
    if (buf.length === 4) return buf.toString("hex");
  } catch {
    /* ignore */
  }
  return undefined;
}

export interface LicenseDownloadResult {
  offlineUrl: string;
  /** 8 hex chars for ffmpeg -activation_bytes when Audible includes an ADRM voucher key. */
  drmKeyHex?: string;
  /** 16-byte key for AAXC/cenc flows when present in voucher. */
  drmCencKeyHex?: string;
  /** Optional IV from voucher for AAXC/cenc flows. */
  drmCencIvHex?: string;
  drmType?: string;
  urlSource?: "offline_url" | "license_response";
  requestedAsin: string;
  resolvedAsin: string;
  licenseResponseUrl?: string;
  contentReference?: {
    acr?: string;
    fileVersion?: string;
  };
}

function decodeVoucherPartHex(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const s = raw.trim();
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return s.toLowerCase();
  try {
    const buf = Buffer.from(s, "base64");
    if (buf.length > 0) return buf.toString("hex");
  } catch {
    /* ignore */
  }
  return undefined;
}

function extractVoucherCencMaterial(
  license: unknown,
): { keyHex?: string; ivHex?: string } {
  if (!license || typeof license !== "object") return {};
  const voucher = (license as Record<string, unknown>).voucher;
  if (!voucher || typeof voucher !== "object") return {};
  const v = voucher as Record<string, unknown>;
  const keyHex = decodeVoucherPartHex(v.key ?? v.Key);
  const ivHex = decodeVoucherPartHex(v.iv ?? v.IV ?? v.Iv);
  return {
    keyHex: keyHex && keyHex.length >= 32 ? keyHex : undefined,
    ivHex: ivHex && ivHex.length >= 16 ? ivHex : undefined,
  };
}

function readLicenseResponseUrl(license: any): string | undefined {
  const asHttpUrl = (v: unknown): string | undefined => {
    if (typeof v !== "string" || v.length === 0) return undefined;
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
    } catch {
      return undefined;
    }
  };
  const lr = license?.license_response;
  const direct = asHttpUrl(lr);
  if (direct) return direct;
  if (lr && typeof lr === "object") {
    const obj = lr as Record<string, unknown>;
    const nested =
      obj["content_url"] ??
      obj["url"] ??
      obj["offline_url"] ??
      obj["download_url"] ??
      obj["href"];
    const nestedUrl = asHttpUrl(nested);
    if (nestedUrl) return nestedUrl;
  }
  return undefined;
}

function describeLicenseResponse(data: unknown): string {
  const d = data as Record<string, unknown>;
  const cl = d?.content_license as Record<string, unknown> | undefined;
  if (!cl) return JSON.stringify(data).slice(0, 400);
  const parts = [cl.status, cl.status_reason, cl.reason, cl.message].filter(
    (x) => typeof x === "string" && x.length > 0,
  );
  if (parts.length) return parts.join(" — ");
  return JSON.stringify(cl).slice(0, 400);
}

/**
 * Headers for api.audible.* — MAC DMS signing when adp + key exist.
 * `licenserequest` still validates `Authorization` + `client-id` together; keep Bearer + `client-id: 0`
 * alongside x-adp-* (see mkb79 bearer branch vs signing; Audible rejects signing-only with a 400 mismatch).
 */
function audibleApiHeaders(method: string, pathWithQuery: string, bodyUtf8: string): Record<string, string> {
  const session = getSession()!;
  const base: Record<string, string> = {
    Accept: "application/json",
    "Accept-Charset": "utf-8",
    "User-Agent": API_UA,
    Authorization: `Bearer ${session.accessToken}`,
    "client-id": "0",
  };
  if (session.adpToken && session.devicePrivateKey) {
    Object.assign(
      base,
      adpSignHeaders({
        method,
        pathWithQuery,
        bodyUtf8,
        adpToken: session.adpToken,
        privateKeyPem: session.devicePrivateKey,
      }),
    );
  }
  return base;
}

async function requireAudibleSession(): Promise<void> {
  const token = await getValidAccessToken();
  if (!token) throw new Error("Not authenticated");
}

function pickLargestCover(coverUri: string | undefined): string | null {
  if (!coverUri) return null;
  return coverUri.replace("._SL500_.", "._SL500_.");
}

function parseBook(item: any): AudibleBook {
  const authors = (item.authors ?? []).map((a: any) => a.name ?? String(a));
  const narrators = (item.narrators ?? []).map((n: any) => n.name ?? String(n));
  const series = (item.series ?? [])[0];

  return {
    asin: item.asin ?? "",
    title: item.title ?? "Unknown",
    subtitle: item.subtitle ?? null,
    authors,
    narrators,
    coverUrl: pickLargestCover(item.product_images?.["500"] ?? item.product_images?.["1215"]),
    runtimeMinutes: item.runtime_length_min ?? null,
    purchaseDate: item.purchase_date ?? null,
    seriesTitle: series?.title ?? null,
    seriesPosition: series?.sequence ?? null,
    releaseDate: item.release_date ?? null,
    description: item.merchandising_summary ?? item.publisher_summary ?? null,
    status: "available",
  };
}

export async function fetchLibrary(
  page = 1,
  pageSize = 50,
): Promise<{ books: AudibleBook[]; total: number }> {
  await requireAudibleSession();

  const session = getSession()!;
  const domain = AUDIBLE_API_DOMAINS[session.marketplace] ?? AUDIBLE_API_DOMAINS.us;

  const params = new URLSearchParams({
    response_groups: LIBRARY_RESPONSE_GROUPS,
    num_results: String(pageSize),
    page: String(page),
    sort_by: "-PurchaseDate",
  });

  const fullUrl = `https://${domain}/1.0/library?${params}`;
  const url = new URL(fullUrl);
  const pathWithQuery = url.pathname + url.search;
  const headers = audibleApiHeaders("GET", pathWithQuery, "");

  const resp = await fetchWithRetry(
    fullUrl,
    { method: "GET", headers },
    { label: `Audible library (${domain})` },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Library fetch failed: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as {
    items: any[];
    total_records?: number;
    response_groups?: string[];
  };

  const books = (data.items ?? []).map(parseBook);
  const tr = data.total_records;
  // If total_records is missing, do not use len(items) as "total" — that makes clients think
  // the library is only one page deep (e.g. 100 of 300 titles).
  const total =
    typeof tr === "number" && tr > 0 ? tr : 0;

  return { books, total };
}

async function resolvePodcastEpisodeAsin(parentAsin: string, domain: string): Promise<string | null> {
  const params = new URLSearchParams({
    parent_asin: parentAsin,
    response_groups: LIBRARY_RESPONSE_GROUPS,
    num_results: "25",
    page: "1",
    sort_by: "-PurchaseDate",
  });
  const fullUrl = `https://${domain}/1.0/library?${params}`;
  const pathWithQuery = `/1.0/library?${params}`;
  const headers = audibleApiHeaders("GET", pathWithQuery, "");
  const resp = await fetchWithRetry(
    fullUrl,
    { method: "GET", headers },
    { label: `Audible parent_asin lookup (${domain})` },
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as { items?: any[] };
  const children = data.items ?? [];
  const firstEpisode = children.find((item) => {
    const cdt = String(item?.content_delivery_type ?? "").toLowerCase();
    return (
      typeof item?.asin === "string" &&
      item.asin.length > 0 &&
      !cdt.includes("podcastparent")
    );
  });
  return firstEpisode?.asin ?? null;
}

async function getDownloadUrlInternal(
  requestedAsin: string,
  asin: string,
  attemptedAsins: Set<string>,
): Promise<LicenseDownloadResult> {
  await requireAudibleSession();
  if (attemptedAsins.has(asin)) {
    throw new Error(`Unable to resolve downloadable ASIN (loop detected): ${asin}`);
  }
  attemptedAsins.add(asin);
  const session = getSession()!;
  const domain = AUDIBLE_API_DOMAINS[session.marketplace] ?? AUDIBLE_API_DOMAINS.us;

  const params = new URLSearchParams({
    quality: "High",
    response_groups: "last_position_heard,pdf_url,content_reference,chapter_info",
    type: "AUDI",
    numeral: "1",
  });

  const fullUrl = `https://${domain}/1.0/content/${asin}/licenserequest?${params}`;
  const url = new URL(fullUrl);
  const pathWithQuery = url.pathname + url.search;

  const bodyObj = {
    quality: "High",
    /** Required by Audible since ~2024; omitting yields 400 on `consumptionType`. */
    consumption_type: "Download",
    // Podcasts/AYCL can be unencrypted MPEG while books are ADRM.
    // Let server choose one of the supported types.
    supported_drm_types:
      process.env.AUDIBLE_WIDEVINE_ENABLED !== "0" &&
      process.env.AUDIBLE_WIDEVINE_ENABLED !== "false"
        ? ["Adrm", "Mpeg", "Widevine"]
        : ["Adrm", "Mpeg"],
    response_groups: "last_position_heard,pdf_url,content_reference,chapter_info",
    type: "AUDI",
    numeral: "1",
  };
  const bodyUtf8 = JSON.stringify(bodyObj);
  const headers = {
    ...audibleApiHeaders("POST", pathWithQuery, bodyUtf8),
    "Content-Type": "application/json",
  };

  const resp = await fetchWithRetry(
    fullUrl,
    {
      method: "POST",
      headers,
      body: bodyUtf8,
    },
    { label: `Audible licenserequest (${domain})` },
  );

  if (!resp.ok) {
    const text = await resp.text();
    if (text.includes("non_audio asset") || text.includes("PodcastParent")) {
      const episodeAsin = await resolvePodcastEpisodeAsin(asin, domain);
      if (episodeAsin) {
        return await getDownloadUrlInternal(requestedAsin, episodeAsin, attemptedAsins);
      }
      throw new Error(
        `This title is a podcast/show container (PodcastParent) and no child episode ASIN was found for ${asin}.`,
      );
    }
    throw new Error(`License request failed: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as any;
  const license = data?.content_license;
  const drmType = String(license?.drm_type ?? "").toLowerCase();
  const offlineUrl =
    typeof license?.content_metadata?.content_url?.offline_url === "string"
      ? license.content_metadata.content_url.offline_url
      : undefined;
  const licenseResponseUrl = readLicenseResponseUrl(license);

  let urlOut: string | undefined;
  let urlSource: "offline_url" | "license_response" | undefined;
  if (drmType === "mpeg") {
    // MPEG licenses often put the actual downloadable URL in `license_response`.
    urlOut = licenseResponseUrl ?? offlineUrl;
    urlSource = licenseResponseUrl ? "license_response" : offlineUrl ? "offline_url" : undefined;
  } else {
    // ADRM/book flow should primarily use `offline_url`.
    urlOut = offlineUrl ?? licenseResponseUrl;
    urlSource = offlineUrl ? "offline_url" : licenseResponseUrl ? "license_response" : undefined;
  }

  if (!urlOut) {
    throw new Error(
      `No offline download URL (classic AAX) in license response. ${describeLicenseResponse(data)}`,
    );
  }

  const drmKeyHex = extractAdrmVoucherKeyHex(license);
  const cenc = extractVoucherCencMaterial(license);

  return {
    offlineUrl: urlOut,
    drmKeyHex,
    drmCencKeyHex: cenc.keyHex,
    drmCencIvHex: cenc.ivHex,
    drmType,
    urlSource,
    requestedAsin,
    resolvedAsin: asin,
    licenseResponseUrl,
    contentReference: {
      acr:
        typeof license?.content_metadata?.content_reference?.acr === "string"
          ? license.content_metadata.content_reference.acr
          : undefined,
      fileVersion:
        typeof license?.content_metadata?.content_reference?.file_version === "string"
          ? license.content_metadata.content_reference.file_version
          : undefined,
    },
  };
}

export async function getDownloadUrl(asin: string): Promise<LicenseDownloadResult> {
  return getDownloadUrlInternal(asin, asin, new Set<string>());
}
