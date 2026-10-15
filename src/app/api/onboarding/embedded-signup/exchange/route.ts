import { NextResponse } from 'next/server'
import { storeTenantConnection } from '@/lib/whatsapp/token-vault'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { code, waba_id, phone_number_id, org_id, manual_access_token, display_phone_number } = body

    if (!org_id) {
      return NextResponse.json({ error: 'org_id is required' }, { status: 400 })
    }

    const META_APP_ID = process.env.META_APP_ID
    const META_APP_SECRET = process.env.META_APP_SECRET
    const META_API_VERSION = process.env.META_API_VERSION || 'v20.0'
    const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

    let accessToken = manual_access_token
    let resolvedWabaId = waba_id
    let resolvedPhoneNumberId = phone_number_id
    let resolvedDisplayPhoneNumber = display_phone_number || ''

    // Manual token fallback for development/testing without App Review
    if (manual_access_token && resolvedPhoneNumberId) {
      console.log('[embedded-signup] Using manual access token fallback')
    } else if (code) {
      if (!META_APP_ID || !META_APP_SECRET) {
        return NextResponse.json(
          { error: 'META_APP_ID or META_APP_SECRET not configured on server' },
          { status: 500 }
        )
      }

      // Step 1: Exchange code -> access_token via Meta Graph API
      const tokenUrl = new URL(`${META_API_BASE}/oauth/access_token`)
      tokenUrl.searchParams.set('client_id', META_APP_ID)
      tokenUrl.searchParams.set('client_secret', META_APP_SECRET)
      tokenUrl.searchParams.set('code', code)

      const tokenRes = await fetch(tokenUrl.toString(), { method: 'GET' })
      const tokenData = await tokenRes.json()

      if (!tokenRes.ok || !tokenData.access_token) {
        console.error('[embedded-signup] Code exchange failed:', tokenData)
        return NextResponse.json(
          {
            error:
              tokenData.error?.message ||
              'Failed to exchange authorization code for access token',
          },
          { status: 400 }
        )
      }

      accessToken = tokenData.access_token

      // Step 2: Debug token to extract granular_scopes if WABA ID not provided
      if (!resolvedWabaId) {
        try {
          const debugUrl = `${META_API_BASE}/debug_token?input_token=${accessToken}&access_token=${META_APP_ID}|${META_APP_SECRET}`
          const debugRes = await fetch(debugUrl)
          const debugData = await debugRes.json()

          const granularScopes = debugData.data?.granular_scopes || []
          const wabaScope = granularScopes.find(
            (s: { scope: string; target_ids?: string[] }) =>
              s.scope === 'whatsapp_business_management'
          )
          if (wabaScope?.target_ids?.[0]) {
            resolvedWabaId = wabaScope.target_ids[0]
          }
        } catch (err) {
          console.warn('[embedded-signup] Debug token auto-detect WABA failed:', err)
        }
      }

      // Step 3: GET /{waba_id}/phone_numbers to fetch numbers
      if (resolvedWabaId && !resolvedPhoneNumberId) {
        try {
          const phonesRes = await fetch(`${META_API_BASE}/${resolvedWabaId}/phone_numbers`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
          const phonesData = await phonesRes.json()
          if (phonesData.data && phonesData.data.length > 0) {
            resolvedPhoneNumberId = phonesData.data[0].id
            resolvedDisplayPhoneNumber = phonesData.data[0].display_phone_number || ''
          }
        } catch (err) {
          console.warn('[embedded-signup] Fetch phone numbers failed:', err)
        }
      }

      // Step 4: POST /{waba_id}/subscribed_apps to subscribe our app
      if (resolvedWabaId) {
        try {
          await fetch(`${META_API_BASE}/${resolvedWabaId}/subscribed_apps`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}` },
          })
        } catch (err) {
          console.warn('[embedded-signup] Subscribe app error (non-fatal):', err)
        }
      }
    } else {
      return NextResponse.json(
        { error: 'Either authorization code or manual access token is required' },
        { status: 400 }
      )
    }

    if (!resolvedPhoneNumberId) {
      return NextResponse.json(
        { error: 'Could not determine WhatsApp phone_number_id' },
        { status: 400 }
      )
    }

    // If display phone number is still empty, fetch phone details
    if (!resolvedDisplayPhoneNumber && accessToken) {
      try {
        const phoneRes = await fetch(
          `${META_API_BASE}/${resolvedPhoneNumberId}?fields=display_phone_number`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        )
        const phoneData = await phoneRes.json()
        if (phoneData.display_phone_number) {
          resolvedDisplayPhoneNumber = phoneData.display_phone_number
        }
      } catch (err) {
        console.warn('[embedded-signup] Fetch phone details warning:', err)
      }
    }

    // Step 5: Encrypt token and store in whatsapp_connections table
    const connection = await storeTenantConnection({
      org_id,
      phone_number_id: resolvedPhoneNumberId,
      waba_id: resolvedWabaId || null,
      display_phone_number: resolvedDisplayPhoneNumber || null,
      raw_access_token: accessToken,
      status: 'active',
      meta_data: { onboarded_at: new Date().toISOString() },
    })

    return NextResponse.json({
      success: true,
      org_id,
      waba_id: connection.waba_id,
      phone_number_id: connection.phone_number_id,
      display_phone_number: connection.display_phone_number,
    })
  } catch (err: any) {
    console.error('[embedded-signup/exchange] Error:', err)
    return NextResponse.json(
      { error: err.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
