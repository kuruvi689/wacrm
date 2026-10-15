import { describe, it, expect, beforeEach } from 'vitest'
import { encryptToken, decryptToken } from './token-vault'

describe('Token Vault Encryption Unit Tests', () => {
  beforeEach(() => {
    // Set mock 32-byte hex key for tests (64 hex characters)
    process.env.ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  })

  it('encrypts and decrypts access token safely', () => {
    const rawToken = 'EAAG1234567890SampleMetaTokenForTesting'
    const encrypted = encryptToken(rawToken)

    expect(encrypted).not.toEqual(rawToken)
    expect(encrypted.split(':').length).toBe(3) // GCM format: iv:ct:tag

    const decrypted = decryptToken(encrypted)
    expect(decrypted).toEqual(rawToken)
  })

  it('throws error when attempting to encrypt or decrypt empty token', () => {
    expect(() => encryptToken('')).toThrow('Cannot encrypt empty token')
    expect(() => decryptToken('')).toThrow('Cannot decrypt empty token')
  })
})
