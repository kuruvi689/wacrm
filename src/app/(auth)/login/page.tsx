"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { BrandMark } from "@/components/brand-mark";
import { GoogleSignInButton } from "@/components/auth/google-button";
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
import { UsersRound } from "lucide-react";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get("invite");
  const queryError = searchParams.get("error") || searchParams.get("error_description");
  const queryErrorCode = searchParams.get("error_code");
  const t = useTranslations("LoginPage");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendStatus, setResendStatus] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => {
    if (queryError || queryErrorCode) {
      const fullErr = `${queryError || ''} ${queryErrorCode || ''}`.toLowerCase();
      if (
        fullErr.includes("validation_failed") ||
        fullErr.includes("unsupported provider") ||
        fullErr.includes("not enabled")
      ) {
        setError(
          "Google Login is not enabled in your Supabase project (Authentication -> Providers -> Google). Please sign in using Email & Password below, or sign up for an account."
        );
      } else if (queryError) {
        setError(queryError);
      }
    }
  }, [queryError, queryErrorCode]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResendStatus(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    const destination = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : "/dashboard";
    window.location.href = destination;
  };

  const handleResendEmail = async () => {
    if (!email) {
      setError("Please enter your email address to resend verification link.");
      return;
    }
    setResending(true);
    setResendStatus(null);
    const emailRedirectTo = inviteToken
      ? `${window.location.origin}/auth/callback?next=/join/${encodeURIComponent(inviteToken)}`
      : `${window.location.origin}/auth/callback?next=/dashboard`;

    const { error: resendError } = await supabase.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo },
    });

    setResending(false);
    if (resendError) {
      setResendStatus(`Failed to resend: ${resendError.message}`);
    } else {
      setResendStatus("Verification link sent! Check your inbox.");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2">
            {inviteToken ? (
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                <UsersRound className="h-6 w-6 text-primary" />
              </div>
            ) : (
              <BrandMark size="lg" />
            )}
          </div>
          <CardTitle className="text-xl text-foreground">
            {inviteToken ? t('titleAccept') : t('titleWelcome')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {inviteToken
              ? t('descAccept')
              : t('descWelcome')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400 space-y-2">
                <div>{error}</div>
                {error.toLowerCase().includes("email not confirmed") && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleResendEmail}
                    disabled={resending}
                    className="w-full text-xs mt-1"
                  >
                    {resending ? "Resending..." : "Resend verification email"}
                  </Button>
                )}
              </div>
            )}

            {resendStatus && (
              <div className="rounded-lg border border-primary/20 bg-primary/10 px-4 py-3 text-sm text-primary">
                {resendStatus}
              </div>
            )}

            <GoogleSignInButton
              inviteToken={inviteToken}
              onError={(err) => setError(err)}
            />

            <div className="relative my-2">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">Or sign in with email</span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                {t('emailLabel')}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t('emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-muted-foreground">
                  {t('passwordLabel')}
                </Label>
                <Link
                  href="/forgot-password"
                  className="text-sm text-primary hover:text-primary/80"
                >
                  {t('forgotPassword')}
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                placeholder={t('passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? t('signingIn') : t('signIn')}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t('noAccount')}{" "}
            <Link
              href={
                inviteToken
                  ? `/signup?invite=${encodeURIComponent(inviteToken)}`
                  : "/signup"
              }
              className="text-primary hover:text-primary/80"
            >
              {t('createAccount')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
