import { Route, Switch, Redirect } from "wouter";
import { AuthProvider, useAuth } from "./lib/authContext";
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

export default function App() {
  return (
    <AuthProvider>
      <Routes />
    </AuthProvider>
  );
}
