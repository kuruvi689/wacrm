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
  it('matches case-insensitively against a comma-separated list', () => {
    expect(isPlatformAdmin('Boss@Example.com', 'a@x.com, boss@example.com')).toBe(true)
  })

  it('rejects emails not on the list', () => {
    expect(isPlatformAdmin('eve@example.com', 'boss@example.com')).toBe(false)
  })

  it('rejects when nothing is configured or the email is missing', () => {
    expect(isPlatformAdmin('boss@example.com', undefined)).toBe(false)
    expect(isPlatformAdmin('boss@example.com', '')).toBe(false)
    expect(isPlatformAdmin(null, 'boss@example.com')).toBe(false)
  })
})
