const KEY = "speed_activation_bytes";

export function saveActivationBytes(bytes: string) {
  localStorage.setItem(KEY, bytes);
}

export function loadActivationBytes(): string | null {
  return localStorage.getItem(KEY);
}

export function clearActivationBytes() {
  localStorage.removeItem(KEY);
}

export function isValidActivationBytes(s: string): boolean {
  return /^[0-9a-fA-F]{8}$/.test(s.trim());
}
