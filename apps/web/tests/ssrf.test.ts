// SSRF policy: the IP classifier (private/loopback/link-local/CGNAT/metadata
// all rejected; public v4+v6 pass) and the two-tier base-URL rule
// (.instructure.com tier-1 pass without DNS; tier-2 origin/port/https
// constraints).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeCanvasBaseUrl,
  assertSafePublicHost,
  classifyIp,
  isAutoTrustedHost,
  isPublicUnicastIp,
} from '../lib/canvas/ssrf';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('classifyIp — IPv4', () => {
  it.each([
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.1.1', 'private'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback'],
    ['169.254.169.254', 'link-local'], // the cloud metadata endpoint
    ['169.254.0.1', 'link-local'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['0.0.0.0', 'unspecified'],
    ['0.255.0.1', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['192.0.2.55', 'reserved'], // TEST-NET-1
    ['198.18.0.1', 'reserved'], // benchmarking
    ['198.51.100.7', 'reserved'], // TEST-NET-2
    ['203.0.113.9', 'reserved'], // TEST-NET-3
  ] as const)('rejects %s (%s)', (ip, reason) => {
    expect(classifyIp(ip)).toEqual({ public: false, reason });
  });

  it.each(['8.8.8.8', '1.1.1.1', '34.120.10.5', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '11.0.0.1'])(
    'passes public %s',
    (ip) => {
      expect(isPublicUnicastIp(ip)).toBe(true);
    },
  );
});

describe('classifyIp — IPv6', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'private'], // ULA
    ['fdab:cdef::9', 'private'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['fec0::1', 'reserved'], // deprecated site-local
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'reserved'], // documentation
    ['::ffff:192.168.1.1', 'private'], // v4-mapped carries v4 policy
    ['::ffff:169.254.169.254', 'link-local'],
    ['64:ff9b::10.0.0.1', 'private'], // NAT64-embedded v4
  ] as const)('rejects %s (%s)', (ip, reason) => {
    expect(classifyIp(ip)).toEqual({ public: false, reason });
  });

  it.each(['2607:f8b0:4004:800::200e', '2606:4700::6810:84e5', '::ffff:8.8.8.8'])(
    'passes public %s',
    (ip) => {
      expect(isPublicUnicastIp(ip)).toBe(true);
    },
  );

  it('rejects garbage', () => {
    expect(classifyIp('not-an-ip')).toEqual({ public: false, reason: 'invalid' });
    expect(classifyIp('999.1.1.1')).toEqual({ public: false, reason: 'invalid' });
    expect(classifyIp('')).toEqual({ public: false, reason: 'invalid' });
  });
});

describe('tier 1 — auto-trusted suffixes', () => {
  it('trusts .instructure.com by default (no DNS involved)', async () => {
    expect(isAutoTrustedHost('byui.instructure.com')).toBe(true);
    expect(isAutoTrustedHost('instructure.com')).toBe(true);
    expect(isAutoTrustedHost('canvas.example.edu')).toBe(false);
    // Suffix spoofing does not pass.
    expect(isAutoTrustedHost('instructure.com.evil.example')).toBe(false);
    expect(isAutoTrustedHost('evilinstructure.com')).toBe(false);

    // Full URL path — no lookup function is provided, proving DNS is skipped.
    await expect(
      assertSafeCanvasBaseUrl('https://byui.instructure.com', {
        lookup: () => Promise.reject(new Error('DNS must not be called for tier 1')),
      }),
    ).resolves.toBe('https://byui.instructure.com');
  });

  it('honors CANVAS_AUTO_TRUST_SUFFIXES', () => {
    vi.stubEnv('CANVAS_AUTO_TRUST_SUFFIXES', '.instructure.com, canvas.example.edu');
    expect(isAutoTrustedHost('canvas.example.edu')).toBe(true);
    expect(isAutoTrustedHost('sub.canvas.example.edu')).toBe(true);
    expect(isAutoTrustedHost('byui.instructure.com')).toBe(true);
  });
});

describe('tier 2 — assertSafeCanvasBaseUrl', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const privateLookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.5', family: 4 }, // one bad address poisons the set
  ];

  it('accepts a clean https origin resolving to public addresses', async () => {
    await expect(
      assertSafeCanvasBaseUrl('https://canvas.example.edu', { lookup: publicLookup }),
    ).resolves.toBe('https://canvas.example.edu');
    // Explicit :443 normalizes away.
    await expect(
      assertSafeCanvasBaseUrl('https://canvas.example.edu:443/', {
        lookup: publicLookup,
      }),
    ).resolves.toBe('https://canvas.example.edu');
  });

  it('rejects when ANY resolved address is non-public', async () => {
    await expect(
      assertSafeCanvasBaseUrl('https://canvas.example.edu', { lookup: privateLookup }),
    ).rejects.toThrow(/non-public/);
  });

  it('rejects http, userinfo, paths, queries, and non-443 ports', async () => {
    const opts = { lookup: publicLookup };
    await expect(assertSafeCanvasBaseUrl('http://canvas.example.edu', opts)).rejects.toThrow(/https/);
    await expect(
      assertSafeCanvasBaseUrl('https://user:pw@canvas.example.edu', opts),
    ).rejects.toThrow(/credentials/);
    await expect(
      assertSafeCanvasBaseUrl('https://canvas.example.edu/lms', opts),
    ).rejects.toThrow(/origin only/);
    await expect(
      assertSafeCanvasBaseUrl('https://canvas.example.edu/?x=1', opts),
    ).rejects.toThrow(/origin only/);
    await expect(
      assertSafeCanvasBaseUrl('https://canvas.example.edu:8443', opts),
    ).rejects.toThrow(/443/);
    await expect(assertSafeCanvasBaseUrl('not a url', opts)).rejects.toThrow(/valid/);
  });

  it('rejects literal non-public IPs without DNS', async () => {
    await expect(assertSafeCanvasBaseUrl('https://169.254.169.254')).rejects.toThrow(
      /link-local/,
    );
    await expect(assertSafeCanvasBaseUrl('https://10.1.2.3')).rejects.toThrow(
      /private/,
    );
    await expect(assertSafeCanvasBaseUrl('https://[::1]')).rejects.toThrow(
      /loopback/,
    );
  });

  it('rejects unresolvable hosts', async () => {
    await expect(
      assertSafePublicHost('nxdomain.example.invalid', {
        lookup: () => Promise.reject(new Error('ENOTFOUND')),
      }),
    ).rejects.toThrow(/did not resolve/);
    await expect(
      assertSafePublicHost('empty.example.invalid', { lookup: async () => [] }),
    ).rejects.toThrow(/did not resolve/);
  });
});
