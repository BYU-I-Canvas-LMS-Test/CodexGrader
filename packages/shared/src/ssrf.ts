// SSRF policy CORE for the teacher-supplied Canvas URL (CANVAS_BASE_URL in
// ~/.aigrader/.env). The engine checks every configured base URL before any
// token-bearing request, so a typo'd or hostile .env value can never aim the
// teacher's token at a private or loopback address.
//
// Two tiers:
//
//   Tier 1 — hosts under CANVAS_AUTO_TRUST_SUFFIXES (default .instructure.com)
//            are Instructure-operated SaaS and pass without DNS checks.
//   Tier 2 — self-hosted Canvas is allowed iff the URL is a bare https origin
//            (no userinfo/path/query/fragment), port 443 only, and EVERY
//            address the hostname resolves to is public unicast — rejecting
//            RFC1918, loopback, link-local (incl. the 169.254.169.254
//            metadata endpoint), CGNAT, and the v6 equivalents.
//
// This module carries NO default DNS resolver — tier-2 hostname checks
// require an injected `lookup` (dns/promises.lookup-shaped). Each service
// owns its thin binding: packages/engine/src/ssrf.ts injects node:dns.

import { isIP } from 'node:net';

export type IpRejection =
  | 'invalid'
  | 'unspecified' // 0.0.0.0/8, ::
  | 'loopback' // 127/8, ::1
  | 'private' // RFC1918, fc00::/7 (ULA)
  | 'link-local' // 169.254/16 (metadata!), fe80::/10
  | 'cgnat' // 100.64/10
  | 'multicast' // 224/4, ff00::/8
  | 'reserved'; // 192.0.0/24, 192.0.2/24, 198.18/15, 198.51.100/24, 203.0.113/24, 240/4, 2001:db8::/32, …

export type IpClassification = { public: true } | { public: false; reason: IpRejection };

function classifyIpv4Octets(o: number[]): IpClassification {
  const [a, b] = [o[0]!, o[1]!];
  if (a === 0) return { public: false, reason: 'unspecified' }; // 0.0.0.0/8
  if (a === 127) return { public: false, reason: 'loopback' }; // 127/8
  if (a === 10) return { public: false, reason: 'private' }; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return { public: false, reason: 'private' }; // 172.16/12
  if (a === 192 && b === 168) return { public: false, reason: 'private' }; // 192.168/16
  if (a === 169 && b === 254) return { public: false, reason: 'link-local' }; // 169.254/16 (cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return { public: false, reason: 'cgnat' }; // 100.64/10
  if (a === 192 && b === 0 && o[2] === 0) return { public: false, reason: 'reserved' }; // 192.0.0/24 (IETF)
  if (a === 192 && b === 0 && o[2] === 2) return { public: false, reason: 'reserved' }; // 192.0.2/24 (TEST-NET-1)
  if (a === 198 && (b === 18 || b === 19)) return { public: false, reason: 'reserved' }; // 198.18/15 (benchmarking)
  if (a === 198 && b === 51 && o[2] === 100) return { public: false, reason: 'reserved' }; // TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return { public: false, reason: 'reserved' }; // TEST-NET-3
  if (a >= 224 && a <= 239) return { public: false, reason: 'multicast' }; // 224/4
  if (a >= 240) return { public: false, reason: 'reserved' }; // 240/4 + broadcast
  return { public: true };
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets;
}

function classifyIpv6(ip: string): IpClassification {
  // Strip zone index (fe80::1%eth0) before parsing.
  const bare = ip.split('%')[0]!.toLowerCase();

  // IPv4-mapped/-translated forms carry the v4 policy.
  const v4Tail = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (v4Tail) {
    const octets = parseIpv4(v4Tail[1]!);
    return octets ? classifyIpv4Octets(octets) : { public: false, reason: 'invalid' };
  }

  // Expand to 8 hextets to test prefixes numerically.
  const hextets = expandIpv6(bare);
  if (!hextets) return { public: false, reason: 'invalid' };
  const [h0] = [hextets[0]!];

  const isZero = hextets.every((h) => h === 0);
  if (isZero) return { public: false, reason: 'unspecified' }; // ::
  if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) {
    return { public: false, reason: 'loopback' }; // ::1
  }
  if ((h0 & 0xfe00) === 0xfc00) return { public: false, reason: 'private' }; // fc00::/7 ULA
  if ((h0 & 0xffc0) === 0xfe80) return { public: false, reason: 'link-local' }; // fe80::/10
  if ((h0 & 0xffc0) === 0xfec0) return { public: false, reason: 'reserved' }; // fec0::/10 (deprecated site-local)
  if ((h0 & 0xff00) === 0xff00) return { public: false, reason: 'multicast' }; // ff00::/8
  if (h0 === 0x2001 && hextets[1] === 0x0db8) return { public: false, reason: 'reserved' }; // 2001:db8::/32 docs
  // 64:ff9b::/96 NAT64 — classify the embedded v4.
  if (h0 === 0x0064 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((h) => h === 0)) {
    const v4 = [
      hextets[6]! >> 8,
      hextets[6]! & 0xff,
      hextets[7]! >> 8,
      hextets[7]! & 0xff,
    ];
    return classifyIpv4Octets(v4);
  }
  return { public: true };
}

