import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { createClient as createAdminClient } from '@supabase/supabase-js'

/**
 * POST /api/whatsapp/embedded-signup
 *
 * Handles the Meta Embedded Signup OAuth code exchange flow.
 *
 * Flow:
 *   1. Client-side FB.login() returns an authorization code
 *   2. We exchange code → short-lived access token
 *   3. Exchange short-lived → long-lived token (60 days)
 *   4. Fetch WABA details and phone number info
 *   5. Register phone number for webhooks
 *   6. Subscribe WABA to our app
 *   7. Encrypt and store in whatsapp_config for the current account
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const body = await request.json()
    const { code, waba_id, phone_number_id } = body

    if (!code) {
      return NextResponse.json(
        { error: 'Authorization code is required' },
        { status: 400 },
      )
    }

    const META_APP_ID = process.env.META_APP_ID
    const META_APP_SECRET = process.env.META_APP_SECRET

    if (!META_APP_ID || !META_APP_SECRET) {
      return NextResponse.json(
        { error: 'Meta app credentials not configured on server' },
        { status: 500 },
      )
    }

    const META_API_VERSION = 'v21.0'
    const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

    // Step 1: Exchange authorization code for short-lived token
    const tokenUrl = new URL(`${META_API_BASE}/oauth/access_token`)
    tokenUrl.searchParams.set('client_id', META_APP_ID)
    tokenUrl.searchParams.set('client_secret', META_APP_SECRET)
    tokenUrl.searchParams.set('code', code)

    const tokenRes = await fetch(tokenUrl.toString(), { method: 'POST' })
    const tokenData = await tokenRes.json()

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[embedded-signup] Code exchange failed:', tokenData)
      return NextResponse.json(
        {
          error:
            tokenData.error?.message ||
            'Failed to exchange authorization code for access token',
        },
        { status: 400 },
      )
    }

    const shortLivedToken = tokenData.access_token

    // Step 2: Exchange short-lived token for long-lived token (60 days)
    const longLivedUrl = new URL(`${META_API_BASE}/oauth/access_token`)
    longLivedUrl.searchParams.set('grant_type', 'fb_exchange_token')
    longLivedUrl.searchParams.set('client_id', META_APP_ID)
    longLivedUrl.searchParams.set('client_secret', META_APP_SECRET)
    longLivedUrl.searchParams.set('fb_exchange_token', shortLivedToken)

    const longLivedRes = await fetch(longLivedUrl.toString())
    const longLivedData = await longLivedRes.json()

    // If long-lived exchange fails, fall back to the short-lived token
    const accessToken = longLivedData.access_token || shortLivedToken

    // Step 3: Determine WABA ID if not provided
    let resolvedWabaId = waba_id
    if (!resolvedWabaId) {
      // Try to find the WABA from the debug token
      try {
        const debugRes = await fetch(
          `${META_API_BASE}/debug_token?input_token=${accessToken}`,
          {
            headers: { Authorization: `Bearer ${META_APP_ID}|${META_APP_SECRET}` },
          },
        )
        const debugData = await debugRes.json()
        // Extract WABA from the granular scopes
        const scopes = debugData.data?.granular_scopes || []
        const wabaScope = scopes.find(
          (s: { scope: string; target_ids?: string[] }) =>
            s.scope === 'whatsapp_business_management',
        )
        if (wabaScope?.target_ids?.[0]) {
          resolvedWabaId = wabaScope.target_ids[0]
        }
      } catch (err) {
        console.warn('[embedded-signup] Could not auto-detect WABA:', err)
      }
    }

    // Step 4: Determine phone number ID if not provided
    let resolvedPhoneNumberId = phone_number_id
    if (!resolvedPhoneNumberId && resolvedWabaId) {
      try {
        const phonesRes = await fetch(
          `${META_API_BASE}/${resolvedWabaId}/phone_numbers`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        )
        const phonesData = await phonesRes.json()
        if (phonesData.data?.[0]?.id) {
          resolvedPhoneNumberId = phonesData.data[0].id
        }
      } catch (err) {
        console.warn('[embedded-signup] Could not fetch phone numbers:', err)
      }
    }

    if (!resolvedPhoneNumberId) {
      return NextResponse.json(
        { error: 'Could not determine WhatsApp phone number ID' },
        { status: 400 },
      )
    }

    // Step 5: Register the phone number for webhooks
    try {
      const registerRes = await fetch(
        `${META_API_BASE}/${resolvedPhoneNumberId}/register`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            pin: '000000', // Default PIN for embedded signup
          }),
        },
      )
      if (!registerRes.ok) {
        const regData = await registerRes.json()
        console.warn('[embedded-signup] Phone registration warning:', regData)
        // Don't fail — registration may already be done
      }
    } catch (err) {
      console.warn('[embedded-signup] Phone registration error (non-fatal):', err)
    }

    // Step 6: Subscribe the WABA to our app's webhooks
    if (resolvedWabaId) {
      try {
        await fetch(
          `${META_API_BASE}/${resolvedWabaId}/subscribed_apps`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
          },
        )
      } catch (err) {
        console.warn('[embedded-signup] WABA subscription error (non-fatal):', err)
      }
    }

    // Step 7: Fetch phone number details for display
    let phoneDisplayNumber = ''
    let verifiedName = ''
    try {
      const phoneInfoRes = await fetch(
        `${META_API_BASE}/${resolvedPhoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      )
      const phoneInfo = await phoneInfoRes.json()
      phoneDisplayNumber = phoneInfo.display_phone_number || ''
      verifiedName = phoneInfo.verified_name || ''
    } catch {
      // Non-fatal — we can still save the config
    }

    // Step 8: Encrypt and store in whatsapp_config
    const encryptedToken = encrypt(accessToken)
    const now = new Date().toISOString()
    const secureVerifyToken = encrypt(crypto.randomUUID())

    // Use admin client to avoid RLS issues during upsert
    const adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    // Check if phone_number_id is already claimed by another account
    const { data: claimedByOther } = await adminClient
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', resolvedPhoneNumberId)
      .neq('account_id', ctx.accountId)
      .maybeSingle()

    if (claimedByOther) {
      return NextResponse.json(
        { error: 'This WhatsApp phone number is already connected to another workspace.' },
        { status: 409 },
      )
    }

    // Check if config already exists for this account
    const { data: existingConfig } = await adminClient
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (existingConfig) {
      await adminClient
        .from('whatsapp_config')
        .update({
          phone_number_id: resolvedPhoneNumberId,
          waba_id: resolvedWabaId || null,
          access_token: encryptedToken,
          verify_token: secureVerifyToken,
          status: 'connected',
          connected_at: now,
          registered_at: now,
          updated_at: now,
          subscribed_apps_at: now,
          last_registration_error: null,
        })
        .eq('id', existingConfig.id)
    } else {
      await adminClient.from('whatsapp_config').insert({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        phone_number_id: resolvedPhoneNumberId,
        waba_id: resolvedWabaId || null,
        access_token: encryptedToken,
        verify_token: secureVerifyToken,
        status: 'connected',
        connected_at: now,
        registered_at: now,
        subscribed_apps_at: now,
      })
    }

    return NextResponse.json({
      success: true,
      phone_number_id: resolvedPhoneNumberId,
      waba_id: resolvedWabaId,
      display_phone_number: phoneDisplayNumber,
      verified_name: verifiedName,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
