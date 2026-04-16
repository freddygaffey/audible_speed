import { Router, type IRouter } from "express";
import fs from "fs";
import path from "path";
import {
  generatePKCE,
  buildOAuthUrl,
  exchangeCodeForTokens,
  getAccountInfo,
  getSession,
  setSession,
  clearSession,
  MARKETPLACES,
} from "../lib/audibleAuth.js";
import { fetchLibrary } from "../lib/audibleClient.js";
import {
  listJobs,
  getJob,
  startDownload,
  cancelJob,
  getOutputPath,
  setActivationBytes,
} from "../lib/downloadManager.js";
import {
  GetAudibleAuthUrlQueryParams,
  ExchangeAudibleCodeBody,
  GetAudibleLibraryQueryParams,
  GetDownloadJobParams,
  CancelDownloadParams,
  DownloadFileParams,
  StartDownloadBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

// GET /audible/auth/url
router.get("/audible/auth/url", async (req, res): Promise<void> => {
  const parsed = GetAudibleAuthUrlQueryParams.safeParse(req.query);
  const marketplace = parsed.success
    ? (parsed.data.marketplace ?? "us")
    : "us";

  const { codeVerifier, codeChallenge } = generatePKCE();
  const url = buildOAuthUrl(marketplace, codeChallenge);

  res.json({ url, codeVerifier, marketplace });
});

// POST /audible/auth/exchange
router.post("/audible/auth/exchange", async (req, res): Promise<void> => {
  const parsed = ExchangeAudibleCodeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { code, codeVerifier, marketplace = "us" } = parsed.data;

  try {
    const { accessToken, refreshToken, expiresIn } =
      await exchangeCodeForTokens(code, codeVerifier, marketplace);

    const { username, email } = await getAccountInfo(accessToken);

    setSession({
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      username,
      email,
      marketplace,
    });

    req.log.info({ username, marketplace }, "Audible auth successful");

    res.json({
      authenticated: true,
      username,
      email,
      marketplace,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
  } catch (err: any) {
    req.log.error({ err: err.message }, "Auth exchange failed");
    res.status(400).json({ error: err.message });
  }
});

// GET /audible/auth/status
router.get("/audible/auth/status", async (_req, res): Promise<void> => {
  const session = getSession();
  if (!session) {
    res.json({ authenticated: false, username: null, email: null, marketplace: null, expiresAt: null });
    return;
  }
  res.json({
    authenticated: true,
    username: session.username,
    email: session.email,
    marketplace: session.marketplace,
    expiresAt: session.expiresAt.toISOString(),
  });
});

// POST /audible/auth/logout
router.post("/audible/auth/logout", async (_req, res): Promise<void> => {
  clearSession();
  res.json({ message: "Logged out" });
});

// GET /audible/library
router.get("/audible/library", async (req, res): Promise<void> => {
  const session = getSession();
  if (!session) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const parsed = GetAudibleLibraryQueryParams.safeParse(req.query);
  const page = parsed.success ? (parsed.data.page ?? 1) : 1;
  const pageSize = parsed.success ? (parsed.data.pageSize ?? 50) : 50;

  try {
    const { books, total } = await fetchLibrary(page, pageSize);

    // Merge download status
    const jobs = listJobs();
    const asinStatus = new Map<string, "downloading" | "downloaded">();
    for (const job of jobs) {
      if (job.status === "done") {
        asinStatus.set(job.asin, "downloaded");
      } else if (
        job.status === "queued" ||
        job.status === "downloading" ||
        job.status === "converting"
      ) {
        if (!asinStatus.has(job.asin)) {
          asinStatus.set(job.asin, "downloading");
        }
      }
    }

    const enriched = books.map((b) => ({
      ...b,
      status: asinStatus.get(b.asin) ?? "available",
    }));

    res.json({ books: enriched, total, page, pageSize });
  } catch (err: any) {
    req.log.error({ err: err.message }, "Library fetch failed");
    res.status(502).json({ error: err.message });
  }
});

// GET /audible/library/stats
router.get("/audible/library/stats", async (req, res): Promise<void> => {
  const session = getSession();
  if (!session) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const { books, total } = await fetchLibrary(1, 1000);
    const jobs = listJobs();

    const doneAsins = new Set(
      jobs.filter((j) => j.status === "done").map((j) => j.asin)
    );
    const activeAsins = new Set(
      jobs
        .filter((j) => ["queued", "downloading", "converting"].includes(j.status))
        .map((j) => j.asin)
    );

    const totalHours = Math.round(
      books.reduce((sum, b) => sum + (b.runtimeMinutes ?? 0), 0) / 60
    );

    res.json({
      total,
      downloaded: doneAsins.size,
      downloading: activeAsins.size,
      totalHours,
    });
  } catch (err: any) {
    req.log.error({ err: err.message }, "Stats fetch failed");
    res.status(502).json({ error: err.message });
  }
});

// GET /audible/downloads
router.get("/audible/downloads", async (_req, res): Promise<void> => {
  res.json(listJobs());
});

// POST /audible/download
router.post("/audible/download", async (req, res): Promise<void> => {
  const session = getSession();
  if (!session) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const parsed = StartDownloadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { asin, title, format = "mp3" } = parsed.data;

  try {
    const job = await startDownload(asin, title, format as "mp3" | "m4b");
    res.json(job);
  } catch (err: any) {
    req.log.error({ err: err.message }, "Start download failed");
    res.status(500).json({ error: err.message });
  }
});

// GET /audible/download/:id
router.get("/audible/download/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = GetDownloadJobParams.safeParse({ id: raw });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const job = getJob(parsed.data.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(job);
});

// DELETE /audible/download/:id
router.delete("/audible/download/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = CancelDownloadParams.safeParse({ id: raw });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const ok = cancelJob(parsed.data.id);
  if (!ok) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json({ message: "Cancelled" });
});

// GET /audible/download/:id/file — serve completed mp3
router.get("/audible/download/:id/file", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = DownloadFileParams.safeParse({ id: raw });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const job = getJob(parsed.data.id);
  if (!job || job.status !== "done" || !job.outputPath) {
    res.status(404).json({ error: "File not ready or not found" });
    return;
  }

  if (!fs.existsSync(job.outputPath)) {
    res.status(404).json({ error: "File missing on disk" });
    return;
  }

  const ext = path.extname(job.outputPath).slice(1);
  const mimeType = ext === "m4b" ? "audio/mp4" : "audio/mpeg";
  const fileName = `${job.title.replace(/[^a-z0-9 ]/gi, "_")}.${ext}`;

  res.setHeader("Content-Type", mimeType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fileName}"`
  );
  fs.createReadStream(job.outputPath).pipe(res);
});

// POST /audible/settings/activation-bytes
router.post("/audible/settings/activation-bytes", async (req, res): Promise<void> => {
  const { activationBytes } = req.body as { activationBytes?: string };
  if (!activationBytes || typeof activationBytes !== "string") {
    res.status(400).json({ error: "activationBytes is required" });
    return;
  }
  setActivationBytes(activationBytes);
  req.log.info("Activation bytes updated");
  res.json({ message: "Activation bytes saved" });
});

export default router;
