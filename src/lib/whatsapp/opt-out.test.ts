import { describe, expect, it } from 'vitest'
import { detectOptKeyword, isPhoneOptedOut } from './opt-out'

describe('detectOptKeyword', () => {
  it.each(['STOP', 'stop', '  Stop  ', 'UNSUBSCRIBE', ' Unsubscribe '])('opt-out: %j', (t) => {
    expect(detectOptKeyword(t)).toBe('opt_out')
  })
  it.each(['START', 'start', ' Subscribe '])('opt-in: %j', (t) => {
    expect(detectOptKeyword(t)).toBe('opt_in')
  })
  it.each(['please stop', 'stop it', 'stopping', 'STOP!', '', null, undefined, 'unsubscribe me'])(
    'not a keyword: %j',
    (t) => {
      expect(detectOptKeyword(t as string | null | undefined)).toBeNull()
    },
  )
})

describe('isPhoneOptedOut', () => {
  it('matches on digits regardless of formatting', () => {
    const set = new Set(['919876543210'])
    expect(isPhoneOptedOut('+91 98765 43210', set)).toBe(true)
    expect(isPhoneOptedOut('919876543211', set)).toBe(false)
  })
})
