// ============================================================
// Settlement verification rules — pure, no I/O, unit-tested.
//
// The ONLY path that marks an invoice paid is a billing operator
// recording a transaction they saw on the receiving bank account,
// checked here and then written atomically by the SQL function
// `billing_settle_payment` (migration 040), which repeats the
// amount/currency/state checks inside the transaction.
//
// Customer-supplied UTRs, screenshots, SMS/notification parsers and
// gateway "success" callbacks are hints for the operator, not proof.
// ============================================================

/** Bank UTR / RRN: 12-digit RRN for UPI, up to 22 alphanumerics for NEFT/IMPS. */
const UTR_RE = /^[A-Z0-9]{10,22}$/;

export function normalizeUtr(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

export function isPlausibleUtr(raw: string): boolean {
  return UTR_RE.test(normalizeUtr(raw));
}

export type AttemptStatus =
  | 'awaiting_customer'
  | 'pending_verification'
  | 'verified'
  | 'rejected'
  | 'expired'
  | 'cancelled';

export interface AttemptForVerification {
  status: AttemptStatus;
  amount_minor: number;
  currency: string;
  account_id: string;
  invoice_status: 'open' | 'paid' | 'void' | 'expired' | 'refunded';
}

/** What the operator copied from the bank statement. */
export interface BankTransaction {
  utr: string;
  amount_minor: number;
  currency: string;
  /** Account the money landed in, as configured for billing (masked ok). */
  received_into: string;
  received_at: string;
}

export interface VerificationContext {
  /** BILLING_RECEIVING_ACCOUNT — the only account we accept money into. */
  expectedReceivingAccount: string;
  /** The account the operator claims this payment is for. */
  accountId: string;
  /** UTR already used by another verified settlement. */
  utrAlreadyUsed: boolean;
  now: Date;
}

export type VerificationError =
  | 'attempt_not_verifiable'
  | 'invoice_not_open'
  | 'tenant_mismatch'
  | 'currency_mismatch'
  | 'amount_mismatch'
  | 'wrong_receiving_account'
  | 'invalid_utr'
  | 'duplicate_utr'
  | 'received_in_future';

export type VerificationResult = { ok: true; utr: string } | { ok: false; error: VerificationError };

/**
 * Decide whether a recorded bank transaction settles this attempt.
 * Amount must match exactly: under- and over-payments go to manual
 * investigation (refund or a separate adjustment), never auto-accept.
 * A late payment against an *expired* attempt is still verifiable as
 * long as the invoice is open — the money did arrive.
 */
export function checkSettlement(
  attempt: AttemptForVerification,
  txn: BankTransaction,
  ctx: VerificationContext,
): VerificationResult {
  const verifiable: AttemptStatus[] = ['awaiting_customer', 'pending_verification', 'expired'];
  if (!verifiable.includes(attempt.status)) return { ok: false, error: 'attempt_not_verifiable' };
  if (attempt.invoice_status !== 'open') return { ok: false, error: 'invoice_not_open' };
  if (attempt.account_id !== ctx.accountId) return { ok: false, error: 'tenant_mismatch' };
  if (txn.currency !== attempt.currency) return { ok: false, error: 'currency_mismatch' };
  if (!Number.isSafeInteger(txn.amount_minor) || txn.amount_minor !== attempt.amount_minor) {
    return { ok: false, error: 'amount_mismatch' };
  }
  if (
    normalizeAccount(txn.received_into) === '' ||
    normalizeAccount(txn.received_into) !== normalizeAccount(ctx.expectedReceivingAccount)
  ) {
    return { ok: false, error: 'wrong_receiving_account' };
  }
  if (!isPlausibleUtr(txn.utr)) return { ok: false, error: 'invalid_utr' };
  if (ctx.utrAlreadyUsed) return { ok: false, error: 'duplicate_utr' };
  const receivedAt = new Date(txn.received_at).getTime();
  if (Number.isNaN(receivedAt) || receivedAt > ctx.now.getTime() + 5 * 60_000) {
    return { ok: false, error: 'received_in_future' };
  }
  return { ok: true, utr: normalizeUtr(txn.utr) };
}

function normalizeAccount(value: string): string {
  return value.replace(/\s/g, '').toLowerCase();
}

export const VERIFICATION_MESSAGES: Record<VerificationError, string> = {
  attempt_not_verifiable: 'This payment attempt is already settled, rejected or cancelled.',
  invoice_not_open: 'The invoice is no longer open (already paid, voided or refunded).',
  tenant_mismatch: 'This payment belongs to a different workspace.',
  currency_mismatch: 'The received currency does not match the invoice.',
  amount_mismatch:
    'The received amount does not match the invoice exactly. Investigate and refund or adjust instead.',
  wrong_receiving_account: 'The money was not received in the configured billing account.',
  invalid_utr: 'That does not look like a bank UTR / RRN.',
  duplicate_utr: 'This UTR has already been used to settle another payment.',
  received_in_future: 'The received date is invalid or in the future.',
};
