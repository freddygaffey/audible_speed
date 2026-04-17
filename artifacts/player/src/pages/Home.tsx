import { useAuth } from "../lib/authContext";
import { LogOut } from "lucide-react";

export default function Home() {
  const { session, signOut } = useAuth();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-gray-950 text-white">
      <h1 className="text-4xl font-bold">Speed Player</h1>
      {session && (
        <div className="flex flex-col items-center gap-2 text-gray-400">
          <p className="text-sm">Signed in as <span className="text-white">{session.username}</span></p>
          <p className="text-xs">{session.email} · {session.marketplace.toUpperCase()}</p>
          <button
            onClick={signOut}
            className="mt-2 flex items-center gap-1 rounded-lg border border-gray-700 px-3 py-1.5 text-xs hover:border-gray-500"
          >
            <LogOut className="h-3 w-3" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
