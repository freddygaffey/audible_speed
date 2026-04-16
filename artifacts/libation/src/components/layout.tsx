import { Link, useLocation } from "wouter";
import { useGetAudibleAuthStatus, useLogoutAudible } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, Download, LogOut, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: authStatus } = useGetAudibleAuthStatus();
  const logout = useLogoutAudible();
  const queryClient = useQueryClient();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries();
      },
    });
  };

  return (
    <div className="min-h-screen flex w-full bg-background text-foreground font-sans">
      <aside className="w-64 border-r border-border flex flex-col bg-card">
        <div className="p-6 border-b border-border flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center font-bold">
            <TerminalSquare size={18} />
          </div>
          <div>
            <h1 className="font-mono font-bold tracking-tight text-lg leading-none">Libation</h1>
            <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider mt-1">Terminal UI</p>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          <Link href="/" className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${location === '/' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>
            <BookOpen size={16} />
            Library
          </Link>
          <Link href="/downloads" className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${location === '/downloads' ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>
            <Download size={16} />
            Downloads
          </Link>
        </nav>

        <div className="p-4 border-t border-border">
          <div className="mb-4 px-2">
            <p className="text-xs font-mono text-muted-foreground truncate" title={authStatus?.email || ""}>
              {authStatus?.email || "Unknown User"}
            </p>
            <p className="text-[10px] text-muted-foreground uppercase mt-1">
              Marketplace: {authStatus?.marketplace || "N/A"}
            </p>
          </div>
          <Button variant="outline" className="w-full justify-start text-muted-foreground" onClick={handleLogout} disabled={logout.isPending}>
            <LogOut size={14} className="mr-2" />
            {logout.isPending ? "Disconnecting..." : "Disconnect"}
          </Button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        {children}
      </main>
    </div>
  );
}
