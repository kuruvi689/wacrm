import { describe, expect, it } from 'vitest'
import { parseAccountPatch, parseSettingsPatch } from './admin-input'

describe('parseAccountPatch', () => {
  it('accepts a valid status + limits update', () => {
    const result = parseAccountPatch({ status: 'active', max_members: 5, max_contacts: '2500' })
    expect(result).toEqual({ ok: true, value: { status: 'active', max_members: 5, max_contacts: 2500 } })
  })

  it('treats null / empty limits as unlimited', () => {
    expect(parseAccountPatch({ max_contacts: null })).toEqual({ ok: true, value: { max_contacts: null } })
    expect(parseAccountPatch({ max_members: '' })).toEqual({ ok: true, value: { max_members: null } })
  })

  it('rejects unknown statuses', () => {
    expect(parseAccountPatch({ status: 'deleted' }).ok).toBe(false)
  })

  it('rejects a zero member cap and fractional limits', () => {
    expect(parseAccountPatch({ max_members: 0 }).ok).toBe(false)
    expect(parseAccountPatch({ max_contacts: 1.5 }).ok).toBe(false)
  })

  it('normalises trial_ends_at and rejects garbage dates', () => {
    const ok = parseAccountPatch({ trial_ends_at: '2026-12-01' })
    expect(ok.ok && ok.value.trial_ends_at).toBe('2026-12-01T00:00:00.000Z')
    expect(parseAccountPatch({ trial_ends_at: 'soon' }).ok).toBe(false)
  })

  it('ignores unknown fields and rejects an empty patch', () => {
    expect(parseAccountPatch({ owner_user_id: 'x' }).ok).toBe(false)
    expect(parseAccountPatch('nope').ok).toBe(false)
    expect(parseAccountPatch([]).ok).toBe(false)
  })
})

describe('parseSettingsPatch', () => {
  it('accepts trial length and caps', () => {
    expect(parseSettingsPatch({ default_trial_days: 14, default_max_members: 3 })).toEqual({
      ok: true,
      value: { default_trial_days: 14, default_max_members: 3 },
    })
  })

  it('rejects a zero-day trial', () => {
    expect(parseSettingsPatch({ default_trial_days: 0 }).ok).toBe(false)
  })
})
