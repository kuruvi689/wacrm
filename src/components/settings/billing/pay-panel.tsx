'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Clock, Copy, ExternalLink, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatMinor } from '@/lib/products/money';

import { postJson } from './billing-api';
import { formatCountdown, isSafeUpiUri, secondsUntil, vpaFromUpiUri } from './billing-logic';
import type { BillingAttempt, BillingInvoice } from './types';

function CopyField({ label, value }: { label: string; value: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy. Select the text and copy it manually.');
    }
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate font-mono text-sm font-medium text-foreground">{value}</div>
      </div>
      <Button type="button" variant="outline" size="icon" aria-label={`Copy ${label}`} onClick={copy}>
        <Copy />
      </Button>
    </div>
  );
}

function useSecondsLeft(deadlineIso: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return secondsUntil(deadlineIso, now);
}

interface PayPanelProps {
  invoice: BillingInvoice;
  attempt: BillingAttempt;
  onChanged: () => void;
  onNewRequest: () => void;
  requesting: boolean;
}

export function PayPanel({ invoice, attempt, onChanged, onNewRequest, requesting }: PayPanelProps) {
  const [utr, setUtr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const secondsLeft = useSecondsLeft(attempt.expires_at);

  const amount = formatMinor(attempt.amount_minor, attempt.currency);
  const vpa = vpaFromUpiUri(attempt.upi_uri);
  const pending = attempt.status === 'pending_verification';
  const rejected = attempt.status === 'rejected';
  const lapsed = attempt.status === 'expired' || (attempt.status === 'awaiting_customer' && secondsLeft === 0);

  async function submitUtr() {
    setSubmitting(true);
    const result = await postJson<{ message: string }>(
      `/api/billing/attempts/${attempt.id}/utr`,
      { utr },
    );
    setSubmitting(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(result.data.message);
    setUtr('');
    onChanged();
  }

  return (
    <Card className="border-primary/40">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Pay invoice {invoice.number}</h3>
            <p className="text-xs text-muted-foreground">
              Pay the exact amount below with any UPI app. Your plan switches on after we confirm the money in our bank
              account.
            </p>
          </div>
          {!pending && !lapsed && !rejected ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Clock className="size-3.5" /> Expires in {formatCountdown(secondsLeft)}
            </span>
          ) : null}
        </div>

        {pending ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
            <strong>Pending verification.</strong> We have your UTR{attempt.customer_utr ? ` (${attempt.customer_utr})` : ''}{' '}
            and are checking our bank account. This usually takes a few working hours. You do not need to pay again.
          </div>
        ) : null}

        {rejected ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground">
            <strong>We could not confirm this payment.</strong>{' '}
            We could not find a matching payment in our bank account. If you already paid, contact support with your UTR.
          </div>
        ) : null}

        {lapsed || rejected ? (
          <Button onClick={onNewRequest} disabled={requesting}>
            {requesting ? <Loader2 className="size-4 animate-spin" /> : null}
            Create a new payment request
          </Button>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <CopyField label="Amount" value={amount} />
              {vpa ? <CopyField label="Pay to (UPI ID)" value={vpa} /> : null}
              <CopyField label="Reference" value={attempt.reference} />
            </div>

            {isSafeUpiUri(attempt.upi_uri) ? (
              <a
                href={attempt.upi_uri}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                <ExternalLink className="size-4" /> Pay with UPI
              </a>
            ) : null}
            <p className="text-xs text-muted-foreground">
              On a computer? Open your UPI app, send {amount} to the UPI ID above and put the reference in the note.
            </p>

            <form
                className="space-y-2 border-t border-border pt-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitUtr();
                }}
              >
                <Label htmlFor="billing-utr">
                  {pending ? 'Typed the wrong UTR? Send the correct one' : 'After paying, enter the UTR from your UPI app'}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="billing-utr"
                    value={utr}
                    onChange={(event) => setUtr(event.target.value)}
                    placeholder="12-digit UTR / reference no."
                    inputMode="text"
                    autoComplete="off"
                    maxLength={40}
                  />
                  <Button type="submit" disabled={submitting || utr.trim().length < 6}>
                    {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                    Submit
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  The UTR helps us find your payment. Entering it does not activate your plan by itself.
                </p>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
