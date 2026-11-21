'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

import { adminRequest } from './admin-api'
import type { AuditEntry } from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function AuditLog() {
  const [accountId, setAccountId] = useState('')
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)

  const trimmed = accountId.trim()
  const valid = trimmed === '' || UUID_RE.test(trimmed)

  useEffect(() => {
    if (!valid) return
    let cancelled = false
    const query = trimmed ? `?account_id=${trimmed}` : ''
    adminRequest<{ entries: AuditEntry[] }>(`/api/admin/billing/audit${query}`).then((result) => {
      if (cancelled) return
      if (result.ok) setEntries(result.data.entries)
      else toast.error(result.message)
    })
    return () => {
      cancelled = true
    }
  }, [trimmed, valid])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
        <CardDescription>Every settlement, rejection, refund, override and plan change. Entries cannot be edited.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Input
          placeholder="Filter by workspace id (optional)"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="max-w-md"
          aria-invalid={!valid}
        />
        {entries === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {entries.map((entry) => (
              <li key={entry.id} className="space-y-1 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{entry.action}</span>
                  <span className="text-xs text-muted-foreground">{entry.actor_email ?? 'system'}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{new Date(entry.created_at).toLocaleString()}</span>
                </div>
                <div className="break-all font-mono text-xs text-muted-foreground">
                  {entry.target_type}:{entry.target_id}
                  {entry.account_id ? ` · workspace ${entry.account_id}` : ''}
                </div>
                <pre className="overflow-x-auto text-xs text-muted-foreground">{JSON.stringify(entry.details)}</pre>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
