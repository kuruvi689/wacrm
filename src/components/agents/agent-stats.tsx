'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { Skeleton } from '@/components/dashboard/skeleton';
import {
  computeAgentStats,
  formatCostMicros,
  formatTokens,
  type AgentStats,
  type UsageLogRow,
} from './agent-logic';

const WINDOW_DAYS = 30;
// Bounded read; an agent writes a few rows per conversation.
const MAX_ROWS = 5000;

interface AgentStatsPanelProps {
  agentId: string;
  accountId: string;
  refreshKey: number;
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold text-foreground">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Last-30-days numbers for one agent, read from ai_usage_log through the
 * signed-in session (RLS limits that table to admins of this account).
 */
export function AgentStatsPanel({ agentId, accountId, refreshKey }: AgentStatsPanelProps) {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
        const { data, error } = await createClient()
          .from('ai_usage_log')
          .select('status, source, handoff, total_tokens, estimated_cost_micros')
          .eq('account_id', accountId)
          .eq('agent_id', agentId)
          .neq('source', 'simulation')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(MAX_ROWS + 1);
        if (cancelled) return;
        if (error) {
          toast.error('Could not load agent stats.');
          setStats(null);
          return;
        }
        const rows = (data ?? []) as UsageLogRow[];
        setTruncated(rows.length > MAX_ROWS);
        setStats(computeAgentStats(rows.slice(0, MAX_ROWS)));
      } catch {
        if (!cancelled) {
          toast.error('Could not load agent stats.');
          setStats(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, accountId, refreshKey]);

  if (loading) return <Skeleton className="h-32 w-full" />;
  if (!stats) return null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Tile label="Replies sent" value={String(stats.replies)} hint="Auto-replies delivered" />
        <Tile label="Tokens used" value={formatTokens(stats.tokens)} />
        <Tile
          label="Estimated cost"
          value={formatCostMicros(stats.costMicros, stats.unpricedCalls)}
          hint={stats.unpricedCalls > 0 ? 'Some models have no price estimate' : 'An estimate, not a bill'}
        />
        <Tile label="Failures" value={String(stats.failures)} hint="Errors and timeouts" />
        <Tile label="Handed to a human" value={String(stats.handoffs)} />
        <Tile label="Blocked" value={String(stats.blocked)} hint="Quota reached or key mismatch" />
      </div>
      <p className="text-xs text-muted-foreground">
        Last {WINDOW_DAYS} days. Simulations are not counted.
        {truncated ? ` Showing the latest ${MAX_ROWS} calls only.` : ''}
      </p>
    </div>
  );
}
