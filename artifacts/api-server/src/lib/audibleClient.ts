import { AUDIBLE_API_DOMAINS, getValidAccessToken, getSession } from "./audibleAuth.js";

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

function pickLargestCover(coverUri: string | undefined): string | null {
  if (!coverUri) return null;
  // Audible returns cover URIs ending in ._SL500_.jpg — try getting a larger one
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
  pageSize = 50
): Promise<{ books: AudibleBook[]; total: number }> {
  const token = await getValidAccessToken();
  if (!token) throw new Error("Not authenticated");

  const session = getSession()!;
  const domain = AUDIBLE_API_DOMAINS[session.marketplace] ?? AUDIBLE_API_DOMAINS.us;
  const offset = (page - 1) * pageSize;

  const params = new URLSearchParams({
    response_groups:
      "product_desc,product_attrs,relationships,series,rating,media,customer_rights,contributors,product_extended_attrs",
    num_results: String(pageSize),
    page: String(page),
    sort_by: "-PurchaseDate",
  });

  const resp = await fetch(`https://${domain}/1.0/library?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0",
    },
  });

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
  const total = data.total_records ?? books.length;

  return { books, total };
}

export async function getDownloadUrl(asin: string): Promise<string> {
  const token = await getValidAccessToken();
  if (!token) throw new Error("Not authenticated");

  const session = getSession()!;
  const domain = AUDIBLE_API_DOMAINS[session.marketplace] ?? AUDIBLE_API_DOMAINS.us;

  const params = new URLSearchParams({
    quality: "High",
    response_groups: "last_position_heard,pdf_url,content_reference,chapter_info",
    type: "AUDI",
    numeral: "1",
  });

  const resp = await fetch(
    `https://${domain}/1.0/content/${asin}/licenserequest?${params}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0",
      },
      body: JSON.stringify({
        quality: "High",
        response_groups:
          "last_position_heard,pdf_url,content_reference,chapter_info",
        type: "AUDI",
        numeral: "1",
      }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`License request failed: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as any;
  const url =
    data?.content_license?.content_metadata?.content_url?.offline_url;

  if (!url) {
    throw new Error(
      `No download URL in response: ${JSON.stringify(data).slice(0, 300)}`
    );
  }

  return url;
}
