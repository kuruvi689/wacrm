'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, KeyRound } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DEFAULT_MODEL,
  TOOL_OPTIONS,
  apiErrorMessage,
  emptyForm,
  formFromAgent,
  formToVersionPayload,
  hasErrors,
  validateAgentForm,
  versionFieldsChanged,
  type Agent,
  type AgentFormState,
  type AgentProvider,
  type AgentVersion,
  type FormErrors,
} from './agent-logic';

interface AgentFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create a new agent. */
  agent: Agent | null;
  hasWebhookSecret: boolean;
  onSaved: () => void;
  onWebhookSecretCreated: () => void;
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-destructive">{message}</p> : null;
}

export function AgentFormDialog({
  open,
  onOpenChange,
  agent,
  hasWebhookSecret,
  onSaved,
  onWebhookSecretCreated,
}: AgentFormDialogProps) {
  const [form, setForm] = useState<AgentFormState>(emptyForm());
  const [version, setVersion] = useState<AgentVersion | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [makingSecret, setMakingSecret] = useState(false);

  // Reset whenever the dialog opens for a (possibly different) agent.
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setSecret(null);
    if (!agent) {
      setForm(emptyForm());
      setVersion(null);
      return;
    }
    const v = agent.current_version ?? null;
    setVersion(v);
    setForm(formFromAgent(agent, v));
  }, [open, agent]);

  const set = <K extends keyof AgentFormState>(key: K, value: AgentFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const changeProvider = (next: AgentProvider) => {
    setForm((f) => {
      const wasDefault = f.model === '' || Object.values(DEFAULT_MODEL).includes(f.model);
      return { ...f, provider: next, model: wasDefault ? DEFAULT_MODEL[next] : f.model };
    });
  };

  const toggleTool = (name: string, on: boolean) =>
    setForm((f) => ({
      ...f,
      toolPermissions: on
        ? Array.from(new Set([...f.toolPermissions, name]))
        : f.toolPermissions.filter((t) => t !== name),
    }));

  const createsNewVersion = agent ? versionFieldsChanged(form, version) : true;

  const handleSave = async () => {
    const found = validateAgentForm(form);
    setErrors(found);
    if (hasErrors(found)) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        role: form.role.trim() || null,
      };
      if (createsNewVersion) body.version = formToVersionPayload(form);
      const res = await fetch(agent ? `/api/ai/agents/${agent.id}` : '/api/ai/agents', {
        method: agent ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(apiErrorMessage(res.status, data));
        return;
      }
      toast.success(
        !agent
          ? 'Agent created as a draft.'
          : createsNewVersion
            ? 'Saved as a new version.'
            : 'Agent details saved.',
      );
      onOpenChange(false);
      onSaved();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const makeSecret = async () => {
    if (
      hasWebhookSecret &&
      !window.confirm(
        'Replace the signing secret for every agent in this workspace? Update your n8n workflows with the new secret before they can verify calls again.',
      )
    ) {
      return;
    }

    setMakingSecret(true);
    try {
      const res = await fetch('/api/ai/agents/webhook-secret', { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok || typeof data?.secret !== 'string') {
        toast.error(apiErrorMessage(res.status, data));
        return;
      }
      setSecret(data.secret);
      onWebhookSecretCreated();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setMakingSecret(false);
    }
  };

  const n8nOn = form.toolPermissions.includes('n8n_webhook');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{agent ? `Edit ${agent.name}` : 'New agent'}</DialogTitle>
          <DialogDescription>
            {agent
              ? 'Changing how the agent behaves saves a new version. Older versions are kept, and you can go back to any of them.'
              : 'The agent starts as a draft. Test it in Simulate, then activate it.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">Name</Label>
              <Input id="agent-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
              <FieldError message={errors.name} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-role">Role (optional)</Label>
              <Input
                id="agent-role"
                value={form.role}
                placeholder="e.g. Sales assistant"
                onChange={(e) => set('role', e.target.value)}
              />
              <FieldError message={errors.role} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-desc">Description (optional)</Label>
            <Input
              id="agent-desc"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
            />
            <FieldError message={errors.description} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-provider">Provider</Label>
              <Select value={form.provider} onValueChange={(v) => v && changeProvider(v as AgentProvider)}>
                <SelectTrigger id="agent-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Must match the provider of the key saved in Setup.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-model">Model</Label>
              <Input id="agent-model" value={form.model} onChange={(e) => set('model', e.target.value)} />
              <FieldError message={errors.model} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="agent-temp">Creativity (0-2)</Label>
              <Input
                id="agent-temp"
                inputMode="decimal"
                value={form.temperature}
                onChange={(e) => set('temperature', e.target.value)}
              />
              <FieldError message={errors.temperature} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-max">Max reply tokens</Label>
              <Input
                id="agent-max"
                inputMode="numeric"
                value={form.maxOutputTokens}
                onChange={(e) => set('maxOutputTokens', e.target.value)}
              />
              <FieldError message={errors.maxOutputTokens} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-ctx">Messages of context</Label>
              <Input
                id="agent-ctx"
                inputMode="numeric"
                value={form.contextMessageLimit}
                onChange={(e) => set('contextMessageLimit', e.target.value)}
              />
              <FieldError message={errors.contextMessageLimit} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-prompt">Instructions</Label>
            <Textarea
              id="agent-prompt"
              rows={4}
              value={form.systemPrompt}
              placeholder="Tone, persona, what it should and should not do."
              onChange={(e) => set('systemPrompt', e.target.value)}
            />
            <FieldError message={errors.systemPrompt} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-knowledge">Business facts</Label>
            <Textarea
              id="agent-knowledge"
              rows={3}
              value={form.businessKnowledge}
              placeholder="Opening hours, delivery areas, policies."
              onChange={(e) => set('businessKnowledge', e.target.value)}
            />
            <FieldError message={errors.businessKnowledge} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-rules">Hard rules</Label>
            <Textarea
              id="agent-rules"
              rows={3}
              value={form.responseConstraints}
              placeholder="Things it must never promise or say."
              onChange={(e) => set('responseConstraints', e.target.value)}
            />
            <FieldError message={errors.responseConstraints} />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Tools the agent may use</legend>
            <p className="text-xs text-muted-foreground">
              Anything not ticked is blocked, even if the model asks for it.
            </p>
            {TOOL_OPTIONS.map((tool) => (
              <label key={tool.name} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2">
                <Checkbox
                  checked={form.toolPermissions.includes(tool.name)}
                  onCheckedChange={(c) => toggleTool(tool.name, c === true)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium text-foreground">{tool.label}</span>
                  <span className="block text-xs text-muted-foreground">{tool.description}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {n8nOn && (
            <div className="space-y-2 rounded-md border border-border p-3">
              <Label htmlFor="agent-n8n">n8n webhook address</Label>
              <Input
                id="agent-n8n"
                value={form.n8nWebhookUrl}
                placeholder="https://n8n.example.com/webhook/..."
                onChange={(e) => set('n8nWebhookUrl', e.target.value)}
              />
              <FieldError message={errors.n8nWebhookUrl} />
              <p className="text-xs text-muted-foreground">
                Every agent in this workspace shares the same signing secret. n8n can verify calls using
                the X-Wacrm-Signature header. {hasWebhookSecret ? 'A secret is saved.' : 'No secret created yet.'}
              </p>
              {secret ? (
                <div className="rounded-md bg-muted p-2">
                  <p className="text-xs text-muted-foreground">Copy it now. It is not shown again.</p>
                  <code className="break-all text-xs">{secret}</code>
                </div>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={makeSecret} disabled={makingSecret}>
                  {makingSecret ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="mr-2 h-4 w-4" />
                  )}
                  {hasWebhookSecret ? 'Replace signing secret' : 'Create signing secret'}
                </Button>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">Hand off when the AI is unavailable</p>
              <p className="text-xs text-muted-foreground">
                If the provider errors or times out, pass the chat to your team instead of staying silent.
              </p>
            </div>
            <Switch checked={form.handoffOnFailure} onCheckedChange={(v) => set('handoffOnFailure', v)} />
          </div>

          {createsNewVersion && (
            <div className="space-y-1.5">
              <Label htmlFor="agent-notes">What changed? (optional)</Label>
              <Input id="agent-notes" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
              <FieldError message={errors.notes} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {!agent ? 'Create agent' : createsNewVersion ? 'Save new version' : 'Save details'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
