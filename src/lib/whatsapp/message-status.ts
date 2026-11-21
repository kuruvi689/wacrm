// ============================================================
// Forward-only delivery status for `messages.status` + Meta error capture.
//
// Ladder: sending < sent < delivered < read. `failed` is a terminal side
// branch accepted only before the customer has read the message. Meta
// callbacks arrive out of order and are replayed, so a late `sent` must
// never overwrite `read`.
// ============================================================

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'

const LADDER: readonly string[] = ['sending', 'sent', 'delivered', 'read']

/**
 * Current statuses from which `incoming` may overwrite. Used as an
 * `.in('status', ...)` filter so the guard is atomic in SQL (message_id is
 * not unique, so an update can touch several rows).
 */
export function allowedPreviousStatuses(incoming: string): string[] {
  if (incoming === 'failed') return ['sending', 'sent', 'delivered']
  const idx = LADDER.indexOf(incoming)
  if (idx < 0) return []
  return LADDER.slice(0, idx)
}

/** Should a row currently at `current` move to `incoming`? */
export function shouldApplyMessageStatus(
  current: string,
  incoming: string,
): boolean {
  return allowedPreviousStatuses(incoming).includes(current)
}

export interface MetaStatusError {
  code?: number
  title?: string
  message?: string
  error_data?: { details?: string }
}

export interface CapturedStatusError {
  errorCode: number | null
  errorMessage: string | null
}

const MAX_ERROR_MESSAGE_LENGTH = 500

/** First Meta `errors[]` entry to (code, human message), or nulls. */
export function extractStatusError(
  errors: MetaStatusError[] | null | undefined,
): CapturedStatusError {
  const first = Array.isArray(errors) ? errors[0] : undefined
  if (!first) return { errorCode: null, errorMessage: null }
  const code = typeof first.code === 'number' ? first.code : null
  const text = first.error_data?.details || first.message || first.title || null
  return {
    errorCode: code,
    errorMessage: text ? text.slice(0, MAX_ERROR_MESSAGE_LENGTH) : null,
  }
}
