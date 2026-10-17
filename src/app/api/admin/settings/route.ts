// GET/PATCH /api/admin/settings — defaults every NEW tenant inherits
// (trial length, seat cap, contact cap). Platform operators only.

import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/saas/admin-auth'
import { parseSettingsPatch } from '@/lib/saas/admin-input'

const COLUMNS = 'default_trial_days, default_max_members, default_max_contacts'

export async function GET() {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response

  const { data, error } = await auth.ctx.admin.from('platform_settings').select(COLUMNS).maybeSingle()
  if (error) {
    console.error('[admin/settings] read failed:', error)
    return NextResponse.json({ error: 'Could not load settings' }, { status: 500 })
  }
  return NextResponse.json({ settings: data })
}

export async function PATCH(request: Request) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response

  const parsed = parseSettingsPatch(await request.json().catch(() => null))
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  const { data, error } = await auth.ctx.admin
    .from('platform_settings')
    .update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq('id', true)
    .select(COLUMNS)
    .maybeSingle()

  if (error || !data) {
    console.error('[admin/settings] update failed:', error)
    return NextResponse.json({ error: 'Could not update settings' }, { status: 500 })
  }
  return NextResponse.json({ settings: data })
}
