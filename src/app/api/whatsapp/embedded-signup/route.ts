// POST /api/whatsapp/embedded-signup
//
// Finishes Meta Embedded Signup: the browser sends the one-time `code`
// from FB.login plus the phone_number_id / waba_id Meta reported for
// the session. We exchange the code for the customer's business access
// token SERVER-SIDE (the app secret and the token never reach the
// browser), then save the connection through the same path as the
// manual credentials form.
//
// Admin+ only. The workspace gate (suspended / expired trial) is
// enforced by requireRole.

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { generateRegistrationPin, parseEmbeddedSignupBody } from '@/lib/whatsapp/embedded-signup'
import { exchangeEmbeddedSignupCode } from '@/lib/whatsapp/meta-api'
import { saveWhatsAppConfig } from '@/lib/whatsapp/save-config'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const limit = checkRateLimit(`admin:embedded-signup:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const parsed = parseEmbeddedSignupBody(await request.json().catch(() => null))
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }

    const appId = process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID
    const appSecret = process.env.META_APP_SECRET
    if (!appId || !appSecret) {
      console.error('[embedded-signup] META_APP_ID / META_APP_SECRET are not configured')
      return NextResponse.json(
        { error: 'Embedded Signup is not configured on this server.' },
        { status: 503 },
      )
    }

    let accessToken: string
    try {
      accessToken = await exchangeEmbeddedSignupCode({
        appId,
        appSecret,
        code: parsed.value.code,
      })
    } catch (err) {
      // Meta's message (e.g. "code has expired") is safe and actionable.
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[embedded-signup] code exchange failed:', message)
      return NextResponse.json({ error: `Meta rejected the sign-in: ${message}` }, { status: 400 })
    }

    return await saveWhatsAppConfig({
      supabase: ctx.supabase,
      admin: supabaseAdmin(),
      accountId: ctx.accountId,
      userId: ctx.userId,
      phone_number_id: parsed.value.phone_number_id,
      waba_id: parsed.value.waba_id,
      access_token: accessToken,
      verify_token: null,
      // Embedded Signup numbers need /register; the PIN becomes the
      // number's two-step-verification PIN. The customer can reset it
      // in WhatsApp Manager if they ever need to.
      pin: generateRegistrationPin(),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
