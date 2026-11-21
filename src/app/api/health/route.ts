import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import pkg from '../../../../package.json'

export const dynamic = 'force-dynamic'

/** Hard cap on the database probe so a hung DB can't hang the health check. */
export const DB_TIMEOUT_MS = 3000

export type DatabaseCheck = { ok: boolean; latency_ms: number }

export type HealthBody = {
  status: 'ok' | 'degraded'
  checks: { database: DatabaseCheck }
  version: string
}

/**
 * Unauthenticated liveness/readiness probe. Returns only status, a latency
 * number and the package version: no env values, no error text.
 */
export async function GET() {
  const database = await checkDatabase()
  const body: HealthBody = {
    status: database.ok ? 'ok' : 'degraded',
    checks: { database },
    version: pkg.version,
  }
  return NextResponse.json(body, { status: database.ok ? 200 : 503 })
}

/** Cheap `select` through the service-role client, bounded by DB_TIMEOUT_MS. */
export async function checkDatabase(): Promise<DatabaseCheck> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const probe = supabaseAdmin()
      .from('accounts')
      .select('id')
      .limit(1)
      .then(({ error }) => {
        if (error) throw new Error('probe failed')
      })
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), DB_TIMEOUT_MS)
    })
    await Promise.race([probe, timeout])
    return { ok: true, latency_ms: Date.now() - started }
  } catch {
    return { ok: false, latency_ms: Date.now() - started }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
