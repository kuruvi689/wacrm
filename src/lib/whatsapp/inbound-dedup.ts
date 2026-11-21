// ============================================================
// Inbound webhook idempotency decision.
//
// Meta retries deliveries; without dedup every retry re-inserts the
// message and re-fires flows / automations / AI. The atomic claim lives
// in Postgres (`claim_inbound_message`, TRUE = first time seen). This
// pure helper turns the RPC result into a decision and FAILS OPEN: if
// the claim cannot be made (RPC error, function missing because the
// migration is not applied yet) we still process. A duplicate is better
// than a dropped customer message.
// ============================================================

export type InboundDedupDecision =
  | { process: true; reason: 'first_seen' | 'no_wamid' | 'dedup_unavailable' }
  | { process: false; reason: 'duplicate' }

export function decideInboundDedup(
  wamid: string | null | undefined,
  rpc: { data: unknown; error: unknown | null } | null,
): InboundDedupDecision {
  if (!wamid) return { process: true, reason: 'no_wamid' }
  if (!rpc || rpc.error) return { process: true, reason: 'dedup_unavailable' }
  if (rpc.data === true) return { process: true, reason: 'first_seen' }
  if (rpc.data === false) return { process: false, reason: 'duplicate' }
  return { process: true, reason: 'dedup_unavailable' }
}
