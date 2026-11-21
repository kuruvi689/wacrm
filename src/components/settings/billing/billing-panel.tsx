'use client';

// ============================================================
// BillingPanel — Settings → Billing
//
// Everything here is display + intent. The browser only ever sends a
// plan id, a UTR the customer typed, or a cancel flag; the amount is
// derived on the server. A customer UTR is a claim: the plan switches
// on only after a Teddy³ operator confirms the money in the bank.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Info, Loader2 } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsChip, type ChipVariant } from '@/components/settings/settings-chip';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';

import { billingRequest, postJson } from './billing-api';
import { describeStatus, formatDate, type StatusTone } from './billing-logic';
import { InvoiceHistory } from './invoice-history';
import { PayPanel } from './pay-panel';
import { PlanCards } from './plan-cards';
import type { BillingOverview } from './types';
import { UsageMeters } from './usage-meters';

const TONE_CHIP: Record<StatusTone, ChipVariant> = { ok: 'ok', warn: 'warn', bad: 'warn', muted: 'muted' };
const CANCELLABLE = new Set(['active', 'past_due', 'grace']);

export function BillingPanel() {
  const [data, setData] = useState<BillingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await billingRequest<BillingOverview>('/api/billing');
    if (result.ok) {
      setData(result.data);
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
      toast.error(result.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    billingRequest<BillingOverview>('/api/billing').then((result) => {
      if (cancelled) return;
      if (result.ok) setData(result.data);
      else {
        setLoadFailed(true);
        toast.error(result.message);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function choosePlan(planId: string) {
    setBusyPlanId(planId);
    const result = await postJson<{ scheduled: boolean }>(
      '/api/billing/checkout',
      { plan_id: planId },
      { 'Idempotency-Key': crypto.randomUUID() },
    );
    setBusyPlanId(null);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(
      result.data.scheduled
        ? 'Done. The cheaper plan starts when your current period ends.'
        : 'Payment request ready. Follow the steps below.',
    );
    await load();
  }

  async function setCancel(cancel: boolean) {
    if (cancel && !window.confirm('Cancel at the end of the current period? You keep full access until then.')) return;
    setCancelBusy(true);
    const result = await postJson('/api/billing/cancel', { cancel });
    setCancelBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(cancel ? 'Cancellation scheduled.' : 'Cancellation withdrawn.');
    await load();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }
  if (!data) {
    return (
      <section className="space-y-3">
        <SettingsPanelHead title="Billing" description="Your plan, usage and invoices." />
        <p className="text-sm text-muted-foreground">
          {loadFailed ? 'Billing could not be loaded.' : ''}{' '}
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </p>
      </section>
    );
  }

  const { subscription, plans, can_manage: canManage } = data;
  const status = describeStatus(subscription);
  const currentPlan = plans.find((plan) => plan.id === subscription?.plan_id) ?? null;
  const planName = currentPlan?.name ?? subscription?.plan_id ?? null;
  const pendingPlan = plans.find((plan) => plan.id === subscription?.pending_plan_id);
  const renewal = formatDate(subscription?.current_period_end);
  const canCancel = canManage && subscription !== null && CANCELLABLE.has(subscription.status);

  return (
    <section className="animate-in fade-in-50 space-y-5 duration-200">
      <SettingsPanelHead title="Billing" description="Your plan, usage and invoices for this workspace." />

      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h3 className="text-base font-semibold text-foreground">{planName ?? 'No plan'}</h3>
            <SettingsChip variant={TONE_CHIP[status.tone]}>{status.label}</SettingsChip>
            {renewal && subscription?.status === 'active' ? (
              <span className="text-xs text-muted-foreground">
                {subscription.cancel_at_period_end ? 'Ends' : 'Renews manually by'} {renewal}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">{status.explanation}</p>
          {pendingPlan ? (
            <p className="text-sm text-foreground">
              Next period you will move to <strong>{pendingPlan.name}</strong>.
            </p>
          ) : null}
          {canCancel ? (
            <Button
              variant="outline"
              size="sm"
              disabled={cancelBusy}
              onClick={() => void setCancel(!subscription?.cancel_at_period_end)}
            >
              {cancelBusy ? <Loader2 className="size-4 animate-spin" /> : null}
              {subscription?.cancel_at_period_end ? 'Undo cancellation' : 'Cancel at period end'}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {!data.configured && canManage ? (
        <Alert>
          <Info />
          <AlertDescription>
            Online payment is not switched on for this installation yet. Plan changes that need a payment are disabled
            until it is. Please contact support.
          </AlertDescription>
        </Alert>
      ) : null}

      {canManage && data.open_invoice && data.open_attempt ? (
        <PayPanel
          invoice={data.open_invoice}
          attempt={data.open_attempt}
          onChanged={() => void load()}
          onNewRequest={() => void choosePlan(data.open_invoice!.plan_id)}
          requesting={busyPlanId !== null}
        />
      ) : null}

      {canManage && data.open_invoice && !data.open_attempt ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-sm text-muted-foreground">
              Invoice {data.open_invoice.number} is open but has no payment request yet.
            </p>
            <Button disabled={busyPlanId !== null} onClick={() => void choosePlan(data.open_invoice!.plan_id)}>
              Create payment request
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Plans</h3>
        <PlanCards
          plans={plans}
          current={currentPlan}
          subscription={subscription}
          canManage={canManage}
          configured={data.configured}
          busyPlanId={busyPlanId}
          onChoose={(id) => void choosePlan(id)}
        />
        {!canManage ? (
          <p className="text-xs text-muted-foreground">Only workspace admins and owners can change the plan or pay.</p>
        ) : null}
      </div>

      <UsageMeters usage={data.usage} />

      {canManage ? <InvoiceHistory invoices={data.invoices} /> : null}

      <Alert>
        <Info />
        <AlertDescription className="space-y-1">
          <p>Renewals are manual each period. We never auto-debit your account: pay again when a period ends.</p>
          <p>
            WhatsApp conversation charges are billed by Meta, and AI provider charges are billed by your own AI
            provider. Both are separate from your Teddy³ CRM subscription.
          </p>
        </AlertDescription>
      </Alert>
    </section>
  );
}
