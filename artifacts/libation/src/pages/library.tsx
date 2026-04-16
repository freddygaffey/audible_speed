import { useState } from "react";
import { useGetAudibleLibrary, useGetLibraryStats, useStartDownload, AudibleBook } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, LayoutGrid, List as ListIcon, DownloadCloud, Clock, BookMarked, HardDriveDownload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function LibraryPage() {
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [searchQuery, setSearchQuery] = useState("");
  
  const { data: library, isLoading } = useGetAudibleLibrary({ page: 1, pageSize: 100 });
  const { data: stats } = useGetLibraryStats();
  
  const filteredBooks = library?.books.filter(book => 
    book.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
    book.authors.some(a => a.toLowerCase().includes(searchQuery.toLowerCase()))
  ) || [];

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Stats Bar */}
      <div className="flex-none border-b border-border bg-card p-4 flex items-center justify-between">
        <div className="flex gap-6">
          <div className="flex items-center gap-2">
            <BookMarked className="text-muted-foreground" size={16} />
            <div className="font-mono">
              <span className="text-xl font-bold">{stats?.total || 0}</span>
              <span className="text-xs text-muted-foreground ml-1 uppercase">Books</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <HardDriveDownload className="text-muted-foreground" size={16} />
            <div className="font-mono">
              <span className="text-xl font-bold">{stats?.downloaded || 0}</span>
              <span className="text-xs text-muted-foreground ml-1 uppercase">Downloaded</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="text-muted-foreground" size={16} />
            <div className="font-mono">
              <span className="text-xl font-bold">{stats?.totalHours ? Math.round(stats.totalHours) : 0}</span>
              <span className="text-xs text-muted-foreground ml-1 uppercase">Hours</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search library..."
              className="pl-9 font-mono text-sm bg-background border-border"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="flex items-center border border-border rounded-md overflow-hidden bg-background">
            <button 
              className={`p-2 transition-colors ${viewMode === 'grid' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-secondary'}`}
              onClick={() => setViewMode('grid')}
            >
              <LayoutGrid size={16} />
            </button>
            <button 
              className={`p-2 transition-colors ${viewMode === 'list' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-secondary'}`}
              onClick={() => setViewMode('list')}
            >
              <ListIcon size={16} />
            </button>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 p-6">
        {isLoading ? (
          <div className={`grid gap-6 ${viewMode === 'grid' ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5' : 'grid-cols-1'}`}>
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className={`flex ${viewMode === 'list' ? 'flex-row gap-4' : 'flex-col gap-2'}`}>
                <Skeleton className={viewMode === 'grid' ? 'aspect-square w-full rounded-md' : 'w-24 h-24 rounded-md'} />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredBooks.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground font-mono">
            {searchQuery ? "No books found matching search." : "No books in library."}
          </div>
        ) : (
          <div className={`grid gap-6 ${viewMode === 'grid' ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6' : 'grid-cols-1'}`}>
            {filteredBooks.map((book) => (
              <BookCard key={book.asin} book={book} viewMode={viewMode} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function BookCard({ book, viewMode }: { book: AudibleBook, viewMode: "grid" | "list" }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const startDownload = useStartDownload();

  const handleDownload = () => {
    startDownload.mutate(
      { data: { asin: book.asin, title: book.title, format: "m4b" } },
      {
        onSuccess: () => {
          toast({ title: "Download Started", description: `Queued ${book.title} for download.` });
          queryClient.invalidateQueries();
        },
        onError: () => {
          toast({ title: "Download Failed", description: "Could not start download.", variant: "destructive" });
        }
      }
    );
  };

  const isList = viewMode === "list";
  const hours = book.runtimeMinutes ? Math.floor(book.runtimeMinutes / 60) : 0;
  const mins = book.runtimeMinutes ? book.runtimeMinutes % 60 : 0;

  return (
    <div className={`group relative flex ${isList ? 'flex-row gap-4 bg-card p-3 rounded-lg border border-border' : 'flex-col gap-3'}`}>
      <div className={`relative overflow-hidden rounded-md bg-secondary flex-none border border-border ${isList ? 'w-24 h-24' : 'aspect-square w-full'}`}>
        {book.coverUrl ? (
          <img src={book.coverUrl} alt={book.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <BookMarked size={32} className="text-muted-foreground/30" />
          </div>
        )}
        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-sm">
          <Button size="sm" className="font-mono text-xs" onClick={handleDownload} disabled={startDownload.isPending || book.status === "downloading"}>
            <DownloadCloud size={14} className="mr-2" />
            {book.status === "downloaded" ? "Re-download" : "Download"}
          </Button>
        </div>
      </div>
      
      <div className="flex flex-col flex-1 min-w-0 justify-center">
        <h3 className="font-bold text-sm leading-tight truncate text-foreground mb-1" title={book.title}>{book.title}</h3>
        <p className="text-xs text-muted-foreground truncate mb-1">{book.authors.join(", ")}</p>
        
        <div className={`flex items-center gap-2 mt-auto ${isList ? '' : 'pt-2'}`}>
          {book.status === "downloaded" && (
            <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-[10px] font-mono rounded-sm px-1.5 py-0">DL'd</Badge>
          )}
          {book.status === "downloading" && (
            <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-[10px] font-mono rounded-sm px-1.5 py-0 animate-pulse">In Prog</Badge>
          )}
          {book.runtimeMinutes && (
            <span className="text-[10px] font-mono text-muted-foreground ml-auto">
              {hours}h {mins}m
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
