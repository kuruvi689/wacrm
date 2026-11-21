// ============================================================
// SSRF guard for outbound webhook delivery.
//
// A webhook URL is attacker-influenced (any account admin with
// `webhooks:manage` can register one) and our server makes the request,
// so an unguarded fetch is a Server-Side Request Forgery primitive: a
// URL pointing at `127.0.0.1`, a cloud metadata IP (`169.254.169.254`),
// or an RFC1918 host would let a caller probe / POST to internal
// services from the app's network.
//
// `isDeliverableUrl` resolves the host and rejects any address that is
// loopback, private, link-local, ULA, or otherwise non-publicly-
// routable. Combined with `redirect: 'manual'` at the call site (so a
// public URL can't 3xx-bounce to an internal one), this blocks the
// common SSRF vectors. It is NOT a defense against DNS rebinding (a
// host that resolves public here but flips to private before connect) —
// that needs pinning the resolved IP into the socket, which fetch
// doesn't expose; documented as a residual risk.
// ============================================================

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null if it
 * isn't a valid literal. Handles `::` compression and a dotted-quad
 * IPv4 tail (`::ffff:127.0.0.1`), which is how the same address can
 * also be written in hex (`::ffff:7f00:1`).
 */
function expandIpv6(raw: string): number[] | null {
  let v6 = raw.toLowerCase().replace(/^\[|\]$/g, '');
  v6 = v6.replace(/%.*$/, ''); // zone id
  if (!v6.includes(':')) return null;

  const tail = v6.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (tail) {
    const o = tail.slice(2).map(Number);
    if (o.some((n) => n > 255)) return null;
    v6 = `${tail[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }

  const halves = v6.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

/** Dotted-quad string for two 16-bit groups holding an embedded IPv4. */
function embeddedV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for loopback / private / link-local / reserved IPv4 or IPv6. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0) return true; // "this" network
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
    if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
    return false;
  }

  // Anything that is neither IPv4 nor a parseable IPv6 literal is
  // refused (fail closed).
  const g = expandIpv6(ip);
  if (!g) return true;

  // :: (unspecified) and ::1 (loopback)
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true;
  // IPv4-compatible ::a.b.c.d (deprecated) and IPv4-mapped ::ffff:a.b.c.d,
  // in dotted or hex form: judge by the embedded IPv4.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) {
    return isPrivateOrReservedIp(embeddedV4(g[6], g[7]));
  }
  // NAT64 64:ff9b::/96: the low 32 bits are the IPv4 destination.
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g.slice(2, 6).every((x) => x === 0)) return isPrivateOrReservedIp(embeddedV4(g[6], g[7]));
    return true; // 64:ff9b:1::/48 local-use NAT64
  }
  // 6to4 2002::/16: bits 16..47 are the embedded IPv4.
  if (g[0] === 0x2002) return isPrivateOrReservedIp(embeddedV4(g[1], g[2]));
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * True if `rawUrl`'s host resolves only to publicly-routable
 * address(es). Returns false for a malformed URL, an obvious internal
 * name (`localhost`, `*.local`, `*.internal`), a literal private IP, or
 * a hostname that resolves to any private/reserved address.
 */
export async function isDeliverableUrl(rawUrl: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  if (isIP(host)) return !isPrivateOrReservedIp(host);

  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return false;
  }

  try {
    const results = await lookup(host, { all: true });
    if (results.length === 0) return false;
    return results.every((r) => !isPrivateOrReservedIp(r.address));
  } catch {
    return false; // unresolvable → not deliverable
  }
}
