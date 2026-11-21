import { describe, expect, it } from 'vitest'

import { parsePlanInput } from './plan-input'
import { missingLimitKeys } from './plan-input'
import { mapBillingError, parseIdempotencyKey, scopeIdempotencyKey } from './server'

describe('mapBillingError', () => {
  it('maps verification codes to their messages', () => {
    const m = mapBillingError({ message: 'billing: amount_mismatch', code: 'P0001' })
    expect(m).toMatchObject({ status: 422, code: 'amount_mismatch' })
    expect(mapBillingError({ message: 'billing: duplicate_utr' }).status).toBe(409)
  })
  it('maps not found and suspended', () => {
    expect(mapBillingError({ message: 'billing: payment attempt not found', code: 'P0002' }).status).toBe(404)
    expect(mapBillingError({ message: 'billing: subscription suspended' }).status).toBe(403)
  })
  it('shows the operator-facing settle message instead of blaming the customer', () => {
    const m = mapBillingError({ message: 'billing: subscription is suspended — reinstate it before settling' })
    expect(m.status).toBe(409)
    expect(m.message).toContain('reinstate it before settling')
  })
  it('hides unknown database errors', () => {
    const m = mapBillingError({ message: 'relation "x" does not exist' })
    expect(m).toMatchObject({ status: 500, code: 'internal_error' })
    expect(m.message).not.toContain('relation')
  })
})

describe('idempotency keys', () => {
  it('validates length 8-200', () => {
    expect(parseIdempotencyKey(null)).toEqual({ ok: true, key: null })
    expect(parseIdempotencyKey('short').ok).toBe(false)
    expect(parseIdempotencyKey('x'.repeat(201)).ok).toBe(false)
    expect(parseIdempotencyKey('x'.repeat(8))).toEqual({ ok: true, key: 'x'.repeat(8) })
  })
  it('scopes keys per account', () => {
    const a = scopeIdempotencyKey('acct-a', 'same-key-123')
    expect(a).toHaveLength(64)
    expect(a).not.toBe(scopeIdempotencyKey('acct-b', 'same-key-123'))
  })
})

describe('parsePlanInput', () => {
  it('converts the price to minor units and treats empty limits as unlimited', () => {
    const r = parsePlanInput({ id: 'starter', name: 'Starter', price: '999.50', monthly_messages: '', max_members: 3 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.price_minor).toBe(99950)
      expect(r.value.monthly_messages).toBeNull()
      expect(r.value.max_members).toBe(3)
      expect(r.value.is_public).toBe(false)
    }
  })
  it('empty price means not for sale', () => {
    const r = parsePlanInput({ id: 'free-ish', name: 'X', price: '' })
    expect(r.ok && r.value.price_minor).toBeNull()
  })
  it('rejects bad input', () => {
    expect(parsePlanInput({ id: 'Bad Id', name: 'x' }).ok).toBe(false)
    expect(parsePlanInput({ id: 'ok-id', name: 'x', price: 'abc' }).ok).toBe(false)
    expect(parsePlanInput({ id: 'ok-id', name: 'x', max_members: 0 }).ok).toBe(false)
    expect(parsePlanInput({ id: 'ok-id', name: 'x', period_days: 0 }).ok).toBe(false)
  })
})

describe('missingLimitKeys', () => {
  it('flags a partial body so omitted limits are not silently unlimited', () => {
    expect(missingLimitKeys({ id: 'x', name: 'x' })).toContain('monthly_messages')
    expect(missingLimitKeys({ monthly_messages: '' })).not.toContain('monthly_messages')
  })
})
