import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { resolveWorkspaceGate } from "@/lib/saas/gate";
import { DashboardShell } from "./dashboard-shell";

// "Do not index" metadata for the authed app. robots.ts already
// disallows these paths at the crawler level and middleware redirects
// unauthenticated visitors, so this is belt-and-suspenders — but
// SEO-critical if a URL ever leaks via a link shared externally.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // SaaS gate: suspended / expired-trial workspaces and brand-new
  // owners never see the dashboard. /account-blocked and /onboarding
  // live outside this route group, so these redirects can't loop.
  const gate = await resolveWorkspaceGate();
  // Middleware only guards a fixed path list (/flows, /agents and
  // /notifications aren't on it), so enforce sign-in here too.
  if (gate.kind === "anonymous") {
    redirect("/login");
  }
  if (gate.kind === "blocked") {
    redirect(`/account-blocked?reason=${gate.reason}`);
  }
  if (gate.kind === "needs_onboarding") {
    redirect("/onboarding");
  }

  return <DashboardShell>{children}</DashboardShell>;
}
