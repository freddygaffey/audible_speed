import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { LibraryIdentity } from "./libraryCache";

const VAULT_ROOT = "speed_vault";

export type VaultIdentity = LibraryIdentity & { serverUrl: string };

function isNativeVault(): boolean {
  return Capacitor.isNativePlatform();
}

/** FNV-1a 32-bit hex — stable scope folder per server + account */
export function vaultScopeHash(serverUrl: string, username: string, marketplace: string): string {
  const s = `${serverUrl.replace(/\/$/, "")}|${username}|${marketplace}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function safeAsin(asin: string): string {
  return asin.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function scopeDir(hash: string): string {
  return `${VAULT_ROOT}/${hash}`;
}

function audioRelPath(hash: string, asin: string): string {
  return `${scopeDir(hash)}/${safeAsin(asin)}.m4b`;
}

function indexRelPath(hash: string): string {
  return `${scopeDir(hash)}/index.json`;
}

type IndexEntry = {
  jobId: string;
  savedAt: number;
  bytes: number;
  source: "server-transfer";
  version: 1;
};
type VaultIndexFile = { v: 1; entries: Record<string, IndexEntry> };
export type VaultEntry = { asin: string; jobId: string; savedAt: number; bytes: number };

const inFlight = new Map<string, Promise<void>>();

async function ensureVaultRootDir(): Promise<void> {
  await Filesystem.mkdir({
    path: VAULT_ROOT,
    directory: Directory.Data,
    recursive: true,
  });
}

async function listVaultScopes(): Promise<Set<string>> {
  await ensureVaultRootDir();
  const root = await Filesystem.readdir({ path: VAULT_ROOT, directory: Directory.Data });
  return new Set(root.files.map((f) => f.name));
}

async function readIndex(hash: string): Promise<VaultIndexFile> {
  await Filesystem.mkdir({
    path: scopeDir(hash),
    directory: Directory.Data,
    recursive: true,
  });
  const scopeEntries = await Filesystem.readdir({
    path: scopeDir(hash),
    directory: Directory.Data,
  });
  if (!scopeEntries.files.some((f) => f.name === "index.json")) {
    return { v: 1, entries: {} };
  }
  try {
    const { data } = await Filesystem.readFile({
      path: indexRelPath(hash),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    const raw = typeof data === "string" ? data : "";
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as VaultIndexFile).v === 1 &&
      typeof (parsed as VaultIndexFile).entries === "object"
    ) {
      return parsed as VaultIndexFile;
    }
  } catch {
    /* missing or corrupt */
  }
  return { v: 1, entries: {} };
}

async function writeIndex(hash: string, index: VaultIndexFile): Promise<void> {
  await Filesystem.mkdir({
    path: scopeDir(hash),
    directory: Directory.Data,
    recursive: true,
  });
  await Filesystem.writeFile({
    path: indexRelPath(hash),
    data: JSON.stringify(index),
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
  });
}

/**
 * If a vault file exists for this ASIN and jobId, returns a WebView-safe URL for `<audio src>`.
 */
export async function getLocalPlaybackUrl(params: VaultIdentity & { asin: string; jobId: string }): Promise<string | null> {
  if (!isNativeVault()) return null;
  const { serverUrl, username, marketplace, asin, jobId } = params;
  const hash = vaultScopeHash(serverUrl, username, marketplace);
  const index = await readIndex(hash);
  const ent = index.entries[asin];
  if (!ent || ent.jobId !== jobId) return null;
  try {
    await Filesystem.stat({
      path: audioRelPath(hash, asin),
      directory: Directory.Data,
    });
  } catch {
    return null;
  }
  const { uri } = await Filesystem.getUri({
    directory: Directory.Data,
    path: audioRelPath(hash, asin),
  });
  return Capacitor.convertFileSrc(uri);
}

/** Returns a local playback URL for this ASIN regardless of current server job id. */
export async function getAnyLocalPlaybackUrl(
  params: VaultIdentity & { asin: string },
): Promise<string | null> {
  if (!isNativeVault()) return null;
  const { serverUrl, username, marketplace, asin } = params;
  const hash = vaultScopeHash(serverUrl, username, marketplace);
  const index = await readIndex(hash);
  if (!index.entries[asin]) return null;
  try {
    await Filesystem.stat({
      path: audioRelPath(hash, asin),
      directory: Directory.Data,
    });
  } catch {
    return null;
  }
  const { uri } = await Filesystem.getUri({
    directory: Directory.Data,
    path: audioRelPath(hash, asin),
  });
  return Capacitor.convertFileSrc(uri);
}

/** Read local vault entries for the current server/account scope. */
export async function listVaultEntries(identity: VaultIdentity): Promise<VaultEntry[]> {
  if (!isNativeVault()) return [];
  const hash = vaultScopeHash(identity.serverUrl, identity.username, identity.marketplace);
  const index = await readIndex(hash);
  return Object.entries(index.entries).map(([asin, ent]) => ({
    asin,
    jobId: ent.jobId,
    savedAt: ent.savedAt,
    bytes: ent.bytes,
  }));
}

/**
 * Downloads the finished M4B from the API into the app sandbox (native only).
 */
export function ensureVaultCopy(params: VaultIdentity & { asin: string; jobId: string; remoteUrl: string }): Promise<void> {
  if (!isNativeVault()) return Promise.resolve();
  const { serverUrl, username, marketplace, asin, jobId, remoteUrl } = params;
  const hash = vaultScopeHash(serverUrl, username, marketplace);
  const key = `${hash}:${asin}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = (async () => {
    const index = await readIndex(hash);
    const ent = index.entries[asin];
    const rel = audioRelPath(hash, asin);
    if (ent?.jobId === jobId) {
      try {
        await Filesystem.stat({ path: rel, directory: Directory.Data });
        return;
      } catch {
        /* re-download below */
      }
    }

    await Filesystem.mkdir({
      path: scopeDir(hash),
      directory: Directory.Data,
      recursive: true,
    });

    if (ent && ent.jobId !== jobId) {
      try {
        await Filesystem.deleteFile({ path: rel, directory: Directory.Data });
      } catch {
        /* ignore */
      }
    }

    await Filesystem.downloadFile({
      url: remoteUrl,
      path: rel,
      directory: Directory.Data,
      recursive: true,
    });

    let bytes = 0;
    try {
      const st = await Filesystem.stat({ path: rel, directory: Directory.Data });
      bytes = typeof st.size === "number" ? st.size : 0;
    } catch {
      bytes = 0;
    }

    const next: VaultIndexFile = {
      v: 1,
      entries: {
        ...index.entries,
        [asin]: {
          jobId,
          savedAt: Date.now(),
          bytes,
          source: "server-transfer",
          version: 1,
        },
      },
    };
    await writeIndex(hash, next);
  })();

  inFlight.set(key, task);
  void task.finally(() => {
    inFlight.delete(key);
  });
  return task;
}

