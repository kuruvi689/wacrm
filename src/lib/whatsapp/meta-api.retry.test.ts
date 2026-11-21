import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MetaApiError, sendTextMessage, verifyPhoneNumber } from './meta-api'

const ARGS = { phoneNumberId: 'p', accessToken: 't', to: '1555', text: 'hi' }

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}
const OK = () => jsonResponse(200, { messages: [{ id: 'wamid.1' }] })

describe('meta-api retry + typed errors', () => {
  beforeEach(() => {
    vi.stubEnv('META_API_RETRY_BASE_MS', '1')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('throws MetaApiError preserving code, subcode, fbtrace_id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(400, {
          error: {
            message: 'Re-engagement message',
            code: 131047,
            error_subcode: 2494,
            fbtrace_id: 'AbC',
            type: 'OAuthException',
          },
        }),
      ),
    )
    const err = await sendTextMessage(ARGS).catch((e) => e)
    expect(err).toBeInstanceOf(MetaApiError)
    expect(err.message).toBe('Re-engagement message')
    expect(err).toMatchObject({
      code: 131047,
      subcode: 2494,
      fbtraceId: 'AbC',
      httpStatus: 400,
      kind: 'api',
    })
  })

  it('retries throttling (130429, then 429) and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: 'Throughput', code: 130429 } }))
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(OK())
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendTextMessage(ARGS)).resolves.toEqual({ messageId: 'wamid.1' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('gives up after 3 attempts on persistent throttling', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, { error: { message: 'pair rate', code: 131056 } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const err = await sendTextMessage(ARGS).catch((e) => e)
    expect(err).toMatchObject({ code: 131056 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry non-throttle errors', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, { error: { message: 'bad', code: 131026 } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendTextMessage(ARGS)).rejects.toThrow('bad')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a connection failure before any response', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))
      .mockResolvedValueOnce(OK())
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendTextMessage(ARGS)).resolves.toEqual({ messageId: 'wamid.1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never retries a timeout (the message may already be sent)', async () => {
    vi.stubEnv('META_API_TIMEOUT_MS', '20')
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const err = await sendTextMessage(ARGS).catch((e) => e)
    expect(err).toBeInstanceOf(MetaApiError)
    expect(err.kind).toBe('timeout')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry non-send calls even when throttled', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(429, { error: { message: 'slow', code: 4 } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      verifyPhoneNumber({ phoneNumberId: 'p', accessToken: 't' }),
    ).rejects.toThrow('slow')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
