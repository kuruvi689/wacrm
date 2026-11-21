// ============================================================
// UPI payment request links — pure, no I/O, unit-tested.
//
// Builds a standard `upi://pay` deep link (NPCI "UPI Linking
// Specification") that any UPI app can open or render as a QR code.
// The link only *asks* for money; it proves nothing. A payment is
// confirmed solely by staff matching the receiving bank's statement
// (see verification.ts), never by the customer's app or a callback.
// ============================================================

/** VPA / UPI ID shape: handle@psp, e.g. teddycubed@okaxis. */
const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/;

/** Transaction reference: we only ever generate [A-Z0-9], max 35 chars. */
const REF_RE = /^[A-Z0-9]{6,35}$/;

export function isValidVpa(value: string): boolean {
  return VPA_RE.test(value.trim());
}

export interface UpiRequest {
  payeeVpa: string;
  payeeName: string;
  /** Integer paise. UPI only supports INR. */
  amountMinor: number;
  /** Our payment-attempt reference; the customer's app echoes it in remarks. */
  reference: string;
  note: string;
}

export type UpiLinkResult = { ok: true; uri: string } | { ok: false; error: string };

export function buildUpiUri(req: UpiRequest): UpiLinkResult {
  if (!isValidVpa(req.payeeVpa)) return { ok: false, error: 'invalid_payee_vpa' };
  if (!Number.isSafeInteger(req.amountMinor) || req.amountMinor <= 0) {
    return { ok: false, error: 'invalid_amount' };
  }
  if (!REF_RE.test(req.reference)) return { ok: false, error: 'invalid_reference' };

  const rupees = Math.floor(req.amountMinor / 100);
  const paise = String(req.amountMinor % 100).padStart(2, '0');

  // URLSearchParams encodes spaces as '+', which several UPI apps show
  // literally. Encode each value with encodeURIComponent instead.
  const params: [string, string][] = [
    ['pa', req.payeeVpa.trim()],
    ['pn', sanitizeText(req.payeeName, 50)],
    ['am', `${rupees}.${paise}`],
    ['cu', 'INR'],
    ['tr', req.reference],
    ['tn', sanitizeText(req.note, 50)],
  ];
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return { ok: true, uri: `upi://pay?${query}` };
}

/** Strip anything that could break the URI or confuse a UPI app. */
function sanitizeText(value: string, max: number): string {
  return value
    .replace(/[^\p{L}\p{N} .,\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Reference attached to a payment attempt. Uppercase base-36 from a
 * random source; unambiguous to read out over the phone.
 */
export function makePaymentReference(randomBytes: Uint8Array, prefix = 'TC'): string {
  let body = '';
  for (const byte of randomBytes) body += (byte % 36).toString(36);
  return `${prefix}${body.toUpperCase()}`.slice(0, 20);
}
