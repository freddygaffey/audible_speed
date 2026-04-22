import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listDownloadJobs,
  startDownload,
  deleteDownloadForAsin,
  markDownloadTransferred,
  deleteAllDownloadedFiles,
  type DownloadJob,
} from "../lib/apiClient";
import { useAuth } from "../lib/authContext";
import { getApiBaseUrl, getStoredServerUrl, isNative } from "../lib/platformConfig";
import {
  ensureVaultCopy,
  removeVaultAsin,
  clearVaultScope,
  listVaultEntries,
  type VaultEntry,
} from "../lib/audioVault";

const ACTIVE = new Set(["queued", "downloading", "converting"]);

/** One job per ASIN: prefer done, then active, then newest terminal (avoids stale errors hiding success). */
function pickJobPerAsin(jobs: DownloadJob[]): Map<string, DownloadJob> {
  const byAsin = new Map<string, DownloadJob[]>();
  for (const j of jobs) {
    const list = byAsin.get(j.asin) ?? [];
    list.push(j);
    byAsin.set(j.asin, list);
  }
  const out = new Map<string, DownloadJob>();
  for (const [asin, list] of byAsin) {
    const sorted = [...list].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const done = sorted.find((j) => j.status === "done");
    if (done) {
      out.set(asin, done);
      continue;
    }
    const active = sorted.find((j) => ACTIVE.has(j.status));
    if (active) {
      out.set(asin, active);
      continue;
    }
    out.set(asin, sorted[0]!);
  }
  return out;
}

export function useDownloads() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const accountKey = session ? [session.username, session.marketplace] as const : ["", ""] as const;
  const [vaultEntries, setVaultEntries] = useState<VaultEntry[]>([]);
  const autoDeletedServerJobsRef = useRef<Set<string>>(new Set());

  const refreshVaultEntries = useCallback(async () => {
    if (!session || !isNative()) {
      setVaultEntries([]);
      return;
    }
    const serverUrl = getStoredServerUrl();
    if (!serverUrl) {
      setVaultEntries([]);
      return;
    }
    const entries = await listVaultEntries({
      serverUrl,
      username: session.username,
      marketplace: session.marketplace,
    });
    setVaultEntries(entries);
  }, [session]);

  const { data: jobs = [] } = useQuery({
    queryKey: ["downloads", ...accountKey],
    queryFn: listDownloadJobs,
    enabled: !!session,
    refetchInterval: (query) => {
      const jobs = query.state.data ?? [];
      return jobs.some((j) => ACTIVE.has(j.status)) ? 2000 : false;
    },
  });

  useEffect(() => {
    void refreshVaultEntries();
  }, [refreshVaultEntries, jobs]);

  const mergedJobs = useMemo(() => {
    const out = [...jobs];
    for (const entry of vaultEntries) {
      if (out.some((j) => j.asin === entry.asin && j.status === "done")) continue;
      const ts = new Date(entry.savedAt || Date.now()).toISOString();
      out.push({
        id: `local:${entry.asin}:${entry.jobId}`,
        asin: entry.asin,
        title: entry.asin,
        status: "done",
        progress: 100,
        format: "m4b",
        outputPath: null,
        error: null,
        createdAt: ts,
        updatedAt: ts,
      });
    }
    return out;
  }, [jobs, vaultEntries]);

  const byAsin = pickJobPerAsin(mergedJobs);

  useEffect(() => {
    if (!session || !isNative()) return;
    const serverUrl = getStoredServerUrl();
    if (!serverUrl) return;
    const base = getApiBaseUrl();
    const keepServerDownloads = import.meta.env.VITE_KEEP_SERVER_DOWNLOADS === "1";
    for (const j of jobs) {
      if (j.status !== "done") continue;
      if (j.id.startsWith("local:")) continue;
      const remoteUrl = `${base}/audible/download/${j.id}/file`;
      void ensureVaultCopy({
        serverUrl,
        username: session.username,
        marketplace: session.marketplace,
        asin: j.asin,
        jobId: j.id,
        remoteUrl,
      })
        .then(async () => {
          if (keepServerDownloads) return;
          if (autoDeletedServerJobsRef.current.has(j.id)) return;
          autoDeletedServerJobsRef.current.add(j.id);
          try {
            await markDownloadTransferred(j.id);
          } catch {
            // Older server fallback path: delete by ASIN.
            await deleteDownloadForAsin(j.asin);
          }
          await queryClient.invalidateQueries({
            queryKey: ["downloads", session.username, session.marketplace],
          });
          await queryClient.invalidateQueries({
            queryKey: ["library", session.username, session.marketplace],
          });
        })
        .catch(() => {
          // Keep local/offline flow robust even if a transfer/delete step fails.
        });
    }
  }, [jobs, queryClient, session]);

  async function download(asin: string, title: string) {
    if (!session) return;
    await startDownload(asin, title, "m4b");
    await queryClient.invalidateQueries({
      queryKey: ["downloads", session.username, session.marketplace],
    });
  }

  async function downloadBatch(items: Array<{ asin: string; title: string }>) {
    if (!session || items.length === 0) return;
    for (const item of items) {
      await startDownload(item.asin, item.title, "m4b");
    }
    await queryClient.invalidateQueries({
      queryKey: ["downloads", session.username, session.marketplace],
    });
  }

  async function removeDownload(asin: string) {
    if (!session) return;
    await deleteDownloadForAsin(asin);
    const serverUrl = getStoredServerUrl();
    if (serverUrl && isNative()) {
      await removeVaultAsin({
        serverUrl,
        username: session.username,
        marketplace: session.marketplace,
        asin,
      });
      await refreshVaultEntries();
    }
    await queryClient.invalidateQueries({
      queryKey: ["downloads", session.username, session.marketplace],
    });
    await queryClient.invalidateQueries({
      queryKey: ["library", session.username, session.marketplace],
    });
  }

  async function removeAllDownloads() {
    if (!session) return;
    await deleteAllDownloadedFiles();
    const serverUrl = getStoredServerUrl();
    if (serverUrl && isNative()) {
      await clearVaultScope({
        serverUrl,
        username: session.username,
        marketplace: session.marketplace,
      });
      await refreshVaultEntries();
    }
    await queryClient.invalidateQueries({
      queryKey: ["downloads", session.username, session.marketplace],
    });
    await queryClient.invalidateQueries({
      queryKey: ["library", session.username, session.marketplace],
    });
  }

  return {
    jobs: mergedJobs,
    byAsin,
    download,
    downloadBatch,
    removeDownload,
    removeAllDownloads,
  };
}
