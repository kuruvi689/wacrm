import { describe, expect, it } from 'vitest'

import { formToBody, emptyPlanForm } from './plan-form'
import { EMPTY_SETTLE_FORM, buildSettleBody } from './settle-form'

describe('buildSettleBody', () => {
  it('starts empty: nothing is prefilled', () => {
    expect(Object.values(EMPTY_SETTLE_FORM).every((v) => v === '')).toBe(true)
    expect(buildSettleBody(EMPTY_SETTLE_FORM).ok).toBe(false)
  })
  it('requires every bank field', () => {
    const full = { amount: '999.00', bankUtr: '412345678901', receivedInto: 'HDFC 1234', receivedAt: '2026-05-04T14:30', note: '' }
    expect(buildSettleBody(full).ok).toBe(true)
    for (const key of ['amount', 'bankUtr', 'receivedInto', 'receivedAt'] as const) {
      expect(buildSettleBody({ ...full, [key]: '  ' }).ok).toBe(false)
    }
  })
  it('sends the amount as the typed decimal string, never a number', () => {
    const r = buildSettleBody({ amount: ' 999.50 ', bankUtr: 'u', receivedInto: 'a', receivedAt: '2026-05-04T14:30', note: '' })
    expect(r.ok && r.body.amount).toBe('999.50')
  })
})

describe('plan form', () => {
  it('sends empty strings for unlimited limits and not-for-sale price', () => {
    const body = formToBody({ ...emptyPlanForm(), id: ' x1 ', name: 'X' })
    expect(body.id).toBe('x1')
    expect(body.price).toBe('')
    expect(body.monthly_messages).toBe('')
  })
})
