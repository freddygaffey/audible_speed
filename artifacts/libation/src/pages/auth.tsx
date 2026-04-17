import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { TerminalSquare, LogIn, ShieldCheck, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const MARKETPLACES = [
  { value: "us", label: "United States (.com)" },
  { value: "uk", label: "United Kingdom (.co.uk)" },
  { value: "ca", label: "Canada (.ca)" },
  { value: "au", label: "Australia (.com.au)" },
  { value: "de", label: "Germany (.de)" },
  { value: "fr", label: "France (.fr)" },
  { value: "jp", label: "Japan (.co.jp)" },
  { value: "it", label: "Italy (.it)" },
  { value: "es", label: "Spain (.es)" },
];

type Step = "credentials" | "otp";

export default function AuthPage() {
  const [marketplace, setMarketplace] = useState("us");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [pendingId, setPendingId] = useState("");
  const [step, setStep] = useState<Step>("credentials");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);

    try {
      const resp = await fetch("/api/audible/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, marketplace }),
      });
      const data = await resp.json();

      if (data.status === "success") {
        queryClient.invalidateQueries();
        toast({ title: "Connected", description: `Signed in as ${data.email}` });
      } else if (data.status === "otp") {
        setPendingId(data.pendingId);
        setStep("otp");
      } else if (data.status === "captcha") {
        toast({ title: "CAPTCHA detected", description: data.error, variant: "destructive" });
      } else {
        toast({ title: "Sign-in failed", description: data.error ?? "Check your credentials and try again.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Network error", description: "Could not reach the server.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp) return;
    setLoading(true);

    try {
      const resp = await fetch("/api/audible/auth/otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingId, otp, marketplace }),
      });
      const data = await resp.json();

      if (data.status === "success") {
        queryClient.invalidateQueries();
        toast({ title: "Connected", description: `Signed in as ${data.email}` });
      } else {
        toast({ title: "OTP failed", description: data.error ?? "Invalid code, try again.", variant: "destructive" });
        setOtp("");
      }
    } catch {
      toast({ title: "Network error", description: "Could not reach the server.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center space-y-2">
          <div className="inline-flex w-16 h-16 rounded-xl bg-primary text-primary-foreground items-center justify-center mb-4">
            <TerminalSquare size={32} />
          </div>
          <h1 className="text-3xl font-mono font-bold tracking-tight">Libation</h1>
          <p className="text-muted-foreground font-mono text-sm">Personal Audible Library Manager</p>
        </div>

        <div className="bg-card border border-border rounded-lg p-6 shadow-xl">
          {step === "credentials" ? (
            <form onSubmit={handleLogin} className="space-y-5">
              <div className="space-y-2">
                <Label className="text-xs uppercase font-mono text-muted-foreground">Marketplace</Label>
                <Select value={marketplace} onValueChange={setMarketplace} disabled={loading}>
                  <SelectTrigger className="font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MARKETPLACES.map(m => (
                      <SelectItem key={m.value} value={m.value} className="font-mono">{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase font-mono text-muted-foreground">Amazon Email</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="font-mono"
                  autoComplete="email"
                  disabled={loading}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase font-mono text-muted-foreground">Password</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="font-mono"
                  autoComplete="current-password"
                  disabled={loading}
                  required
                />
              </div>

              <Button type="submit" className="w-full font-mono font-bold" size="lg" disabled={loading || !email || !password}>
                {loading ? <Loader2 size={16} className="mr-2 animate-spin" /> : <LogIn size={16} className="mr-2" />}
                {loading ? "Signing in..." : "Sign in to Audible"}
              </Button>

              <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
                Your credentials are sent directly from this server to Amazon — never stored.
                Two-factor authentication is supported.
              </p>
            </form>
          ) : (
            <form onSubmit={handleOtp} className="space-y-5">
              <div className="text-center space-y-2 pb-2">
                <div className="inline-flex w-12 h-12 rounded-full bg-primary/10 text-primary items-center justify-center">
                  <ShieldCheck size={24} />
                </div>
                <p className="font-mono text-sm text-foreground font-medium">Two-factor authentication</p>
                <p className="text-xs text-muted-foreground font-mono">
                  Enter the code from your authenticator app or SMS.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase font-mono text-muted-foreground">Verification Code</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={otp}
                  onChange={e => setOtp(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  className="font-mono text-center text-2xl tracking-widest"
                  maxLength={8}
                  disabled={loading}
                  autoFocus
                  required
                />
              </div>

              <Button type="submit" className="w-full font-mono font-bold" size="lg" disabled={loading || !otp}>
                {loading ? <Loader2 size={16} className="mr-2 animate-spin" /> : <ShieldCheck size={16} className="mr-2" />}
                {loading ? "Verifying..." : "Verify"}
              </Button>

              <Button
                type="button"
                variant="ghost"
                className="w-full font-mono text-xs text-muted-foreground"
                onClick={() => { setStep("credentials"); setOtp(""); }}
                disabled={loading}
              >
                Back to sign in
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
