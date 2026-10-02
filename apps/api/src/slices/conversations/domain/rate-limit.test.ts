import { describe, expect, it } from 'vitest';
import {
  linkCreateRateLimit,
  publicShareReadRateLimit,
  shareCreateRateLimit,
} from './rate-limit.js';

/**
 * Enforcement lands at the pipeline rate-limit stage, from the layers this
 * slice's posture fragment declares.
 * The contract pinned here is that each registry entry EXISTS, is a throttle,
 * and carries the legacy limit under its own key.
 */
describe('publicShareReadRateLimit', () => {
  it('caps the unauthenticated public share read at 30 per 60s (mirrors legacy)', () => {
    expect(publicShareReadRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 30,
      windowSeconds: 60,
    });
  });

  it('keys per client-IP hash', () => {
    expect(publicShareReadRateLimit.buildKey('ip-hash-abc')).toBe(
      'ratelimit:conversations:share-read:ip:ip-hash-abc'
    );
  });
});

describe('shareCreateRateLimit', () => {
  it('caps authenticated shared-message creation at 20 per 60s (mirrors legacy)', () => {
    expect(shareCreateRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 20,
      windowSeconds: 60,
    });
  });

  it('keys per resolved caller id', () => {
    expect(shareCreateRateLimit.buildKey('user-123')).toBe(
      'ratelimit:conversations:share-create:user:user-123'
    );
  });
});

describe('linkCreateRateLimit', () => {
  it('caps authenticated shared-link minting at 20 per 60s', () => {
    expect(linkCreateRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 20,
      windowSeconds: 60,
    });
  });

  it('keys per authenticated user id', () => {
    expect(linkCreateRateLimit.buildKey('user-123')).toBe(
      'ratelimit:conversations:link-create:user:user-123'
    );
  });
});
