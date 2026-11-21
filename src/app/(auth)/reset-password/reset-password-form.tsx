"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

interface ResetPasswordFormProps {
  userId: string;
  email?: string;
}

export function ResetPasswordForm({ userId, email }: ResetPasswordFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [updated, setUpdated] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const password = String(fields.get("password") ?? "");
    if (password !== fields.get("confirmation")) {
      setError("The passwords do not match.");
      return;
    }

    setError(null);
    setSaving(true);
    try {
      const supabase = createClient();
      const { data, error: sessionError } = await supabase.auth.getUser();
      if (sessionError || data.user?.id !== userId) {
        setError("Your session changed or expired. Request a new reset link.");
        return;
      }

      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        if (updateError.code === "weak_password") {
          setError("Use a longer, more complex password.");
        } else if (updateError.code === "same_password") {
          setError("Choose a password different from your current one.");
        } else {
          setError("Could not update your password. Try again or request a new reset link.");
        }
        return;
      }

      form.reset();
      setUpdated(true);
    } catch {
      setError("Could not update your password. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader>
          <CardTitle>{updated ? "Password updated" : "Choose a new password"}</CardTitle>
          {email && <CardDescription>{email}</CardDescription>}
        </CardHeader>
        <CardContent>
          {updated ? (
            <Link className="text-sm font-medium text-primary underline" href="/dashboard">
              Continue to your workspace
            </Link>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <div className="grid gap-2">
                <Label htmlFor="reset-password">New password</Label>
                <Input id="reset-password" name="password" type="password" autoComplete="new-password" minLength={6} required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="reset-confirmation">Confirm password</Label>
                <Input id="reset-confirmation" name="confirmation" type="password" autoComplete="new-password" minLength={6} required />
              </div>
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Update password"}</Button>
              <Link className="text-sm text-muted-foreground underline" href="/forgot-password">
                Request a new reset link
              </Link>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
