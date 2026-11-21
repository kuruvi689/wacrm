// GET /auth/callback
//
// Landing point for Supabase's PKCE redirects (Google sign-in today).
// Supabase sends the browser here with a one-time `code`; we exchange
// it for a session server-side, which writes the auth cookies, then
// forward the user to `next`.

import { NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { safeNextPath } from '@/lib/auth/safe-next-path'
import { signInErrorCode } from '@/lib/auth/sign-in-errors'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const next = safeNextPath(url.searchParams.get('next'))

  const recoveryRequested = next === '/reset-password'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(new URL(next, url.origin))
    }
    console.error('[auth/callback] code exchange failed:', error.message)
  }

  if (recoveryRequested) {
    return NextResponse.redirect(new URL('/forgot-password?expired=1', url.origin))
  }

  // Provider-side failures (user cancelled, consent denied) arrive as
  // ?error=… instead of a code. Only a fixed code is passed on, never
  // the provider's free text.
  const login = new URL('/login', url.origin)
  login.searchParams.set('error', signInErrorCode(url.searchParams.get('error')))
  return NextResponse.redirect(login)
}
