"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
import { CheckCircle, UsersRound } from "lucide-react";

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const searchParams = useSearchParams();
  // When the user lands here from `/join/<token>` we carry the
  // invite token in the query so it survives the signup → email
  // verification → redirect round-trip. `emailRedirectTo` below
  // points back at /join/<token> so the user lands on the redeem
  // step after verifying instead of being dropped on /dashboard.
  const inviteToken = searchParams.get("invite");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setLoading(true);

    // 1. Attempt admin signup (bypasses rate limits & pre-confirms)
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, fullName }),
      })
      const apiData = await res.json()

      if (apiData.success) {
        // Sign in immediately
        const { error: signInErr } = await supabase.auth.signInWithPassword({
          email,
          password,
        })

        if (!signInErr) {
          const destination = inviteToken
            ? `/join/${encodeURIComponent(inviteToken)}`
            : "/dashboard"
          window.location.href = destination
          return
        }
      } else if (apiData.error && apiData.error.includes('already exists')) {
        setError(apiData.error)
        setLoading(false)
        return
      }
    } catch {
      // Fallback to client signup if endpoint fails
    }

    // 2. Fallback: Standard client signup
    const emailRedirectTo = inviteToken
      ? `${window.location.origin}/auth/callback?next=/join/${encodeURIComponent(inviteToken)}`
      : `${window.location.origin}/auth/callback?next=/dashboard`;

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo,
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    // Auto sign-in immediately
    const { error: signInErr } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (!signInErr) {
      const destination = inviteToken
        ? `/join/${encodeURIComponent(inviteToken)}`
        : "/dashboard"
      window.location.href = destination
      return
    }

    setSuccess(true);
    setLoading(false);
  };

  const handleResendEmail = async () => {
    setResending(true);
    setResendMessage(null);

    const emailRedirectTo = inviteToken
      ? `${window.location.origin}/auth/callback?next=/join/${encodeURIComponent(inviteToken)}`
      : `${window.location.origin}/auth/callback?next=/dashboard`;

    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo,
      },
    });

    setResending(false);
    if (error) {
      setResendMessage(`Failed to resend: ${error.message}`);
    } else {
      setResendMessage("Verification email resent! Please check your inbox and spam folder.");
    }
  };

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <CheckCircle className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">
              Check your email
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              We&apos;ve sent a confirmation link to{" "}
              <span className="text-foreground font-medium">{email}</span>. Please check your
              inbox (and spam folder) and click the link to verify your account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {resendMessage && (
              <div className={`rounded-lg border px-4 py-3 text-sm ${
                resendMessage.startsWith('Failed')
                  ? 'border-red-500/20 bg-red-500/10 text-red-400'
                  : 'border-primary/20 bg-primary/10 text-primary'
              }`}>
                {resendMessage}
              </div>
            )}

            <Button
              type="button"
              variant="secondary"
              onClick={handleResendEmail}
              disabled={resending}
              className="w-full"
            >
              {resending ? "Sending..." : "Resend verification email"}
            </Button>

            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
              className="block"
            >
              <Button
                variant="outline"
                className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Back to sign in
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

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
            {inviteToken ? "Create account & join" : "Create account"}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {inviteToken
              ? "Verify your email, then accept the invitation to join your team."
              : "Get started with ROOKIE CRM"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName" className="text-muted-foreground">
                Full name
              </Label>
              <Input
                id="fullName"
                type="text"
                placeholder="John Doe"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                Password
              </Label>
              <Input
                id="password"
                type="password"
                placeholder="At least 6 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword" className="text-muted-foreground">
                Confirm password
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder="Repeat your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <GoogleSignInButton
              inviteToken={inviteToken}
              text="Sign up with Google"
              onError={(err) => setError(err)}
            />

            <div className="relative my-2">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">Or sign up with email</span>
              </div>
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "Creating account..." : "Create account"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
              className="text-primary hover:text-primary/80"
            >
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
