import { Capacitor } from "@capacitor/core";

/** Default: Node `speed-api` on the droplet (no reverse proxy). Override via `VITE_SPEED_API_ORIGIN` if needed. */
const DEFAULT_SPEED_API_ORIGIN = "http://134.199.172.228:3001";

const fromEnv = import.meta.env.VITE_SPEED_API_ORIGIN?.trim();

/**
 * Override at build time with `VITE_SPEED_API_ORIGIN`, e.g.:
 * - **Local API on your Mac:** `pnpm build:local` → `http://127.0.0.1:3001` (Simulator uses host loopback).
 * - **SSH tunnel to VPS:** `pnpm build:tunnel` with `ssh -N -L 3001:127.0.0.1:3001 root@<droplet>`.
 */
export const SPEED_API_ORIGIN =
  fromEnv && fromEnv.length > 0 ? fromEnv.replace(/\/+$/, "") : DEFAULT_SPEED_API_ORIGIN;

function apiOrigin(): string {
  return SPEED_API_ORIGIN.replace(/\/+$/, "");
}

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

/** Same origin used for API calls and offline vault scoping. */
export function getStoredServerUrl(): string {
  return apiOrigin();
}

export function saveServerUrl(_url: string) {
  // Origin is fixed in this build.
}

export function getApiBaseUrl(): string {
  return `${apiOrigin()}/api`;
}
