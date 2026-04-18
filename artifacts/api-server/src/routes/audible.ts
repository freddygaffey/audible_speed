import { Router, type IRouter } from "express";
import fs from "fs";
import path from "path";
import {
  fetchLoginPage,
  submitCredentials,
  submitOtp,
  initLogin,
  completeFromUrl,
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
// Debug — probe what Amazon sends back during login (dev only)
// ---------------------------------------------------------------------------

router.post("/audible/auth/debug-login", async (req, res): Promise<void> => {
  const { email, password, marketplace = "us" } = req.body as {
    email?: string;
    password?: string;
    marketplace?: string;
  };

  if (!email || !password) {
    res.status(400).json({ error: "email and password required" });
    return;
  }

  const IOS_UA = "Audible/671 CFNetwork/1335.0.3 Darwin/21.6.0";
  const cfg = (MARKETPLACES as any)[marketplace] ?? (MARKETPLACES as any).us;

  try {
    // Step 1: fetch login page
    const params = new URLSearchParams({
      "openid.pape.preferred_auth_policies": "MultiFactor",
      "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
      "pageId": cfg.assocHandle,
      "openid.mode": "checkid_setup",
      "openid.ns.pape": "http://specs.openid.net/extensions/pape/1.0",
      "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
      "openid.assoc_handle": cfg.assocHandle,
      "openid.return_to": `https://${cfg.domain}/ap/maplanding`,
      "openid.ns": "http://specs.openid.net/auth/2.0",
    });
    const loginUrl = `https://${cfg.domain}/ap/signin?${params}`;
    const getResp = await fetch(loginUrl, {
      headers: { "User-Agent": IOS_UA, "Accept-Language": "en-US" },
      redirect: "follow",
    });
    const getHtml = await getResp.text();
    const setCookies = getResp.headers.getSetCookie?.() ?? [];

    // Extract hidden fields
    const fields: Record<string, string> = {};
    const re = /<input[^>]+type=["']hidden["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(getHtml)) !== null) {
      const tag = m[0];
      const nm = /name=["']([^"']+)["']/.exec(tag);
      const vm = /value=["']([^"']*)["']/.exec(tag);
      if (nm) fields[nm[1]] = vm ? vm[1] : "";
    }
    const actionM = /action=["']([^"']+)["']/.exec(getHtml);
    const formAction = actionM
      ? (actionM[1].startsWith("http") ? actionM[1] : `https://${cfg.domain}${actionM[1]}`)
      : `https://${cfg.domain}/ap/signin`;

    // Detect GET page
    const getPageType = getHtml.includes("ap_email") ? "login-form" : "other";

    // Step 2: submit credentials
    const cookieStr = setCookies.map((c: string) => c.split(";")[0]).join("; ");
    const postBody = new URLSearchParams({ ...fields, email, password, appAction: "SIGNIN" });
    const postResp = await fetch(formAction, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": IOS_UA,
        "Cookie": cookieStr,
        "Accept-Language": "en-US",
        "Referer": loginUrl,
      },
      body: postBody.toString(),
    });

    const postStatus = postResp.status;
    const postLocation = postResp.headers.get("location") ?? "";
    let postHtml = "";
    if (postStatus !== 301 && postStatus !== 302) {
      postHtml = await postResp.text();
    }

    res.json({
      step1: {
        url: getResp.url,
        status: getResp.status,
        pageType: getPageType,
        fieldCount: Object.keys(fields).length,
        fieldNames: Object.keys(fields),
        formAction,
        cookieCount: setCookies.length,
      },
      step2: {
        status: postStatus,
        location: postLocation,
        htmlSnippet: postHtml.slice(0, 2000),
        containsOtp: postHtml.includes("otpCode") || postHtml.includes("cvf-input"),
        containsCaptcha: postHtml.includes("captcha"),
        containsError: postHtml.includes("auth-error") || postHtml.includes("a-alert"),
        errorText: (() => {
          const em = /<div[^>]*class="[^"]*a-alert[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(postHtml);
          return em ? em[1].replace(/<[^>]+>/g, " ").trim().slice(0, 300) : null;
        })(),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ---------------------------------------------------------------------------
// Auth — server-side login (no client_id needed, uses Audible iOS UA)
// ---------------------------------------------------------------------------

// POST /audible/auth/login  — generate Amazon login URL (browser-based PKCE flow)
router.post("/audible/auth/login", async (req, res): Promise<void> => {
  const { marketplace = "us" } = req.body as { marketplace?: string };

  if (!MARKETPLACES[marketplace]) {
    res.status(400).json({ error: `Unknown marketplace: ${marketplace}` });
    return;
  }

  try {
    const { pendingId, loginUrl } = await initLogin(marketplace);
    res.json({ loginUrl, pendingId });
  } catch (err: any) {
    req.log.error({ err: err.message }, "initLogin failed");
    res.status(500).json({ error: err.message });
  }
});

// POST /audible/auth/complete-url  — complete login from pasted maplanding URL
router.post("/audible/auth/complete-url", async (req, res): Promise<void> => {
  const { pendingId, maplandingUrl, marketplace = "us" } = req.body as {
    pendingId?: string;
    maplandingUrl?: string;
    marketplace?: string;
  };

  if (!pendingId || !maplandingUrl) {
    res.status(400).json({ error: "pendingId and maplandingUrl are required" });
    return;
  }

  try {
    const result = await completeFromUrl(pendingId, maplandingUrl);

    if (result.status === "success") {
      setSession({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: new Date(Date.now() + result.expiresIn * 1000),
        username: result.username,
        email: result.email,
        marketplace,
      });
      req.log.info({ username: result.username, marketplace }, "Audible login complete");
      res.json({ status: "success", username: result.username, email: result.email, marketplace });
    } else {
      res.status(401).json({ status: "error", error: (result as any).message ?? "Auth failed" });
    }
  } catch (err: any) {
    req.log.error({ err: err.message }, "complete-url failed");
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
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  res.sendFile(job.outputPath);
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
