// ============================================================
// Plan-limit errors raised by the database (migration 037).
//
// `enforce_contact_limit` / `enforce_member_limit` raise
//   plan_limit: contacts (x of y used)
//   plan_limit: members  (x of y used)
// with ERRCODE P0001. PostgREST surfaces that as an error whose
// `message` starts with `plan_limit:`. Nothing else maps it, so without
// this helper a capped account gets an opaque 500.
//
// Pure (no Supabase / Next imports) so routes, the MCP handler and
// client components can all share it.
// ============================================================

export interface PlanLimitInfo {
  /** What hit its cap, e.g. 'contacts' or 'members'. */
  resource: string;
  /** Rows in use when the insert was refused; null if the message omitted it. */
  used: number | null;
  /** The plan's cap; null if the message omitted it. */
  limit: number | null;
}

const PREFIX = 'plan_limit:';
const DETAIL = /^plan_limit:\s*([A-Za-z_]+)(?:\s*\(\s*(\d+)\s+of\s+(\d+)\s+used\s*\))?/;

/**
 * Detect a database plan-limit error (PostgrestError, Error, or any
 * `{ message }` shape) and extract its details. Returns null for
 * anything else, so callers can fall through to their normal handling.
 */
export function parsePlanLimitError(err: unknown): PlanLimitInfo | null {
  if (!err || typeof err !== 'object') return null;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string' || !message.trim().startsWith(PREFIX)) return null;

  const m = message.trim().match(DETAIL);
  if (!m) return { resource: 'unknown', used: null, limit: null };
  return {
    resource: m[1].toLowerCase(),
    used: m[2] !== undefined ? Number(m[2]) : null,
    limit: m[3] !== undefined ? Number(m[3]) : null,
  };
}

/** Human-facing, upgrade-oriented message for a plan-limit error. */
export function planLimitMessage(info: PlanLimitInfo): string {
  const cap = info.limit !== null ? ` (${info.limit} on your plan)` : '';
  switch (info.resource) {
    case 'contacts':
      return `Contact limit reached${cap}. Upgrade your plan or delete contacts to add more.`;
    case 'members':
      return `Team member limit reached${cap}. Upgrade your plan to add more people.`;
    default:
      return `Plan limit reached${cap}. Upgrade your plan to continue.`;
  }
}

/** HTTP 402 Payment Required: the status used for every plan-limit refusal. */
export const PLAN_LIMIT_STATUS = 402;

/** Internal-API JSON body: `{ error, code: 'plan_limit', resource, used, limit }`. */
export function planLimitBody(info: PlanLimitInfo) {
  return {
    error: planLimitMessage(info),
    code: 'plan_limit' as const,
    resource: info.resource,
    used: info.used,
    limit: info.limit,
  };
}

/** 402 JSON response for a plan-limit error (internal `{ error }` shape plus details). */
export function planLimitResponse(info: PlanLimitInfo): Response {
  return Response.json(planLimitBody(info), { status: PLAN_LIMIT_STATUS });
}
