import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  SERVICE_WINDOW_MS,
  WindowClosedError,
  assertServiceWindowOpen,
  isServiceWindowOpen,
} from './service-window'

const NOW = new Date('2026-11-21T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

describe('isServiceWindowOpen', () => {
  it('is open inside 24h', () => {
    expect(isServiceWindowOpen(ago(60_000), NOW)).toBe(true)
    expect(isServiceWindowOpen(ago(SERVICE_WINDOW_MS - 1), NOW)).toBe(true)
  })
  it('is closed at and after 24h', () => {
    expect(isServiceWindowOpen(ago(SERVICE_WINDOW_MS), NOW)).toBe(false)
    expect(isServiceWindowOpen(ago(SERVICE_WINDOW_MS + 1), NOW)).toBe(false)
  })
  it('is closed with no inbound message or a bad timestamp', () => {
    expect(isServiceWindowOpen(null, NOW)).toBe(false)
    expect(isServiceWindowOpen(undefined, NOW)).toBe(false)
    expect(isServiceWindowOpen('not-a-date', NOW)).toBe(false)
  })
})

function dbWith(row: { created_at: string } | null, error: unknown = null): SupabaseClient {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b
  b.maybeSingle = async () => ({ data: row, error })
  return { from: () => b } as unknown as SupabaseClient
}

describe('assertServiceWindowOpen', () => {
  it('passes with a recent inbound message', async () => {
    await expect(
      assertServiceWindowOpen(dbWith({ created_at: new Date().toISOString() }), 'c'),
    ).resolves.toBeUndefined()
  })
  it('throws window_closed with no inbound message', async () => {
    const err = await assertServiceWindowOpen(dbWith(null), 'c').catch((e) => e)
    expect(err).toBeInstanceOf(WindowClosedError)
    expect(err.code).toBe('window_closed')
    expect(err.message).toMatch(/template/i)
  })
  it('throws when the last inbound is stale', async () => {
    await expect(
      assertServiceWindowOpen(
        dbWith({ created_at: new Date(Date.now() - 2 * SERVICE_WINDOW_MS).toISOString() }),
        'c',
      ),
    ).rejects.toBeInstanceOf(WindowClosedError)
  })
})
