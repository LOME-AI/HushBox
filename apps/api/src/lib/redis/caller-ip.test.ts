import { describe, expect, it } from 'vitest';
import { createEnvUtilities } from '@hushbox/shared';
import {
  callerIpId,
  callerIpIdForAddress,
  canonicalCallerIp,
  resolveClientIp,
  trustedCallerIpId,
} from './caller-ip.js';

function headersOf(record: Record<string, string>): (name: string) => string | undefined {
  const lowered = new Map(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string): string | undefined => lowered.get(name.toLowerCase());
}

const DEVELOPMENT = createEnvUtilities({ NODE_ENV: 'development' });
const E2E = createEnvUtilities({ NODE_ENV: 'development', CI: 'true', E2E: 'true' });
const PRODUCTION = createEnvUtilities({ NODE_ENV: 'production' });

/** The address the resolver answers when no trusted header carries one. */
const LOOPBACK = '127.0.0.1';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('resolveClientIp', () => {
  it('prefers cf-connecting-ip over every other header', () => {
    const ip = resolveClientIp(
      headersOf({
        'cf-connecting-ip': '1.1.1.1',
        'x-forwarded-for': '2.2.2.2, 3.3.3.3',
        'x-real-ip': '4.4.4.4',
      }),
      DEVELOPMENT
    );
    expect(ip).toBe('1.1.1.1');
  });

  // The answer is recorded as consent evidence in an `inet` column, so every
  // arm of the chain — the exhausted one included — has to answer an address.
  it('answers loopback, never a word, when no IP header is present', () => {
    expect(resolveClientIp(headersOf({}), DEVELOPMENT)).toBe('127.0.0.1');
  });

  it('answers the literal address, uncollapsed — the evidence surfaces need it', () => {
    expect(
      resolveClientIp(headersOf({ 'cf-connecting-ip': '2001:db8:1:2::abcd' }), DEVELOPMENT)
    ).toBe('2001:db8:1:2::abcd');
  });

  describe('in production', () => {
    it('answers cf-connecting-ip, the only header the edge is authoritative for', () => {
      expect(resolveClientIp(headersOf({ 'cf-connecting-ip': '1.1.1.1' }), PRODUCTION)).toBe(
        '1.1.1.1'
      );
    });

    // Cloudflare APPENDS its hop to any x-forwarded-for the client sent, so the
    // FIRST entry is the caller's own — the entry the pre-gate resolver read.
    it('ignores the caller-supplied first x-forwarded-for hop', () => {
      const ip = resolveClientIp(
        headersOf({ 'x-forwarded-for': '198.51.100.66, 203.0.113.9' }),
        PRODUCTION
      );
      expect(ip).not.toBe('198.51.100.66');
      expect(ip).toBe(LOOPBACK);
    });

    it('ignores x-real-ip', () => {
      expect(resolveClientIp(headersOf({ 'x-real-ip': '4.4.4.4' }), PRODUCTION)).toBe(LOOPBACK);
    });

    it('answers the sentinel, never a client value, when cf-connecting-ip is empty', () => {
      const ip = resolveClientIp(
        headersOf({ 'cf-connecting-ip': '', 'x-forwarded-for': '2.2.2.2' }),
        PRODUCTION
      );
      expect(ip).toBe(LOOPBACK);
    });
  });

  describe('in development', () => {
    it('ignores an empty cf-connecting-ip and falls through to x-forwarded-for', () => {
      const ip = resolveClientIp(
        headersOf({ 'cf-connecting-ip': '', 'x-forwarded-for': '2.2.2.2' }),
        DEVELOPMENT
      );
      expect(ip).toBe('2.2.2.2');
    });

    it('ignores an empty x-real-ip and answers the sentinel', () => {
      expect(resolveClientIp(headersOf({ 'x-real-ip': '' }), DEVELOPMENT)).toBe(LOOPBACK);
    });

    it('takes the FIRST x-forwarded-for hop when cf-connecting-ip is absent', () => {
      const ip = resolveClientIp(
        headersOf({ 'x-forwarded-for': ' 2.2.2.2 , 3.3.3.3', 'x-real-ip': '4.4.4.4' }),
        DEVELOPMENT
      );
      expect(ip).toBe('2.2.2.2');
    });

    it('falls back to x-real-ip', () => {
      expect(resolveClientIp(headersOf({ 'x-real-ip': '4.4.4.4' }), DEVELOPMENT)).toBe('4.4.4.4');
    });

    it('treats an empty x-forwarded-for as absent and answers the sentinel', () => {
      expect(resolveClientIp(headersOf({ 'x-forwarded-for': ' ' }), DEVELOPMENT)).toBe(LOOPBACK);
    });
  });

  describe('under E2E', () => {
    it('keeps the x-forwarded-for fallback, so a spec can present its own address', () => {
      expect(resolveClientIp(headersOf({ 'x-forwarded-for': '2.2.2.2' }), E2E)).toBe('2.2.2.2');
    });
  });
});

