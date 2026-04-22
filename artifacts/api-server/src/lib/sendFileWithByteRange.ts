import fs from "fs";
import type { Request, Response } from "express";

export type SetCommonHeaders = (res: Response) => void;

/**
 * Parse the first `bytes=` range spec (RFC 7233 subset used by media clients).
 * @returns null = send full representation (200); object = partial (206); "416" = unsatisfiable
 */
export function parseByteRange(
  rangeHeader: string | undefined,
  size: number,
): { start: number; end: number } | null | "416" {
  if (!rangeHeader) return null;
  const trimmed = rangeHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bytes=")) return "416";
  if (size === 0) return "416";
  const first = trimmed.slice(6).split(",")[0]?.trim() ?? "";
  if (!first) return "416";

  const dash = first.indexOf("-");
  if (dash < 0) return "416";
  const startPart = first.slice(0, dash);
  const endPart = first.slice(dash + 1);

  // Suffix range: bytes=-500
  if (startPart === "" && endPart !== "") {
    const suffixLen = parseInt(endPart, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return "416";
    if (size === 0) return "416";
    const start = Math.max(0, size - suffixLen);
    return { start, end: size - 1 };
  }

  const start = startPart === "" ? 0 : parseInt(startPart, 10);
  const end = endPart === "" ? size - 1 : parseInt(endPart, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "416";
  if (start > end) return "416";
  if (start >= size) return "416";
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Stream a file with optional single-range support (Accept-Ranges / 206 / Content-Range).
 */
export function sendFileWithByteRange(
  req: Request,
  res: Response,
  absoluteFilePath: string,
  setCommonHeaders: SetCommonHeaders,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absoluteFilePath);
  } catch {
    res.status(404).json({ error: "File missing" });
    return;
  }

  const size = stat.size;
  const parsed = parseByteRange(req.headers.range, size);

  if (parsed === "416") {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${size}`);
    res.end();
    return;
  }

  res.setHeader("Accept-Ranges", "bytes");

  const isHead = req.method === "HEAD";

  if (parsed === null) {
    res.status(200);
    res.setHeader("Content-Length", String(size));
    setCommonHeaders(res);
    if (isHead) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(absoluteFilePath);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.pipe(res);
    return;
  }

  const { start, end } = parsed;
  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  res.setHeader("Content-Length", String(chunkSize));
  setCommonHeaders(res);
  if (isHead) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(absoluteFilePath, { start, end });
  stream.on("error", () => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  stream.pipe(res);
}
