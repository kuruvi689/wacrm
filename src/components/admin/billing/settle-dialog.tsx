'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatMinor } from '@/lib/products/money'

import { adminRequest } from './admin-api'
import { EMPTY_SETTLE_FORM, buildSettleBody, type SettleFormValues } from './settle-form'
import type { QueueAttempt } from './types'

interface SettleDialogProps {
  attempt: QueueAttempt | null
  receivingConfigured: boolean
  onClose: () => void
  onSettled: () => void
}

export function SettleDialog({ attempt, receivingConfigured, onClose, onSettled }: SettleDialogProps) {
  const [values, setValues] = useState<SettleFormValues>(EMPTY_SETTLE_FORM)
  const [busy, setBusy] = useState(false)

  const set = (key: keyof SettleFormValues) => (event: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: event.target.value }))

  function close() {
    setValues(EMPTY_SETTLE_FORM)
    onClose()
  }

  async function submit() {
    if (!attempt) return
    const built = buildSettleBody(values)
    if (!built.ok) {
      toast.error(built.error)
      return
    }
    setBusy(true)
    const result = await adminRequest(`/api/admin/billing/attempts/${attempt.id}/settle`, built.body)
    setBusy(false)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    toast.success('Payment settled. The plan is now active.')
    setValues(EMPTY_SETTLE_FORM)
    onSettled()
  }

  return (
    <Dialog open={attempt !== null} onOpenChange={(next) => (!next ? close() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settle payment</DialogTitle>
          <DialogDescription>
            Open the bank statement and type what you see. Settling activates the plan, so every field must match the
            bank, not this screen.
          </DialogDescription>
        </DialogHeader>

        {attempt ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border bg-muted/40 p-3 text-sm">
              <dt className="text-muted-foreground">Workspace</dt>
              <dd className="font-medium">{attempt.account_name ?? attempt.account_id}</dd>
              <dt className="text-muted-foreground">Invoice</dt>
              <dd>
                {attempt.invoice_number} {attempt.plan_id ? `· ${attempt.plan_id}` : ''}
              </dd>
              <dt className="text-muted-foreground">Expected amount</dt>
              <dd className="font-medium tabular-nums">{formatMinor(attempt.amount_minor, attempt.currency)}</dd>
              <dt className="text-muted-foreground">Reference</dt>
              <dd className="font-mono">{attempt.reference}</dd>
              <dt className="text-muted-foreground">Customer says UTR</dt>
              <dd className="font-mono">{attempt.customer_utr ?? 'not provided'}</dd>
            </dl>

            {attempt.duplicate_utr ? (
              <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                {attempt.utr_already_settled
                  ? 'This UTR has already settled another payment. Do not settle again.'
                  : 'The same UTR was claimed on another payment. Check the bank statement carefully.'}
              </p>
            ) : null}

            {!receivingConfigured ? (
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                BILLING_RECEIVING_ACCOUNT is not set on the server, so settlement is switched off.
              </p>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="settle-amount">Amount received</Label>
                <Input id="settle-amount" inputMode="decimal" autoComplete="off" value={values.amount} onChange={set('amount')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settle-utr">Bank UTR</Label>
                <Input id="settle-utr" autoComplete="off" value={values.bankUtr} onChange={set('bankUtr')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settle-into">Received into (account)</Label>
                <Input id="settle-into" autoComplete="off" value={values.receivedInto} onChange={set('receivedInto')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settle-at">Received on</Label>
                <Input id="settle-at" type="datetime-local" value={values.receivedAt} onChange={set('receivedAt')} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="settle-note">Note (optional)</Label>
              <Input id="settle-note" value={values.note} onChange={set('note')} maxLength={500} />
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !receivingConfigured}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Settle payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