describe('trustedCallerIpId', () => {
  it('answers the identity of the edge-set address', async () => {
    expect(
      await trustedCallerIpId(headersOf({ 'cf-connecting-ip': '203.0.113.7' }), PRODUCTION)
    ).toBe(await callerIpIdForAddress('203.0.113.7'));
  });

  it('refuses a production caller carrying only x-real-ip', async () => {
    expect(await trustedCallerIpId(headersOf({ 'x-real-ip': '4.4.4.4' }), PRODUCTION)).toBeNull();
  });

  it('refuses a production caller carrying only x-forwarded-for', async () => {
    expect(
      await trustedCallerIpId(headersOf({ 'x-forwarded-for': '2.2.2.2, 3.3.3.3' }), PRODUCTION)
    ).toBeNull();
  });

  it('refuses a production caller whose cf-connecting-ip is empty', async () => {
    expect(await trustedCallerIpId(headersOf({ 'cf-connecting-ip': '' }), PRODUCTION)).toBeNull();
  });

  // The refusal is the whole point: hashing the sentinel would answer one
  // identity every caller behind the same fault shares.
  it('never answers the sentinel identity in production', async () => {
    expect(await trustedCallerIpId(headersOf({}), PRODUCTION)).not.toBe(
      await callerIpIdForAddress(LOOPBACK)
    );
  });

  it('keys on the development fallback chain rather than refusing', async () => {
    expect(await trustedCallerIpId(headersOf({ 'x-real-ip': '4.4.4.4' }), DEVELOPMENT)).toBe(
      await callerIpIdForAddress('4.4.4.4')
    );
  });

  it('answers the sentinel identity in development when no header carries an address', async () => {
    expect(await trustedCallerIpId(headersOf({}), DEVELOPMENT)).toBe(
      await callerIpIdForAddress(LOOPBACK)
    );
  });

  it('never refuses under E2E', async () => {
    expect(await trustedCallerIpId(headersOf({ 'x-forwarded-for': '2.2.2.2' }), E2E)).toBe(
      await callerIpIdForAddress('2.2.2.2')
    );
  });
});

describe('callerIpId', () => {
  it('resolves and hashes in one call', async () => {
    const id = await callerIpId(headersOf({ 'cf-connecting-ip': '203.0.113.7' }), DEVELOPMENT);
    expect(id).toBe(await sha256Hex('203.0.113.7'));
  });

  it('collapses two addresses in one /64 onto one identity', async () => {
    const a = await callerIpId(headersOf({ 'cf-connecting-ip': '2001:db8:1:2::1' }), DEVELOPMENT);
    const b = await callerIpId(
      headersOf({ 'x-forwarded-for': '2001:db8:1:2::dead:beef' }),
      DEVELOPMENT
    );
    expect(a).toBe(b);
  });

  it('keeps two /64s distinct', async () => {
    const a = await callerIpId(headersOf({ 'cf-connecting-ip': '2001:db8:1:2::1' }), DEVELOPMENT);
    const b = await callerIpId(headersOf({ 'cf-connecting-ip': '2001:db8:1:3::1' }), DEVELOPMENT);
    expect(a).not.toBe(b);
  });

  // The defect this gate closes: an IP-keyed window derived from this value is
  // one a caller that can choose it chooses for itself. The sentinel it answers
  // instead is why a limiter resolves through `trustedCallerIpId` and refuses;
  // the trial gates still key on this one.
  it('cannot be steered by a caller-supplied x-forwarded-for in production', async () => {
    const spoofed = await callerIpId(
      headersOf({ 'x-forwarded-for': '198.51.100.66, 203.0.113.9' }),
      PRODUCTION
    );
    expect(spoofed).not.toBe(await callerIpIdForAddress('198.51.100.66'));
    expect(spoofed).toBe(await callerIpIdForAddress(LOOPBACK));
  });

  it('gives every rotated x-forwarded-for value in production the same identity', async () => {
    const first = await callerIpId(headersOf({ 'x-forwarded-for': '198.51.100.66' }), PRODUCTION);
    const second = await callerIpId(headersOf({ 'x-forwarded-for': '198.51.100.67' }), PRODUCTION);
    expect(first).toBe(second);
  });

  it('still keys on x-forwarded-for in development', async () => {
    const id = await callerIpId(headersOf({ 'x-forwarded-for': '198.51.100.66' }), DEVELOPMENT);
    expect(id).toBe(await callerIpIdForAddress('198.51.100.66'));
  });
});

