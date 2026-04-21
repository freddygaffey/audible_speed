import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/authContext";
import { initLogin, completeFromUrl } from "../lib/apiClient";
import { Loader2, ExternalLink, ClipboardPaste, Check } from "lucide-react";
import { isNative, getStoredServerUrl, saveServerUrl } from "../lib/platformConfig";

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
  const { setSession, refreshFromServer } = useAuth();
  const [step, setStep] = useState<Step>("marketplace");
  const [marketplace, setMarketplace] = useState("us");
  const [loginUrl, setLoginUrl] = useState("");
  const [pendingId, setPendingId] = useState("");
  const [pastedUrl, setPastedUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [serverUrl, setServerUrl] = useState(() => getStoredServerUrl());
  const [serverSaved, setServerSaved] = useState(false);

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
      const result = await completeFromUrl(pendingId, pastedUrl.trim());
      if (result.status === "success") {
        setSession({ username: result.username, email: result.email, marketplace: result.marketplace });
        await refreshFromServer();
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
            {isNative() && (
              <div className="space-y-2 rounded-lg border border-gray-800 bg-gray-900 p-3">
                <p className="text-xs font-medium text-gray-300">API server URL (required on device)</p>
                <p className="text-xs text-gray-500">
                  Example: http://192.168.1.10:3001 — must reach the machine running the Speed API.
                </p>
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(e) => {
                    setServerUrl(e.target.value);
                    setServerSaved(false);
                  }}
                  placeholder="http://192.168.1.10:3001"
                  className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    saveServerUrl(serverUrl);
                    setServerSaved(true);
                    setTimeout(() => setServerSaved(false), 1500);
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 hover:border-gray-500"
                >
                  {serverSaved && <Check className="h-3.5 w-3.5 text-green-400" />}
                  {serverSaved ? "Saved" : "Save server URL"}
                </button>
              </div>
            )}
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
              <div className="space-y-2">
                <p className="text-xs font-medium text-gray-300">Step 1 — Sign in to Audible</p>
                <a
                  href={loginUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-3 font-medium text-white hover:bg-orange-600"
                >
                  <ExternalLink className="h-4 w-4" />
                  Open Amazon Sign-in
                </a>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium text-gray-300">Step 2 — Paste the redirect URL</p>
                <p className="text-xs text-gray-500">
                  After signing in you'll see an Audible page — copy the full URL from your browser's address bar and paste it here.
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={pastedUrl}
                    onChange={(e) => setPastedUrl(e.target.value)}
                    placeholder="https://www.audible.com.au/ap/maplanding?..."
                    required
                    className="w-full flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none text-sm"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const t = await navigator.clipboard.readText();
                        setPastedUrl(t.trim());
                      } catch {
                        setError("Clipboard access denied — paste manually");
                      }
                    }}
                    className="flex-shrink-0 rounded-lg border border-gray-700 px-3 py-3 text-gray-300 hover:border-gray-500"
                    title="Paste from clipboard"
                  >
                    <ClipboardPaste className="h-4 w-4" />
                  </button>
                </div>
              </div>
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
