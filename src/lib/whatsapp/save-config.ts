import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt } from '@/lib/whatsapp/encryption'

export interface SaveWhatsAppConfigArgs {
  /** Cookie-session client (RLS scoped to the caller). */
  supabase: SupabaseClient
  /** Service-role client, used only to detect numbers claimed by other accounts. */
  admin: SupabaseClient
  accountId: string
  userId: string
  phone_number_id: string
  waba_id?: string | null
  access_token: string
  verify_token?: string | null
  /** 6-digit two-step-verification PIN used for /register. */
  pin?: string | null
}

/**
 * Verify a WhatsApp number with Meta, register it, subscribe its WABA to
 * this app, and persist the encrypted config for the account.
 *
 * Shared by the manual credentials form (POST /api/whatsapp/config) and
 * Meta Embedded Signup (POST /api/whatsapp/embedded-signup) so both paths
 * behave identically. Callers must already have authenticated the user,
 * enforced the role and the workspace gate, and validated the inputs.
 */
export async function saveWhatsAppConfig(args: SaveWhatsAppConfigArgs): Promise<NextResponse> {
  const {
    supabase,
    admin,
    accountId,
    userId,
    phone_number_id,
    waba_id,
    access_token,
    verify_token,
    pin,
  } = args

  // Reject if another account has already claimed this phone_number_id.
  // wacrm is single-tenant-per-WhatsApp-number — letting two accounts
  // bind the same number causes the webhook's `.single()` lookup to
  // throw PGRST116 ("multiple rows"), silently dropping every
  // inbound message. See issue #136. Post-multi-user we key on
  // account_id (not user_id) since teammates inside the same account
  // all share one config; the conflict is between accounts.
  const { data: claimed, error: claimedError } = await admin
    .from('whatsapp_config')
    .select('account_id')
    .eq('phone_number_id', phone_number_id)
    .neq('account_id', accountId)
    .maybeSingle()

  if (claimedError) {
    console.error('Error checking phone_number_id ownership:', claimedError)
    return NextResponse.json(
      { error: 'Failed to validate configuration' },
      { status: 500 }
    )
  }

  if (claimed) {
    return NextResponse.json(
      {
        error:
          'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
      },
      { status: 409 }
    )
  }

  // Verify credentials with Meta BEFORE saving
  let phoneInfo
  try {
    phoneInfo = await verifyPhoneNumber({
      phoneNumberId: phone_number_id,
      accessToken: access_token,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta API error'
    console.error('Meta API verification failed during save:', message)
    return NextResponse.json(
      { error: `Meta API error: ${message}` },
      { status: 400 }
    )
  }

  // Encrypt sensitive tokens before storing
  let encryptedAccessToken: string
  let encryptedVerifyToken: string | null
  try {
    encryptedAccessToken = encrypt(access_token)
    encryptedVerifyToken = verify_token ? encrypt(verify_token) : null
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown encryption error'
    console.error('Encryption failed:', message)
    return NextResponse.json(
      {
        error:
          'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
      },
      { status: 500 }
    )
  }

  // Look up any pre-existing row for this account so we know whether
  // this number is already registered with Meta — if so we can skip
  // /register when the user didn't provide a PIN this time around.
  const { data: existing } = await supabase
    .from('whatsapp_config')
    .select('id, registered_at, phone_number_id')
    .eq('account_id', accountId)
    .maybeSingle()

  const sameNumber =
    existing?.phone_number_id === phone_number_id &&
    existing?.registered_at != null

  // Step 1: register the phone number for inbound webhooks.
  //
  // Attempted on first save AND whenever the user supplies a fresh
  // PIN (e.g. they rotated the 2FA PIN in Meta Manager). Skipped
  // when the same number is already registered and no PIN was
  // supplied — re-registering an already-active number with a
  // stale PIN would actually fail and undo the active subscription.
  let registeredAt: string | null = existing?.registered_at ?? null
  let registrationError: string | null = null
  // True when registration was deliberately skipped because no PIN
  // was supplied (see below). Distinct from registrationError — this
  // is not a failure, just an incomplete-but-valid save.
  let registrationSkipped = false

  const needsRegistration = !sameNumber || (typeof pin === 'string' && pin.length > 0)
  if (needsRegistration) {
    if (!pin) {
      // No PIN provided. Meta TEST numbers (Developer Console) are
      // pre-registered by Meta and expose no two-step verification
      // PIN to set, so requiring one made them impossible to connect
      // (issue #242). The /register + PIN step only matters for
      // production numbers under a shared WABA (issue #136), so treat
      // it as best-effort: skip it, save the (already Meta-verified)
      // credentials as connected, and leave registered_at null. The
      // UI surfaces a separate "Not registered" banner with a path to
      // add a PIN later for users who do need inbound webhook routing.
      registrationSkipped = true
    } else {
      try {
        await registerPhoneNumber({
          phoneNumberId: phone_number_id,
          accessToken: access_token,
          pin,
        })
        registeredAt = new Date().toISOString()
      } catch (err) {
        registrationError =
          err instanceof Error ? err.message : 'Unknown Meta API error'
        console.error('Phone number /register failed:', registrationError)
        // We deliberately fall through and still save the row so the
        // user can retry without re-entering everything. The UI
        // surfaces `last_registration_error` so they see WHY it's
        // not actually live yet.
      }
    }
  }

  // Step 2: subscribe the WABA to this app. Idempotent on Meta's
  // side, so we call on every save and persist the timestamp.
  // Skipped only when there's no waba_id (legacy rows from before
  // we required it).
  let subscribedAppsAt: string | null = null
  if (waba_id) {
    try {
      await subscribeWabaToApp({
        wabaId: waba_id,
        accessToken: access_token,
      })
      subscribedAppsAt = new Date().toISOString()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('WABA subscribed_apps failed (non-fatal):', message)
      // Subscription failures are rare once the App has the right
      // permissions; we don't block save on them — the diagnostic
      // endpoint surfaces this state too.
    }
  }

  // Persist everything in one shot. If /register failed we still
  // store the credentials and the error so the UI can guide the
  // user through a retry.
  const baseRow = {
    phone_number_id,
    waba_id: waba_id || null,
    access_token: encryptedAccessToken,
    verify_token: encryptedVerifyToken,
    status: registrationError ? 'disconnected' : 'connected',
    connected_at: registrationError ? null : new Date().toISOString(),
    registered_at: registrationError ? null : registeredAt,
    subscribed_apps_at: subscribedAppsAt ?? null,
    last_registration_error: registrationError,
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from('whatsapp_config')
      .update(baseRow)
      .eq('account_id', accountId)

    if (updateError) {
      console.error('Error updating whatsapp_config:', updateError)
      return NextResponse.json(
        { error: 'Failed to update configuration' },
        { status: 500 }
      )
    }
  } else {
    // Insert with both columns: `account_id` is the tenancy key
    // (NOT NULL post-017, UNIQUE so duplicates trip the constraint
    // up-front), `user_id` is the audit column identifying which
    // member of the account saved the config.
    const { error: insertError } = await supabase
      .from('whatsapp_config')
      .insert({
        account_id: accountId,
        user_id: userId,
        ...baseRow,
      })

    if (insertError) {
      console.error('Error inserting whatsapp_config:', insertError)
      return NextResponse.json(
        { error: 'Failed to save configuration' },
        { status: 500 }
      )
    }
  }

  if (registrationError) {
    // Save succeeded but the number isn't actually live. Return
    // 200 with a structured error so the UI can show the specific
    // remediation step instead of a generic toast.
    return NextResponse.json({
      success: false,
      saved: true,
      registered: false,
      registration_error: registrationError,
      phone_info: phoneInfo,
    })
  }

  return NextResponse.json({
    success: true,
    saved: true,
    registered: registeredAt != null,
    // Credentials are valid and saved, but inbound webhook
    // registration was skipped because no PIN was supplied (e.g. a
    // Meta test number). The UI shows the "Not registered" banner
    // rather than claiming the number is fully live.
    registration_skipped: registrationSkipped,
    phone_info: phoneInfo,
  })
}
