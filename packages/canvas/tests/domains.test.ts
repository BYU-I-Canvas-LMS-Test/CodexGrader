// Multi-instance routing contract: how launch-supplied canvas_api_domain
// values are normalized and which hosts the API token may follow.
// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\CanvasDomainsTests.cs
// (the "configured base URL is always trusted" case moved to the forDomain
// tests in client.test.ts, where that behavior now lives).

import { describe, expect, it } from 'vitest';
import { DEFAULT_TRUSTED_SUFFIXES, isTrustedHost, normalizeHost } from '../src/domains.js';

describe('normalizeHost', () => {
  it.each([
    ['byui.instructure.com', 'byui.instructure.com'],
    ['BYUPW.Instructure.Com', 'byupw.instructure.com'],
    ['  byuird.instructure.com  ', 'byuird.instructure.com'],
  ])('bare hosts normalize to themselves, lowercased: %s', (raw, expected) => {
    expect(normalizeHost(raw)).toBe(expected);
  });

  it.each([
    ['https://byui.instructure.com', 'byui.instructure.com'],
    ['https://byui.instructure.com/courses/1', 'byui.instructure.com'],
    ['localhost:7216', 'localhost:7216'],
  ])("scheme'd values reduce to their host; non-default ports survive: %s", (raw, expected) => {
    expect(normalizeHost(raw)).toBe(expected);
  });

  it.each([[null], [''], ['   '], ['$Canvas.api.domain']])(
    'absent or unsubstituted values mean "use the default instance": %j',
    (raw) => {
      expect(normalizeHost(raw)).toBeNull();
    },
  );

  it('rejects values that do not parse as a host', () => {
    expect(normalizeHost('not a host')).toBeNull();
    expect(normalizeHost('https://')).toBeNull();
  });
});

describe('isTrustedHost', () => {
  it.each([['byui.instructure.com'], ['byupw.instructure.com'], ['instructure.com']])(
    'any *.instructure.com host is trusted by default: %s',
    (host) => {
      expect(isTrustedHost(host)).toBe(true);
      expect(isTrustedHost(host, DEFAULT_TRUSTED_SUFFIXES)).toBe(true);
    },
  );

  it.each([['evilinstructure.com'], ['instructure.com.evil.example'], ['canvas.example.com']])(
    'suffix matching is on dot boundaries — lookalikes never receive the token: %s',
    (host) => {
      expect(isTrustedHost(host)).toBe(false);
    },
  );

  it('extra suffixes from configuration extend the allowlist', () => {
    const suffixes = [...DEFAULT_TRUSTED_SUFFIXES, '.byui.edu'];
    expect(isTrustedHost('canvas.byui.edu', suffixes)).toBe(true);
    expect(isTrustedHost('canvas.byu.edu', suffixes)).toBe(false);
  });

  it('an empty allowlist trusts nothing (personal-token pinning)', () => {
    expect(isTrustedHost('byui.instructure.com', [])).toBe(false);
  });
});
