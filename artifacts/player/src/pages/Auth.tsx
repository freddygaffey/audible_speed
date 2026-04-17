import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/authContext";
import { login, submitOtp } from "../lib/apiClient";
import { Loader2 } from "lucide-react";

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

type Step = "marketplace" | "credentials" | "otp";

export default function Auth() {
  const { setSession } = useAuth();
  const [step, setStep] = useState<Step>("marketplace");
  const [marketplace, setMarketplace] = useState("us");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [pendingId, setPendingId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleCredentials(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await login(email, password, marketplace);
      if (result.status === "success") {
        setSession({ username: result.username, email: result.email, marketplace: result.marketplace });
      } else if (result.status === "otp") {
        setPendingId(result.pendingId);
        setStep("otp");
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleOtp(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await submitOtp(pendingId, otp, marketplace);
      if (result.status === "success") {
        setSession({ username: result.username, email: result.email, marketplace: result.marketplace });
      } else if (result.status === "otp") {
        setPendingId(result.pendingId);
        setError("Incorrect code, try again.");
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "OTP failed");
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
            <div className="grid grid-cols-3 gap-2">
              {MARKETPLACES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => { setMarketplace(m.id); setStep("credentials"); }}
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
          </div>
        )}

        {step === "credentials" && (
          <form onSubmit={handleCredentials} className="space-y-4">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStep("marketplace")}
                className="text-xs text-gray-500 hover:text-gray-300"
              >
                ← {MARKETPLACES.find((m) => m.id === marketplace)?.label}
              </button>
            </div>
            <div className="space-y-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Amazon email"
                required
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
                className="w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none"
              />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-3 font-medium text-white hover:bg-orange-600 disabled:opacity-50"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Sign in
            </button>
          </form>
        )}

        {step === "otp" && (
          <form onSubmit={handleOtp} className="space-y-4">
            <p className="text-sm text-gray-300">Enter the verification code sent to your device.</p>
            <input
              type="text"
              inputMode="numeric"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              placeholder="6-digit code"
              required
              className="w-full rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-center text-2xl tracking-widest text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none"
            />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-3 font-medium text-white hover:bg-orange-600 disabled:opacity-50"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Verify
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
