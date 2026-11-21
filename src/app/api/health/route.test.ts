import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
}))

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: (cols: string) => {
        mocks.select(cols)
        return { limit: () => mocks.select.mock.results.at(-1)?.value }
      },
    }),
  }),
}))

import { DB_TIMEOUT_MS, GET } from './route'

beforeEach(() => {
  mocks.select.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/health', () => {
  it('returns 200 and ok when the database probe succeeds', async () => {
    mocks.select.mockReturnValue(Promise.resolve({ data: [], error: null }))

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.checks.database.ok).toBe(true)
    expect(typeof body.checks.database.latency_ms).toBe('number')
    expect(body.version).toBe('0.8.0')
  })

  it('returns 503 and degraded when the probe returns an error, without leaking it', async () => {
    mocks.select.mockReturnValue(
      Promise.resolve({ data: null, error: { message: 'secret db detail' } }),
    )

    const res = await GET()
    const text = await res.text()

    expect(res.status).toBe(503)
    expect(JSON.parse(text).status).toBe('degraded')
    expect(text).not.toContain('secret db detail')
  })

  it('returns 503 when the probe hangs past the timeout', async () => {
    vi.useFakeTimers()
    mocks.select.mockReturnValue(new Promise(() => {}))

    const pending = GET()
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS + 10)
    const res = await pending
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.checks.database.ok).toBe(false)
  })
})
