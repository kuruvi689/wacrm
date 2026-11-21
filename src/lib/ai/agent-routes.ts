import { NextResponse } from 'next/server'
import { toErrorResponse } from '@/lib/auth/account'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { AgentAdminError, parseVersionInput, type VersionInput } from './agent-admin'
import { AiError } from './types'

/** Map any agent-route failure to a JSON response ({ error, code? }). */
export function agentErrorResponse(err: unknown): NextResponse {
  if (err instanceof AgentAdminError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
  }
  if (err instanceof AiError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
  }
  const known = toErrorResponse(err)
  if (known.status !== 500) return known
  console.error('[ai/agents] unexpected error:', err instanceof Error ? err.message : err)
  return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
}

/** Validate a version payload and make sure its n8n URL is a public
 *  HTTPS endpoint (re-checked again on every call). */
export async function parseAndCheckVersion(
  raw: unknown,
  base?: VersionInput,
): Promise<{ ok: true; value: VersionInput } | { ok: false; response: NextResponse }> {
  const parsed = parseVersionInput(raw, base)
  if (!parsed.ok) {
    return { ok: false, response: NextResponse.json({ error: parsed.error, code: 'invalid_input' }, { status: 400 }) }
  }
  const url = parsed.value.n8n_webhook_url
  if (url && url !== base?.n8n_webhook_url && !(await isDeliverableUrl(url))) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'The n8n webhook URL must be a public https:// address.', code: 'webhook_url_not_allowed' },
        { status: 400 },
      ),
    }
  }
  return { ok: true, value: parsed.value }
}

export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length >= 1 && t.length <= 80 ? t : null
}

export function optionalText(v: unknown, max: number): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'string' || v.length > max) return undefined
  return v.trim() || null
}
