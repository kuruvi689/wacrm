import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ResetPasswordForm } from "./reset-password-form";

export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user || user.is_anonymous) {
    redirect("/forgot-password?expired=1");
  }

  return <ResetPasswordForm userId={user.id} email={user.email} />;
}
