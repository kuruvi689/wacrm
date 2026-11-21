// ============================================================
// WhatsApp 24-hour customer service window.
//
// Free-form (non-template) messages may only be sent while the
// customer's latest INBOUND message is under 24 hours old. Outside it,
// Meta rejects with 131047 (re-engagement) — we refuse up front instead
// of burning a Meta call, and tell the user to send an approved template.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000

export const WINDOW_CLOSED_CODE = 'window_closed'
export const WINDOW_CLOSED_MESSAGE =
  'The 24-hour customer service window is closed. Send an approved template message to re-open the conversation.'

export class WindowClosedError extends Error {
  readonly code = WINDOW_CLOSED_CODE
  constructor(message: string = WINDOW_CLOSED_MESSAGE) {
    super(message)
    this.name = 'WindowClosedError'
  }
}

/** Open iff the latest inbound customer message is < 24h old. */
export function isServiceWindowOpen(
  lastInboundAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastInboundAt) return false
  const t = new Date(lastInboundAt).getTime()
  if (Number.isNaN(t)) return false
  return now.getTime() - t < SERVICE_WINDOW_MS
}

/** Latest inbound customer message timestamp for a conversation. */
export async function loadLastInboundAt(
  db: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  return (data as { created_at: string }).created_at ?? null
}

/** Throws {@link WindowClosedError} when a free-form send is not allowed. */
export async function assertServiceWindowOpen(
  db: SupabaseClient,
  conversationId: string,
): Promise<void> {
  const last = await loadLastInboundAt(db, conversationId)
  if (!isServiceWindowOpen(last)) throw new WindowClosedError()
}
