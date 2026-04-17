import { Route, Switch } from "wouter";
import { AuthProvider, useAuth } from "./lib/authContext";
import Auth from "./pages/Auth";
import Home from "./pages/Home";

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
      <Route path="/" component={Home} />
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
