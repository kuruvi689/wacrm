// ============================================================
// Payment adapters — WACRM Billing → Adapter → Provider.
//
// An adapter only CREATES a payment request (UPI link, hosted
// checkout). It never decides that money arrived: settlement is
// recorded by a billing operator against the receiving bank account
// (billing_settle_payment) — or, for a future regulated PSP, by a
// verified server-to-server event that still goes through the same
// SQL function and its exact-amount checks.
//
// Shipped adapters:
//   manual_upi — our own NPCI `upi://pay` link + QR, manual verification.
//
// Evaluated and NOT shipped (see docs/PAYMENT_SECURITY_REVIEW.md):
//   youpi — github.com/youpi-pg/YouPI-PG has no license (all rights
//   reserved) and confirms payments by parsing forgeable SMS /
//   notifications (issue #141). It cannot be reused or deployed.
// ============================================================

import { buildUpiUri, isValidVpa } from './upi';

export interface PaymentRequestInput {
  /** Our attempt reference (uppercase alphanumeric). */
  reference: string;
  amountMinor: number;
  currency: string;
  /** Shown in the customer's UPI app, e.g. "Teddy CRM Starter INV-2026-000012". */
  description: string;
}

export interface PaymentRequest {
  upiUri: string | null;
  checkoutUrl: string | null;
  providerSessionId: string | null;
  /** Human steps shown next to the QR. */
  instructions: string[];
}

export type CreateRequestResult = { ok: true; request: PaymentRequest } | { ok: false; error: string };

export interface PaymentAdapter {
  id: string;
  /** Whether the server has everything this adapter needs. */
  isConfigured(): boolean;
  createRequest(input: PaymentRequestInput): CreateRequestResult;
}

export interface ManualUpiConfig {
  payeeVpa: string | undefined;
  payeeName: string | undefined;
}

export function manualUpiAdapter(config: ManualUpiConfig): PaymentAdapter {
  return {
    id: 'manual_upi',
    isConfigured: () => Boolean(config.payeeVpa && isValidVpa(config.payeeVpa) && config.payeeName),
    createRequest(input) {
      if (!config.payeeVpa || !config.payeeName || !isValidVpa(config.payeeVpa)) {
        return { ok: false, error: 'billing_not_configured' };
      }
      if (input.currency !== 'INR') return { ok: false, error: 'upi_requires_inr' };
      const link = buildUpiUri({
        payeeVpa: config.payeeVpa,
        payeeName: config.payeeName,
        amountMinor: input.amountMinor,
        reference: input.reference,
        note: input.description,
      });
      if (!link.ok) return { ok: false, error: link.error };
      return {
        ok: true,
        request: {
          upiUri: link.uri,
          checkoutUrl: null,
          providerSessionId: null,
          instructions: [
            'Scan the QR or tap "Pay with UPI" on your phone.',
            `Pay the exact amount shown. The reference ${input.reference} is filled in for you.`,
            'After paying, enter the 12-digit UTR from your UPI app so we can match it.',
            'Your plan activates once we confirm the payment in our bank account (usually within a few working hours).',
          ],
        },
      };
    },
  };
}

/** The adapter the server uses, from env. */
export function activePaymentAdapter(env: NodeJS.ProcessEnv = process.env): PaymentAdapter {
  return manualUpiAdapter({
    payeeVpa: env.BILLING_UPI_VPA,
    payeeName: env.BILLING_UPI_PAYEE_NAME,
  });
}
