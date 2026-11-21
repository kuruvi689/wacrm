// Pure validation for the settle dialog. The operator types every value
// from the bank statement; nothing is prefilled from the attempt, so a
// mismatch can only be caught by what they actually read off the bank.

export interface SettleFormValues {
  amount: string
  bankUtr: string
  receivedInto: string
  /** datetime-local value, e.g. 2026-05-04T14:30 */
  receivedAt: string
  note: string
}

export const EMPTY_SETTLE_FORM: SettleFormValues = {
  amount: '',
  bankUtr: '',
  receivedInto: '',
  receivedAt: '',
  note: '',
}

export type SettleBodyResult =
  | { ok: true; body: { bank_utr: string; amount: string; received_into: string; received_at: string; note: string } }
  | { ok: false; error: string }

export function buildSettleBody(values: SettleFormValues): SettleBodyResult {
  const amount = values.amount.trim()
  const bankUtr = values.bankUtr.trim()
  const receivedInto = values.receivedInto.trim()
  if (!amount) return { ok: false, error: 'Type the amount you saw in the bank.' }
  if (!bankUtr) return { ok: false, error: 'Type the bank UTR.' }
  if (!receivedInto) return { ok: false, error: 'Type the account the money arrived in.' }
  if (!values.receivedAt) return { ok: false, error: 'Pick the date and time it was received.' }
  const when = new Date(values.receivedAt)
  if (Number.isNaN(when.getTime())) return { ok: false, error: 'The received date is not valid.' }
  return {
    ok: true,
    body: {
      bank_utr: bankUtr,
      amount,
      received_into: receivedInto,
      received_at: when.toISOString(),
      note: values.note.trim(),
    },
  }
}

export function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / (60 * 24))}d`
}
