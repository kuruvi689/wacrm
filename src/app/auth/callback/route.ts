// GET /auth/callback
//
// Landing point for Supabase's PKCE redirects (Google sign-in today).
// Supabase sends the browser here with a one-time `code`; we exchange
// it for a session server-side, which writes the auth cookies, then
// forward the user to `next`.

import { NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { safeNextPath } from '@/lib/auth/safe-next-path'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const next = safeNextPath(url.searchParams.get('next'))

  // Provider-side failures (user cancelled, consent denied) arrive as
  // ?error=…&error_description=… instead of a code.
  const providerError = url.searchParams.get('error_description') || url.searchParams.get('error')

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(new URL(next, url.origin))
    }
    console.error('[auth/callback] code exchange failed:', error.message)
  }

  const login = new URL('/login', url.origin)
  login.searchParams.set('error', providerError || 'Sign-in failed. Please try again.')
  return NextResponse.redirect(login)
}
