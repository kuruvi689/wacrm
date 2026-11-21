'use client';

import { Check, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatMinor } from '@/lib/products/money';

import { limitText, planAction } from './billing-logic';
import type { BillingPlan, BillingSubscription } from './types';

interface PlanCardsProps {
  plans: BillingPlan[];
  current: BillingPlan | null;
  subscription: BillingSubscription | null;
  canManage: boolean;
  configured: boolean;
  busyPlanId: string | null;
  onChoose: (planId: string) => void;
}

function features(plan: BillingPlan): string[] {
  return [
    `${limitText(plan.monthly_messages)} WhatsApp messages a month`,
    `${limitText(plan.monthly_ai_responses)} AI replies a month`,
    `${limitText(plan.max_members)} team members`,
    `${limitText(plan.max_contacts)} contacts`,
    `${limitText(plan.max_whatsapp_numbers)} WhatsApp numbers`,
    `${limitText(plan.max_ai_agents)} AI agents`,
  ];
}

export function PlanCards({ plans, current, subscription, canManage, configured, busyPlanId, onChoose }: PlanCardsProps) {
  if (plans.length === 0) {
    return (
      <Card>
        <CardContent className="p-5 text-sm text-muted-foreground">
          No plans are on sale yet. Check back soon or contact support.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {plans.map((plan) => {
        const action = planAction(plan, current, subscription);
        const isCurrent = subscription?.plan_id === plan.id;
        const price = plan.price_minor === null ? null : formatMinor(plan.price_minor, plan.currency);
        return (
          <Card key={plan.id} className={isCurrent ? 'ring-2 ring-primary' : undefined}>
            <CardContent className="flex h-full flex-col gap-4 p-5">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-foreground">{plan.name}</h3>
                  {isCurrent ? <span className="text-xs font-medium text-primary">Current plan</span> : null}
                </div>
                {plan.description ? <p className="mt-1 text-xs text-muted-foreground">{plan.description}</p> : null}
              </div>
              <div>
                <span className="text-2xl font-bold tracking-tight text-foreground">{price}</span>
                <span className="ml-1 text-xs text-muted-foreground">for {plan.period_days} days</span>
              </div>
              <ul className="flex-1 space-y-1.5 text-sm text-muted-foreground">
                {features(plan).map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              {canManage ? (
                <Button
                  variant={action.kind === 'upgrade' || action.kind === 'subscribe' ? 'default' : 'outline'}
                  disabled={action.disabled || busyPlanId !== null || (!configured && action.kind !== 'downgrade')}
                  onClick={() => onChoose(plan.id)}
                >
                  {busyPlanId === plan.id ? <Loader2 className="size-4 animate-spin" /> : null}
                  {action.label}
                </Button>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
