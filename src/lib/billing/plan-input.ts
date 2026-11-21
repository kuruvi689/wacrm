// Validation for the operator's plan editor. Pure, no I/O.
// Prices are entered by the founder as decimal strings and converted
// to minor units here; no price is ever seeded in code.

import { isCurrencyCode, parseAmountToMinor } from '@/lib/products/money'

const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/

/** [body key, column, minimum] — null/empty means unlimited. */
const LIMIT_FIELDS: ReadonlyArray<readonly [string, string, number]> = [
  ['max_ai_agents', 'max_ai_agents', 0],
  ['max_whatsapp_numbers', 'max_whatsapp_numbers', 0],
  ['max_members', 'max_members', 1],
  ['max_contacts', 'max_contacts', 0],
  ['max_active_automations', 'max_active_automations', 0],
  ['max_integrations', 'max_integrations', 0],
  ['knowledge_storage_mb', 'knowledge_storage_mb', 0],
  ['monthly_messages', 'monthly_messages', 0],
  ['monthly_ai_responses', 'monthly_ai_responses', 0],
  ['monthly_ai_tokens', 'monthly_ai_tokens', 0],
  ['monthly_workflow_runs', 'monthly_workflow_runs', 0],
]

export type PlanInputResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }

function intInRange(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : null
}

/** Limit keys absent from the body. The save is a full replace, so a partial body would silently make them unlimited. */
export function missingLimitKeys(raw: Record<string, unknown>): string[] {
  return LIMIT_FIELDS.map(([key]) => key).filter((key) => !(key in raw))
}

export function parsePlanInput(raw: Record<string, unknown>): PlanInputResult {
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!PLAN_ID_RE.test(id)) return { ok: false, error: 'Plan id: 2-40 chars, lowercase letters, digits, - or _.' }

  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : ''
  if (!name) return { ok: false, error: 'Plan name is required.' }

  const currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : 'INR'
  if (!isCurrencyCode(currency)) return { ok: false, error: 'Currency must be a 3-letter code.' }

  const periodDays = intInRange(raw.period_days ?? 30, 1, 366)
  if (periodDays === null) return { ok: false, error: 'Period must be 1 to 366 days.' }
  const graceDays = intInRange(raw.grace_days ?? 3, 0, 60)
  if (graceDays === null) return { ok: false, error: 'Grace must be 0 to 60 days.' }

  // Empty price = not for sale.
  let priceMinor: number | null = null
  const priceRaw = raw.price
  if (priceRaw !== null && priceRaw !== undefined && String(priceRaw).trim() !== '') {
    priceMinor = parseAmountToMinor(String(priceRaw), currency)
    if (priceMinor === null) return { ok: false, error: 'Enter the price as a plain number, e.g. 999.00.' }
  }

  const value: Record<string, unknown> = {
    id,
    name,
    description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim().slice(0, 500) : null,
    is_active: raw.is_active !== false,
    is_public: raw.is_public === true,
    price_minor: priceMinor,
    currency,
    period_days: periodDays,
    grace_days: graceDays,
    sort_order: intInRange(raw.sort_order ?? 0, -1000, 1000) ?? 0,
    updated_at: new Date().toISOString(),
  }

  for (const [key, column, min] of LIMIT_FIELDS) {
    const v = raw[key]
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
      value[column] = null
      continue
    }
    const n = intInRange(v, min, Number.MAX_SAFE_INTEGER)
    if (n === null) return { ok: false, error: `${key.replace(/_/g, ' ')} must be a whole number of ${min} or more (empty = unlimited).` }
    value[column] = n
  }

  return { ok: true, value }
}
