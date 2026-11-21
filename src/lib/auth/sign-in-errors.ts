// Fixed messages for sign-in failures that come back through
// /auth/callback. The login page only ever shows one of these: free
// text from the URL would let anyone craft a login link that displays
// their own "instructions" on our page.

export type SignInErrorCode = 'oauth_cancelled' | 'oauth_failed'

const SIGN_IN_ERROR_MESSAGES: Record<SignInErrorCode, string> = {
  oauth_cancelled: 'Google sign-in was cancelled. Please try again.',
  oauth_failed: 'Sign-in failed. Please try again.',
}

/** Message for a known error code from the URL, or null for anything else. */
export function signInErrorMessage(code: string | null | undefined): string | null {
  if (!code || !Object.hasOwn(SIGN_IN_ERROR_MESSAGES, code)) return null
  return SIGN_IN_ERROR_MESSAGES[code as SignInErrorCode]
}

/** Map a provider's `error` parameter (RFC 6749) to one of our codes. */
export function signInErrorCode(providerError: string | null | undefined): SignInErrorCode {
  return providerError === 'access_denied' ? 'oauth_cancelled' : 'oauth_failed'
}
