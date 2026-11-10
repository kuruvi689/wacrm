const DEFAULT_NEXT_PATH = '/dashboard'

/**
 * Where to send the user after an auth redirect. Only same-site paths
 * are allowed: anything else (absolute URLs, protocol-relative `//host`,
 * backslash tricks) would make /auth/callback an open redirect.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return DEFAULT_NEXT_PATH
  }
  try {
    // Resolve against a dummy origin; a same-site path keeps that origin.
    const resolved = new URL(next, 'https://app.invalid')
    if (resolved.origin !== 'https://app.invalid') return DEFAULT_NEXT_PATH
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    return DEFAULT_NEXT_PATH
  }
}
