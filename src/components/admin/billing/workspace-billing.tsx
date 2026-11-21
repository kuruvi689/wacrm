'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatMinor } from '@/lib/products/money'

import { adminRequest } from './admin-api'
import { ReasonDialog } from './reason-dialog'
import type { AccountBilling, AccountInvoice, AdminPlan, WorkspaceRow } from './types'

type EventKind = 'suspend' | 'reinstate' | 'cancel'

const EVENT_COPY: Record<EventKind, { title: string; description: string; confirm: string; destructive: boolean }> = {
  suspend: { title: 'Suspend workspace', description: 'The team loses access immediately.', confirm: 'Suspend', destructive: true },
  reinstate: { title: 'Reinstate workspace', description: 'Restores the plan the workspace had before suspension.', confirm: 'Reinstate', destructive: false },
  cancel: { title: 'Cancel subscription', description: 'Ends the subscription now. Use refunds separately if money goes back.', confirm: 'Cancel subscription', destructive: true },
}

const SELECT_CLASS = 'h-8 w-full rounded-lg border border-input bg-background px-2 text-sm'

export function WorkspaceBilling() {
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [plans, setPlans] = useState<AdminPlan[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      adminRequest<{ accounts: WorkspaceRow[] }>('/api/admin/accounts'),
      adminRequest<{ plans: AdminPlan[] }>('/api/admin/billing/plans'),
    ]).then(([accounts, planList]) => {
      if (cancelled) return
      if (accounts.ok) setWorkspaces(accounts.data.accounts)
      else toast.error(accounts.message)
      if (planList.ok) setPlans(planList.data.plans)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const needle = filter.trim().toLowerCase()
  const visible = workspaces.filter((w) => !needle || `${w.name} ${w.owner_email ?? ''}`.toLowerCase().includes(needle))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace subscriptions</CardTitle>
        <CardDescription>Override a plan, suspend, reinstate, cancel or record a refund. Every action needs a reason and is audited.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Input placeholder="Search by name or owner email" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-sm" />
        <ul className="max-h-56 divide-y overflow-y-auto rounded-lg border">
          {visible.map((workspace) => (
            <li key={workspace.id}>
              <button
                type="button"
                onClick={() => setSelectedId(workspace.id)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted ${selectedId === workspace.id ? 'bg-muted' : ''}`}
              >
                <span className="font-medium">{workspace.name}</span>
                <span className="text-muted-foreground">{workspace.owner_email ?? ''}</span>
              </button>
            </li>
          ))}
          {visible.length === 0 ? <li className="p-3 text-sm text-muted-foreground">No workspaces match.</li> : null}
        </ul>
        {selectedId ? <AccountPanel key={selectedId} accountId={selectedId} plans={plans} /> : null}
      </CardContent>
    </Card>
  )
}

function AccountPanel({ accountId, plans }: { accountId: string; plans: AdminPlan[] }) {
  const [data, setData] = useState<AccountBilling | null>(null)
  const [event, setEvent] = useState<EventKind | null>(null)
  const [refunding, setRefunding] = useState<AccountInvoice | null>(null)

  const load = useCallback(async () => {
    const result = await adminRequest<AccountBilling>(`/api/admin/billing/accounts/${accountId}/subscription`)
    if (result.ok) setData(result.data)
    else toast.error(result.message)
  }, [accountId])

  useEffect(() => {
    let cancelled = false
    adminRequest<AccountBilling>(`/api/admin/billing/accounts/${accountId}/subscription`).then((result) => {
      if (cancelled) return
      if (result.ok) setData(result.data)
      else toast.error(result.message)
    })
    return () => {
      cancelled = true
    }
  }, [accountId])

  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>
  const sub = data.subscription
  const copy = event ? EVENT_COPY[event] : null

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        {sub ? (
          <>
            <span className="font-medium">{sub.plan_id}</span>
            <Badge variant="secondary">{sub.status}</Badge>
            {sub.current_period_end ? (
              <span className="text-xs text-muted-foreground">until {new Date(sub.current_period_end).toLocaleDateString()}</span>
            ) : null}
            {sub.cancel_at_period_end ? <Badge variant="outline">cancels at period end</Badge> : null}
            {sub.suspended_reason ? <span className="text-xs text-muted-foreground">Suspended: {sub.suspended_reason}</span> : null}
          </>
        ) : (
          <span className="text-sm text-muted-foreground">No subscription row (legacy workspace).</span>
        )}
        <div className="ml-auto flex gap-2">
          {sub?.status === 'suspended' ? (
            <Button size="sm" variant="outline" onClick={() => setEvent('reinstate')}>
              Reinstate…
            </Button>
          ) : (
            <Button size="sm" variant="destructive" disabled={!sub} onClick={() => setEvent('suspend')}>
              Suspend…
            </Button>
          )}
          <Button size="sm" variant="destructive" disabled={!sub} onClick={() => setEvent('cancel')}>
            Cancel…
          </Button>
        </div>
      </div>

      <OverrideForm accountId={accountId} plans={plans} onDone={load} />

      <div>
        <h4 className="mb-2 text-sm font-semibold">Recent invoices</h4>
        <ul className="divide-y rounded-lg border text-sm">
          {data.invoices.map((invoice) => (
            <li key={invoice.id} className="flex flex-wrap items-center gap-2 p-2.5">
              <span className="font-mono text-xs">{invoice.number}</span>
              <Badge variant="secondary">{invoice.status}</Badge>
              <span className="ml-auto tabular-nums">{formatMinor(invoice.amount_minor, invoice.currency)}</span>
              {invoice.status === 'paid' ? (
                <Button size="sm" variant="outline" onClick={() => setRefunding(invoice)}>
                  Record refund…
                </Button>
              ) : null}
            </li>
          ))}
          {data.invoices.length === 0 ? <li className="p-2.5 text-muted-foreground">No invoices.</li> : null}
        </ul>
      </div>

      <ReasonDialog
        open={event !== null}
        title={copy?.title ?? ''}
        description={copy?.description ?? ''}
        confirmLabel={copy?.confirm ?? 'Confirm'}
        destructive={copy?.destructive}
        onClose={() => setEvent(null)}
        onSubmit={async (reason) => {
          if (!event) return false
          const result = await adminRequest(`/api/admin/billing/accounts/${accountId}/event`, { event, reason })
          if (!result.ok) {
            toast.error(result.message)
            return false
          }
          toast.success('Done')
          await load()
          return true
        }}
      />
      <RefundDialog invoice={refunding} onClose={() => setRefunding(null)} onDone={load} />
    </div>
  )
}

function OverrideForm({ accountId, plans, onDone }: { accountId: string; plans: AdminPlan[]; onDone: () => Promise<void> }) {
  const [planId, setPlanId] = useState('')
  const [status, setStatus] = useState<'trialing' | 'active'>('trialing')
  const [endsAt, setEndsAt] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!planId || !endsAt || !reason.trim()) {
      toast.error('Choose a plan, an end date and give a reason.')
      return
    }
    setBusy(true)
    const result = await adminRequest(`/api/admin/billing/accounts/${accountId}/subscription`, {
      plan_id: planId,
      status,
      ends_at: new Date(endsAt).toISOString(),
      reason: reason.trim(),
    })
    setBusy(false)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    toast.success('Plan overridden')
    setReason('')
    await onDone()
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <h4 className="text-sm font-semibold">Override plan (no payment)</h4>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1.5">
          <Label className="text-xs">Plan</Label>
          <select className={SELECT_CLASS} value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">Choose…</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Status</Label>
          <select className={SELECT_CLASS} value={status} onChange={(e) => setStatus(e.target.value === 'active' ? 'active' : 'trialing')}>
            <option value="trialing">Trial</option>
            <option value="active">Complimentary active</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Ends on</Label>
          <Input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </div>
        <div className="space-y-1.5 sm:col-span-4">
          <Label className="text-xs">Reason (required)</Label>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </div>
      </div>
      <Button size="sm" onClick={() => void submit()} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        Apply override
      </Button>
    </div>
  )
}

function RefundDialog({ invoice, onClose, onDone }: { invoice: AccountInvoice | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [amount, setAmount] = useState('')
  const [bankReference, setBankReference] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!invoice) return
    setBusy(true)
    const result = await adminRequest(`/api/admin/billing/invoices/${invoice.id}/refund`, {
      amount: amount.trim(),
      bank_reference: bankReference.trim(),
      reason: reason.trim(),
    })
    setBusy(false)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    toast.success('Refund recorded')
    setAmount('')
    setBankReference('')
    setReason('')
    onClose()
    await onDone()
  }

  return (
    <Dialog open={invoice !== null} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record refund {invoice?.number}</DialogTitle>
          <DialogDescription>
            This only records a refund you have already sent from the bank. It does not move money or change the plan.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="refund-amount">Amount refunded</Label>
            <Input id="refund-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refund-ref">Bank reference</Label>
            <Input id="refund-ref" value={bankReference} onChange={(e) => setBankReference(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refund-reason">Reason (required)</Label>
            <Textarea id="refund-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !amount.trim() || !reason.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Record refund
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
