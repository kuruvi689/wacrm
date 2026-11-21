// ============================================================
// WhatsApp marketing opt-out (STOP / START keywords) + send-time checks.
// DB reads here are tolerant: if migration 042 (contacts.opted_out_at)
// is not applied yet, they report "not opted out" instead of breaking
// every send.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export const OPT_OUT_REASON = 'opted_out'
export const OPT_OUT_SOURCE_KEYWORD = 'whatsapp_keyword'

export type OptKeyword = 'opt_out' | 'opt_in'

const OPT_OUT_WORDS = new Set(['stop', 'unsubscribe'])
const OPT_IN_WORDS = new Set(['start', 'subscribe'])

/** Exact-match (trimmed, case-insensitive) STOP/UNSUBSCRIBE or START/SUBSCRIBE. */
export function detectOptKeyword(text: string | null | undefined): OptKeyword | null {
  if (!text) return null
  const word = text.trim().toLowerCase()
  if (OPT_OUT_WORDS.has(word)) return 'opt_out'
  if (OPT_IN_WORDS.has(word)) return 'opt_in'
  return null
}

export class OptedOutError extends Error {
  readonly code = OPT_OUT_REASON
  constructor(message = 'Contact has opted out of marketing messages') {
    super(message)
    this.name = 'OptedOutError'
  }
}

/** True when the contact has an opted_out_at timestamp. Fails open. */
export async function isContactOptedOut(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('contacts')
    .select('opted_out_at')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data) return false
  return Boolean((data as { opted_out_at: string | null }).opted_out_at)
}

/** Ids (from `contactIds`) that are opted out. Fails open to an empty set. */
export async function loadOptedOutContactIds(
  db: SupabaseClient,
  accountId: string,
  contactIds: string[],
): Promise<Set<string>> {
  if (contactIds.length === 0) return new Set()
  const { data, error } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .in('id', contactIds)
    .not('opted_out_at', 'is', null)
  if (error || !data) return new Set()
  return new Set((data as { id: string }[]).map((r) => r.id))
}

function digits(phone: string): string {
  return phone.replace(/\D/g, '')
}

/** Digit-normalised phones of every opted-out contact in the account. */
export async function loadOptedOutPhoneDigits(
  db: SupabaseClient,
  accountId: string,
): Promise<Set<string>> {
  const { data, error } = await db
    .from('contacts')
    .select('phone')
    .eq('account_id', accountId)
    .not('opted_out_at', 'is', null)
  if (error || !data) return new Set()
  return new Set(
    (data as { phone: string | null }[])
      .map((r) => (r.phone ? digits(r.phone) : ''))
      .filter(Boolean),
  )
}

export function isPhoneOptedOut(phone: string, optedOutDigits: Set<string>): boolean {
  return optedOutDigits.has(digits(phone))
}
