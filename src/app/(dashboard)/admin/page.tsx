"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  Building2,
  CheckCircle2,
  Clock,
  Database,
  Loader2,
  MessageSquare,
  RefreshCw,
  Shield,
  Users,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface AccountOverview {
  id: string;
  name: string;
  createdAt: string;
  onboardingCompletedAt: string | null;
  ownerEmail: string;
  ownerName: string;
  memberCount: number;
  whatsappStatus: string;
  phoneNumberId: string | null;
  wabaId: string | null;
  stats: {
    contacts: number;
    conversations: number;
    messages: number;
  };
}

export default function AdminOversightPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<AccountOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const fetchOverview = async () => {
    setLoading(true);
    setForbidden(false);
    try {
      const res = await fetch("/api/admin/overview");
      if (res.status === 403 || res.status === 401) {
        setForbidden(true);
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load overview");
      setAccounts(data.accounts || []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error loading super admin oversight";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverview();
  }, []);

  if (forbidden) {
    return (
      <div className="flex h-[70vh] flex-col items-center justify-center text-center p-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 text-destructive mb-4">
          <Shield className="h-8 w-8" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">Access Denied</h2>
        <p className="text-muted-foreground text-sm max-w-md mt-2">
          This Super Admin Oversight dashboard is restricted to the platform owner. Client accounts cannot access this page.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Super Admin Oversight
            </h1>
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-300 gap-1">
              <Shield className="h-3 w-3" /> Owner Dashboard
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor all onboarded client business accounts, WhatsApp connection status, and system usage.
          </p>
        </div>

        <Button onClick={fetchOverview} variant="outline" size="sm" disabled={loading} className="gap-2 self-start sm:self-auto">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* Overview Metric Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-border">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Total Client Accounts
            </CardTitle>
            <Building2 className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{accounts.length}</div>
            <p className="text-[11px] text-muted-foreground mt-1">Active client organizations</p>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              WhatsApp Connected
            </CardTitle>
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-400">
              {accounts.filter((a) => a.whatsappStatus === "connected").length}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">Live Cloud API numbers</p>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Total Managed Contacts
            </CardTitle>
            <Users className="h-4 w-4 text-blue-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {accounts.reduce((sum, a) => sum + (a.stats?.contacts || 0), 0)}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">Across all client accounts</p>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Total Messages Served
            </CardTitle>
            <MessageSquare className="h-4 w-4 text-amber-400" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {accounts.reduce((sum, a) => sum + (a.stats?.messages || 0), 0)}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">Inbound + Outbound messages</p>
          </CardContent>
        </Card>
      </div>

      {/* Accounts Table */}
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" /> Onboarded Client Accounts
          </CardTitle>
          <CardDescription>
            Detailed status and resource usage for every onboarded organization.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : accounts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No client accounts onboarded yet.
            </div>
          ) : (
            <div className="rounded-md border border-border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account / Business</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>WhatsApp Connection</TableHead>
                    <TableHead>Team Size</TableHead>
                    <TableHead>Usage (Contacts / Messages)</TableHead>
                    <TableHead>Onboarding Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map((acc) => (
                    <TableRow key={acc.id}>
                      <TableCell className="font-medium">
                        <div className="flex flex-col">
                          <span className="text-foreground text-sm font-semibold">{acc.name}</span>
                          <span className="text-[11px] font-mono text-muted-foreground">{acc.id}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col text-xs">
                          <span className="text-foreground">{acc.ownerName}</span>
                          <span className="text-muted-foreground">{acc.ownerEmail}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {acc.whatsappStatus === "connected" ? (
                          <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 gap-1">
                            <CheckCircle2 className="h-3 w-3" /> Connected
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive gap-1">
                            <XCircle className="h-3 w-3" /> Disconnected
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs font-semibold">
                        {acc.memberCount} member{acc.memberCount === 1 ? "" : "s"}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="font-medium text-foreground">{acc.stats.contacts}</span> contacts /{" "}
                        <span className="font-medium text-foreground">{acc.stats.messages}</span> msgs
                      </TableCell>
                      <TableCell>
                        {acc.onboardingCompletedAt ? (
                          <Badge variant="outline" className="border-primary/30 text-primary text-[10px] gap-1">
                            <CheckCircle2 className="h-3 w-3" /> Complete
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-amber-500/30 text-amber-400 text-[10px] gap-1">
                            <Clock className="h-3 w-3" /> Pending Setup
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
