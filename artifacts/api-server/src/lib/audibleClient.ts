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
  lastPositionMs: number | null;
  lastPositionUpdated: string | null;
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
  chapterInfo?: {
    runtimeLengthMs?: number;
    isAccurate?: boolean;
    chapters: Array<{
      title: string;
      startOffsetMs: number;
      lengthMs: number;
    }>;
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

/** Flatten `chapter_titles_type=Tree` nested `chapters` into a single ordered list. */
function flattenChapterTree(nodes: unknown): Array<{
  title: string;
  startOffsetMs: number;
  lengthMs: number;
}> {
  const out: Array<{ title: string; startOffsetMs: number; lengthMs: number }> = [];
  const walk = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    for (const c of arr) {
      if (!c || typeof c !== "object") continue;
      const raw = c as Record<string, unknown>;
      const title =
        typeof raw.title === "string" && raw.title.trim().length > 0 ? raw.title.trim() : "Chapter";
      const startOffsetMs =
        typeof raw.start_offset_ms === "number" && Number.isFinite(raw.start_offset_ms)
          ? Math.max(0, Math.floor(raw.start_offset_ms))
          : 0;
      const lengthMs =
        typeof raw.length_ms === "number" && Number.isFinite(raw.length_ms)
          ? Math.max(0, Math.floor(raw.length_ms))
          : 0;
      const nested = raw.chapters;
      if (lengthMs > 0) {
        out.push({ title, startOffsetMs, lengthMs });
      }
      if (Array.isArray(nested) && nested.length > 0) {
        walk(nested);
      }
    }
  };
  walk(nodes);
  return out;
}

function chapterInfoFromRaw(chapterInfoRaw: unknown): {
  runtimeLengthMs?: number;
  isAccurate?: boolean;
  chapters: Array<{ title: string; startOffsetMs: number; lengthMs: number }>;
} {
  if (!chapterInfoRaw || typeof chapterInfoRaw !== "object") {
    return { chapters: [] };
  }
  const raw = chapterInfoRaw as Record<string, unknown>;
  const chapters = flattenChapterTree(raw.chapters).filter((c) => c.lengthMs > 0);
  return {
    runtimeLengthMs:
      typeof raw.runtime_length_ms === "number" && Number.isFinite(raw.runtime_length_ms)
        ? Math.max(0, Math.floor(raw.runtime_length_ms))
        : undefined,
    isAccurate: typeof raw.is_accurate === "boolean" ? raw.is_accurate : undefined,
    chapters,
  };
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

  const positionMsRaw = item?.last_position_heard?.position_ms;
  const positionMs =
    typeof positionMsRaw === "number" && Number.isFinite(positionMsRaw) && positionMsRaw >= 0
      ? Math.floor(positionMsRaw)
      : typeof item?.percent_complete === "number" &&
          Number.isFinite(item.percent_complete) &&
          typeof item?.runtime_length_min === "number"
        ? Math.max(
            0,
            Math.floor((item.percent_complete / 100) * item.runtime_length_min * 60_000),
          )
      : null;
  const lastUpdated =
    typeof item?.last_position_heard?.last_updated === "string"
      ? item.last_position_heard.last_updated
      : typeof item?.listening_status?.last_updated === "string"
        ? item.listening_status.last_updated
      : null;

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
    lastPositionMs: positionMs,
    lastPositionUpdated: lastUpdated,
    status: "available",
  };
}

function toAudibleXmlTimestamp(dt: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}` +
    `T${p2(dt.getUTCHours())}:${p2(dt.getUTCMinutes())}:${p2(dt.getUTCSeconds())}+0000`
  );
}

function buildLastHeardAnnotationXml(asin: string, positionMs: number, now: Date): string {
  const ts = toAudibleXmlTimestamp(now);
  return [
    `<annotations version="1.0" timestamp="${ts}">`,
    `<book key="${asin}" type="AUDI" guid="_LATEST_">`,
    `<last_heard action="modify" begin="${positionMs}" timestamp="${ts}" />`,
    `</book>`,
    `</annotations>`,
  ].join("");
}

export async function syncLastHeardProgress(asin: string, positionMs: number): Promise<void> {
  await requireAudibleSession();
  const normalizedAsin = asin.trim();
  if (!/^[A-Z0-9]{8,32}$/i.test(normalizedAsin)) {
    throw new Error("Invalid ASIN for progress sync");
  }
  const ms = Math.max(0, Math.floor(positionMs));
  const pathWithQuery = "/FionaCDEServiceEngine/sidecar?type=AUDI";
  const bodyUtf8 = buildLastHeardAnnotationXml(normalizedAsin, ms, new Date());
  const headers = {
    ...audibleApiHeaders("POST", pathWithQuery, bodyUtf8),
    "Content-Type": "application/xml",
  };
  const resp = await fetchWithRetry(
    `https://cde-ta-g7g.amazon.com${pathWithQuery}`,
    { method: "POST", headers, body: bodyUtf8 },
    { label: "Audible progress sync", attempts: 2 },
  );
  if (!resp.ok) {
    const text = (await resp.text()).slice(0, 500);
    throw new Error(`Progress sync failed: ${resp.status} ${text}`);
  }
}

