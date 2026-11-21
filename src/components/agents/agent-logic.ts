// ============================================================
// Pure view logic for the Agents tab: types mirroring the
// /api/ai/agents responses, status badges, version ordering, stats
// folding/formatting, form validation and API error copy. No I/O so it
// stays unit-testable.
// ============================================================

export type AgentStatus = 'draft' | 'testing' | 'active' | 'paused';
export type AgentProvider = 'openai' | 'anthropic';

export interface AgentVersion {
  id: string;
  agent_id: string;
  version_number: number;
  provider: AgentProvider;
  model: string;
  temperature: number;
  max_output_tokens: number;
  context_message_limit: number;
  system_prompt: string | null;
  business_knowledge: string | null;
  response_constraints: string | null;
  tool_permissions: string[];
  n8n_webhook_url: string | null;
  handoff_on_failure: boolean;
  notes: string | null;
  created_by?: string | null;
  created_at: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  role: string | null;
  status: AgentStatus;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
  current_version?: AgentVersion | null;
}

// ---------- status badges ----------

export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';

export interface StatusBadge {
  label: string;
  variant: BadgeVariant;
}

export function statusBadge(status: string): StatusBadge {
  switch (status) {
    case 'active':
      return { label: 'Active', variant: 'default' };
    case 'paused':
      return { label: 'Paused', variant: 'secondary' };
    case 'testing':
      return { label: 'Testing', variant: 'outline' };
    case 'draft':
      return { label: 'Draft', variant: 'outline' };
    default:
      return { label: status || 'Unknown', variant: 'outline' };
  }
}

/** Activate needs a saved version and is pointless on an active agent. */
export function canActivate(agent: Pick<Agent, 'status' | 'current_version_id'>): boolean {
  return agent.status !== 'active' && !!agent.current_version_id;
}

export function canPause(agent: Pick<Agent, 'status'>): boolean {
  return agent.status === 'active';
}

// ---------- tools ----------

/** Mirrors TOOL_NAMES in src/lib/ai/tools/definitions.ts (that module
 *  pulls in server-only code, so it is not imported by the browser). A
 *  test keeps the two lists in sync. */
export const TOOL_OPTIONS = [
  {
    name: 'knowledge_search',
    label: 'Search knowledge base',
    description: 'Look up your uploaded knowledge when answering.',
  },
  {
    name: 'crm_lookup_contact',
    label: 'Look up the contact',
    description: 'Read the current contact’s name, tags and fields.',
  },
  {
    name: 'crm_update_contact',
    label: 'Update the contact',
    description: 'Add existing tags or fill existing custom fields. Never creates new ones.',
  },
  {
    name: 'handoff_to_human',
    label: 'Hand off to a human',
    description: 'Let the agent pass the chat to your team with a short summary.',
  },
  {
    name: 'n8n_webhook',
    label: 'Call your n8n webhook',
    description: 'Send the request to an https n8n webhook you control (signed).',
  },
] as const;

export function toolLabel(name: string): string {
  return TOOL_OPTIONS.find((t) => t.name === name)?.label ?? name;
}

// ---------- versions ----------

/** Newest first, by version number (ties broken by created_at). */
export function orderVersions<T extends Pick<AgentVersion, 'version_number' | 'created_at'>>(
  versions: readonly T[],
): T[] {
  return [...versions].sort(
    (a, b) =>
      b.version_number - a.version_number ||
      b.created_at.localeCompare(a.created_at),
  );
}

export function isCurrentVersion(
  version: Pick<AgentVersion, 'id'>,
  currentVersionId: string | null,
): boolean {
  return currentVersionId !== null && version.id === currentVersionId;
}

export function versionLabel(v: Pick<AgentVersion, 'version_number'>): string {
  return `v${v.version_number}`;
}

/** One line describing a version, e.g. "gpt-5.4-mini · 3 tools". */
export function versionSummary(
  v: Pick<AgentVersion, 'model' | 'tool_permissions'>,
): string {
  const n = v.tool_permissions.length;
  return `${v.model} · ${n} ${n === 1 ? 'tool' : 'tools'}`;
}

export type AgentEventType = 'created' | 'version_created' | 'activated' | 'paused' | 'rollback';

export function eventLabel(event: string): string {
  switch (event) {
    case 'created':
      return 'Agent created';
    case 'version_created':
      return 'New version saved';
    case 'activated':
      return 'Activated';
    case 'paused':
      return 'Paused';
    case 'rollback':
      return 'Rolled back';
    default:
      return event;
  }
}

// ---------- stats ----------

export interface UsageLogRow {
  status: string;
  source: string;
  handoff: boolean;
  total_tokens: number | null;
  estimated_cost_micros: number | string | null;
}

export interface AgentStats {
  /** Auto-replies that completed. */
  replies: number;
  tokens: number;
  /** Sum of known estimates, in micro-USD. */
  costMicros: number;
  /** Rows with no price estimate (unknown model). */
  unpricedCalls: number;
  failures: number;
  handoffs: number;
  blocked: number;
}

