import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/authContext";
import { initLogin, completeFromUrl } from "../lib/apiClient";
import { Loader2, ExternalLink } from "lucide-react";

const MARKETPLACES = [
  { id: "us", label: "United States" },
  { id: "uk", label: "United Kingdom" },
  { id: "ca", label: "Canada" },
  { id: "au", label: "Australia" },
  { id: "de", label: "Germany" },
  { id: "fr", label: "France" },
  { id: "jp", label: "Japan" },
  { id: "it", label: "Italy" },
  { id: "es", label: "Spain" },
] as const;

type Step = "marketplace" | "awaiting";

export default function Auth() {
  const { setSession } = useAuth();
  const [step, setStep] = useState<Step>("marketplace");
  const [marketplace, setMarketplace] = useState("us");
  const [loginUrl, setLoginUrl] = useState("");
  const [pendingId, setPendingId] = useState("");
  const [pastedUrl, setPastedUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleMarketplace(mkt: string) {
    setMarketplace(mkt);
    setLoading(true);
    setError("");
    try {
      const result = await initLogin(mkt);
      setLoginUrl(result.loginUrl);
      setPendingId(result.pendingId);
      setStep("awaiting");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start login");
    } finally {
      setLoading(false);
    }
  }

  async function handleComplete(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await completeFromUrl(pendingId, pastedUrl.trim(), marketplace);
      if (result.status === "success") {
        setSession({ username: result.username, email: result.email, marketplace: result.marketplace });
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white">Speed</h1>
          <p className="mt-1 text-sm text-gray-400">Audible at 16×</p>
        </div>

        {step === "marketplace" && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-gray-300">Select your Audible marketplace</p>
            {loading && (
              <div className="flex justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-orange-400" />
              </div>
            )}
            {!loading && (
              <div className="grid grid-cols-3 gap-2">
                {MARKETPLACES.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => handleMarketplace(m.id)}
                    className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                      marketplace === m.id
                        ? "border-orange-500 bg-orange-500/10 text-orange-400"
                        : "border-gray-700 bg-gray-900 text-gray-300 hover:border-gray-500"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>
        )}

        {step === "awaiting" && (
          <form onSubmit={handleComplete} className="space-y-4">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { setStep("marketplace"); setError(""); }}
                className="text-xs text-gray-500 hover:text-gray-300"
              >
                ← {MARKETPLACES.find((m) => m.id === marketplace)?.label}
              </button>
            </div>

            <div className="space-y-3">
              <a
                href={loginUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-3 font-medium text-white hover:bg-orange-600"
              >
                <ExternalLink className="h-4 w-4" />
                Open Amazon Sign-in
              </a>

              <p className="text-xs text-gray-400">
                Sign in with your Amazon credentials. After signing in, your browser will show a
                page that says <span className="text-gray-200">"Looking for something?"</span> —
                copy the full URL from your browser's address bar and paste it below.
              </p>

              <input
                type="text"
                value={pastedUrl}
                onChange={(e) => setPastedUrl(e.target.value)}
                placeholder="Paste the redirect URL here"
                required
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none text-sm"
              />
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={loading || !pastedUrl.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-3 font-medium text-white hover:bg-orange-600 disabled:opacity-50"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Complete Sign-in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
