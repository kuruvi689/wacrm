import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '@/lib/ai/tools/definitions';
import {
  apiErrorMessage,
  atAgentLimit,
  canActivate,
  canPause,
  computeAgentStats,
  emptyForm,
  formatCostMicros,
  formatTokens,
  formToVersionPayload,
  formFromAgent,
  hasErrors,
  isCurrentVersion,
  orderVersions,
  statusBadge,
  TOOL_OPTIONS,
  validateAgentForm,
  versionFieldsChanged,
  versionSummary,
  type Agent,
  type AgentVersion,
  type UsageLogRow,
} from './agent-logic';

const version = (over: Partial<AgentVersion> = {}): AgentVersion => ({
  id: 'v1',
  agent_id: 'a1',
  version_number: 1,
  provider: 'openai',
  model: 'gpt-5.4-mini',
  temperature: 0.4,
  max_output_tokens: 1024,
  context_message_limit: 20,
  system_prompt: null,
  business_knowledge: null,
  response_constraints: null,
  tool_permissions: ['knowledge_search'],
  n8n_webhook_url: null,
  handoff_on_failure: true,
  notes: null,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a1',
  name: 'Support',
  description: null,
  role: null,
  status: 'draft',
  current_version_id: 'v1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

describe('statusBadge', () => {
  it('maps every status to a label and variant', () => {
    expect(statusBadge('active')).toEqual({ label: 'Active', variant: 'default' });
    expect(statusBadge('paused').label).toBe('Paused');
    expect(statusBadge('testing').label).toBe('Testing');
    expect(statusBadge('draft').label).toBe('Draft');
    expect(statusBadge('weird').label).toBe('weird');
  });
});

describe('activate / pause availability', () => {
  it('only activates inactive agents that have a version', () => {
    expect(canActivate(agent({ status: 'draft' }))).toBe(true);
    expect(canActivate(agent({ status: 'paused' }))).toBe(true);
    expect(canActivate(agent({ status: 'active' }))).toBe(false);
    expect(canActivate(agent({ current_version_id: null }))).toBe(false);
    expect(canPause(agent({ status: 'active' }))).toBe(true);
    expect(canPause(agent({ status: 'draft' }))).toBe(false);
  });
});

describe('orderVersions', () => {
  it('sorts newest version first without mutating the input', () => {
    const input = [
      version({ id: 'a', version_number: 1 }),
      version({ id: 'c', version_number: 3 }),
      version({ id: 'b', version_number: 2 }),
    ];
    expect(orderVersions(input).map((v) => v.id)).toEqual(['c', 'b', 'a']);
    expect(input[0].id).toBe('a');
  });

  it('flags the current version', () => {
    expect(isCurrentVersion(version({ id: 'x' }), 'x')).toBe(true);
    expect(isCurrentVersion(version({ id: 'x' }), 'y')).toBe(false);
    expect(isCurrentVersion(version({ id: 'x' }), null)).toBe(false);
  });

  it('summarises a version', () => {
    expect(versionSummary(version())).toBe('gpt-5.4-mini · 1 tool');
    expect(versionSummary(version({ tool_permissions: [] }))).toBe('gpt-5.4-mini · 0 tools');
  });
});

describe('computeAgentStats', () => {
  const row = (over: Partial<UsageLogRow>): UsageLogRow => ({
    status: 'ok',
    source: 'auto_reply',
    handoff: false,
    total_tokens: 100,
    estimated_cost_micros: 2000,
    ...over,
  });

  it('counts live auto-reply outcomes and ignores simulations', () => {
    const stats = computeAgentStats([
      row({}),
      row({ status: 'handoff' }),
      row({ status: 'error' }),
      row({ status: 'timeout' }),
      row({ status: 'blocked', total_tokens: 0, estimated_cost_micros: 0 }),
      row({ source: 'simulation', total_tokens: 999 }),
      row({ source: 'draft', total_tokens: 50, estimated_cost_micros: '1000' }),
    ]);
    expect(stats.replies).toBe(1);
    expect(stats.handoffs).toBe(1);
    expect(stats.failures).toBe(2);
    expect(stats.blocked).toBe(1);
    expect(stats.tokens).toBe(100 * 4 + 50);
    expect(stats.costMicros).toBe(2000 * 4 + 1000);
    expect(stats.unpricedCalls).toBe(0);
  });

  it('tracks unpriced calls', () => {
    const stats = computeAgentStats([row({ estimated_cost_micros: null })]);
    expect(stats.unpricedCalls).toBe(1);
    expect(stats.costMicros).toBe(0);
  });

  it('returns zeros for no rows', () => {
    expect(computeAgentStats([]).replies).toBe(0);
  });
});

describe('formatting', () => {
  it('formats tokens compactly', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(25_000)).toBe('25k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });

  it('formats cost estimates', () => {
    expect(formatCostMicros(0)).toBe('$0.00');
    expect(formatCostMicros(0, 3)).toBe('Unknown');
    expect(formatCostMicros(1234)).toBe('$0.0012');
    expect(formatCostMicros(2_500_000)).toBe('$2.50');
    expect(formatCostMicros(2_500_000, 1)).toBe('$2.50+');
  });
});

describe('validateAgentForm', () => {
  const valid = () => ({ ...emptyForm(), name: 'Support' });

  it('accepts a valid form', () => {
    expect(hasErrors(validateAgentForm(valid()))).toBe(false);
  });

  it('requires name and model', () => {
    const e = validateAgentForm({ ...valid(), name: ' ', model: '' });
    expect(e.name).toBeTruthy();
    expect(e.model).toBeTruthy();
  });

  it('checks numeric bounds', () => {
    const e = validateAgentForm({
      ...valid(),
      temperature: '3',
      maxOutputTokens: '10',
      contextMessageLimit: '1.5',
    });
    expect(e.temperature).toBeTruthy();
    expect(e.maxOutputTokens).toBeTruthy();
    expect(e.contextMessageLimit).toBeTruthy();
  });

  it('requires an https webhook when the n8n tool is on', () => {
    const on = { ...valid(), toolPermissions: ['n8n_webhook'] };
    expect(validateAgentForm(on).n8nWebhookUrl).toBeTruthy();
    expect(validateAgentForm({ ...on, n8nWebhookUrl: 'http://x.io/h' }).n8nWebhookUrl).toBeTruthy();
    expect(validateAgentForm({ ...on, n8nWebhookUrl: 'https://u:p@x.io/h' }).n8nWebhookUrl).toBeTruthy();
    expect(hasErrors(validateAgentForm({ ...on, n8nWebhookUrl: 'https://n8n.example.com/hook' }))).toBe(false);
  });

  it('enforces text length limits', () => {
    expect(validateAgentForm({ ...valid(), systemPrompt: 'x'.repeat(8001) }).systemPrompt).toBeTruthy();
  });
});

describe('payload and change detection', () => {
  it('builds a payload with nulls for blank text and numbers parsed', () => {
    const p = formToVersionPayload({ ...emptyForm(), name: 'A', systemPrompt: '  ', temperature: '0.7' });
    expect(p.system_prompt).toBeNull();
    expect(p.temperature).toBe(0.7);
    expect(p.max_output_tokens).toBe(1024);
  });

  it('round-trips a version through the form without reporting a change', () => {
    const v = version({ system_prompt: 'Be kind', tool_permissions: ['knowledge_search', 'handoff_to_human'] });
    const form = formFromAgent(agent(), v);
    expect(form.notes).toBe('');
    expect(versionFieldsChanged(form, v)).toBe(false);
    expect(versionFieldsChanged({ ...form, model: 'other' }, v)).toBe(true);
    expect(versionFieldsChanged({ ...form, toolPermissions: ['knowledge_search'] }, v)).toBe(true);
    expect(versionFieldsChanged({ ...form, name: 'Renamed' }, v)).toBe(false);
  });
});

describe('apiErrorMessage', () => {
  it('maps known codes and statuses', () => {
    expect(apiErrorMessage(422, { code: 'provider_key_mismatch' })).toMatch(/different provider/);
    expect(apiErrorMessage(409, { code: 'ai_not_configured' })).toMatch(/Setup/);
    expect(apiErrorMessage(403, { code: 'plan_limit' })).toMatch(/limit/);
    expect(apiErrorMessage(503, null)).toMatch(/temporarily unavailable/);
    expect(apiErrorMessage(400, { error: 'model is required' })).toBe('model is required');
    expect(apiErrorMessage(500, {})).toMatch(/Something went wrong/);
  });
});

describe('limits and tool list', () => {
  it('detects the plan limit', () => {
    expect(atAgentLimit(2, 2)).toBe(true);
    expect(atAgentLimit(1, 2)).toBe(false);
    expect(atAgentLimit(5, null)).toBe(false);
  });

  it('stays in sync with the server tool registry', () => {
    expect(TOOL_OPTIONS.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });
});
