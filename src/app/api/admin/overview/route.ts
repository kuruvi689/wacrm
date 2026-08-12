import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { toErrorResponse, ForbiddenError, UnauthorizedError } from '@/lib/auth/account'

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function isUserSuperAdmin(user: { id: string; email?: string | null }, isSuperAdminProfile?: boolean): boolean {
  if (isSuperAdminProfile) return true
  // Hardcoded owner fallback & env var fallback
  const hardcodedOwnerId = '678aa37d-2140-4567-ac27-e62c21f4b0b9'
  const hardcodedOwnerEmail = 'ssivanesh544@gmail.com'
  const envSuperAdminEmails = (process.env.SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

  if (user.id === hardcodedOwnerId) return true
  if (user.email && user.email.toLowerCase() === hardcodedOwnerEmail) return true
  if (user.email && envSuperAdminEmails.includes(user.email.toLowerCase())) return true

  return false
}

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: userErr } = await supabase.auth.getUser()
    if (userErr || !user) {
      throw new UnauthorizedError()
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('is_super_admin')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!isUserSuperAdmin(user, Boolean(profile?.is_super_admin))) {
      throw new ForbiddenError('Super Admin oversight access required')
    }

    // Service-role client queries all tenant accounts safely
    const admin = supabaseAdmin()

    const { data: accounts, error: accErr } = await admin
      .from('accounts')
      .select('id, name, created_at, owner_user_id, onboarding_completed_at')
      .order('created_at', { ascending: false })

    if (accErr) {
      console.error('[GET /api/admin/overview] accounts query error:', accErr)
      return NextResponse.json({ error: 'Failed to query accounts' }, { status: 500 })
    }

    const accountOverviewList = await Promise.all(
      (accounts || []).map(async (acc) => {
        // Owner email lookup
        const { data: ownerProfile } = await admin
          .from('profiles')
          .select('email, full_name')
          .eq('user_id', acc.owner_user_id)
          .maybeSingle()

        // Member count
        const { count: memberCount } = await admin
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', acc.id)

        // WhatsApp config status
        const { data: waConfig } = await admin
          .from('whatsapp_config')
          .select('status, phone_number_id, waba_id, updated_at')
          .eq('account_id', acc.id)
          .maybeSingle()

        // Contact count
        const { count: contactCount } = await admin
          .from('contacts')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', acc.id)

        // Conversation count
        const { count: conversationCount } = await admin
          .from('conversations')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', acc.id)

        // Message count
        const { count: messageCount } = await admin
          .from('messages')
          .select('id, conversations!inner(account_id)', { count: 'exact', head: true })
          .eq('conversations.account_id', acc.id)

        return {
          id: acc.id,
          name: acc.name,
          createdAt: acc.created_at,
          onboardingCompletedAt: acc.onboarding_completed_at,
          ownerEmail: ownerProfile?.email || 'N/A',
          ownerName: ownerProfile?.full_name || 'N/A',
          memberCount: memberCount || 1,
          whatsappStatus: waConfig?.status || 'disconnected',
          phoneNumberId: waConfig?.phone_number_id || null,
          wabaId: waConfig?.waba_id || null,
          stats: {
            contacts: contactCount || 0,
            conversations: conversationCount || 0,
            messages: messageCount || 0,
          },
        }
      })
    )

    return NextResponse.json({
      accounts: accountOverviewList,
      totalAccounts: accountOverviewList.length,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
