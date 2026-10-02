import { describe, expect, it } from 'vitest';
import {
  loginIpRateLimit,
  recoveryGetKeyIpRateLimit,
  recoveryResetIpRateLimit,
  registerIpRateLimit,
  resendVerifyIpRateLimit,
  tokenLoginIpRateLimit,
  verifyEmailIpRateLimit,
} from './rate-limit.js';

/**
 * Enforcement lands at the pipeline rate-limit stage, under the `ip` identity
 * this slice's posture fragment declares; the contract pinned here is that
 * each per-IP registry entry EXISTS,
 * is a throttle, and carries its documented limit under its own key. Most of
 * those limits are the legacy ones; an entry with no legacy counterpart carries
 * the size its own comment states and justifies.
 */
describe('identity per-IP edge rate-limit entries', () => {
  it('caps login start at 20 per 15 minutes, keyed per IP hash', () => {
    expect(loginIpRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 20,
      windowSeconds: 900,
    });
    expect(loginIpRateLimit.buildKey('ip-abc')).toBe('ratelimit:identity:login:ip:ip-abc');
  });

  it('caps registration start at 10 per hour, keyed per IP hash', () => {
    expect(registerIpRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 10,
      windowSeconds: 3600,
    });
    expect(registerIpRateLimit.buildKey('ip-abc')).toBe('ratelimit:identity:register:ip:ip-abc');
  });

  it('caps recovery reset start at 10 per hour, keyed per IP hash', () => {
    expect(recoveryResetIpRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 10,
      windowSeconds: 3600,
    });
    expect(recoveryResetIpRateLimit.buildKey('ip-abc')).toBe(
      'ratelimit:identity:recovery-reset:ip:ip-abc'
    );
  });

  it('caps recovery wrapped-key retrieval at 10 per hour, keyed per IP hash', () => {
    expect(recoveryGetKeyIpRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 10,
      windowSeconds: 3600,
    });
    expect(recoveryGetKeyIpRateLimit.buildKey('ip-abc')).toBe(
      'ratelimit:identity:recovery-getkey:ip:ip-abc'
    );
  });

  it('caps email-verification consume at 30 per hour, keyed per IP hash', () => {
    expect(verifyEmailIpRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 30,
      windowSeconds: 3600,
    });
    expect(verifyEmailIpRateLimit.buildKey('ip-abc')).toBe(
      'ratelimit:identity:verify-email:ip:ip-abc'
    );
  });

  it('caps verification-email resend at 5 per 60s, keyed per IP hash', () => {
    expect(resendVerifyIpRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 5,
      windowSeconds: 60,
    });
    expect(resendVerifyIpRateLimit.buildKey('ip-abc')).toBe(
      'ratelimit:identity:resend-verify:ip:ip-abc'
    );
  });

  it('caps billing-portal token redemption at 20 per 10 minutes, keyed per IP hash', () => {
    // A throttle rather than a reservation: a reservation clears on verified
    // success, which on this surface would reset the window on every valid
    // token and cap nothing.
    expect(tokenLoginIpRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 20,
      windowSeconds: 600,
    });
    expect(tokenLoginIpRateLimit.buildKey('ip-abc')).toBe(
      'ratelimit:identity:token-login:ip:ip-abc'
    );
  });
});
