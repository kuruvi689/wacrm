// Plan editor form <-> API body. The server (parsePlanInput) is the real
// validator; this only moves values between strings and the body.

import { minorToAmountString } from '@/lib/products/money'

import type { AdminPlan } from './types'

export const LIMIT_FIELDS = [
  ['max_members', 'Team members'],
  ['max_contacts', 'Contacts'],
  ['max_whatsapp_numbers', 'WhatsApp numbers'],
  ['max_ai_agents', 'AI agents'],
  ['max_active_automations', 'Active automations'],
  ['max_integrations', 'Integrations'],
  ['knowledge_storage_mb', 'Knowledge storage (MB)'],
  ['monthly_messages', 'Messages / month'],
  ['monthly_ai_responses', 'AI replies / month'],
  ['monthly_ai_tokens', 'AI tokens / month'],
  ['monthly_workflow_runs', 'Automation runs / month'],
] as const

export type LimitKey = (typeof LIMIT_FIELDS)[number][0]

export interface PlanForm {
  id: string
  name: string
  description: string
  price: string
  currency: string
  period_days: string
  grace_days: string
  sort_order: string
  is_public: boolean
  is_active: boolean
  limits: Record<LimitKey, string>
}

function emptyLimits(): Record<LimitKey, string> {
  return Object.fromEntries(LIMIT_FIELDS.map(([key]) => [key, ''])) as Record<LimitKey, string>
}

export function emptyPlanForm(): PlanForm {
  return {
    id: '',
    name: '',
    description: '',
    price: '',
    currency: 'INR',
    period_days: '30',
    grace_days: '3',
    sort_order: '0',
    is_public: false,
    is_active: true,
    limits: emptyLimits(),
  }
}

export function planToForm(plan: AdminPlan): PlanForm {
  const limits = emptyLimits()
  for (const [key] of LIMIT_FIELDS) limits[key] = plan[key] === null ? '' : String(plan[key])
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description ?? '',
    price: plan.price_minor === null ? '' : minorToAmountString(plan.price_minor, plan.currency),
    currency: plan.currency,
    period_days: String(plan.period_days),
    grace_days: String(plan.grace_days),
    sort_order: String(plan.sort_order),
    is_public: plan.is_public,
    is_active: plan.is_active,
    limits,
  }
}

/** Empty limit = unlimited, empty price = not for sale (both sent as empty strings). */
export function formToBody(form: PlanForm): Record<string, unknown> {
  return {
    id: form.id.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    price: form.price.trim(),
    currency: form.currency.trim().toUpperCase(),
    period_days: form.period_days.trim(),
    grace_days: form.grace_days.trim(),
    sort_order: form.sort_order.trim(),
    is_public: form.is_public,
    is_active: form.is_active,
    ...Object.fromEntries(LIMIT_FIELDS.map(([key]) => [key, form.limits[key].trim()])),
  }
}
