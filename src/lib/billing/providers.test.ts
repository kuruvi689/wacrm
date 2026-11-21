import { describe, expect, it } from 'vitest'

import { activePaymentAdapter, manualUpiAdapter } from './providers'

const input = { reference: 'TCABC123XYZ', amountMinor: 99900, currency: 'INR', description: 'Teddy CRM Starter INV-1' }

describe('manualUpiAdapter', () => {
  const ok = manualUpiAdapter({ payeeVpa: 'teddy@okaxis', payeeName: 'Teddy Cubed' })

  it('is configured only with a valid VPA and payee name', () => {
    expect(ok.isConfigured()).toBe(true)
    expect(manualUpiAdapter({ payeeVpa: undefined, payeeName: 'x' }).isConfigured()).toBe(false)
    expect(manualUpiAdapter({ payeeVpa: 'not-a-vpa', payeeName: 'x' }).isConfigured()).toBe(false)
    expect(manualUpiAdapter({ payeeVpa: 'a@okaxis', payeeName: undefined }).isConfigured()).toBe(false)
  })

  it('builds a upi:// link with the exact amount and reference', () => {
    const res = ok.createRequest(input)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.request.upiUri).toContain('am=999.00')
      expect(res.request.upiUri).toContain('tr=TCABC123XYZ')
      expect(res.request.instructions.length).toBeGreaterThan(0)
    }
  })

  it('refuses non-INR currencies', () => {
    expect(ok.createRequest({ ...input, currency: 'USD' })).toEqual({ ok: false, error: 'upi_requires_inr' })
  })

  it('refuses when not configured', () => {
    const bad = manualUpiAdapter({ payeeVpa: undefined, payeeName: undefined })
    expect(bad.createRequest(input)).toEqual({ ok: false, error: 'billing_not_configured' })
  })

  it('rejects invalid amounts', () => {
    expect(ok.createRequest({ ...input, amountMinor: 0 }).ok).toBe(false)
  })
})

describe('activePaymentAdapter', () => {
  it('reads the VPA and payee from env', () => {
    const env = { BILLING_UPI_VPA: 'teddy@okaxis', BILLING_UPI_PAYEE_NAME: 'Teddy' } as unknown as NodeJS.ProcessEnv
    expect(activePaymentAdapter(env).id).toBe('manual_upi')
    expect(activePaymentAdapter(env).isConfigured()).toBe(true)
    expect(activePaymentAdapter({} as NodeJS.ProcessEnv).isConfigured()).toBe(false)
  })
})
