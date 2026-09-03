import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const body = (await request.json().catch(() => null)) as {
      businessName?: string
      phone_number_id?: string
      waba_id?: string
      access_token?: string
      pin?: string
      verify_token?: string
    } | null

    const businessName = body?.businessName?.trim()
    if (!businessName) {
      return NextResponse.json(
        { error: 'Business name is required' },
        { status: 400 }
      )
    }

    const now = new Date().toISOString()

    // 1. Update business name and set onboarding_completed_at on accounts
    const { error: accountError } = await ctx.supabase
      .from('accounts')
      .update({
        name: businessName,
        onboarding_completed_at: now,
        updated_at: now,
      })
      .eq('id', ctx.accountId)

    if (accountError) {
      console.warn('[POST /api/onboarding/complete] full update failed, falling back to name update:', accountError.message)
      await ctx.supabase
        .from('accounts')
        .update({
          name: businessName,
          updated_at: now,
        })
        .eq('id', ctx.accountId)
    }

    // 2. Optional WhatsApp credentials save (developer mode or embedded signup completion)
    if (body?.phone_number_id && body?.access_token) {
      const phoneNumberId = body.phone_number_id.trim()
      const wabaId = body.waba_id?.trim() || null
      const rawToken = body.access_token.trim()
      const verifyToken = body.verify_token?.trim() || 'teddy'
      const encryptedToken = encrypt(rawToken)
      const encryptedVerifyToken = encrypt(verifyToken)

      const { data: existingConfig } = await ctx.supabase
        .from('whatsapp_config')
        .select('id')
        .eq('account_id', ctx.accountId)
        .maybeSingle()

      if (existingConfig) {
        await ctx.supabase
          .from('whatsapp_config')
          .update({
            phone_number_id: phoneNumberId,
            waba_id: wabaId,
            access_token: encryptedToken,
            verify_token: encryptedVerifyToken,
            status: 'connected',
            connected_at: now,
            updated_at: now,
            subscribed_apps_at: now,
            last_registration_error: null,
          })
          .eq('id', existingConfig.id)
      } else {
        await ctx.supabase.from('whatsapp_config').insert({
          account_id: ctx.accountId,
          user_id: ctx.userId,
          phone_number_id: phoneNumberId,
          waba_id: wabaId,
          access_token: encryptedToken,
          verify_token: encryptedVerifyToken,
          status: 'connected',
          connected_at: now,
          subscribed_apps_at: now,
        })
      }
    }

    return NextResponse.json({
      success: true,
      accountId: ctx.accountId,
      businessName,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
