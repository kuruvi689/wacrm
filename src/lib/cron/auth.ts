import { timingSafeEqual } from 'node:crypto'

// Minimum length for either shared secret. Shorter values are treated as
// "not configured" so a typo like `CRON_SECRET=1` can never open the route.
export const MIN_CRON_SECRET_LENGTH = 16

function usableSecret(value: string | undefined): string | null {
  if (!value || value.length < MIN_CRON_SECRET_LENGTH) return null
  return value
}

/** Constant-time string equality. Length mismatch returns false early. */
function secretsEqual(supplied: string, expected: string): boolean {
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(suppliedBuf, expectedBuf)
}

/**
 * True when at least one cron secret is configured with a usable length.
 * Routes use this to return 503 ("cron not configured") instead of 401
 * when the operator has not provisioned anything yet.
 */
export function isCronConfigured(): boolean {
  return (
    usableSecret(process.env.CRON_SECRET) !== null ||
    usableSecret(process.env.AUTOMATION_CRON_SECRET) !== null
  )
}

/**
 * Accepts either:
 *  - `Authorization: Bearer <CRON_SECRET>` (what Vercel Cron sends), or
 *  - `x-cron-secret: <AUTOMATION_CRON_SECRET>` (external pingers / legacy).
 *
 * Fails closed: returns false when the relevant env var is unset or too short.
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const cronSecret = usableSecret(process.env.CRON_SECRET)
  const authHeader = request.headers.get('authorization') ?? ''
  if (cronSecret && authHeader.startsWith('Bearer ')) {
    const supplied = authHeader.slice('Bearer '.length)
    if (secretsEqual(supplied, cronSecret)) return true
  }

  const legacySecret = usableSecret(process.env.AUTOMATION_CRON_SECRET)
  const legacyHeader = request.headers.get('x-cron-secret')
  if (legacySecret && legacyHeader !== null) {
    if (secretsEqual(legacyHeader, legacySecret)) return true
  }

  return false
}