describe('callerIpIdForAddress', () => {
  it('returns a stable 64-char SHA-256 hex digest', async () => {
    const a = await callerIpIdForAddress('203.0.113.7');
    const b = await callerIpIdForAddress('203.0.113.7');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('produces different digests for different IPv4 addresses (never stores a raw IP)', async () => {
    expect(await callerIpIdForAddress('203.0.113.7')).not.toBe(
      await callerIpIdForAddress('203.0.113.8')
    );
  });

  it('hashes IPv4 verbatim — byte-identical to a raw SHA-256 of the address', async () => {
    // The verbatim path must not change: the digest equals SHA-256 of the
    // untouched dotted-quad string, so existing per-IPv4 counters keep their keys.
    expect(await callerIpIdForAddress('203.0.113.7')).toBe(await sha256Hex('203.0.113.7'));
  });

  it('leaves the unroutable sentinel 0.0.0.0 hashed verbatim', async () => {
    expect(await callerIpIdForAddress('0.0.0.0')).toBe(await sha256Hex('0.0.0.0'));
  });

  it('leaves the off-Cloudflare loopback sentinel hashed verbatim', async () => {
    expect(await callerIpIdForAddress(LOOPBACK)).toBe(await sha256Hex(LOOPBACK));
  });

  // Two addresses inside the SAME /64 must collapse to one identity; two in
  // DIFFERENT /64s must not. The host bits (last 64) are caller-rotatable.
  const sameSixtyFour: readonly (readonly [string, string, string])[] = [
    ['compressed vs expanded host bits', '2001:db8:1:2::1', '2001:db8:1:2:ffff:ffff:ffff:ffff'],
    ['link-local host rotation', 'fe80::1', 'fe80::abcd:1234:5678:9abc'],
    [
      'embedded IPv4 tail differs (beyond the prefix)',
      '2001:db8:1:2::192.0.2.1',
      '2001:db8:1:2::192.0.2.254',
    ],
    ['uppercase vs lowercase hextets', '2001:DB8:1:2::1', '2001:db8:1:2::9'],
    ['leading-zero hextets', '2001:0db8:0001:0002::1', '2001:db8:1:2::2'],
  ];
  it.each(sameSixtyFour)('collapses same-/64 pair (%s) to one hash', async (_label, a, b) => {
    expect(await callerIpIdForAddress(a)).toBe(await callerIpIdForAddress(b));
  });

  const differentSixtyFour: readonly (readonly [string, string, string])[] = [
    ['adjacent subnet', '2001:db8:1:2::1', '2001:db8:1:3::1'],
    ['different second hextet', '2001:db8:1:2::1', '2001:dead:1:2::1'],
    ['loopback vs link-local', '::1', 'fe80::1'],
  ];
  it.each(differentSixtyFour)('keeps different-/64 pair (%s) distinct', async (_label, a, b) => {
    expect(await callerIpIdForAddress(a)).not.toBe(await callerIpIdForAddress(b));
  });

  it('does not collapse an IPv6 /64 into an unrelated IPv4 address', async () => {
    expect(await callerIpIdForAddress('2001:db8:1:2::1')).not.toBe(
      await callerIpIdForAddress('203.0.113.7')
    );
  });

  // Malformed IPv6-shaped input can never be parsed to a prefix; it falls back
  // to a verbatim hash rather than throwing, so a garbage header still yields a
  // stable key (and never crashes the limiter).
  const malformed: readonly (readonly [string, string])[] = [
    ['two :: groups', '2001:db8::1::2'],
    ['nine hextets, no ::', '1:2:3:4:5:6:7:8:9'],
    ['invalid hextet, no ::', '1:2:3:4:5:6:7:zzzz'],
    ['over-long after :: fill', '1:2:3:4:5::6:7:8:9'],
    ['non-hex hextet', '2001:xyz::1'],
    ['embedded IPv4 not last', '2001:1.2.3.4:db8::1'],
    ['short embedded IPv4', '::ffff:1.2.3'],
    ['out-of-range embedded octet', '::ffff:256.1.1.1'],
    ['non-numeric embedded octet', '::ffff:1.2.3.a'],
  ];
  it.each(malformed)(
    'falls back to a stable verbatim hash for malformed input (%s)',
    async (_label, ip) => {
      expect(await callerIpIdForAddress(ip)).toMatch(/^[0-9a-f]{64}$/);
    }
  );

  it('normalizes a full uncompressed IPv6 address by its /64 prefix', async () => {
    expect(await callerIpIdForAddress('2001:0db8:0001:0002:0003:0004:0005:0006')).toBe(
      await callerIpIdForAddress('2001:db8:1:2::7')
    );
  });

  // An IPv4-mapped address (`::ffff:a.b.c.d`, RFC 4291 §2.5.5.2) IS that IPv4
  // address. Treating it as an ordinary IPv6 literal buckets every one of them
  // onto the `::` /64 — a single global identity across every limiter, which is
  // unbounded rather than bounded per delegation like a real /64 is.
  it('gives an IPv4-mapped address the identity of the IPv4 address it is', async () => {
    expect(await callerIpIdForAddress('::ffff:192.0.2.1')).toBe(
      await callerIpIdForAddress('192.0.2.1')
    );
  });

  it('keeps two different IPv4-mapped addresses distinct', async () => {
    expect(await callerIpIdForAddress('::ffff:192.0.2.1')).not.toBe(
      await callerIpIdForAddress('::ffff:203.0.113.7')
    );
  });

  it('unwraps the hex spelling of an IPv4-mapped address the same way', async () => {
    // `::ffff:c000:0201` and `::ffff:192.0.2.1` are the same address.
    expect(await callerIpIdForAddress('::ffff:c000:0201')).toBe(
      await callerIpIdForAddress('192.0.2.1')
    );
  });

  it('does not bucket an IPv4-mapped address with the unspecified /64', async () => {
    expect(await callerIpIdForAddress('::ffff:192.0.2.1')).not.toBe(
      await callerIpIdForAddress('::1')
    );
  });

  it('keeps a mapped address, an unrelated IPv4 literal and a real IPv6 address distinct', async () => {
    const mapped = await callerIpIdForAddress('::ffff:192.0.2.1');
    const ipv4 = await callerIpIdForAddress('203.0.113.7');
    const ipv6 = await callerIpIdForAddress('2001:db8:1:2::1');
    expect(new Set([mapped, ipv4, ipv6]).size).toBe(3);
  });

  it('strips an IPv6 zone id before deriving the prefix', async () => {
    expect(await callerIpIdForAddress('fe80::1%eth0')).toBe(
      await callerIpIdForAddress('fe80::2%wlan0')
    );
  });
});

describe('canonicalCallerIp', () => {
  it('leaves an IPv4 address verbatim', () => {
    expect(canonicalCallerIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('collapses an IPv6 address onto its zero-padded /64 prefix', () => {
    expect(canonicalCallerIp('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:0db8:0001:0002');
  });

  it('unwraps an IPv4-mapped address to the IPv4 address it is', () => {
    expect(canonicalCallerIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('leaves an unparseable value verbatim', () => {
    expect(canonicalCallerIp('not-an-address')).toBe('not-an-address');
  });

  // The identity every rate-limit key derives from is the digest of exactly
  // this value, so a canonicalisation that drifted from it would key two
  // mechanisms on two different populations while both claim one address.
  it('is the value callerIpIdForAddress digests', async () => {
    expect(await callerIpIdForAddress('2001:db8:1:2::9')).toBe(
      await sha256Hex(canonicalCallerIp('2001:db8:1:2::9'))
    );
  });
});