export async function getLastHeardProgress(
  asin: string,
): Promise<{ positionMs: number | null; updatedAt: string | null }> {
  await requireAudibleSession();
  const normalizedAsin = asin.trim();
  if (!/^[A-Z0-9]{8,32}$/i.test(normalizedAsin)) {
    throw new Error("Invalid ASIN for progress lookup");
  }
  const pathWithQuery = `/FionaCDEServiceEngine/sidecar?type=AUDI&key=${encodeURIComponent(
    normalizedAsin,
  )}`;
  const headers = audibleApiHeaders("GET", pathWithQuery, "");
  const resp = await fetchWithRetry(
    `https://cde-ta-g7g.amazon.com${pathWithQuery}`,
    { method: "GET", headers },
    { label: "Audible progress lookup", attempts: 2 },
  );
  if (!resp.ok) {
    // No progress record yet can be returned as 404/empty by some regions/accounts.
    if (resp.status === 404) return { positionMs: null, updatedAt: null };
    const text = (await resp.text()).slice(0, 500);
    throw new Error(`Progress lookup failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as {
    payload?: { records?: Array<{ type?: string; startPosition?: string | number; creationTime?: string }> };
  };
  const recs = data?.payload?.records ?? [];
  const lastHeard = recs.find((r) => r.type === "audible.last_heard");
  const posRaw = lastHeard?.startPosition;
  const parsed =
    typeof posRaw === "number"
      ? Math.floor(posRaw)
      : typeof posRaw === "string"
        ? Number.parseInt(posRaw, 10)
        : NaN;
  return {
    positionMs: Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
    updatedAt: lastHeard?.creationTime ?? null,
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

  let books = (data.items ?? []).map(parseBook);
  const enrichCloudProgress =
    process.env.AUDIBLE_LIBRARY_PROGRESS_ENRICH !== "0" &&
    process.env.AUDIBLE_LIBRARY_PROGRESS_ENRICH !== "false";
  if (enrichCloudProgress && books.length > 0) {
    books = await enrichBooksWithCloudProgress(books);
  }
  const tr = data.total_records;
  // If total_records is missing, do not use len(items) as "total" — that makes clients think
  // the library is only one page deep (e.g. 100 of 300 titles).
  const total =
    typeof tr === "number" && tr > 0 ? tr : 0;

  return { books, total };
}

async function enrichBooksWithCloudProgress(books: AudibleBook[]): Promise<AudibleBook[]> {
  const out = [...books];
  const concurrency = Math.min(8, books.length);
  let idx = 0;
  const worker = async () => {
    for (;;) {
      const i = idx++;
      if (i >= books.length) return;
      const b = books[i];
      try {
        const p = await getLastHeardProgress(b.asin);
        if (p.positionMs != null || p.updatedAt != null) {
          out[i] = {
            ...b,
            lastPositionMs: p.positionMs ?? b.lastPositionMs,
            lastPositionUpdated: p.updatedAt ?? b.lastPositionUpdated,
          };
        }
      } catch {
        // Keep library listing resilient; progress enrichment is best-effort.
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
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

async function fetchChapterInfoFromMetadata(
  asin: string,
  chapterTitlesType: "Tree" | "Flat",
): Promise<{
  runtimeLengthMs?: number;
  isAccurate?: boolean;
  chapters: Array<{ title: string; startOffsetMs: number; lengthMs: number }>;
}> {
  await requireAudibleSession();
  const session = getSession()!;
  const domain = AUDIBLE_API_DOMAINS[session.marketplace] ?? AUDIBLE_API_DOMAINS.us;
  const params = new URLSearchParams({
    response_groups: "chapter_info,content_reference",
    chapter_titles_type: chapterTitlesType,
  });
  const pathWithQuery = `/1.0/content/${asin}/metadata?${params}`;
  const fullUrl = `https://${domain}${pathWithQuery}`;
  const headers = audibleApiHeaders("GET", pathWithQuery, "");
  const resp = await fetchWithRetry(
    fullUrl,
    { method: "GET", headers },
    { label: `Audible content metadata (${domain})` },
  );
  if (!resp.ok) {
    const text = (await resp.text()).slice(0, 400);
    throw new Error(`Content metadata failed: ${resp.status} ${text}`);
  }
  const data = (await resp.json()) as { content_metadata?: { chapter_info?: unknown } };
  return chapterInfoFromRaw(data?.content_metadata?.chapter_info);
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

  const requestLicense = async (
    numeral?: string,
  ): Promise<{ resp: Response; numeralUsed: string | null }> => {
    const params = new URLSearchParams({
      quality: "High",
      response_groups: "last_position_heard,pdf_url,content_reference,chapter_info",
      type: "AUDI",
    });
    if (numeral) params.set("numeral", numeral);
    const fullUrl = `https://${domain}/1.0/content/${asin}/licenserequest?${params}`;
    const url = new URL(fullUrl);
    const pathWithQuery = url.pathname + url.search;

    const bodyObj: Record<string, unknown> = {
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
    };
    if (numeral) bodyObj.numeral = numeral;
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
    return { resp, numeralUsed: numeral ?? null };
  };

  // Try request without a hardcoded numeral first; some long titles return the full asset
  // only when numeral is omitted. Fallback to numeral=1 for compatibility with older flows.
  let response: { resp: Response; numeralUsed: string | null };
  try {
    response = await requestLicense();
  } catch {
    response = await requestLicense("1");
  }
  let resp = response.resp;
  if (!resp.ok) {
    // If the no-numeral request fails, retry once with numeral=1 before surfacing errors.
    if (response.numeralUsed == null) {
      response = await requestLicense("1");
      resp = response.resp;
    }
  }

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
  const chapterInfoRaw = license?.content_metadata?.chapter_info;
  const chapterParsed = chapterInfoFromRaw(chapterInfoRaw);

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
    chapterInfo: chapterParsed,
  };
}

export async function getDownloadUrl(asin: string): Promise<LicenseDownloadResult> {
  return getDownloadUrlInternal(asin, asin, new Set<string>());
}

export async function getChapterInfo(asin: string): Promise<{
  runtimeLengthMs?: number;
  isAccurate?: boolean;
  chapters: Array<{ title: string; startOffsetMs: number; lengthMs: number }>;
}> {
  await requireAudibleSession();
  const normalizedAsin = asin.trim().toUpperCase();
  if (!/^[A-Z0-9]{8,32}$/i.test(normalizedAsin)) {
    throw new Error("Invalid ASIN for chapters");
  }

  const loadFromMetadata = async (target: string) => {
    let info = await fetchChapterInfoFromMetadata(target, "Tree");
    if (info.chapters.length === 0) {
      const flat = await fetchChapterInfoFromMetadata(target, "Flat");
      if (flat.chapters.length > 0) info = flat;
    }
    return info;
  };

  const looksUsable = (info: {
    chapters: unknown[];
    runtimeLengthMs?: number;
  }) => info.chapters.length > 0 || typeof info.runtimeLengthMs === "number";

  try {
    const info = await loadFromMetadata(normalizedAsin);
    if (looksUsable(info)) return info;
  } catch {
    /* try podcast child or licenserequest */
  }

  const session = getSession()!;
  const domain = AUDIBLE_API_DOMAINS[session.marketplace] ?? AUDIBLE_API_DOMAINS.us;
  const episodeAsin = await resolvePodcastEpisodeAsin(normalizedAsin, domain).catch(() => null);
  if (episodeAsin) {
    try {
      const info = await loadFromMetadata(episodeAsin);
      if (looksUsable(info)) return info;
    } catch {
      /* fall through */
    }
  }

  const license = await getDownloadUrl(normalizedAsin);
  return license.chapterInfo ?? { chapters: [] };
}
