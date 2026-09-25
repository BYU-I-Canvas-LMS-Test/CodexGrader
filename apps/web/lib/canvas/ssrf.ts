// Thin binding of the shared SSRF policy core (@aigrader/shared ssrf.ts): the
// classifier and URL rules live there; this module supplies the node:dns
// default resolver for tier-2 hostname checks. Existing web importers keep
// their paths and signatures.

import {
  assertSafeCanvasBaseUrl as assertSafeCanvasBaseUrlCore,
  assertSafePublicHost as assertSafePublicHostCore,
  type SsrfOptions,
} from '@aigrader/shared';

export {
  classifyIp,
  isPublicUnicastIp,
  isAutoTrustedHost,
  getAutoTrustSuffixes,
  type IpClassification,
  type IpRejection,
  type SsrfOptions,
  type DnsLookup,
} from '@aigrader/shared';

async function defaultLookup(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  const { lookup } = await import('node:dns/promises');
  return lookup(hostname, { all: true, verbatim: true });
}

/** assertSafePublicHost with node:dns as the default tier-2 resolver. */
export async function assertSafePublicHost(
  hostname: string,
  opts: SsrfOptions = {},
): Promise<void> {
  return assertSafePublicHostCore(hostname, { lookup: defaultLookup, ...opts });
}

/** assertSafeCanvasBaseUrl with node:dns as the default tier-2 resolver. */
export async function assertSafeCanvasBaseUrl(
  rawUrl: string,
  opts: SsrfOptions = {},
): Promise<string> {
  return assertSafeCanvasBaseUrlCore(rawUrl, { lookup: defaultLookup, ...opts });
}
