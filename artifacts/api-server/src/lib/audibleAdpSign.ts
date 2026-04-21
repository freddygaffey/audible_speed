import crypto from "node:crypto";

/**
 * UTC timestamp in the same shape Python `datetime.utcnow().isoformat("T") + "Z"`
 * uses (fractional seconds only when milliseconds are non-zero), for mkb79-compatible
 * ADP request signing. See audible.auth.sign_request.
 */
export function utcAdpTimestamp(): string {
  const d = new Date();
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, "0");
  const D = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  const ms = d.getUTCMilliseconds();
  if (ms === 0) return `${Y}-${M}-${D}T${h}:${m}:${s}Z`;
  const frac = String(ms * 1000).padStart(6, "0");
  return `${Y}-${M}-${D}T${h}:${m}:${s}.${frac}Z`;
}

/** Headers for Audible 1.0 API when MAC DMS signing is available (mkb79 audible.auth.sign_request). */
export function adpSignHeaders(opts: {
  method: string;
  /** Path + query only, e.g. `/1.0/library?page=1` (leading slash, no host). */
  pathWithQuery: string;
  bodyUtf8: string;
  adpToken: string;
  privateKeyPem: string;
}): Record<string, string> {
  const date = utcAdpTimestamp();
  const canonical = `${opts.method}\n${opts.pathWithQuery}\n${date}\n${opts.bodyUtf8}\n${opts.adpToken}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(canonical, "utf8");
  sign.end();
  const key = parsePrivateKey(opts.privateKeyPem);
  const sigB64 = sign.sign(key, "base64");
  const xAdpSignature = `${sigB64}:${date}`;
  return {
    "x-adp-token": opts.adpToken,
    "x-adp-alg": "SHA256withRSA:1.0",
    "x-adp-signature": xAdpSignature,
  };
}

function parsePrivateKey(raw: string): crypto.KeyObject {
  const trimmed = raw.trim();
  if (trimmed.includes("BEGIN ")) {
    return crypto.createPrivateKey(trimmed);
  }

  const der = Buffer.from(trimmed, "base64");
  if (der.length === 0) {
    throw new Error("Invalid ADP private key: empty key material");
  }

  // Android registration commonly returns base64 DER (PKCS#8).
  try {
    return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    // Fallback for environments returning PKCS#1 DER.
    return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs1" });
  }
}
