import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { unwrap } from '../adapters/test-fixtures.js';
import { MEDIA_RATE_LIMITS, consumeLinkMint, reserveShareRemint } from './rate-limit.js';
import { rateLimitKey } from '../../../lib/rate-limit/index.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_* are required for media rate-limit tests — run via pnpm test:api'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

describe('media rate-limit registry entries', () => {
  it('caps presign minting per caller at the legacy window', () => {
    const entry = MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit;
    expect(entry).toMatchObject({ kind: 'throttle', maxAttempts: 60, windowSeconds: 60 });
    expect(entry.buildKey('caller-1')).toBe('ratelimit:media:download:user:caller-1');
  });

  it('caps sessionless member-path presign per IP above the per-caller window', () => {
    const entry = MEDIA_RATE_LIMITS.mediaDownloadGuestIpRateLimit;
    expect(entry).toMatchObject({ kind: 'throttle', maxAttempts: 240, windowSeconds: 60 });
    expect(entry.buildKey('ip-hash')).toBe('ratelimit:media:download:guest-ip:ip-hash');
  });

  it('leaves the sessionless cap a multiple of the per-caller cap it sits above', () => {
    const guest = MEDIA_RATE_LIMITS.mediaDownloadGuestIpRateLimit;
    const caller = MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit;
    expect(guest.windowSeconds).toBe(caller.windowSeconds);
    expect(guest.maxAttempts).toBeGreaterThan(caller.maxAttempts);
  });

  it('caps unauthenticated share presign per IP at the public-share window', () => {
    const entry = MEDIA_RATE_LIMITS.sharePresignIpRateLimit;
    expect(entry).toMatchObject({ kind: 'throttle', maxAttempts: 30, windowSeconds: 60 });
    expect(entry.buildKey('ip-hash')).toBe('ratelimit:media:share-presign:ip:ip-hash');
  });

  it('caps member-path mints per link across every network the link is used from', () => {
    const entry = MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit;
    expect(entry).toMatchObject({ kind: 'throttle', maxAttempts: 1200, windowSeconds: 60 });
    expect(entry.buildKey('link-1')).toBe('ratelimit:media:download:link-mint:link-1');
  });

  it('sizes the per-link mint cap at twenty saturated per-caller windows', () => {
    const link = MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit;
    const caller = MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit;
    expect(link.windowSeconds).toBe(caller.windowSeconds);
    expect(link.maxAttempts).toBe(caller.maxAttempts * 20);
  });

  it('caps member-path credential lookups per link, keyed on the hashed credential', () => {
    const entry = MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit;
    expect(entry).toMatchObject({ kind: 'throttle', maxAttempts: 4800, windowSeconds: 60 });
    expect(entry.buildKey('credential-hash')).toBe(
      'ratelimit:media:download:link-lookup:credential-hash'
    );
  });

  it('sizes the per-link lookup cap the same multiple above its mint cap as the per-network pair', () => {
    const linkLookup = MEDIA_RATE_LIMITS.mediaDownloadLinkLookupRateLimit;
    const linkMint = MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit;
    const ipLookup = MEDIA_RATE_LIMITS.mediaDownloadGuestIpRateLimit;
    const callerMint = MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit;
    expect(linkLookup.windowSeconds).toBe(linkMint.windowSeconds);
    expect(linkLookup.maxAttempts / linkMint.maxAttempts).toBe(
      ipLookup.maxAttempts / callerMint.maxAttempts
    );
  });

  it('caps presign re-mints per shareId', () => {
    const entry = MEDIA_RATE_LIMITS.sharePresignRemintRateLimit;
    expect(entry).toMatchObject({ kind: 'throttle', maxAttempts: 30, windowSeconds: 60 });
    expect(entry.buildKey('share-1')).toBe('ratelimit:media:share-presign:remint:share-1');
  });
});

describe('the in-handler limiters against Redis', () => {
  const max = MEDIA_RATE_LIMITS.sharePresignRemintRateLimit.maxAttempts;

  it('admits exactly the configured number of re-mints in a window', async () => {
    const shareId = crypto.randomUUID();
    for (let attempt = 0; attempt < max; attempt += 1) {
      const decision = await unwrap(reserveShareRemint(redis, shareId));
      expect(decision.allowed).toBe(true);
    }

    const denied = await unwrap(reserveShareRemint(redis, shareId));

    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('counts each shareId in its own window', async () => {
    const exhausted = crypto.randomUUID();
    for (let attempt = 0; attempt <= max; attempt += 1) {
      await unwrap(reserveShareRemint(redis, exhausted));
    }

    const other = await unwrap(reserveShareRemint(redis, crypto.randomUUID()));

    expect(other.allowed).toBe(true);
  });
});

describe('the per-link mint limiter against Redis', () => {
  it('counts each link in its own window under the registry key', async () => {
    const linkId = crypto.randomUUID();
    const decision = await unwrap(consumeLinkMint(redis, linkId));

    expect(decision).toEqual({ allowed: true, count: 1 });
    expect(
      await redis.get(
        rateLimitKey(MEDIA_RATE_LIMITS.mediaDownloadLinkMintRateLimit, linkId)._unsafeUnwrap()
      )
    ).toBe(1);
  });
});
