/** Flatten Error / AggregateError / .cause chains for logs and user-facing strings. */
export function explainFetchError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const visit = (e: unknown, depth: number): void => {
    if (e == null || depth > 8 || seen.has(e)) return;
    seen.add(e);
    if (e instanceof Error) {
      parts.push(e.message);
      const agg = e as AggregateError & { errors?: unknown[] };
      if (Array.isArray(agg.errors)) {
        for (const sub of agg.errors) visit(sub, depth + 1);
      }
      visit((e as Error & { cause?: unknown }).cause, depth + 1);
    } else if (typeof e === "object" && e !== null && "message" in e) {
      parts.push(String((e as { message: unknown }).message));
    }
  };

  visit(err, 0);
  const uniq = [...new Set(parts.map((s) => s.trim()).filter(Boolean))];
  return uniq.join(" — ") || String(err);
}

function isTransientNetworkFailure(detail: string): boolean {
  const d = detail.toLowerCase();
  return (
    d.includes("fetch failed") ||
    d.includes("econnreset") ||
    d.includes("econnrefused") ||
    d.includes("etimedout") ||
    d.includes("enotfound") ||
    d.includes("ecanceled") ||
    d.includes("socket hang up") ||
    d.includes("tls") ||
    d.includes("ssl") ||
    d.includes("certificate") ||
    d.includes("eai_again") ||
    d.includes("und_err") ||
    d.includes("connect")
  );
}

/**
 * Retry `fetch` a few times on typical transient failures (IPv6/DNS blips, TLS, resets).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts?: { attempts?: number; label?: string },
): Promise<Response> {
  const attempts = opts?.attempts ?? 3;
  const label = opts?.label ?? "HTTP";
  let last: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      last = e;
      const detail = explainFetchError(e);
      if (!isTransientNetworkFailure(detail) || i === attempts - 1) {
        break;
      }
      await new Promise((r) => setTimeout(r, 120 * 2 ** i));
    }
  }

  const hint =
    "Check network/VPN/DNS. On some networks IPv6 is broken — the server prefers IPv4 first at startup.";
  throw new Error(`${label}: ${explainFetchError(last)}. ${hint}`);
}
