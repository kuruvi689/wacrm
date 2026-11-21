import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isAuthorizedCronRequest, isCronConfigured } from './auth'

const CRON_SECRET = 'cron-secret-value-0123456789'
const LEGACY_SECRET = 'legacy-secret-value-0123456789'

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/automations/cron', { headers })
}

describe('isAuthorizedCronRequest', () => {
  const saved = {
    CRON_SECRET: process.env.CRON_SECRET,
    AUTOMATION_CRON_SECRET: process.env.AUTOMATION_CRON_SECRET,
  }

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    process.env.AUTOMATION_CRON_SECRET = LEGACY_SECRET
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('accepts a matching Bearer CRON_SECRET (Vercel Cron)', () => {
    expect(
      isAuthorizedCronRequest(req({ authorization: `Bearer ${CRON_SECRET}` })),
    ).toBe(true)
  })

  it('accepts a matching x-cron-secret (legacy AUTOMATION_CRON_SECRET)', () => {
    expect(
      isAuthorizedCronRequest(req({ 'x-cron-secret': LEGACY_SECRET })),
    ).toBe(true)
  })

  it('rejects a wrong Bearer token', () => {
    expect(
      isAuthorizedCronRequest(
        req({ authorization: 'Bearer wrong-secret-value-000000' }),
      ),
    ).toBe(false)
  })

  it('rejects a wrong x-cron-secret', () => {
    expect(
      isAuthorizedCronRequest(req({ 'x-cron-secret': 'wrong-secret-value-000000' })),
    ).toBe(false)
  })

  it('rejects a request with no credentials', () => {
    expect(isAuthorizedCronRequest(req())).toBe(false)
  })

  it('does not accept the legacy secret as a Bearer token', () => {
    expect(
      isAuthorizedCronRequest(req({ authorization: `Bearer ${LEGACY_SECRET}` })),
    ).toBe(false)
  })

  it('does not accept CRON_SECRET via x-cron-secret', () => {
    expect(
      isAuthorizedCronRequest(req({ 'x-cron-secret': CRON_SECRET })),
    ).toBe(false)
  })

  it('fails closed when CRON_SECRET is unset', () => {
    delete process.env.CRON_SECRET
    expect(
      isAuthorizedCronRequest(req({ authorization: `Bearer ${CRON_SECRET}` })),
    ).toBe(false)
  })

  it('fails closed when AUTOMATION_CRON_SECRET is unset', () => {
    delete process.env.AUTOMATION_CRON_SECRET
    expect(
      isAuthorizedCronRequest(req({ 'x-cron-secret': LEGACY_SECRET })),
    ).toBe(false)
  })

  it('fails closed when a configured secret is shorter than 16 chars', () => {
    process.env.CRON_SECRET = 'short'
    process.env.AUTOMATION_CRON_SECRET = 'tiny'
    expect(
      isAuthorizedCronRequest(req({ authorization: 'Bearer short' })),
    ).toBe(false)
    expect(isAuthorizedCronRequest(req({ 'x-cron-secret': 'tiny' }))).toBe(false)
  })

  it('fails closed on an empty supplied secret even when configured', () => {
    expect(isAuthorizedCronRequest(req({ authorization: 'Bearer ' }))).toBe(false)
    expect(isAuthorizedCronRequest(req({ 'x-cron-secret': '' }))).toBe(false)
  })

  it('rejects a supplied secret whose length differs (no throw)', () => {
    expect(
      isAuthorizedCronRequest(req({ authorization: `Bearer ${CRON_SECRET}x` })),
    ).toBe(false)
  })
})

describe('isCronConfigured', () => {
  const saved = {
    CRON_SECRET: process.env.CRON_SECRET,
    AUTOMATION_CRON_SECRET: process.env.AUTOMATION_CRON_SECRET,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('is true when either usable secret is present', () => {
    process.env.CRON_SECRET = CRON_SECRET
    delete process.env.AUTOMATION_CRON_SECRET
    expect(isCronConfigured()).toBe(true)
  })

  it('is false when neither usable secret is present', () => {
    delete process.env.CRON_SECRET
    process.env.AUTOMATION_CRON_SECRET = 'short'
    expect(isCronConfigured()).toBe(false)
  })
})
