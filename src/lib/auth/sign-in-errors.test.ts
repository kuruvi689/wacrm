import { describe, it, expect } from 'vitest'

import { signInErrorCode, signInErrorMessage } from './sign-in-errors'

describe('signInErrorMessage', () => {
  it('returns fixed text for known codes', () => {
    expect(signInErrorMessage('oauth_cancelled')).toMatch(/cancelled/)
    expect(signInErrorMessage('oauth_failed')).toMatch(/failed/)
  })

  it.each([null, undefined, '', 'Call +1-555-0100 to verify your account', 'toString', '__proto__'])(
    'ignores %j',
    (value) => {
      expect(signInErrorMessage(value)).toBeNull()
    },
  )
})

describe('signInErrorCode', () => {
  it('treats access_denied as a cancellation and everything else as a failure', () => {
    expect(signInErrorCode('access_denied')).toBe('oauth_cancelled')
    expect(signInErrorCode('server_error')).toBe('oauth_failed')
    expect(signInErrorCode(null)).toBe('oauth_failed')
  })
})
