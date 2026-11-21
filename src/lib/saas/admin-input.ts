// Pure validation for operator PATCH bodies — no I/O, unit-testable.

const STATUSES = ['trialing', 'active', 'suspended'] as const
const MAX_PLAN_LENGTH = 40
const MAX_REASON_LENGTH = 300
const MAX_LIMIT_VALUE = 1_000_000_000

export interface AccountPatch {
  plan?: string
  status?: (typeof STATUSES)[number]
  trial_ends_at?: string | null
  max_members?: number | null
  max_contacts?: number | null
  suspended_reason?: string | null
}

export interface SettingsPatch {
  default_trial_days?: number | null
  default_max_members?: number | null
  default_max_contacts?: number | null
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** null/'' → null (unlimited); otherwise an integer in [min, MAX]. */
function parseLimit(value: unknown, min: number, field: string): ParseResult<number | null> {
  if (value === null || value === '') return { ok: true, value: null }
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < min || n > MAX_LIMIT_VALUE) {
    return { ok: false, error: `${field} must be a whole number between ${min} and ${MAX_LIMIT_VALUE}, or empty for unlimited` }
  }
  return { ok: true, value: n }
}

export function parseAccountPatch(body: unknown): ParseResult<AccountPatch> {
  if (!isRecord(body)) return { ok: false, error: 'Body must be a JSON object' }
  const patch: AccountPatch = {}

  if ('plan' in body) {
    if (typeof body.plan !== 'string' || !body.plan.trim() || body.plan.length > MAX_PLAN_LENGTH) {
      return { ok: false, error: `plan must be 1–${MAX_PLAN_LENGTH} characters` }
    }
    patch.plan = body.plan.trim()
  }

  if ('status' in body) {
    if (!STATUSES.includes(body.status as (typeof STATUSES)[number])) {
      return { ok: false, error: `status must be one of: ${STATUSES.join(', ')}` }
    }
    patch.status = body.status as AccountPatch['status']
  }

  if ('trial_ends_at' in body) {
    if (body.trial_ends_at === null || body.trial_ends_at === '') {
      patch.trial_ends_at = null
    } else if (typeof body.trial_ends_at === 'string' && !Number.isNaN(Date.parse(body.trial_ends_at))) {
      patch.trial_ends_at = new Date(body.trial_ends_at).toISOString()
    } else {
      return { ok: false, error: 'trial_ends_at must be an ISO date or null' }
    }
  }

  for (const [field, min] of [['max_members', 1], ['max_contacts', 0]] as const) {
    if (field in body) {
      const parsed = parseLimit(body[field], min, field)
      if (!parsed.ok) return parsed
      patch[field] = parsed.value
    }
  }

  if ('suspended_reason' in body) {
    if (body.suspended_reason === null || body.suspended_reason === '') {
      patch.suspended_reason = null
    } else if (typeof body.suspended_reason === 'string' && body.suspended_reason.length <= MAX_REASON_LENGTH) {
      patch.suspended_reason = body.suspended_reason.trim()
    } else {
      return { ok: false, error: `suspended_reason must be at most ${MAX_REASON_LENGTH} characters` }
    }
  }

  if (Object.keys(patch).length === 0) return { ok: false, error: 'No valid fields to update' }
  return { ok: true, value: patch }
}

export function parseSettingsPatch(body: unknown): ParseResult<SettingsPatch> {
  if (!isRecord(body)) return { ok: false, error: 'Body must be a JSON object' }
  const patch: SettingsPatch = {}

  for (const [field, min] of [
    ['default_trial_days', 1],
    ['default_max_members', 1],
    ['default_max_contacts', 0],
  ] as const) {
    if (field in body) {
      const parsed = parseLimit(body[field], min, field)
      if (!parsed.ok) return parsed
      patch[field] = parsed.value
    }
  }

  if (Object.keys(patch).length === 0) return { ok: false, error: 'No valid fields to update' }
  return { ok: true, value: patch }
}
