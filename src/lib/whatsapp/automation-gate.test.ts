import { describe, expect, it } from 'vitest'
import { canRunAutomation } from './automation-gate'

const NOW = new Date('2026-11-21T00:00:00Z')

describe('canRunAutomation', () => {
  it('allows active and in-trial workspaces', () => {
    expect(canRunAutomation({ status: 'active' }, NOW)).toBe(true)
    expect(
      canRunAutomation({ status: 'trialing', trial_ends_at: '2026-12-01T00:00:00Z' }, NOW),
    ).toBe(true)
    expect(canRunAutomation({}, NOW)).toBe(true)
  })
  it('blocks suspended workspaces', () => {
    expect(canRunAutomation({ status: 'suspended' }, NOW)).toBe(false)
  })
  it('blocks expired trials', () => {
    expect(
      canRunAutomation({ status: 'trialing', trial_ends_at: '2026-11-01T00:00:00Z' }, NOW),
    ).toBe(false)
  })
})
