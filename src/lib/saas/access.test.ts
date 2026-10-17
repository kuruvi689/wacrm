import { describe, expect, it } from 'vitest'
import { evaluateAccess, isPlatformAdmin } from './access'

const NOW = new Date('2026-10-17T12:00:00Z')

describe('evaluateAccess', () => {
  it('allows active accounts', () => {
    expect(evaluateAccess({ status: 'active', trial_ends_at: null }, NOW)).toEqual({ allowed: true })
  })

  it('blocks suspended accounts even with a future trial date', () => {
    expect(
      evaluateAccess({ status: 'suspended', trial_ends_at: '2027-01-01T00:00:00Z' }, NOW),
    ).toEqual({ allowed: false, reason: 'suspended' })
  })

  it('allows a trial that has not ended', () => {
    expect(
      evaluateAccess({ status: 'trialing', trial_ends_at: '2026-10-18T00:00:00Z' }, NOW),
    ).toEqual({ allowed: true })
  })

  it('blocks a trial that ended exactly now or earlier', () => {
    expect(
      evaluateAccess({ status: 'trialing', trial_ends_at: '2026-10-17T12:00:00Z' }, NOW),
    ).toEqual({ allowed: false, reason: 'trial_expired' })
  })

  it('allows a trialing account with no end date (open-ended trial)', () => {
    expect(evaluateAccess({ status: 'trialing', trial_ends_at: null }, NOW)).toEqual({ allowed: true })
  })

  it('does not block active accounts whose old trial date has passed', () => {
    expect(
      evaluateAccess({ status: 'active', trial_ends_at: '2020-01-01T00:00:00Z' }, NOW),
    ).toEqual({ allowed: true })
  })
})

describe('isPlatformAdmin', () => {
  const verified = { id: 'u1', email: 'Boss@Example.com', email_confirmed_at: '2026-01-01T00:00:00Z' }

  it('matches a verified email case-insensitively', () => {
    expect(isPlatformAdmin(verified, { emails: 'a@x.com, boss@example.com' })).toBe(true)
  })

  it('rejects an UNVERIFIED email even when it is on the list', () => {
    expect(isPlatformAdmin({ ...verified, email_confirmed_at: null }, { emails: 'boss@example.com' })).toBe(false)
  })

  it('accepts a listed user id regardless of email state', () => {
    expect(isPlatformAdmin({ id: 'u1', email: null }, { userIds: 'u0, u1' })).toBe(true)
  })

  it('rejects users that are on neither list', () => {
    expect(isPlatformAdmin({ ...verified, email: 'eve@example.com' }, { emails: 'boss@example.com', userIds: 'u9' })).toBe(false)
  })

  it('rejects when nothing is configured or there is no user', () => {
    expect(isPlatformAdmin(verified, {})).toBe(false)
    expect(isPlatformAdmin(null, { emails: 'boss@example.com' })).toBe(false)
  })
})
