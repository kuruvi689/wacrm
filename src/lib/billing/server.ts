// ============================================================
// Server-only helpers shared by the billing API routes.
//
// Nothing here decides money questions: amounts come from the plan
// price (SQL) and settlement is checked by verification.ts + the SQL
// function. This module only normalises request handling — role
// gates, rate limits, JSON envelopes and SQL error mapping.
// ============================================================

import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'

import { requireRole, ForbiddenError, UnauthorizedError, type AccountContext } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimitShared, rateLimitResponse } from '@/lib/rate-limit'
import { VERIFICATION_MESSAGES, type VerificationError } from './verification'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const BILLING_MUTATION_LIMIT = { limit: 10, windowMs: 60_000 }
export const IDEMPOTENCY_KEY_MIN = 8
export const IDEMPOTENCY_KEY_MAX = 200

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status })
}

/** Parse a JSON object body; anything else is an empty object. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

export function readString(body: Record<string, unknown>, key: string, max = 500): string {
  const value = body[key]
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** BILLING_RECEIVING_ACCOUNT — the only bank account we accept money into. */
export function receivingAccount(): string | null {
  const value = process.env.BILLING_RECEIVING_ACCOUNT?.trim()
  return value ? value : null
}

/** Role gate for tenant billing routes. Never reads the account from the request. */
export async function authorizeTenant(
  min: 'viewer' | 'admin',
): Promise<{ ok: true; ctx: AccountContext } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, ctx: await requireRole(min) }
  } catch (err) {
    if (err instanceof UnauthorizedError) return { ok: false, response: jsonError(401, 'unauthorized', 'Please sign in.') }
    if (err instanceof ForbiddenError) return { ok: false, response: jsonError(403, 'forbidden', err.message) }
    console.error('[billing] auth failed', err)
    return { ok: false, response: jsonError(500, 'internal_error', 'Something went wrong.') }
  }
}

/** Shared limiter: 10 mutating calls a minute per user per route family. */
export async function limitMutation(userId: string, name: string): Promise<NextResponse | null> {
  const result = await checkRateLimitShared(`billing:${name}:${userId}`, BILLING_MUTATION_LIMIT)
  return result.success ? null : rateLimitResponse(result)
}

/**
 * Scope a caller-supplied Idempotency-Key to the account. The DB key is
 * globally unique, so hashing keeps one tenant from colliding with (or
 * probing) another tenant's keys and keeps the value within 200 chars.
 */
export function scopeIdempotencyKey(accountId: string, key: string): string {
  return createHash('sha256').update(`${accountId}:${key}`).digest('hex')
}

export function parseIdempotencyKey(header: string | null): { ok: true; key: string | null } | { ok: false } {
  if (header === null) return { ok: true, key: null }
  const key = header.trim()
  if (key.length < IDEMPOTENCY_KEY_MIN || key.length > IDEMPOTENCY_KEY_MAX) return { ok: false }
  return { ok: true, key }
}

const CONFLICT_CODES = new Set([
  'attempt_not_open',
  'attempt_not_verifiable',
  'invoice_not_open',
  'duplicate_utr',
])

const CODE_MESSAGES: Record<string, string> = {
  plan_not_for_sale: 'That plan is not available for purchase.',
  invalid_utr: 'Enter the 12-digit UTR (or reference) from your payment app.',
  attempt_not_open: 'This payment is no longer open.',
  invoice_not_open: 'The invoice is no longer open (already paid, voided or expired).',
}

export interface MappedBillingError {
  status: number
  code: string
  message: string
}

/**
 * Map a PostgREST / SQL error raised by a billing function
 * ('billing: <code or sentence>') to an HTTP error. Unknown database
 * failures become a generic 500 and never leak internals.
 */
export function mapBillingError(error: { message?: string; code?: string } | null | undefined): MappedBillingError {
  const raw = error?.message ?? ''
  const match = /^billing: ([\s\S]+)$/.exec(raw)
  if (!match) return { status: 500, code: 'internal_error', message: 'Something went wrong. Please try again.' }

  const detail = match[1].trim()
  const token = /^[a-z_]+$/.test(detail) ? detail : null

  if (token && token in VERIFICATION_MESSAGES) {
    return {
      status: CONFLICT_CODES.has(token) ? 409 : 422,
      code: token,
      message: VERIFICATION_MESSAGES[token as VerificationError],
    }
  }
  if (token && token in CODE_MESSAGES) {
    return { status: token === 'invalid_utr' ? 400 : 409, code: token, message: CODE_MESSAGES[token] }
  }
  if (error?.code === 'P0002' || /not found|unknown account|no subscription/i.test(detail)) {
    return { status: 404, code: 'not_found', message: detail }
  }
  if (/^subscription suspended$/i.test(detail)) {
    return { status: 403, code: 'subscription_suspended', message: 'This subscription is suspended. Contact support.' }
  }
  // Remaining P0001 sentences are operator-facing business rules
  // (e.g. "a reason is required"); safe and useful to show.
  return { status: 409, code: 'billing_rule', message: detail.charAt(0).toUpperCase() + detail.slice(1) }
}

export function billingErrorResponse(error: { message?: string; code?: string } | null | undefined): NextResponse {
  const mapped = mapBillingError(error)
  if (mapped.status >= 500) console.error('[billing] database error', error)
  return jsonError(mapped.status, mapped.code, mapped.message)
}

/** Start of the current UTC month as YYYY-MM-DD (usage_counters.period_start). */
export function currentPeriodStart(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
}

export const USAGE_METRICS = ['messages', 'ai_responses', 'ai_tokens', 'workflow_runs'] as const

/** Tenant-safe subscription columns (no suspended_reason: that is an operator note). */
export const SUBSCRIPTION_COLUMNS =
  'plan_id, pending_plan_id, status, trial_ends_at, current_period_end, grace_ends_at, cancel_at_period_end'

export const PLAN_COLUMNS =
  'id, name, description, is_active, is_public, price_minor, currency, period_days, grace_days, ' +
  'max_ai_agents, max_whatsapp_numbers, max_members, max_contacts, max_active_automations, max_integrations, ' +
  'knowledge_storage_mb, monthly_messages, monthly_ai_responses, monthly_ai_tokens, monthly_workflow_runs, sort_order'

export { supabaseAdmin }
