// Shapes returned by the /api/admin/billing routes. Money is integer minor units.

export type QueueStatus = 'pending_verification' | 'awaiting_customer' | 'expired' | 'verified' | 'rejected'

export interface QueueAttempt {
  id: string
  invoice_id: string
  account_id: string
  reference: string
  amount_minor: number
  currency: string
  status: QueueStatus
  customer_utr: string | null
  customer_submitted_at: string | null
  expires_at: string
  rejected_reason: string | null
  created_at: string
  invoice_number: string | null
  invoice_status: string | null
  invoice_kind: string | null
  plan_id: string | null
  account_name: string | null
  duplicate_utr: boolean
  utr_already_settled: boolean
  utr_claimed_elsewhere: boolean
  age_minutes: number
}

export interface QueueResponse {
  status: QueueStatus
  attempts: QueueAttempt[]
  receiving_account_configured: boolean
}

export interface AdminPlan {
  id: string
  name: string
  description: string | null
  is_active: boolean
  is_public: boolean
  price_minor: number | null
  currency: string
  period_days: number
  grace_days: number
  max_ai_agents: number | null
  max_whatsapp_numbers: number | null
  max_members: number | null
  max_contacts: number | null
  max_active_automations: number | null
  max_integrations: number | null
  knowledge_storage_mb: number | null
  monthly_messages: number | null
  monthly_ai_responses: number | null
  monthly_ai_tokens: number | null
  monthly_workflow_runs: number | null
  sort_order: number
}

export interface WorkspaceRow {
  id: string
  name: string
  owner_email: string | null
}

export interface AccountSubscription {
  plan_id: string
  status: string
  current_period_end: string | null
  trial_ends_at: string | null
  cancel_at_period_end: boolean
  suspended_reason: string | null
}

export interface AccountInvoice {
  id: string
  number: string
  plan_id: string
  kind: string
  status: string
  amount_minor: number
  currency: string
  created_at: string
  paid_at: string | null
}

export interface AccountBilling {
  subscription: AccountSubscription | null
  invoices: AccountInvoice[]
  events: { id: number; event: string; from_status: string | null; to_status: string; actor_kind: string; reason: string | null; created_at: string }[]
}

export interface AuditEntry {
  id: number
  actor_email: string | null
  action: string
  account_id: string | null
  target_type: string
  target_id: string
  details: Record<string, unknown>
  created_at: string
}
