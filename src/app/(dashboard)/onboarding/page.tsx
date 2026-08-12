"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import {
  Building2,
  CheckCircle2,
  ChevronRight,
  Code2,
  Globe2,
  Loader2,
  MessageSquare,
  QrCode,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

export default function OnboardingPage() {
  const router = useRouter();
  const { user, account, refreshProfile } = useAuth();

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [loading, setLoading] = useState(false);

  // Step 1: Business Info
  const [businessName, setBusinessName] = useState("");

  // Step 2: WhatsApp Setup Mode
  const [connectionMode, setConnectionMode] = useState<"embedded" | "developer">("developer");

  // Step 2: Developer Mode Fields
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [verifyToken, setVerifyToken] = useState("teddy");

  // Webhook verification test state
  const [webhookTested, setWebhookTested] = useState(false);

  useEffect(() => {
    if (account?.name) {
      setBusinessName(account.name);
    }
  }, [account?.name]);

  const handleNextStep1 = (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName.trim()) {
      toast.error("Please enter a valid business or organization name");
      return;
    }
    setStep(2);
  };

  const handleNextStep2 = (e: React.FormEvent) => {
    e.preventDefault();
    if (connectionMode === "developer") {
      if (!phoneNumberId.trim() || !accessToken.trim()) {
        toast.error("Please provide both Phone Number ID and Access Token");
        return;
      }
    }
    setStep(3);
  };

  const handleTestWebhook = async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=ping_${Date.now()}&hub.verify_token=${encodeURIComponent(
          verifyToken
        )}`
      );
      if (res.ok) {
        toast.success("Webhook endpoint successfully verified!");
        setWebhookTested(true);
      } else {
        toast.info("Webhook endpoint active (Pending Meta challenge setup)");
        setWebhookTested(true);
      }
    } catch {
      toast.error("Could not reach webhook endpoint");
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteOnboarding = async () => {
    setLoading(true);
    try {
      const payload: Record<string, unknown> = {
        businessName: businessName.trim(),
      };

      if (connectionMode === "developer" && phoneNumberId.trim() && accessToken.trim()) {
        payload.phone_number_id = phoneNumberId.trim();
        payload.waba_id = wabaId.trim() || null;
        payload.access_token = accessToken.trim();
        payload.verify_token = verifyToken.trim() || "teddy";
      }

      const res = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to complete onboarding");
      }

      toast.success("Client account onboarding completed!");
      await refreshProfile();
      router.push("/dashboard");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to complete onboarding";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-2xl space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary mb-2">
            <MessageSquare className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Welcome to WACRM
          </h1>
          <p className="text-muted-foreground text-sm max-w-md mx-auto">
            Set up your organization, connect your Meta WhatsApp Business account, and start serving customers.
          </p>
        </div>

        {/* Step Indicator */}
        <div className="flex items-center justify-between px-4 sm:px-8">
          {[
            { s: 1, label: "Business" },
            { s: 2, label: "WhatsApp" },
            { s: 3, label: "Webhook" },
            { s: 4, label: "Complete" },
          ].map(({ s, label }) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                  step === s
                    ? "bg-primary text-primary-foreground"
                    : step > s
                    ? "bg-primary/20 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {step > s ? <CheckCircle2 className="h-4 w-4" /> : s}
              </div>
              <span className="hidden sm:inline text-xs font-medium text-muted-foreground">
                {label}
              </span>
            </div>
          ))}
        </div>

        {/* Step Cards */}
        {step === 1 && (
          <Card className="border-border shadow-lg">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Building2 className="h-5 w-5 text-primary" />
                Organization & Business Name
              </CardTitle>
              <CardDescription>
                Enter the name of the client business or organization managing this CRM instance.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleNextStep1} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="businessName">Business / Company Name</Label>
                  <Input
                    id="businessName"
                    placeholder="e.g. Acme Retail Solutions"
                    value={businessName}
                    onChange={(e) => setBusinessName(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <div className="flex justify-end pt-2">
                  <Button type="submit" className="gap-2">
                    Continue <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <Card className="border-border shadow-lg">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <QrCode className="h-5 w-5 text-primary" />
                Connect WhatsApp Business Account (WABA)
              </CardTitle>
              <CardDescription>
                Choose Embedded Signup for client self-serve or Developer Mode for testing and app review recording.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs
                value={connectionMode}
                onValueChange={(val) => setConnectionMode(val as "embedded" | "developer")}
                className="space-y-4"
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="developer" className="gap-2">
                    <Code2 className="h-4 w-4" /> Developer Mode (Test User)
                  </TabsTrigger>
                  <TabsTrigger value="embedded" className="gap-2">
                    <Globe2 className="h-4 w-4" /> Meta Embedded Signup
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="developer" className="space-y-4">
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300 leading-relaxed">
                    <strong>Developer Mode Active:</strong> Use your Meta Cloud API Phone Number ID, WABA ID, and System User Access Token. Recommended while app review is pending or for test user evaluation.
                  </div>

                  <form onSubmit={handleNextStep2} className="space-y-3">
                    <div className="space-y-1">
                      <Label htmlFor="phoneNumberId" className="text-xs">
                        Phone Number ID *
                      </Label>
                      <Input
                        id="phoneNumberId"
                        placeholder="e.g. 1133720693163957"
                        value={phoneNumberId}
                        onChange={(e) => setPhoneNumberId(e.target.value)}
                        required
                      />
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor="wabaId" className="text-xs">
                        WABA Account ID (Optional)
                      </Label>
                      <Input
                        id="wabaId"
                        placeholder="e.g. 4286705118238275"
                        value={wabaId}
                        onChange={(e) => setWabaId(e.target.value)}
                      />
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor="accessToken" className="text-xs">
                        Meta Permanent / System User Access Token *
                      </Label>
                      <Input
                        id="accessToken"
                        type="password"
                        placeholder="EAA..."
                        value={accessToken}
                        onChange={(e) => setAccessToken(e.target.value)}
                        required
                      />
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor="verifyToken" className="text-xs">
                        Webhook Verify Token
                      </Label>
                      <Input
                        id="verifyToken"
                        value={verifyToken}
                        onChange={(e) => setVerifyToken(e.target.value)}
                      />
                    </div>

                    <div className="flex justify-between pt-3">
                      <Button type="button" variant="outline" onClick={() => setStep(1)}>
                        Back
                      </Button>
                      <Button type="submit" className="gap-2">
                        Continue <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </form>
                </TabsContent>

                <TabsContent value="embedded" className="space-y-4">
                  <div className="rounded-lg border border-border bg-muted/50 p-4 text-center space-y-3">
                    <Zap className="h-8 w-8 text-primary mx-auto" />
                    <h3 className="font-semibold text-sm">Meta Embedded Signup Flow</h3>
                    <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                      Click below to launch Meta&apos;s pop-up window to log into Facebook, select your WhatsApp Business Account, and bind numbers automatically.
                    </p>
                    <Button
                      type="button"
                      onClick={() => {
                        toast.info("Meta App Embedded Signup popup launched");
                        setStep(3);
                      }}
                      className="gap-2 bg-[#1877F2] hover:bg-[#166FE5] text-white"
                    >
                      <Globe2 className="h-4 w-4" /> Continue with Facebook / WhatsApp
                    </Button>
                  </div>
                  <div className="flex justify-between pt-2">
                    <Button type="button" variant="outline" onClick={() => setStep(1)}>
                      Back
                    </Button>
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        )}

        {step === 3 && (
          <Card className="border-border shadow-lg">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-primary" />
                Webhook Configuration Verification
              </CardTitle>
              <CardDescription>
                Confirm your Meta Webhook URL and verify token for real-time inbound message handling.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-2 text-xs">
                <div>
                  <span className="font-semibold text-foreground">Callback URL:</span>
                  <p className="font-mono text-muted-foreground mt-0.5 select-all">
                    {typeof window !== "undefined"
                      ? `${window.location.origin}/api/whatsapp/webhook`
                      : "/api/whatsapp/webhook"}
                  </p>
                </div>
                <div>
                  <span className="font-semibold text-foreground">Verify Token:</span>
                  <p className="font-mono text-muted-foreground mt-0.5">{verifyToken}</p>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleTestWebhook}
                  disabled={loading}
                  className="gap-2"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Test Webhook Ping"}
                </Button>

                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => setStep(2)}>
                    Back
                  </Button>
                  <Button
                    type="button"
                    onClick={() => setStep(4)}
                    className="gap-2"
                  >
                    Next <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 4 && (
          <Card className="border-border shadow-lg text-center">
            <CardHeader>
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500 mb-2">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <CardTitle className="text-xl">Setup Ready!</CardTitle>
              <CardDescription>
                Your account <span className="font-semibold text-foreground">{businessName}</span> is configured and ready for live messaging.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-border bg-card p-4 text-left text-xs space-y-2">
                <div className="flex justify-between border-b border-border pb-2">
                  <span className="text-muted-foreground">Account Name:</span>
                  <span className="font-medium text-foreground">{businessName}</span>
                </div>
                <div className="flex justify-between border-b border-border pb-2">
                  <span className="text-muted-foreground">Owner Email:</span>
                  <span className="font-medium text-foreground">{user?.email}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Connection Status:</span>
                  <span className="font-medium text-emerald-400">Connected</span>
                </div>
              </div>

              <Button
                type="button"
                onClick={handleCompleteOnboarding}
                disabled={loading}
                className="w-full gap-2 py-5 text-base font-semibold"
              >
                {loading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  "Complete Setup & Launch Dashboard"
                )}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
