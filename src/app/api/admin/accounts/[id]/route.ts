// PATCH /api/admin/accounts/:id — change a tenant's plan, status,
// trial end or limits. Platform operators only.

import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/saas/admin-auth'
import { parseAccountPatch } from '@/lib/saas/admin-input'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: 'Invalid account id' }, { status: 400 })
  }

  const parsed = parseAccountPatch(await request.json().catch(() => null))
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  const patch = { ...parsed.value }
  // Reactivating clears the suspension note; suspending without one is fine.
  if (patch.status && patch.status !== 'suspended' && patch.suspended_reason === undefined) {
    patch.suspended_reason = null
  }

  const { data, error } = await auth.ctx.admin
    .from('accounts')
    .update(patch)
    .eq('id', id)
    .select('id, plan, status, trial_ends_at, max_members, max_contacts, suspended_reason')
    .maybeSingle()

  if (error) {
    console.error('[admin/accounts] update failed:', error)
    return NextResponse.json({ error: 'Could not update account' }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  console.info(`[admin] ${auth.ctx.email} updated account ${id}:`, Object.keys(patch).join(','))
  return NextResponse.json({ account: data })
}
