import { describe, expect, it } from 'vitest'
import {
  allowedPreviousStatuses,
  extractStatusError,
  shouldApplyMessageStatus,
} from './message-status'

describe('shouldApplyMessageStatus (forward-only)', () => {
  it.each([
    ['sent', 'delivered', true],
    ['delivered', 'read', true],
    ['sent', 'read', true],
    ['read', 'delivered', false],
    ['read', 'sent', false],
    ['delivered', 'sent', false],
    ['sent', 'sent', false],
    ['sent', 'failed', true],
    ['delivered', 'failed', true],
    ['read', 'failed', false],
    ['failed', 'delivered', false],
    ['failed', 'failed', false],
    ['sent', 'deleted', false],
  ])('%s -> %s = %s', (cur, inc, expected) => {
    expect(shouldApplyMessageStatus(cur, inc)).toBe(expected)
  })

  it('exposes previous-status sets for SQL filtering', () => {
    expect(allowedPreviousStatuses('read')).toEqual(['sending', 'sent', 'delivered'])
    expect(allowedPreviousStatuses('failed')).not.toContain('read')
    expect(allowedPreviousStatuses('unknown')).toEqual([])
  })
})

describe('extractStatusError', () => {
  it('captures code and the most specific message', () => {
    expect(
      extractStatusError([
        {
          code: 131026,
          title: 'Message undeliverable',
          message: 'Message undeliverable',
          error_data: { details: 'Recipient not on WhatsApp' },
        },
      ]),
    ).toEqual({ errorCode: 131026, errorMessage: 'Recipient not on WhatsApp' })
  })
  it('falls back to message then title', () => {
    expect(extractStatusError([{ code: 131047, title: 'Re-engagement' }])).toEqual({
      errorCode: 131047,
      errorMessage: 'Re-engagement',
    })
  })
  it('returns nulls when absent', () => {
    expect(extractStatusError(undefined)).toEqual({ errorCode: null, errorMessage: null })
    expect(extractStatusError([])).toEqual({ errorCode: null, errorMessage: null })
  })
})
