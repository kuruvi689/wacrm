import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateRegistrationPin, parseEmbeddedSignupBody } from './embedded-signup'
import { exchangeEmbeddedSignupCode } from './meta-api'

describe('parseEmbeddedSignupBody', () => {
  const valid = { code: 'AQB123', phone_number_id: '109876543210987', waba_id: '208765432109876' }

  it('accepts a well-formed body', () => {
    expect(parseEmbeddedSignupBody(valid)).toEqual({ ok: true, value: valid })
  })

  it('rejects a missing or oversized code', () => {
    expect(parseEmbeddedSignupBody({ ...valid, code: '' }).ok).toBe(false)
    expect(parseEmbeddedSignupBody({ ...valid, code: 'x'.repeat(3000) }).ok).toBe(false)
  })

  it('rejects non-numeric Meta ids (no path or query injection into Graph URLs)', () => {
    expect(parseEmbeddedSignupBody({ ...valid, phone_number_id: '123/../me' }).ok).toBe(false)
    expect(parseEmbeddedSignupBody({ ...valid, waba_id: '12?x=1' }).ok).toBe(false)
    expect(parseEmbeddedSignupBody({ ...valid, waba_id: undefined }).ok).toBe(false)
  })

  it('rejects non-object bodies', () => {
    expect(parseEmbeddedSignupBody(null).ok).toBe(false)
    expect(parseEmbeddedSignupBody([]).ok).toBe(false)
    expect(parseEmbeddedSignupBody('x').ok).toBe(false)
  })
})

describe('generateRegistrationPin', () => {
  it('always returns exactly 6 digits', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateRegistrationPin()).toMatch(/^\d{6}$/)
    }
  })
})

describe('exchangeEmbeddedSignupCode', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs the secret in the body (not the URL) and returns the token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: 'EAAtoken' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const token = await exchangeEmbeddedSignupCode({ appId: '111', appSecret: 'shh', code: 'abc' })

    expect(token).toBe('EAAtoken')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).not.toContain('shh')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toContain('client_secret=shh')
  })

  it("surfaces Meta's error message", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Code has expired' } }), { status: 400 })),
    )
    await expect(
      exchangeEmbeddedSignupCode({ appId: '1', appSecret: 's', code: 'c' }),
    ).rejects.toThrow('Code has expired')
  })

  it('fails when Meta returns no token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    await expect(
      exchangeEmbeddedSignupCode({ appId: '1', appSecret: 's', code: 'c' }),
    ).rejects.toThrow('did not return an access token')
  })
})
