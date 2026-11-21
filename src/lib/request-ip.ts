/**
 * Best-effort client IP for rate-limit keys.
 *
 * Trust order:
 *   1. `x-real-ip` — set by Vercel from the actual connection, not
 *      client-supplied.
 *   2. The RIGHTMOST `x-forwarded-for` entry — the one appended by the
 *      nearest trusted proxy. The leftmost entry is whatever the client
 *      sent, so keying on it lets a caller rotate IPs per request and
 *      defeat the limiter.
 *   3. `'unknown'` when neither header is present (local dev, no proxy).
 */
export function clientIp(request: Request): string {
  const xri = request.headers.get("x-real-ip")?.trim();
  if (xri) return xri;

  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const entries = xff.split(",").map((part) => part.trim()).filter(Boolean);
    const rightmost = entries[entries.length - 1];
    if (rightmost) return rightmost;
  }

  return "unknown";
}
