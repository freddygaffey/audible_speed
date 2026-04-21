import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listDownloadJobs,
  startDownload,
  deleteDownloadForAsin,
  deleteAllDownloadedFiles,
  type DownloadJob,
} from "../lib/apiClient";
import { useAuth } from "../lib/authContext";

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

  const { data: jobs = [] } = useQuery({
    queryKey: ["downloads", ...accountKey],
    queryFn: listDownloadJobs,
    enabled: !!session,
    refetchInterval: (query) => {
      const jobs = query.state.data ?? [];
      return jobs.some((j) => ACTIVE.has(j.status)) ? 2000 : false;
    },
  });

  const byAsin = pickJobPerAsin(jobs);

  async function download(asin: string, title: string) {
    if (!session) return;
    await startDownload(asin, title, "m4b");
    await queryClient.invalidateQueries({
      queryKey: ["downloads", session.username, session.marketplace],
    });
  }

  async function removeDownload(asin: string) {
    if (!session) return;
    await deleteDownloadForAsin(asin);
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
    await queryClient.invalidateQueries({
      queryKey: ["downloads", session.username, session.marketplace],
    });
    await queryClient.invalidateQueries({
      queryKey: ["library", session.username, session.marketplace],
    });
  }

  return { jobs, byAsin, download, removeDownload, removeAllDownloads };
}
