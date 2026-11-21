'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, PauseCircle, PencilLine, PlayCircle, Plus } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/dashboard/skeleton';
import { AgentFormDialog } from './agent-form-dialog';
import { AgentVersions } from './agent-versions';
import { AgentStatsPanel } from './agent-stats';
import { AgentSimulator } from './agent-simulator';
import {
  apiErrorMessage,
  atAgentLimit,
  canActivate,
  canPause,
  statusBadge,
  versionLabel,
  type Agent,
} from './agent-logic';

type DetailTab = 'versions' | 'stats' | 'simulate';

export function AgentsPanel() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [maxAgents, setMaxAgents] = useState<number | null>(null);
  const [hasSecret, setHasSecret] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('versions');
  const [refreshKey, setRefreshKey] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/agents', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(apiErrorMessage(res.status, data));
        return;
      }
      const list = (data?.agents ?? []) as Agent[];
      setAgents(list);
      setMaxAgents(typeof data?.limits?.max_ai_agents === 'number' ? data.limits.max_ai_agents : null);
      setHasSecret(data?.has_webhook_secret === true);
      setSelectedId((cur) => (cur && list.some((a) => a.id === cur) ? cur : (list[0]?.id ?? null)));
    } catch {
      toast.error('Could not load agents.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canEdit) void load();
    else setLoading(false);
  }, [canEdit, load]);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    void load();
  }, [load]);

  const changeStatus = async (agent: Agent, action: 'activate' | 'pause') => {
    setBusyId(agent.id);
    try {
      const res = await fetch(`/api/ai/agents/${agent.id}/${action}`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(apiErrorMessage(res.status, data));
        return;
      }
      toast.success(action === 'activate' ? `${agent.name} is now answering customers.` : `${agent.name} is paused.`);
      refresh();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  if (profileLoading || loading) return <Skeleton className="h-64 w-full" />;

  if (!canEdit) {
    return (
      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        Only admins and owners can view and manage AI agents.
      </p>
    );
  }

  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const limitReached = atAgentLimit(agents.length, maxAgents);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          One agent answers customers at a time. Editing an agent saves a new version, so you can always
          go back. The auto-reply switch in Setup stays the master off switch.
        </p>
        <div className="flex flex-col items-end gap-1">
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
            disabled={limitReached}
          >
            <Plus className="mr-2 h-4 w-4" /> New agent
          </Button>
          {maxAgents !== null && (
            <span className="text-xs text-muted-foreground">
              {agents.length} of {maxAgents} agents on your plan
            </span>
          )}
        </div>
      </div>

      {agents.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No agents yet. Create one to choose its instructions, tools and model.
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {agents.map((a) => {
            const badge = statusBadge(a.status);
            const v = a.current_version;
            const isSelected = a.id === selectedId;
            return (
              <li key={a.id}>
                <Card
                  className={isSelected ? 'ring-2 ring-primary' : undefined}
                  onClick={() => setSelectedId(a.id)}
                >
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="truncate text-base">
                          <button
                            type="button"
                            className="max-w-full truncate text-left focus-visible:underline focus-visible:outline-none"
                            aria-pressed={isSelected}
                            aria-label={`Show details for ${a.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedId(a.id);
                            }}
                          >
                            {a.name}
                          </button>
                        </CardTitle>
                        <CardDescription className="truncate">
                          {a.role || a.description || 'No description'}
                        </CardDescription>
                      </div>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                      {v ? `${versionLabel(v)} · ${v.model}` : 'No version saved'}
                    </p>
                    <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditing(a);
                          setFormOpen(true);
                        }}
                      >
                        <PencilLine className="mr-2 h-4 w-4" /> Edit
                      </Button>
                      {canActivate(a) && (
                        <Button size="sm" disabled={busyId !== null} onClick={() => changeStatus(a, 'activate')}>
                          {busyId === a.id ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <PlayCircle className="mr-2 h-4 w-4" />
                          )}
                          Activate
                        </Button>
                      )}
                      {canPause(a) && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyId !== null}
                          onClick={() => changeStatus(a, 'pause')}
                        >
                          {busyId === a.id ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <PauseCircle className="mr-2 h-4 w-4" />
                          )}
                          Pause
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {selected && accountId && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{selected.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs value={detailTab} onValueChange={(v) => setDetailTab(v as DetailTab)}>
              <TabsList>
                <TabsTrigger value="versions">Versions</TabsTrigger>
                <TabsTrigger value="stats">Last 30 days</TabsTrigger>
                <TabsTrigger value="simulate">Simulate</TabsTrigger>
              </TabsList>
              <TabsContent value="versions" className="mt-4">
                <AgentVersions
                  agentId={selected.id}
                  refreshKey={refreshKey}
                  readOnly={!canEdit}
                  onChanged={refresh}
                />
              </TabsContent>
              <TabsContent value="stats" className="mt-4">
                <AgentStatsPanel agentId={selected.id} accountId={accountId} refreshKey={refreshKey} />
              </TabsContent>
              <TabsContent value="simulate" className="mt-4">
                <AgentSimulator key={`${selected.id}:${selected.current_version_id ?? ''}`} agentId={selected.id} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      )}

      <AgentFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        agent={editing}
        hasWebhookSecret={hasSecret}
        onSaved={refresh}
        onWebhookSecretCreated={() => setHasSecret(true)}
      />
    </div>
  );
}
