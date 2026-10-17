// GET /api/admin/accounts — every tenant with plan, status, usage.
// Platform operators only (PLATFORM_ADMIN_EMAILS).

import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/saas/admin-auth'

export async function GET() {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response

  const { data, error } = await auth.ctx.admin.rpc('admin_account_overview')
  if (error) {
    console.error('[admin/accounts] overview failed:', error)
    return NextResponse.json({ error: 'Could not load accounts' }, { status: 500 })
  }
  return NextResponse.json({ accounts: data ?? [] })
}
