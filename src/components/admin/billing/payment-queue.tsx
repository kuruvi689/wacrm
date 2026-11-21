'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatMinor } from '@/lib/products/money'

import { adminRequest } from './admin-api'
import { ReasonDialog } from './reason-dialog'
import { formatAge } from './settle-form'
import { SettleDialog } from './settle-dialog'
import type { QueueAttempt, QueueResponse, QueueStatus } from './types'

const FILTERS: { id: QueueStatus; label: string }[] = [
  { id: 'pending_verification', label: 'To verify' },
  { id: 'awaiting_customer', label: 'Awaiting customer' },
  { id: 'expired', label: 'Expired' },
  { id: 'verified', label: 'Settled' },
  { id: 'rejected', label: 'Rejected' },
]

export function PaymentQueue() {
  const [status, setStatus] = useState<QueueStatus>('pending_verification')
  const [data, setData] = useState<QueueResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [settling, setSettling] = useState<QueueAttempt | null>(null)
  const [rejecting, setRejecting] = useState<QueueAttempt | null>(null)

  const load = useCallback(async (next: QueueStatus) => {
    const result = await adminRequest<QueueResponse>(`/api/admin/billing?status=${next}`)
    if (result.ok) setData(result.data)
    else toast.error(result.message)
    setLoading(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    adminRequest<QueueResponse>(`/api/admin/billing?status=${status}`).then((result) => {
      if (cancelled) return
      if (result.ok) setData(result.data)
      else toast.error(result.message)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [status])

  const actionable = status === 'pending_verification' || status === 'awaiting_customer' || status === 'expired'

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments</CardTitle>
        <CardDescription>
          Customers pay by UPI and submit a UTR. A payment only counts once you find the money in the bank statement and
          settle it here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <Button
              key={filter.id}
              size="sm"
              variant={filter.id === status ? 'default' : 'outline'}
              onClick={() => {
                setLoading(true)
                setStatus(filter.id)
              }}
            >
              {filter.label}
            </Button>
          ))}
        </div>

        {data && !data.receiving_account_configured ? (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            BILLING_RECEIVING_ACCOUNT is not set. Settlement is disabled until it is.
          </p>
        ) : null}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data || data.attempts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing here.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {data.attempts.map((attempt) => (
              <li key={attempt.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{attempt.account_name ?? attempt.account_id}</span>
                  <span className="font-mono text-xs text-muted-foreground">{attempt.invoice_number}</span>
                  <Badge variant="secondary">{attempt.status.replace('_', ' ')}</Badge>
                  {attempt.duplicate_utr ? (
                    <Badge variant="destructive">
                      <AlertTriangle /> Duplicate UTR
                    </Badge>
                  ) : null}
                  <span className="ml-auto text-sm font-semibold tabular-nums">
                    {formatMinor(attempt.amount_minor, attempt.currency)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Ref {attempt.reference}</span>
                  <span>Customer UTR: {attempt.customer_utr ?? 'none yet'}</span>
                  <span>Age {formatAge(attempt.age_minutes)}</span>
                  {attempt.utr_already_settled ? <span className="text-destructive">UTR already used to settle a payment</span> : null}
                  {attempt.utr_claimed_elsewhere ? <span className="text-destructive">UTR also claimed on another attempt</span> : null}
                  {attempt.rejected_reason ? <span>Reason: {attempt.rejected_reason}</span> : null}
                </div>
                {actionable ? (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setSettling(attempt)}>
                      Settle…
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setRejecting(attempt)}>
                      Reject…
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <SettleDialog
        attempt={settling}
        receivingConfigured={data?.receiving_account_configured ?? false}
        onClose={() => setSettling(null)}
        onSettled={() => {
          setSettling(null)
          void load(status)
        }}
      />
      <ReasonDialog
        open={rejecting !== null}
        title="Reject payment"
        description="Use this when no matching money arrived. The customer sees your reason."
        confirmLabel="Reject payment"
        destructive
        onClose={() => setRejecting(null)}
        onSubmit={async (reason) => {
          if (!rejecting) return false
          const result = await adminRequest(`/api/admin/billing/attempts/${rejecting.id}/reject`, { reason })
          if (!result.ok) {
            toast.error(result.message)
            return false
          }
          toast.success('Payment rejected')
          void load(status)
          return true
        }}
      />
    </Card>
  )
}
