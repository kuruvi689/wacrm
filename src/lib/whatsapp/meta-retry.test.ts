import { describe, expect, it } from 'vitest'
import {
  computeBackoffMs,
  isAbortError,
  isPreResponseNetworkError,
  isThrottleResponse,
  parseRetryAfterMs,
} from './meta-retry'

describe('isThrottleResponse', () => {
  it('retries HTTP 429 regardless of code', () => {
    expect(isThrottleResponse(429)).toBe(true)
  })
  it.each([4, 80007, 130429, 131056])('retries throttle code %i', (code) => {
    expect(isThrottleResponse(400, code)).toBe(true)
  })
  it.each([131047, 131026, 190, 100])('does not retry code %i', (code) => {
    expect(isThrottleResponse(400, code)).toBe(false)
  })
  it('does not retry plain 5xx without a throttle code', () => {
    expect(isThrottleResponse(500)).toBe(false)
  })
})

describe('isPreResponseNetworkError', () => {
  it('detects codes on the error and on a nested cause', () => {
    expect(
      isPreResponseNetworkError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })),
    ).toBe(true)
    const wrapped = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    expect(isPreResponseNetworkError(wrapped)).toBe(true)
    expect(isPreResponseNetworkError({ cause: { code: 'ECONNRESET' } })).toBe(true)
  })
  it('ignores timeouts and unknown errors', () => {
    expect(isPreResponseNetworkError(new Error('boom'))).toBe(false)
    expect(
      isPreResponseNetworkError(Object.assign(new Error('t'), { code: 'ETIMEDOUT' })),
    ).toBe(false)
    expect(isPreResponseNetworkError(null)).toBe(false)
  })
  it('classifies AbortError separately', () => {
    expect(isAbortError(Object.assign(new Error('a'), { name: 'AbortError' }))).toBe(true)
    expect(isAbortError(new Error('a'))).toBe(false)
  })
})

describe('computeBackoffMs', () => {
  it('grows exponentially within the jitter band', () => {
    expect(computeBackoffMs(1, { baseMs: 100, random: () => 0 })).toBe(50)
    expect(computeBackoffMs(1, { baseMs: 100, random: () => 1 })).toBe(100)
    expect(computeBackoffMs(2, { baseMs: 100, random: () => 1 })).toBe(200)
    expect(computeBackoffMs(3, { baseMs: 100, random: () => 1 })).toBe(400)
  })
  it('is capped', () => {
    expect(computeBackoffMs(10, { baseMs: 1000, capMs: 2000, random: () => 1 })).toBe(2000)
  })
})

describe('parseRetryAfterMs', () => {
  it('parses seconds and caps', () => {
    expect(parseRetryAfterMs('2')).toBe(2000)
    expect(parseRetryAfterMs('120', 5000)).toBe(5000)
  })
  it('rejects junk', () => {
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs('soon')).toBeNull()
    expect(parseRetryAfterMs('-1')).toBeNull()
  })
})
