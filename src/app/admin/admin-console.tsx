'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type Status = 'trialing' | 'active' | 'suspended'

interface AccountRow {
  id: string
  name: string
  owner_email: string | null
  plan: string
  status: Status
  trial_ends_at: string | null
  max_members: number | null
  max_contacts: number | null
  suspended_reason: string | null
  created_at: string
  member_count: number
  contact_count: number
}

interface Defaults {
  default_trial_days: number | null
  default_max_members: number | null
  default_max_contacts: number | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const TRIAL_EXTENSION_DAYS = 14

const STATUS_STYLE: Record<Status, string> = {
  active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  trialing: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  suspended: 'bg-red-500/15 text-red-700 dark:text-red-300',
}

async function sendPatch(url: string, body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.ok) return true
  const payload = await res.json().catch(() => null)
  toast.error(payload?.error ?? 'Request failed')
  return false
}

interface ConsoleData {
  accounts: AccountRow[]
  defaults: Defaults
}

async function fetchConsole(): Promise<ConsoleData | null> {
  const [accountsRes, settingsRes] = await Promise.all([
    fetch('/api/admin/accounts'),
    fetch('/api/admin/settings'),
  ])
  if (!accountsRes.ok || !settingsRes.ok) return null
  return {
    accounts: (await accountsRes.json()).accounts,
    defaults: (await settingsRes.json()).settings,
  }
}

/** Indirection so "now" is read in event handlers, not during render. */
const nowMs = () => Date.now()

function toLimit(value: string): number | null {
  return value.trim() === '' ? null : Number(value)
}

export function AdminConsole() {
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [defaults, setDefaults] = useState<Defaults | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')

  const apply = useCallback((data: ConsoleData | null) => {
    if (data) {
      setAccounts(data.accounts)
      setDefaults(data.defaults)
    } else {
      toast.error('Could not load the operator console')
    }
    setLoading(false)
  }, [])

  const reload = useCallback(async () => apply(await fetchConsole()), [apply])

  useEffect(() => {
    let cancelled = false
    fetchConsole().then((data) => {
      if (!cancelled) apply(data)
    })
    return () => {
      cancelled = true
    }
  }, [apply])

  async function updateAccount(id: string, body: Record<string, unknown>, success: string) {
    if (await sendPatch(`/api/admin/accounts/${id}`, body)) {
      toast.success(success)
      await reload()
    }
  }

  async function saveDefaults(next: Defaults) {
    if (await sendPatch('/api/admin/settings', { ...next })) {
      toast.success('Defaults saved — they apply to new signups')
      await reload()
    }
  }

  const visible = accounts.filter((account) => {
    const needle = filter.trim().toLowerCase()
    return !needle || `${account.name} ${account.owner_email ?? ''}`.toLowerCase().includes(needle)
  })

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Operator console</h1>
        <p className="text-muted-foreground">
          {accounts.length} workspaces · {accounts.filter((a) => a.status === 'active').length} active ·{' '}
          {accounts.filter((a) => a.status === 'trialing').length} trialing ·{' '}
          {accounts.filter((a) => a.status === 'suspended').length} suspended
        </p>
      </header>

      {defaults && <DefaultsCard defaults={defaults} onSave={saveDefaults} />}

      <Card>
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>Plan changes take effect immediately. Empty limit = unlimited.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            placeholder="Search by name or owner email"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="max-w-sm"
          />
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No workspaces match.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {visible.map((account) => (
                <AccountRowView key={account.id} account={account} onUpdate={updateAccount} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  )
}

function DefaultsCard({ defaults, onSave }: { defaults: Defaults; onSave: (next: Defaults) => void }) {
  const [trialDays, setTrialDays] = useState(String(defaults.default_trial_days ?? ''))
  const [members, setMembers] = useState(String(defaults.default_max_members ?? ''))
  const [contacts, setContacts] = useState(String(defaults.default_max_contacts ?? ''))

  return (
    <Card>
      <CardHeader>
        <CardTitle>New-signup defaults</CardTitle>
        <CardDescription>
          Every new workspace starts with these. Leave trial days empty for no trial (instantly active).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        {[
          ['Trial days', trialDays, setTrialDays],
          ['Max members', members, setMembers],
          ['Max contacts', contacts, setContacts],
        ].map(([label, value, setter]) => (
          <div key={label as string} className="space-y-1.5">
            <Label>{label as string}</Label>
            <Input
              inputMode="numeric"
              className="w-32"
              value={value as string}
              onChange={(event) => (setter as (v: string) => void)(event.target.value)}
            />
          </div>
        ))}
        <Button
          onClick={() =>
            onSave({
              default_trial_days: toLimit(trialDays),
              default_max_members: toLimit(members),
              default_max_contacts: toLimit(contacts),
            })
          }
        >
          Save defaults
        </Button>
      </CardContent>
    </Card>
  )
}

function AccountRowView({
  account,
  onUpdate,
}: {
  account: AccountRow
  onUpdate: (id: string, body: Record<string, unknown>, success: string) => Promise<void>
}) {
  const [plan, setPlan] = useState(account.plan)
  const [members, setMembers] = useState(String(account.max_members ?? ''))
  const [contacts, setContacts] = useState(String(account.max_contacts ?? ''))

  const trialEnd = account.trial_ends_at ? new Date(account.trial_ends_at) : null

  // Computed at click time (not render) so "now" is never stale or impure.
  function extendTrial() {
    const base = Math.max(nowMs(), trialEnd?.getTime() ?? 0)
    const extendedTrialEnd = new Date(base + TRIAL_EXTENSION_DAYS * DAY_MS).toISOString()
    onUpdate(
      account.id,
      { status: 'trialing', trial_ends_at: extendedTrialEnd },
      `Trial extended ${TRIAL_EXTENSION_DAYS} days`,
    )
  }

  return (
    <li className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{account.name}</span>
        <Badge className={STATUS_STYLE[account.status]}>{account.status}</Badge>
        <span className="text-sm text-muted-foreground">{account.owner_email ?? 'no owner email'}</span>
        <span className="ml-auto text-sm text-muted-foreground">
          {account.member_count} members · {account.contact_count} contacts
          {trialEnd && ` · trial ends ${trialEnd.toLocaleDateString()}`}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Plan label</Label>
          <Input className="h-8 w-32" value={plan} onChange={(event) => setPlan(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Max members</Label>
          <Input className="h-8 w-24" value={members} onChange={(event) => setMembers(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Max contacts</Label>
          <Input className="h-8 w-28" value={contacts} onChange={(event) => setContacts(event.target.value)} />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onUpdate(
              account.id,
              { plan, max_members: toLimit(members), max_contacts: toLimit(contacts) },
              'Plan updated',
            )
          }
        >
          Save plan
        </Button>

        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={extendTrial}>
            Extend trial
          </Button>
          {account.status !== 'active' && (
            <Button size="sm" onClick={() => onUpdate(account.id, { status: 'active', trial_ends_at: null }, 'Workspace activated')}>
              Activate
            </Button>
          )}
          {account.status !== 'suspended' && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                if (window.confirm(`Suspend "${account.name}"? Their team loses access immediately.`)) {
                  onUpdate(account.id, { status: 'suspended' }, 'Workspace suspended')
                }
              }}
            >
              Suspend
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}
