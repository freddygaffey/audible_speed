import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getDownloadDiagnostics } from "../lib/downloadManager.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/healthz/runtime", (_req, res) => {
  const data = {
    status: "ok" as const,
    downloads: getDownloadDiagnostics(),
  };
  res.json(data);
});

export default router;
