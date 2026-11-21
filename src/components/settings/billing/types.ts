// Shapes returned by GET /api/billing. Money is always integer minor units.

import type { SubscriptionStatus } from '@/lib/billing/subscription-state';

export interface BillingPlan {
  id: string;
  name: string;
  description: string | null;
  price_minor: number | null;
  currency: string;
  period_days: number;
  grace_days: number;
  max_ai_agents: number | null;
  max_whatsapp_numbers: number | null;
  max_members: number | null;
  max_contacts: number | null;
  max_active_automations: number | null;
  max_integrations: number | null;
  knowledge_storage_mb: number | null;
  monthly_messages: number | null;
  monthly_ai_responses: number | null;
  monthly_ai_tokens: number | null;
  monthly_workflow_runs: number | null;
}

export interface BillingSubscription {
  plan_id: string;
  pending_plan_id: string | null;
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  current_period_end: string | null;
  grace_ends_at: string | null;
  cancel_at_period_end: boolean;
}

export interface UsageRow {
  metric: string;
  used: number;
  reserved: number;
  blocked: number;
  limit: number | null;
}

export interface BillingInvoice {
  id: string;
  number: string;
  plan_id: string;
  kind: string;
  status: 'open' | 'paid' | 'void' | 'expired' | 'refunded';
  amount_minor: number;
  credit_minor: number;
  currency: string;
  created_at: string;
  paid_at: string | null;
}

export type AttemptStatus =
  | 'awaiting_customer'
  | 'pending_verification'
  | 'verified'
  | 'rejected'
  | 'expired'
  | 'cancelled';

export interface BillingAttempt {
  id: string;
  reference: string;
  amount_minor: number;
  currency: string;
  status: AttemptStatus;
  upi_uri: string | null;
  customer_utr: string | null;
  customer_submitted_at: string | null;
  expires_at: string;
}

export interface BillingOverview {
  can_manage: boolean;
  configured: boolean;
  entitlements: {
    source: 'subscription' | 'legacy';
    status: string;
    plan_id: string | null;
    chargeable: boolean;
  } | null;
  plans: BillingPlan[];
  subscription: BillingSubscription | null;
  usage: UsageRow[];
  open_invoice: BillingInvoice | null;
  open_attempt: BillingAttempt | null;
  invoices: BillingInvoice[];
}
