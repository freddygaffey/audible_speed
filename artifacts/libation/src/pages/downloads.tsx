import { useListDownloads, useCancelDownload, DownloadJob, useStartDownload } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X, RefreshCw, Save, HardDriveDownload, AlertTriangle, CheckCircle2, Loader2, ArrowDownToLine } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";

export default function DownloadsPage() {
  const { data: downloads = [], isLoading } = useListDownloads({
    query: {
      refetchInterval: (query) => {
        const jobs = query.state.data;
        const hasActive = jobs?.some(j => j.status === "queued" || j.status === "downloading" || j.status === "converting");
        return hasActive ? 2000 : false;
      }
    }
  });

  const activeDownloads = downloads.filter(d => ["queued", "downloading", "converting"].includes(d.status));
  const completedDownloads = downloads.filter(d => ["done", "error"].includes(d.status));

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex-none border-b border-border bg-card p-6">
        <h1 className="text-xl font-mono font-bold flex items-center gap-2">
          <HardDriveDownload className="text-primary" />
          Download Queue
        </h1>
      </div>

      <ScrollArea className="flex-1 p-6">
        <div className="space-y-8 max-w-4xl mx-auto">
          {isLoading && downloads.length === 0 ? (
            <div className="text-center text-muted-foreground font-mono py-12 animate-pulse">Loading queue...</div>
          ) : (
            <>
              <section>
                <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-muted-foreground mb-4">Active ({activeDownloads.length})</h2>
                {activeDownloads.length === 0 ? (
                  <div className="bg-card border border-border border-dashed rounded-lg p-8 text-center text-muted-foreground font-mono text-sm">
                    No active downloads
                  </div>
                ) : (
                  <div className="space-y-3">
                    {activeDownloads.map(job => (
                      <DownloadCard key={job.id} job={job} />
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-muted-foreground mb-4">Completed / Failed ({completedDownloads.length})</h2>
                {completedDownloads.length === 0 ? (
                  <div className="bg-card border border-border border-dashed rounded-lg p-8 text-center text-muted-foreground font-mono text-sm">
                    No history
                  </div>
                ) : (
                  <div className="space-y-3">
                    {completedDownloads.map(job => (
                      <DownloadCard key={job.id} job={job} />
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function DownloadCard({ job }: { job: DownloadJob }) {
  const cancel = useCancelDownload();
  const startDownload = useStartDownload();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isDone = job.status === "done";
  const isError = job.status === "error";
  const isActive = !isDone && !isError;

  const handleCancel = () => {
    cancel.mutate({ id: job.id }, {
      onSuccess: () => queryClient.invalidateQueries()
    });
  };

  const handleRetry = () => {
    startDownload.mutate({ data: { asin: job.asin, title: job.title, format: job.format } }, {
      onSuccess: () => queryClient.invalidateQueries()
    });
  };

  const handleSave = () => {
    const apiBase = import.meta.env.VITE_API_URL ?? "";
    const a = document.createElement("a");
    a.href = `${apiBase}/api/audible/download/${job.id}/file`;
    a.download = "";
    a.click();
  };

  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-4 transition-all hover:border-border/80">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-bold text-sm truncate">{job.title}</h3>
            <StatusBadge status={job.status} />
          </div>
          <div className="flex items-center gap-3 text-xs font-mono text-muted-foreground">
            <span>ASIN: {job.asin}</span>
            <span>•</span>
            <span>{job.format.toUpperCase()}</span>
            <span>•</span>
            <span title={new Date(job.updatedAt).toLocaleString()}>
              {formatDistanceToNow(new Date(job.updatedAt), { addSuffix: true })}
            </span>
          </div>
          {isError && job.error && (
            <p className="mt-2 text-xs font-mono text-destructive bg-destructive/10 p-2 rounded-md border border-destructive/20">
              {job.error}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isActive && (
            <Button variant="outline" size="icon" onClick={handleCancel} disabled={cancel.isPending} title="Cancel">
              <X size={14} />
            </Button>
          )}
          {isError && (
            <Button variant="outline" size="sm" onClick={handleRetry} disabled={startDownload.isPending} className="font-mono text-xs">
              <RefreshCw size={14} className="mr-2" /> Retry
            </Button>
          )}
          {isDone && (
            <Button onClick={handleSave} className="font-mono text-xs shadow-none" size="sm">
              <Save size={14} className="mr-2" /> Save to Disk
            </Button>
          )}
        </div>
      </div>

      {isActive && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs font-mono text-muted-foreground">
            <span>Progress</span>
            <span>{Math.round(job.progress)}%</span>
          </div>
          <Progress value={job.progress} className="h-1.5" />
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "done":
      return <Badge className="bg-green-500/10 text-green-500 border-green-500/20 hover:bg-green-500/20 text-[10px] font-mono px-1.5 py-0 rounded-sm"><CheckCircle2 size={10} className="mr-1 inline" />DONE</Badge>;
    case "error":
      return <Badge className="bg-red-500/10 text-red-500 border-red-500/20 hover:bg-red-500/20 text-[10px] font-mono px-1.5 py-0 rounded-sm"><AlertTriangle size={10} className="mr-1 inline" />ERROR</Badge>;
    case "downloading":
      return <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20 hover:bg-blue-500/20 text-[10px] font-mono px-1.5 py-0 rounded-sm"><ArrowDownToLine size={10} className="mr-1 inline animate-pulse" />DOWNLOADING</Badge>;
    case "converting":
      return <Badge className="bg-purple-500/10 text-purple-500 border-purple-500/20 hover:bg-purple-500/20 text-[10px] font-mono px-1.5 py-0 rounded-sm"><Loader2 size={10} className="mr-1 inline animate-spin" />CONVERTING</Badge>;
    case "queued":
    default:
      return <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0 rounded-sm text-muted-foreground">QUEUED</Badge>;
  }
}