export const EMPTY_STATS: AgentStats = {
  replies: 0,
  tokens: 0,
  costMicros: 0,
  unpricedCalls: 0,
  failures: 0,
  handoffs: 0,
  blocked: 0,
};

/**
 * Fold ai_usage_log rows for one agent. Simulations are dry runs and are
 * excluded entirely; drafts and playground calls count towards tokens and
 * cost (they spend the account's key) but not towards the outcome counts,
 * which describe live auto-replies by usage-log status: ok = reply sent,
 * handoff, error/timeout = failure, blocked.
 */
export function computeAgentStats(rows: readonly UsageLogRow[]): AgentStats {
  const out = { ...EMPTY_STATS };
  for (const r of rows) {
    if (r.source === 'simulation') continue;
    out.tokens += Number(r.total_tokens ?? 0);
    if (r.estimated_cost_micros === null || r.estimated_cost_micros === undefined) {
      out.unpricedCalls += 1;
    } else {
      out.costMicros += Number(r.estimated_cost_micros) || 0;
    }
    if (r.source !== 'auto_reply') continue;
    if (r.status === 'ok') out.replies += 1;
    else if (r.status === 'handoff') out.handoffs += 1;
    else if (r.status === 'error' || r.status === 'timeout') out.failures += 1;
    else if (r.status === 'blocked') out.blocked += 1;
  }
  return out;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Micro-USD to a "$0.0123" style estimate. Always an estimate. */
export function formatCostMicros(micros: number, unpriced = 0): string {
  if (!Number.isFinite(micros) || micros <= 0) {
    return unpriced > 0 ? 'Unknown' : '$0.00';
  }
  const usd = micros / 1_000_000;
  const text = usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  return unpriced > 0 ? `${text}+` : text;
}

// ---------- form ----------

export interface AgentFormState {
  name: string;
  description: string;
  role: string;
  provider: AgentProvider;
  model: string;
  temperature: string;
  maxOutputTokens: string;
  contextMessageLimit: string;
  systemPrompt: string;
  businessKnowledge: string;
  responseConstraints: string;
  toolPermissions: string[];
  n8nWebhookUrl: string;
  handoffOnFailure: boolean;
  notes: string;
}

export const DEFAULT_MODEL: Record<AgentProvider, string> = {
  openai: 'gpt-5.4-mini',
  anthropic: 'claude-haiku-4-5-20251001',
};

export function emptyForm(provider: AgentProvider = 'openai'): AgentFormState {
  return {
    name: '',
    description: '',
    role: '',
    provider,
    model: DEFAULT_MODEL[provider],
    temperature: '0.4',
    maxOutputTokens: '1024',
    contextMessageLimit: '20',
    systemPrompt: '',
    businessKnowledge: '',
    responseConstraints: '',
    toolPermissions: ['knowledge_search', 'handoff_to_human'],
    n8nWebhookUrl: '',
    handoffOnFailure: true,
    notes: '',
  };
}

export function formFromAgent(agent: Agent, version: AgentVersion | null): AgentFormState {
  const base = emptyForm(version?.provider ?? 'openai');
  if (!version) {
    return { ...base, name: agent.name, description: agent.description ?? '', role: agent.role ?? '' };
  }
  return {
    name: agent.name,
    description: agent.description ?? '',
    role: agent.role ?? '',
    provider: version.provider,
    model: version.model,
    temperature: String(version.temperature),
    maxOutputTokens: String(version.max_output_tokens),
    contextMessageLimit: String(version.context_message_limit),
    systemPrompt: version.system_prompt ?? '',
    businessKnowledge: version.business_knowledge ?? '',
    responseConstraints: version.response_constraints ?? '',
    toolPermissions: [...version.tool_permissions],
    n8nWebhookUrl: version.n8n_webhook_url ?? '',
    handoffOnFailure: version.handoff_on_failure,
    // The change note describes one edit; never carry it forward.
    notes: '',
  };
}

// Same bounds the API enforces (parseVersionInput), so the form fails
// fast with plain-English copy instead of a 400.
const LIMITS = {
  name: 80,
  description: 500,
  role: 80,
  model: 100,
  systemPrompt: 8_000,
  businessKnowledge: 20_000,
  responseConstraints: 4_000,
  notes: 500,
} as const;

export type FormErrors = Partial<Record<keyof AgentFormState, string>>;

function numberIn(raw: string, min: number, max: number, whole: boolean): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  if (whole && !Number.isInteger(n)) return null;
  return n;
}

