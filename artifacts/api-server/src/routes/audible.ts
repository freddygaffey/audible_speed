import { Router, type IRouter } from "express";
import fs from "fs";
import path from "path";
import {
  fetchLoginPage,
  submitCredentials,
  submitOtp,
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
  setActivationBytes,
} from "../lib/downloadManager.js";
import {
  GetAudibleLibraryQueryParams,
  GetDownloadJobParams,
  CancelDownloadParams,
  DownloadFileParams,
  StartDownloadBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Auth — server-side login (no client_id needed, uses Audible iOS UA)
// ---------------------------------------------------------------------------

// POST /audible/auth/login  — start login with email + password
router.post("/audible/auth/login", async (req, res): Promise<void> => {
  const { email, password, marketplace = "us" } = req.body as {
    email?: string;
    password?: string;
    marketplace?: string;
  };

  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  if (!MARKETPLACES[marketplace]) {
    res.status(400).json({ error: `Unknown marketplace: ${marketplace}` });
    return;
  }

  try {
    const { pendingId } = await fetchLoginPage(marketplace);
    const result = await submitCredentials(pendingId, email, password);

    if (result.status === "success") {
      setSession({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: new Date(Date.now() + result.expiresIn * 1000),
        username: result.username,
        email: result.email,
        marketplace,
      });
      req.log.info({ username: result.username, marketplace }, "Audible login success");
      res.json({ status: "success", username: result.username, email: result.email, marketplace });
    } else if (result.status === "otp") {
      res.json({ status: "otp", pendingId: result.pendingId });
    } else if (result.status === "captcha") {
      res.status(503).json({ status: "captcha", error: result.message });
    } else {
      res.status(401).json({ status: "error", error: result.message });
    }
  } catch (err: any) {
    req.log.error({ err: err.message }, "Login failed");
    res.status(500).json({ error: err.message });
  }
});

// POST /audible/auth/otp  — submit 2FA / OTP code
router.post("/audible/auth/otp", async (req, res): Promise<void> => {
  const { pendingId, otp, marketplace = "us" } = req.body as {
    pendingId?: string;
    otp?: string;
    marketplace?: string;
  };

  if (!pendingId || !otp) {
    res.status(400).json({ error: "pendingId and otp are required" });
    return;
  }

  try {
    const result = await submitOtp(pendingId, otp);

    if (result.status === "success") {
      setSession({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: new Date(Date.now() + result.expiresIn * 1000),
        username: result.username,
        email: result.email,
        marketplace,
      });
      req.log.info({ username: result.username }, "Audible OTP success");
      res.json({ status: "success", username: result.username, email: result.email, marketplace });
    } else if (result.status === "otp") {
      res.json({ status: "otp", pendingId: result.pendingId });
    } else {
      res.status(401).json({ status: "error", error: (result as any).message });
    }
  } catch (err: any) {
    req.log.error({ err: err.message }, "OTP failed");
    res.status(500).json({ error: err.message });
  }
});

// GET /audible/auth/status
router.get("/audible/auth/status", async (_req, res): Promise<void> => {
  const session = getSession();
  if (!session) {
    res.json({ authenticated: false, username: null, email: null, marketplace: null });
    return;
  }
  res.json({
    authenticated: true,
    username: session.username,
    email: session.email,
    marketplace: session.marketplace,
  });
});

// POST /audible/auth/logout
router.post("/audible/auth/logout", async (_req, res): Promise<void> => {
  clearSession();
  res.json({ message: "Logged out" });
});

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

router.get("/audible/library", async (req, res): Promise<void> => {
  if (!getSession()) { res.status(401).json({ error: "Not authenticated" }); return; }

  const parsed = GetAudibleLibraryQueryParams.safeParse(req.query);
  const page = parsed.success ? (parsed.data.page ?? 1) : 1;
  const pageSize = parsed.success ? (parsed.data.pageSize ?? 50) : 50;

  try {
    const { books, total } = await fetchLibrary(page, pageSize);
    const jobs = listJobs();
    const asinStatus = new Map<string, "downloading" | "downloaded">();
    for (const job of jobs) {
      if (job.status === "done") asinStatus.set(job.asin, "downloaded");
      else if (["queued", "downloading", "converting"].includes(job.status) && !asinStatus.has(job.asin))
        asinStatus.set(job.asin, "downloading");
    }
    res.json({ books: books.map(b => ({ ...b, status: asinStatus.get(b.asin) ?? "available" })), total, page, pageSize });
  } catch (err: any) {
    req.log.error({ err: err.message }, "Library fetch failed");
    res.status(502).json({ error: err.message });
  }
});

router.get("/audible/library/stats", async (req, res): Promise<void> => {
  if (!getSession()) { res.status(401).json({ error: "Not authenticated" }); return; }

  try {
    const { books, total } = await fetchLibrary(1, 1000);
    const jobs = listJobs();
    const doneAsins = new Set(jobs.filter(j => j.status === "done").map(j => j.asin));
    const activeAsins = new Set(jobs.filter(j => ["queued", "downloading", "converting"].includes(j.status)).map(j => j.asin));
    const totalHours = Math.round(books.reduce((s, b) => s + (b.runtimeMinutes ?? 0), 0) / 60);
    res.json({ total, downloaded: doneAsins.size, downloading: activeAsins.size, totalHours });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

router.get("/audible/downloads", async (_req, res): Promise<void> => {
  res.json(listJobs());
});

router.post("/audible/download", async (req, res): Promise<void> => {
  if (!getSession()) { res.status(401).json({ error: "Not authenticated" }); return; }

  const parsed = StartDownloadBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { asin, title, format = "mp3" } = parsed.data;
  try {
    const job = await startDownload(asin, title, format as "mp3" | "m4b");
    res.json(job);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/audible/download/:id", async (req, res): Promise<void> => {
  const parsed = GetDownloadJobParams.safeParse({ id: req.params.id });
  if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const job = getJob(parsed.data.id);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json(job);
});

router.delete("/audible/download/:id", async (req, res): Promise<void> => {
  const parsed = CancelDownloadParams.safeParse({ id: req.params.id });
  if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const ok = cancelJob(parsed.data.id);
  if (!ok) { res.status(404).json({ error: "Job not found" }); return; }
  res.json({ message: "Cancelled" });
});

router.get("/audible/download/:id/file", async (req, res): Promise<void> => {
  const parsed = DownloadFileParams.safeParse({ id: req.params.id });
  if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const job = getJob(parsed.data.id);
  if (!job || job.status !== "done" || !job.outputPath) {
    res.status(404).json({ error: "File not ready" }); return;
  }
  if (!fs.existsSync(job.outputPath)) {
    res.status(404).json({ error: "File missing on disk" }); return;
  }

  const ext = path.extname(job.outputPath).slice(1);
  const mimeType = ext === "m4b" ? "audio/mp4" : "audio/mpeg";
  const fileName = `${job.title.replace(/[^a-z0-9 ]/gi, "_")}.${ext}`;
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  fs.createReadStream(job.outputPath).pipe(res);
});

// POST /audible/settings/activation-bytes
router.post("/audible/settings/activation-bytes", async (req, res): Promise<void> => {
  const { activationBytes } = req.body as { activationBytes?: string };
  if (!activationBytes || typeof activationBytes !== "string") {
    res.status(400).json({ error: "activationBytes is required" }); return;
  }
  setActivationBytes(activationBytes);
  res.json({ message: "Activation bytes saved" });
});

export default router;
