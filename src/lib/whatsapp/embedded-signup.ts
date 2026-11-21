// Pure helpers for Meta Embedded Signup — no I/O, unit-testable.

import { randomInt } from 'node:crypto'

export interface EmbeddedSignupBody {
  code: string
  phone_number_id: string
  waba_id: string
}

type ParseResult = { ok: true; value: EmbeddedSignupBody } | { ok: false; error: string }

const META_ID = /^\d{5,30}$/
const MAX_CODE_LENGTH = 2048

/** Validate what the browser reports after FB.login + the signup session event. */
export function parseEmbeddedSignupBody(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' }
  }
  const { code, phone_number_id, waba_id } = body as Record<string, unknown>

  if (typeof code !== 'string' || !code.trim() || code.length > MAX_CODE_LENGTH) {
    return { ok: false, error: 'A valid authorization code is required' }
  }
  if (typeof phone_number_id !== 'string' || !META_ID.test(phone_number_id)) {
    return { ok: false, error: 'A valid phone_number_id is required' }
  }
  if (typeof waba_id !== 'string' || !META_ID.test(waba_id)) {
    return { ok: false, error: 'A valid waba_id is required' }
  }
  return { ok: true, value: { code: code.trim(), phone_number_id, waba_id } }
}

/** Random 6-digit two-step-verification PIN (cryptographically random). */
export function generateRegistrationPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}
