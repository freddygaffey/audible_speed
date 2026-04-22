import type { ReactNode } from "react";
import { Route, Switch, Redirect } from "wouter";
import { AuthProvider, useAuth } from "./lib/authContext";
import { MobilePreviewProvider, useMobilePreview } from "./lib/mobilePreviewContext";
import Auth from "./pages/Auth";
import Library from "./pages/Library";
import Player from "./pages/Player";
import Settings from "./pages/Settings";

function Routes() {
  const { status } = useAuth();

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <Auth />;
  }

  return (
    <Switch>
      <Route path="/library" component={Library} />
      <Route path="/player/:asin" component={Player} />
      <Route path="/settings" component={Settings} />
      <Route path="/">
        <Redirect to="/library" />
      </Route>
    </Switch>
  );
}

function MobileLayoutShell({ children }: { children: ReactNode }) {
  const { mobilePreview } = useMobilePreview();
  if (!mobilePreview) {
    return <>{children}</>;
  }
  return (
    <div className="flex min-h-[100dvh] w-full flex-col bg-zinc-900 text-white">
      <div className="flex min-h-0 flex-1 justify-center overflow-hidden">
        <div
          className="flex w-full max-w-[390px] flex-col overflow-x-hidden overflow-y-auto bg-gray-950 shadow-2xl ring-1 ring-zinc-800"
          data-mobile-layout-preview
        >
          {children}
        </div>
      </div>
      <p className="hidden shrink-0 border-t border-zinc-800 px-3 py-2 text-center text-[11px] leading-snug text-zinc-500 sm:block">
        Mobile width preview (~390px), saved for next visit. Tailwind{" "}
        <code className="text-zinc-400">sm:</code> / <code className="text-zinc-400">md:</code> still follow your
        browser window — narrow the window too if you need true breakpoint behavior.
      </p>
    </div>
  );
}

export default function App() {
  return (
    <MobilePreviewProvider>
      <AuthProvider>
        <MobileLayoutShell>
          <Routes />
        </MobileLayoutShell>
      </AuthProvider>
    </MobilePreviewProvider>
  );
}
