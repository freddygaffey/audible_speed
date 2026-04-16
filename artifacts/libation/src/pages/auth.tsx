import { useState } from "react";
import { useGetAudibleAuthUrl, useExchangeAudibleCode } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { TerminalSquare, KeyRound, ExternalLink } from "lucide-react";
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

export default function AuthPage() {
  const [marketplace, setMarketplace] = useState("us");
  const [redirectUrl, setRedirectUrl] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: authUrlData, isLoading: isLoadingUrl, refetch: getUrl } = useGetAudibleAuthUrl(
    { marketplace },
    { query: { enabled: false } }
  );

  const exchange = useExchangeAudibleCode();

  const handleConnect = async () => {
    const { data } = await getUrl();
    if (data?.url) {
      window.open(data.url, "_blank", "width=600,height=800");
    } else {
      toast({ title: "Error", description: "Could not generate auth URL", variant: "destructive" });
    }
  };

  const handleExchange = () => {
    if (!redirectUrl) return;
    if (!authUrlData?.codeVerifier) {
      toast({ title: "Error", description: "Missing session data. Please click Connect again.", variant: "destructive" });
      return;
    }

    try {
      const url = new URL(redirectUrl);
      const code = url.searchParams.get("openid.oa2.authorization_code");

      if (!code) {
        toast({ title: "Invalid URL", description: "Could not find authorization code in the URL.", variant: "destructive" });
        return;
      }

      exchange.mutate(
        { data: { code, codeVerifier: authUrlData.codeVerifier, marketplace } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries();
            toast({ title: "Success", description: "Connected to Audible" });
          },
          onError: () => {
            toast({ title: "Authentication Failed", description: "Could not verify the authorization code.", variant: "destructive" });
          }
        }
      );
    } catch (e) {
      toast({ title: "Invalid URL", description: "Please paste a valid URL.", variant: "destructive" });
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

        <div className="bg-card border border-border rounded-lg p-6 space-y-6 shadow-xl">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs uppercase font-mono text-muted-foreground">1. Select Marketplace</Label>
              <Select value={marketplace} onValueChange={setMarketplace}>
                <SelectTrigger className="font-mono">
                  <SelectValue placeholder="Select marketplace" />
                </SelectTrigger>
                <SelectContent>
                  {MARKETPLACES.map(m => (
                    <SelectItem key={m.value} value={m.value} className="font-mono">{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs uppercase font-mono text-muted-foreground">2. Authorize</Label>
              <Button onClick={handleConnect} disabled={isLoadingUrl} className="w-full font-mono font-bold" size="lg">
                <ExternalLink size={16} className="mr-2" />
                Connect Audible Account
              </Button>
              <p className="text-[11px] text-muted-foreground text-center">
                Opens <span className="text-foreground">amazon.com</span> (always, regardless of marketplace). After logging in, copy the URL of the page you land on — it may show an error, that is normal.
              </p>
            </div>
          </div>

          <div className="pt-4 border-t border-border space-y-4">
            <div className="space-y-2">
              <Label className="text-xs uppercase font-mono text-muted-foreground">3. Paste Redirect URL</Label>
              <Input 
                value={redirectUrl} 
                onChange={e => setRedirectUrl(e.target.value)}
                placeholder="https://www.amazon.com/ap/maplanding?openid.oa2.authorization_code=..."
                className="font-mono text-xs"
              />
            </div>
            
            <Button 
              onClick={handleExchange} 
              disabled={!redirectUrl || exchange.isPending || !authUrlData} 
              variant="secondary"
              className="w-full font-mono"
            >
              <KeyRound size={16} className="mr-2" />
              {exchange.isPending ? "Verifying..." : "Verify & Connect"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
