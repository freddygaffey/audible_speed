import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listDownloadJobs, startDownload, type DownloadJob } from "../lib/apiClient";

const ACTIVE = new Set(["queued", "downloading", "converting"]);

export function useDownloads() {
  const queryClient = useQueryClient();

  const { data: jobs = [] } = useQuery({
    queryKey: ["downloads"],
    queryFn: listDownloadJobs,
    refetchInterval: (query) => {
      const jobs = query.state.data ?? [];
      return jobs.some((j) => ACTIVE.has(j.status)) ? 2000 : false;
    },
  });

  const byAsin = new Map<string, DownloadJob>(jobs.map((j) => [j.asin, j]));

  async function download(asin: string, title: string) {
    await startDownload(asin, title, "m4b");
    await queryClient.invalidateQueries({ queryKey: ["downloads"] });
  }

  return { jobs, byAsin, download };
}
