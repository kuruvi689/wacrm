// ============================================================
// Pure retry / classification helpers for Meta Cloud API calls.
//
// Retrying a send is only safe when we KNOW Meta did not process the
// request: an explicit throttling response (HTTP 429 or one of the
// documented throttle codes) or a connection failure that happened
// before any response. A timeout after the request may have been
// written is NOT retried — Meta could already have queued the message
// and a second attempt would deliver a duplicate.
// ============================================================

/** Meta error codes that mean "throttled, nothing was sent":
 *   4      app-level rate limit
 *   80007  WABA rate limit
 *   130429 Cloud API throughput limit
 *   131056 business/consumer pair rate limit */
export const THROTTLE_ERROR_CODES: readonly number[] = [4, 80007, 130429, 131056]

/** Node/undici connection errors raised before a response existed. */
export const PRE_RESPONSE_NETWORK_CODES: readonly string[] = [
  'ECONNRESET',
  'ENOTFOUND',
  'ECONNREFUSED',
]

export const META_MAX_ATTEMPTS = 3
export const META_DEFAULT_TIMEOUT_MS = 15_000
export const META_DEFAULT_BACKOFF_BASE_MS = 500
export const META_BACKOFF_CAP_MS = 8_000

export function isThrottleResponse(
  httpStatus: number,
  code?: number | null,
): boolean {
  if (httpStatus === 429) return true
  return typeof code === 'number' && THROTTLE_ERROR_CODES.includes(code)
}

/**
 * True for fetch failures that happened before Meta responded and where
 * the request cannot have been processed (DNS failure, refused or reset
 * connection). Walks `error.cause` because undici wraps the socket error
 * in `TypeError: fetch failed`.
 */
export function isPreResponseNetworkError(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; depth < 4 && cur; depth++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && PRE_RESPONSE_NETWORK_CODES.includes(code)) {
      return true
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

/** True when the error is an AbortController timeout/abort. */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'AbortError'
  )
}

/**
 * Exponential backoff with "equal jitter": half the exponential delay is
 * fixed, the other half random, so concurrent senders do not retry in
 * lockstep. `attempt` is the attempt that just failed (1-based).
 */
export function computeBackoffMs(
  attempt: number,
  options: { baseMs?: number; capMs?: number; random?: () => number } = {},
): number {
  const {
    baseMs = META_DEFAULT_BACKOFF_BASE_MS,
    capMs = META_BACKOFF_CAP_MS,
    random = Math.random,
  } = options
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1))
  return Math.round(exp / 2 + random() * (exp / 2))
}

/** Parse a Retry-After header (delta-seconds form) into ms, capped. */
export function parseRetryAfterMs(
  header: string | null | undefined,
  capMs: number = META_BACKOFF_CAP_MS,
): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(capMs, Math.round(seconds * 1000))
}
