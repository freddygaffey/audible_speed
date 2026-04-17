import { Capacitor } from "@capacitor/core";

const SERVER_URL_KEY = "speed_server_url";

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export function getStoredServerUrl(): string {
  return localStorage.getItem(SERVER_URL_KEY) ?? "";
}

export function saveServerUrl(url: string) {
  localStorage.setItem(SERVER_URL_KEY, url.replace(/\/$/, ""));
}

export function getApiBaseUrl(): string {
  if (!isNative()) return "/api";
  const stored = getStoredServerUrl();
  if (stored) return `${stored}/api`;
  return "/api";
}
