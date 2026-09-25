// Thin binding of the shared SSRF policy core (@aigrader/shared ssrf.ts) with
// node:dns as the default tier-2 resolver. The engine RE-CHECKS every
// configured Canvas base URL before a token-bearing request goes out (DNS
// rebinding is mitigated by these re-checks + redirects disabled).

import {
  assertSafeCanvasBaseUrl as assertSafeCanvasBaseUrlCore,
  type SsrfOptions,
} from '@aigrader/shared';

export type { SsrfOptions } from '@aigrader/shared';

async function defaultLookup(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  const { lookup } = await import('node:dns/promises');
  return lookup(hostname, { all: true, verbatim: true });
}

/** assertSafeCanvasBaseUrl with node:dns as the default tier-2 resolver. */
export async function assertSafeCanvasBaseUrl(
  rawUrl: string,
  opts: SsrfOptions = {},
): Promise<string> {
  return assertSafeCanvasBaseUrlCore(rawUrl, { lookup: defaultLookup, ...opts });
}
