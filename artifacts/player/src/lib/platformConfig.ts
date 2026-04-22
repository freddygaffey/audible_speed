import { Capacitor } from "@capacitor/core";

/**
 * Fixed Speed API server (origin only, no path, no trailing slash).
 * All platforms use this build — no Vite proxy or localStorage override.
 */
export const SPEED_API_ORIGIN = "http://134.199.172.228:3001";

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
