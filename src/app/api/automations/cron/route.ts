import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { isAuthorizedCronRequest, isCronConfigured } from '@/lib/cron/auth'

export const maxDuration = 60

/** A row stuck in 'running' longer than this is considered abandoned. */
const STUCK_AFTER_MS = 10 * 60 * 1000
/** Total claims allowed before a stuck row is marked failed (1 retry). */
const MAX_ATTEMPTS = 2

/**
 * Drain due `automation_pending_executions` rows. Hit on a schedule
 * (Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET`;
 * external pingers may use `x-cron-secret: $AUTOMATION_CRON_SECRET`).
 *
 * The claim step (status = 'running', claimed_at, attempts + 1) serves as
 * a lock so overlapping invocations don't double-process rows.
 *
 * Reaper: before draining, rows stuck in 'running' for more than 10 minutes
 * are returned to 'pending' if they have been claimed fewer than
 * MAX_ATTEMPTS times, otherwise marked 'failed'. Rows claimed before
 * migration 043 have no claimed_at and fall back to created_at.
 */
export async function GET(request: Request) {
  if (!isCronConfigured()) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const reaped = await reapStuckRows(admin)

  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0, reaped })

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({
        status: 'running',
        claimed_at: new Date().toISOString(),
        attempts: ((row.attempts as number | null) ?? 0) + 1,
      })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  return NextResponse.json({ processed, reaped })
}

/** Same handler for POST so external schedulers can use either verb. */
export const POST = GET

type Admin = ReturnType<typeof supabaseAdmin>

/**
 * Returns stuck 'running' rows to 'pending' (first time) or marks them
 * 'failed' (already claimed MAX_ATTEMPTS times). Every write is guarded by
 * `status = 'running'` so a row that finishes concurrently is left alone.
 */
async function reapStuckRows(
  admin: Admin,
): Promise<{ requeued: number; failed: number }> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString()
  const { data: stuck, error } = await admin
    .from('automation_pending_executions')
    .select('id, attempts')
    .eq('status', 'running')
    .or(`claimed_at.lt.${cutoff},and(claimed_at.is.null,created_at.lt.${cutoff})`)
    .limit(50)

  if (error) {
    console.error('[automations-cron] reaper scan failed:', error.message)
    return { requeued: 0, failed: 0 }
  }

  let requeued = 0
  let failed = 0
  for (const row of stuck ?? []) {
    const attempts = (row.attempts as number | null) ?? 0
    const exhausted = attempts >= MAX_ATTEMPTS
    const { data: updated, error: updateError } = await admin
      .from('automation_pending_executions')
      .update(
        exhausted
          ? { status: 'failed' }
          : { status: 'pending', claimed_at: null },
      )
      .eq('id', row.id)
      .eq('status', 'running')
      .select('id')

    if (updateError) {
      console.error('[automations-cron] reaper update failed:', updateError.message)
      continue
    }
    if (!updated || updated.length === 0) continue
    if (exhausted) failed++
    else requeued++
  }

  return { requeued, failed }
}
