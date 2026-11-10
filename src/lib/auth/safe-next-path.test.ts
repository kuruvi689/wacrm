import { describe, it, expect } from 'vitest'

import { safeNextPath } from './safe-next-path'

describe('safeNextPath', () => {
  it('keeps same-site paths with query strings', () => {
    expect(safeNextPath('/dashboard')).toBe('/dashboard')
    expect(safeNextPath('/join/abc123?x=1')).toBe('/join/abc123?x=1')
  })

  it.each([
    null,
    undefined,
    '',
    'dashboard',
    'https://evil.com',
    '//evil.com',
    '/\\evil.com',
    '\\\\evil.com',
    'javascript:alert(1)',
    // Dot segments that normalize into a protocol-relative path.
    '/.//evil.com',
    '/x/..//evil.com',
    '/%2e//evil.com',
  ])('falls back to /dashboard for %j', (value) => {
    expect(safeNextPath(value)).toBe('/dashboard')
  })
})