export async function removeVaultAsin(params: VaultIdentity & { asin: string }): Promise<void> {
  if (!isNativeVault()) return;
  const hash = vaultScopeHash(params.serverUrl, params.username, params.marketplace);
  const scopes = await listVaultScopes();
  if (!scopes.has(hash)) return;
  const index = await readIndex(hash);
  if (!index.entries[params.asin]) return;
  const { [params.asin]: _removed, ...rest } = index.entries;
  try {
    await Filesystem.deleteFile({
      path: audioRelPath(hash, params.asin),
      directory: Directory.Data,
    });
  } catch {
    /* ignore */
  }
  await writeIndex(hash, { v: 1, entries: rest });
}

export async function clearVaultScope(identity: VaultIdentity): Promise<void> {
  if (!isNativeVault()) return;
  const hash = vaultScopeHash(identity.serverUrl, identity.username, identity.marketplace);
  const scopes = await listVaultScopes();
  if (!scopes.has(hash)) return;
  try {
    await Filesystem.rmdir({
      path: scopeDir(hash),
      directory: Directory.Data,
      recursive: true,
    });
  } catch {
    /* already gone */
  }
}

/** Remove all `speed_vault` trees (Settings “clear offline audio”). */
export async function clearAllVaults(): Promise<void> {
  if (!isNativeVault()) return;
  await ensureVaultRootDir();
  try {
    await Filesystem.rmdir({
      path: VAULT_ROOT,
      directory: Directory.Data,
      recursive: true,
    });
  } catch {
    /* ignore */
  }
}

/** Sum bytes of `.m4b` files under `speed_vault` (best-effort). */
export async function getVaultTotalBytes(): Promise<number> {
  if (!isNativeVault()) return 0;
  let total = 0;
  try {
    await ensureVaultRootDir();
    const scopes = await Filesystem.readdir({ path: VAULT_ROOT, directory: Directory.Data });
    for (const name of scopes.files.map((f) => f.name)) {
      const scopePath = `${VAULT_ROOT}/${name}`;
      let files;
      try {
        files = await Filesystem.readdir({ path: scopePath, directory: Directory.Data });
      } catch {
        continue;
      }
      for (const f of files.files) {
        if (f.type !== "file" || !f.name.endsWith(".m4b")) continue;
        try {
          const st = await Filesystem.stat({
            path: `${scopePath}/${f.name}`,
            directory: Directory.Data,
          });
          if (typeof st.size === "number") total += st.size;
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    return 0;
  }
  return total;
}

export function formatVaultBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
