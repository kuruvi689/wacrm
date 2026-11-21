import { describe, expect, it } from 'vitest'
import { decideInboundDedup } from './inbound-dedup'

describe('decideInboundDedup', () => {
  it('processes the first sighting', () => {
    expect(decideInboundDedup('wamid.1', { data: true, error: null })).toEqual({
      process: true,
      reason: 'first_seen',
    })
  })
  it('skips a confirmed duplicate', () => {
    expect(decideInboundDedup('wamid.1', { data: false, error: null })).toEqual({
      process: false,
      reason: 'duplicate',
    })
  })
  it('fails open on RPC error', () => {
    expect(
      decideInboundDedup('wamid.1', { data: null, error: { message: 'function does not exist' } }),
    ).toEqual({ process: true, reason: 'dedup_unavailable' })
    expect(decideInboundDedup('wamid.1', null).process).toBe(true)
  })
  it('fails open on an unexpected result shape', () => {
    expect(decideInboundDedup('wamid.1', { data: 'yes', error: null }).process).toBe(true)
  })
  it('processes messages without a wamid', () => {
    expect(decideInboundDedup(undefined, { data: false, error: null })).toEqual({
      process: true,
      reason: 'no_wamid',
    })
  })
})
