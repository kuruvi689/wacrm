import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { toErrorResponse, ForbiddenError, UnauthorizedError } from '@/lib/auth/account'

import { isPlatformAdmin } from '@/lib/auth/isPlatformAdmin'

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function isUserSuperAdmin(user: { id: string; email?: string | null }, isSuperAdminProfile?: boolean): boolean {
  if (isSuperAdminProfile) return true
  return isPlatformAdmin(user?.email)
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

    const admin = supabaseAdmin()

    // 1. Fetch all accounts
    const { data: accounts, error: accErr } = await admin
      .from('accounts')
      .select('id, name, created_at, owner_user_id, onboarding_completed_at')
      .order('created_at', { ascending: false })

    if (accErr) {
      console.error('[GET /api/admin/overview] accounts query error:', accErr)
      return NextResponse.json({ error: 'Failed to query accounts' }, { status: 500 })
    }

    if (!accounts || accounts.length === 0) {
      return NextResponse.json({
        accounts: [],
        totalAccounts: 0,
        timestamp: new Date().toISOString(),
      })
    }

    const accountIds = accounts.map((a) => a.id)
    const ownerUserIds = Array.from(new Set(accounts.map((a) => a.owner_user_id)))

    // 2. Batched parallel queries (6 queries total, NO N+1 loop)
    const [
      { data: ownerProfiles },
      { data: allProfiles },
      { data: waConfigs },
      { data: contactsData },
      { data: conversationsData },
    ] = await Promise.all([
      admin
        .from('profiles')
        .select('user_id, email, full_name')
        .in('user_id', ownerUserIds),
      admin
        .from('profiles')
        .select('account_id')
        .in('account_id', accountIds),
      admin
        .from('whatsapp_config')
        .select('account_id, status, phone_number_id, waba_id, updated_at')
        .in('account_id', accountIds),
      admin
        .from('contacts')
        .select('account_id')
        .in('account_id', accountIds),
      admin
        .from('conversations')
        .select('account_id')
        .in('account_id', accountIds),
    ])

    // Build fast lookup maps in O(N)
    const ownerMap = new Map<string, { email: string; full_name: string | null }>()
    ownerProfiles?.forEach((p) => ownerMap.set(p.user_id, p))

    const memberCountMap = new Map<string, number>()
    allProfiles?.forEach((p) => {
      if (p.account_id) {
        memberCountMap.set(p.account_id, (memberCountMap.get(p.account_id) || 0) + 1)
      }
    })

    const waConfigMap = new Map<string, { status: string; phone_number_id: string | null; waba_id: string | null }>()
    waConfigs?.forEach((cfg) => {
      if (cfg.account_id) waConfigMap.set(cfg.account_id, cfg)
    })

    const contactCountMap = new Map<string, number>()
    contactsData?.forEach((c) => {
      if (c.account_id) {
        contactCountMap.set(c.account_id, (contactCountMap.get(c.account_id) || 0) + 1)
      }
    })

    const convCountMap = new Map<string, number>()
    conversationsData?.forEach((cv) => {
      if (cv.account_id) {
        convCountMap.set(cv.account_id, (convCountMap.get(cv.account_id) || 0) + 1)
      }
    })

    // Assemble final response list
    const accountOverviewList = accounts.map((acc) => {
      const owner = ownerMap.get(acc.owner_user_id)
      const waConfig = waConfigMap.get(acc.id)

      return {
        id: acc.id,
        name: acc.name,
        createdAt: acc.created_at,
        onboardingCompletedAt: acc.onboarding_completed_at,
        ownerEmail: owner?.email || 'N/A',
        ownerName: owner?.full_name || 'N/A',
        memberCount: memberCountMap.get(acc.id) || 1,
        whatsappStatus: waConfig?.status || 'disconnected',
        phoneNumberId: waConfig?.phone_number_id || null,
        wabaId: waConfig?.waba_id || null,
        stats: {
          contacts: contactCountMap.get(acc.id) || 0,
          conversations: convCountMap.get(acc.id) || 0,
          messages: 0,
        },
      }
    })

    return NextResponse.json({
      accounts: accountOverviewList,
      totalAccounts: accountOverviewList.length,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