export function validateAgentForm(form: AgentFormState): FormErrors {
  const e: FormErrors = {};
  const name = form.name.trim();
  if (!name) e.name = 'Give the agent a name.';
  else if (name.length > LIMITS.name) e.name = `Keep the name under ${LIMITS.name} characters.`;
  if (form.description.length > LIMITS.description) e.description = `Keep this under ${LIMITS.description} characters.`;
  if (form.role.length > LIMITS.role) e.role = `Keep this under ${LIMITS.role} characters.`;
  const model = form.model.trim();
  if (!model) e.model = 'Enter a model name.';
  else if (model.length > LIMITS.model) e.model = `Keep the model under ${LIMITS.model} characters.`;
  if (numberIn(form.temperature, 0, 2, false) === null) e.temperature = 'Use a number from 0 to 2.';
  if (numberIn(form.maxOutputTokens, 64, 4096, true) === null) e.maxOutputTokens = 'Use a whole number from 64 to 4096.';
  if (numberIn(form.contextMessageLimit, 1, 50, true) === null) e.contextMessageLimit = 'Use a whole number from 1 to 50.';
  if (form.systemPrompt.length > LIMITS.systemPrompt) e.systemPrompt = `Keep instructions under ${LIMITS.systemPrompt} characters.`;
  if (form.businessKnowledge.length > LIMITS.businessKnowledge) e.businessKnowledge = `Keep this under ${LIMITS.businessKnowledge} characters.`;
  if (form.responseConstraints.length > LIMITS.responseConstraints) e.responseConstraints = `Keep rules under ${LIMITS.responseConstraints} characters.`;
  if (form.notes.length > LIMITS.notes) e.notes = `Keep the note under ${LIMITS.notes} characters.`;

  const url = form.n8nWebhookUrl.trim();
  if (url) {
    let ok = false;
    try {
      const u = new URL(url);
      ok = u.protocol === 'https:' && !u.username && !u.password;
    } catch {
      ok = false;
    }
    if (!ok) e.n8nWebhookUrl = 'Use a public https:// address.';
  }
  if (form.toolPermissions.includes('n8n_webhook') && !url) {
    e.n8nWebhookUrl = 'Add the webhook address, or turn the n8n tool off.';
  }
  return e;
}

export function hasErrors(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}

function textOrNull(s: string): string | null {
  const t = s.trim();
  return t === '' ? null : t;
}

/** Version payload for POST/PATCH. Call only after validateAgentForm
 *  returned no errors. */
export function formToVersionPayload(form: AgentFormState) {
  return {
    provider: form.provider,
    model: form.model.trim(),
    temperature: Number(form.temperature),
    max_output_tokens: Number(form.maxOutputTokens),
    context_message_limit: Number(form.contextMessageLimit),
    system_prompt: textOrNull(form.systemPrompt),
    business_knowledge: textOrNull(form.businessKnowledge),
    response_constraints: textOrNull(form.responseConstraints),
    tool_permissions: [...form.toolPermissions],
    n8n_webhook_url: textOrNull(form.n8nWebhookUrl),
    handoff_on_failure: form.handoffOnFailure,
    notes: textOrNull(form.notes),
  };
}

/** True when saving would change anything the model sees, i.e. would
 *  create a new version. Name/description/role edits do not. */
export function versionFieldsChanged(
  form: AgentFormState,
  version: AgentVersion | null,
): boolean {
  if (!version) return true;
  const next = formToVersionPayload(form);
  const sameTools =
    next.tool_permissions.length === version.tool_permissions.length &&
    next.tool_permissions.every((t) => version.tool_permissions.includes(t));
  return !(
    next.provider === version.provider &&
    next.model === version.model &&
    next.temperature === version.temperature &&
    next.max_output_tokens === version.max_output_tokens &&
    next.context_message_limit === version.context_message_limit &&
    next.system_prompt === (version.system_prompt ?? null) &&
    next.business_knowledge === (version.business_knowledge ?? null) &&
    next.response_constraints === (version.response_constraints ?? null) &&
    next.n8n_webhook_url === (version.n8n_webhook_url ?? null) &&
    next.handoff_on_failure === version.handoff_on_failure &&
    sameTools
  );
}

// ---------- API errors ----------

/** Plain-English copy for the error codes the agent routes return. */
export function apiErrorMessage(
  status: number,
  body: { error?: unknown; code?: unknown } | null | undefined,
): string {
  const code = typeof body?.code === 'string' ? body.code : '';
  switch (code) {
    case 'provider_key_mismatch':
      return 'This agent uses a different provider than your saved API key. Change the provider here or update the key in Setup.';
    case 'ai_not_configured':
      return 'Save an AI provider key in Setup first.';
    case 'plan_limit':
      return 'Your plan’s agent limit is reached. Upgrade or remove an agent to add more.';
    case 'webhook_url_not_allowed':
      return 'The n8n webhook must be a public https:// address.';
  }
  if (status === 503) return 'AI agents are temporarily unavailable. Try again in a moment.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status === 403) return 'Only admins and owners can manage agents.';
  const msg = typeof body?.error === 'string' ? body.error : '';
  return msg || 'Something went wrong. Please try again.';
}

export function atAgentLimit(count: number, max: number | null | undefined): boolean {
  return typeof max === 'number' && count >= max;
}

// ---------- simulation ----------

export interface SimToolCall {
  tool: string;
  status: string;
  latencyMs?: number;
  error?: string;
  argsSummary?: string;
  wouldCall?: string;
}

export function toolCallStatusLabel(status: string): string {
  switch (status) {
    case 'dry_run':
      return 'Would run';
    case 'ok':
      return 'OK';
    case 'denied':
      return 'Not allowed';
    case 'timeout':
      return 'Timed out';
    case 'invalid':
      return 'Bad input';
    case 'error':
      return 'Failed';
    default:
      return status;
  }
}
