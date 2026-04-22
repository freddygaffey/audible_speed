import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { logger } from "./logger.js";

/** Bundled dev/prod entry is dist/index.mjs → one level up to api-server/scripts. Unbundled lib is dist/lib or src/lib → two levels up. */
function resolveAudibleAuthScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "../scripts/audible_auth.py"),
    path.join(here, "../../scripts/audible_auth.py"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return path.resolve(p);
  }
  throw new Error(
    `audible_auth.py not found from ${here}; tried: ${candidates.join(", ")}`,
  );
}

const SCRIPT = resolveAudibleAuthScript();
const API_SERVER_ROOT = path.resolve(path.dirname(SCRIPT), "..");
const VENV_PYTHON = path.join(API_SERVER_ROOT, ".venv", "bin", "python3");
const PYTHON = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";

logger.info({ script: SCRIPT, python: PYTHON }, "audible_auth.py resolved");

function runPython(args: string[], stdinData?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [SCRIPT, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => {
      stdout += d;
    });
    proc.stderr.on("data", (d: string) => {
      stderr += d;
    });
    if (stdinData !== undefined) {
      proc.stdin.write(stdinData, "utf8");
    }
    proc.stdin.end();
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`audible_auth.py exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as unknown);
      } catch {
        reject(new Error(`Invalid JSON from Python: ${stdout.slice(0, 200)}`));
      }
    });
    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ${PYTHON}: ${err.message}`));
    });
  });
}

export async function pyInitLogin(
  marketplace: string,
): Promise<{ loginUrl: string; pythonState: string }> {
  const result = (await runPython(["login", marketplace])) as {
    loginUrl?: string;
    state?: unknown;
    error?: string;
  };
  if (result.error) throw new Error(result.error);
  if (!result.loginUrl || result.state === undefined) {
    throw new Error("audible_auth.py login: missing loginUrl or state");
  }
  return { loginUrl: result.loginUrl, pythonState: JSON.stringify(result.state) };
}

export async function pyCompleteLogin(
  pythonState: string,
  maplandingUrl: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  username: string;
  email: string;
  adpToken: string;
  devicePrivateKey: string;
}> {
  const result = (await runPython(["complete", maplandingUrl], pythonState)) as {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    username?: string;
    email?: string;
    adpToken?: string;
    devicePrivateKey?: string;
    error?: string;
  };
  if (result.error) throw new Error(result.error);
  if (
    result.accessToken === undefined ||
    result.refreshToken === undefined ||
    result.expiresIn === undefined ||
    result.username === undefined ||
    result.email === undefined ||
    result.adpToken === undefined ||
    result.devicePrivateKey === undefined
  ) {
    throw new Error("audible_auth.py complete: missing token or ADP fields in response");
  }
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn,
    username: result.username,
    email: result.email,
    adpToken: result.adpToken,
    devicePrivateKey: result.devicePrivateKey,
  };
}
