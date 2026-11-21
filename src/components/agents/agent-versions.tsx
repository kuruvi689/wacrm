'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, RotateCcw } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/dashboard/skeleton';
import {
  apiErrorMessage,
  eventLabel,
  isCurrentVersion,
  orderVersions,
  toolLabel,
  versionLabel,
  versionSummary,
  type AgentVersion,
} from './agent-logic';

interface AgentEvent {
  id: string;
  event: string;
  created_at: string;
}

interface AgentVersionsProps {
  agentId: string;
  /** Bumped by the parent after any change so this refetches. */
  refreshKey: number;
  readOnly: boolean;
  onChanged: () => void;
}

export function AgentVersions({ agentId, refreshKey, readOnly, onChanged }: AgentVersionsProps) {
  const [loading, setLoading] = useState(true);
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [vRes, dRes] = await Promise.all([
        fetch(`/api/ai/agents/${agentId}/versions`, { cache: 'no-store' }),
        fetch(`/api/ai/agents/${agentId}`, { cache: 'no-store' }),
      ]);
      const v = await vRes.json().catch(() => null);
      const d = await dRes.json().catch(() => null);
      if (!vRes.ok) {
        toast.error(apiErrorMessage(vRes.status, v));
        return;
      }
      setVersions(orderVersions((v?.versions ?? []) as AgentVersion[]));
      setCurrentId(v?.current_version_id ?? null);
      setEvents(dRes.ok ? ((d?.events ?? []) as AgentEvent[]) : []);
    } catch {
      toast.error('Could not load versions.');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const makeCurrent = async (versionId: string) => {
    setBusyId(versionId);
    try {
      const res = await fetch(`/api/ai/agents/${agentId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version_id: versionId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(apiErrorMessage(res.status, data));
        return;
      }
      toast.success('That version is now live for this agent.');
      onChanged();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <Skeleton className="h-40 w-full" />;
  if (versions.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No versions yet.</p>;
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {versions.map((v) => {
          const current = isCurrentVersion(v, currentId);
          return (
            <li key={v.id} className="rounded-md border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{versionLabel(v)}</span>
                    {current && <Badge>Current</Badge>}
                    <span className="text-xs text-muted-foreground">
                      {format(parseISO(v.created_at), 'MMM d, yyyy h:mm a')}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{versionSummary(v)}</p>
                  {v.tool_permissions.length > 0 && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Tools: {v.tool_permissions.map(toolLabel).join(', ')}
                    </p>
                  )}
                  {v.notes && <p className="mt-1 text-sm text-foreground">{v.notes}</p>}
                </div>
                {!readOnly && !current && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId !== null}
                    onClick={() => makeCurrent(v.id)}
                  >
                    {busyId === v.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="mr-2 h-4 w-4" />
                    )}
                    Make current
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {events.length > 0 && (
        <div>
          <h4 className="mb-1 text-sm font-medium text-foreground">History</h4>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {events.slice(0, 10).map((e) => (
              <li key={e.id}>
                {eventLabel(e.event)} · {format(parseISO(e.created_at), 'MMM d, h:mm a')}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
