import dns from "node:dns";
import { execSync } from "node:child_process";
import app from "./app";
import { logger } from "./lib/logger";

// Prefer IPv4 when resolving Audible/CDN — avoids common macOS "fetch failed" when IPv6 routes are broken.
dns.setDefaultResultOrder("ipv4first");

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  // Ensure startup/runtime crashes are visible even if logger transport fails to flush.
  console.error("[speed-api] uncaughtException", err);
  logger.fatal({ err }, "Uncaught exception");
  process.exit(1);
});

try {
  execSync("python3 -c 'import audible'", { stdio: "pipe" });
} catch {
  logger.error("Python package 'audible' not found. Install with:");
  logger.error(
    "python3 -m pip install -r artifacts/api-server/requirements.txt",
  );
  process.exit(1);
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