function expandIpv6(ip: string): number[] | null {
  // Embedded dotted-quad tail (e.g. "64:ff9b::10.0.0.1") → two hextets.
  let normalized = ip;
  const lastColon = ip.lastIndexOf(':');
  const tailPart = ip.slice(lastColon + 1);
  if (tailPart.includes('.')) {
    const octets = parseIpv4(tailPart);
    if (!octets) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    normalized = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColon = normalized.indexOf('::');
  let head: string[];
  let tail: string[];
  if (doubleColon >= 0) {
    head = normalized.slice(0, doubleColon).split(':').filter((s) => s.length > 0);
    tail = normalized.slice(doubleColon + 2).split(':').filter((s) => s.length > 0);
  } else {
    head = normalized.split(':');
    tail = [];
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (doubleColon < 0 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const hextets: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    hextets.push(parseInt(g, 16));
  }
  return hextets;
}

/** Classify a literal IP address. Anything not clearly public unicast is
 * rejected with a reason — the deny-list is deliberately broad. */
export function classifyIp(ip: string): IpClassification {
  const family = isIP(ip);
  if (family === 4) {
    const octets = parseIpv4(ip);
    return octets ? classifyIpv4Octets(octets) : { public: false, reason: 'invalid' };
  }
  if (family === 6) return classifyIpv6(ip);
  return { public: false, reason: 'invalid' };
}

/** Convenience predicate over classifyIp. */
export function isPublicUnicastIp(ip: string): boolean {
  return classifyIp(ip).public;
}

// ── Host / URL policy ────────────────────────────────────────────────────────

/** dns/promises.lookup(host, { all: true })-shaped resolver. */
export type DnsLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export interface SsrfOptions {
  /** Tier-1 suffixes; default from CANVAS_AUTO_TRUST_SUFFIXES env
   * (comma-separated), falling back to ['.instructure.com']. */
  autoTrustSuffixes?: string[];
  /** DNS resolver — REQUIRED for tier-2 hostname checks (this core module
   * carries no default; each service's thin binding injects node:dns). */
  lookup?: DnsLookup;
}

function normalizeSuffix(suffix: string): string {
  const s = suffix.trim().toLowerCase();
  if (!s) return '';
  return s.startsWith('.') ? s : `.${s}`;
}

export function getAutoTrustSuffixes(): string[] {
  const env = process.env.CANVAS_AUTO_TRUST_SUFFIXES;
  const raw = env ? env.split(',') : ['.instructure.com'];
  return raw.map(normalizeSuffix).filter((s) => s.length > 1);
}

/** Tier-1 check: `canvas.instructure.com` matches `.instructure.com`; the
 * apex (`instructure.com`) matches too. */
export function isAutoTrustedHost(hostname: string, suffixes?: string[]): boolean {
  const host = hostname.toLowerCase();
  for (const suffix of suffixes ?? getAutoTrustSuffixes()) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Assert a hostname is safe to connect to: tier-1 auto-trusted, a public
 * literal IP, or a name whose EVERY resolved A/AAAA address is public
 * unicast. Throws with a user-safe message otherwise.
 */
export async function assertSafePublicHost(
  hostname: string,
  opts: SsrfOptions = {},
): Promise<void> {
  const host = hostname.toLowerCase();

  // Tier 1: Instructure-operated SaaS.
  if (isAutoTrustedHost(host, opts.autoTrustSuffixes)) return;

  // Literal IP (URL wraps IPv6 hosts in brackets).
  const bareIp = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(bareIp) !== 0) {
    const cls = classifyIp(bareIp);
    if (!cls.public) {
      throw new Error(`Canvas host resolves to a non-public address (${cls.reason}).`);
    }
    return;
  }

  // Tier 2: resolve and require every address to be public unicast. DNS
  // rebinding between this check and the fetch is mitigated operationally
  // (engine-side re-checks + no redirect following), not here.
  if (!opts.lookup) {
    // Fail closed: the policy core never resolves names itself — a caller
    // that forgot its binding must not silently skip the tier-2 check.
    throw new Error(
      'SSRF policy misconfiguration: tier-2 host checks require a DNS resolver.',
    );
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await opts.lookup(host);
  } catch {
    throw new Error(`Canvas host "${host}" did not resolve.`);
  }
  if (addresses.length === 0) {
    throw new Error(`Canvas host "${host}" did not resolve.`);
  }
  for (const { address } of addresses) {
    const cls = classifyIp(address);
    if (!cls.public) {
      throw new Error(`Canvas host resolves to a non-public address (${cls.reason}).`);
    }
  }
}

/**
 * The full two-tier base-URL policy. Accepts only:
 *   - https
 *   - origin-only (no userinfo, no path beyond '/', no query, no fragment)
 *   - port 443 only (an explicit ':443' normalizes away; anything else fails)
 *   - a host passing assertSafePublicHost
 * Returns the canonical origin (e.g. "https://canvas.example.edu").
 */
export async function assertSafeCanvasBaseUrl(
  rawUrl: string,
  opts: SsrfOptions = {},
): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Canvas URL is not a valid absolute URL.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Canvas URL must use https.');
  }
  if (url.username || url.password) {
    throw new Error('Canvas URL must not contain credentials.');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('Canvas URL must be an origin only (no path or query).');
  }
  // URL normalizes an explicit https :443 to '' — any remaining port is
  // non-default and refused.
  if (url.port) {
    throw new Error('Canvas URL must use port 443.');
  }
  await assertSafePublicHost(url.hostname, opts);
  return url.origin;
}
