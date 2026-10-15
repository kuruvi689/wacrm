import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isPlatformAdmin } from '@/lib/auth/isPlatformAdmin'

/**
 * GET /auth/callback
 *
 * PKCE authorization code exchange handler for Supabase Auth.
 * Handles tenant auto-provisioning for client signups & platform admin routing.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const rawNext = searchParams.get('next') ?? '/dashboard'

  if (code) {
    let supabaseResponse = NextResponse.next()

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            )
            supabaseResponse = NextResponse.next()
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options)
            )
          },
        },
      }
    )

    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error && data.user) {
      const user = data.user
      const isAdmin = isPlatformAdmin(user.email)

      let targetDestination = '/dashboard'

      if (isAdmin) {
        targetDestination = '/admin'
      } else {
        // Client signup: Check or provision account context
        const { data: profile } = await supabase
          .from('profiles')
          .select('account_id')
          .eq('user_id', user.id)
          .maybeSingle()

        let accountId = profile?.account_id

        if (!accountId) {
          // Auto-create new tenant account
          const { data: newAccount, error: accErr } = await supabase
            .from('accounts')
            .insert({ name: user.email || 'Client Tenant' })
            .select('id')
            .single()

          if (!accErr && newAccount) {
            accountId = newAccount.id

            // Link user as owner in profiles / account_members
            await supabase.from('profiles').upsert({
              user_id: user.id,
              account_id: accountId,
              email: user.email,
              role: 'owner',
            })

            await supabase.from('account_members').insert({
              account_id: accountId,
              user_id: user.id,
              role: 'owner',
            })
          }
        }

        targetDestination = accountId ? `/onboarding/${accountId}` : '/onboarding'
      }

      const redirectUrl = new URL(targetDestination, origin)
      const res = NextResponse.redirect(redirectUrl)
      supabaseResponse.cookies.getAll().forEach((c) => res.cookies.set(c))
      return res
    } else if (error) {
      console.error('[auth/callback] Code exchange error:', error.message)
    }
  }

  const loginUrl = new URL('/login', origin)
  loginUrl.searchParams.set('error', 'Invalid or expired authentication link. Please sign in.')
  return NextResponse.redirect(loginUrl)
}
