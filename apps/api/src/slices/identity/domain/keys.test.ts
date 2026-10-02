import { describe, expect, it } from 'vitest';
import {
  BILLING_PORTAL_MAX_AGE_SECONDS,
  SESSION_MAX_AGE_SECONDS,
} from '../../../lib/context/index.js';
import { rateLimitKey } from '../../../lib/rate-limit/index.js';
import {
  IDENTITY_KEYS,
  loginNetworkLockoutId,
  loginNetworkLockoutKey,
  recoveryNetworkLockoutId,
  recoveryNetworkLockoutKeys,
} from './keys.js';

describe('IDENTITY_KEYS', () => {
  it('keys pending registrations by the server-issued handshake id with a 5-minute TTL', () => {
    expect(IDENTITY_KEYS.opaquePendingRegistration.buildKey('handshake-1')).toBe(
      'opaque:pending:handshake-1'
    );
    expect(IDENTITY_KEYS.opaquePendingRegistration.ttlSeconds).toBe(300);
  });

  it('pins the sealed server material and KEK fingerprint in the pending registration', () => {
    const base = { email: 'a@b.test', username: 'ab', userId: 'u1' };
    expect(IDENTITY_KEYS.opaquePendingRegistration.schema.safeParse(base).success).toBe(false);
    expect(
      IDENTITY_KEYS.opaquePendingRegistration.schema.safeParse({
        ...base,
        serverMaterial: [1, 2, 3],
        kekFingerprint: [4, 5, 6, 7, 8, 9, 10, 11],
      }).success
    ).toBe(true);
  });

  it('lets the change-password handshake carry the rotation pin the finish round writes', () => {
    const core = { userId: 'u1', expectedSerialized: [1] };
    expect(IDENTITY_KEYS.opaquePendingChangePassword.schema.safeParse(core).success).toBe(true);
    expect(
      IDENTITY_KEYS.opaquePendingChangePassword.schema.safeParse({
        ...core,
        rotation: { observedRegistration: [1], serverMaterial: [2], kekFingerprint: [3] },
      }).success
    ).toBe(true);
    expect(
      IDENTITY_KEYS.opaquePendingChangePassword.schema.safeParse({
        ...core,
        rotation: { observedRegistration: [1] },
      }).success
    ).toBe(false);
  });

  it('pins the sealed server material and KEK fingerprint in the pending recovery reset', () => {
    const base = { identifier: 'a@b.test', nonce: 'AQID' };
    expect(IDENTITY_KEYS.opaquePendingRecoveryReset.schema.safeParse(base).success).toBe(false);
    expect(
      IDENTITY_KEYS.opaquePendingRecoveryReset.schema.safeParse({
        ...base,
        serverMaterial: [1, 2, 3],
        kekFingerprint: [4, 5, 6, 7, 8, 9, 10, 11],
      }).success
    ).toBe(true);
  });

  it('keys pending logins by the server-issued handshake id with a 2-minute TTL', () => {
    expect(IDENTITY_KEYS.opaquePendingLogin.buildKey('handshake-2')).toBe(
      'opaque:login:handshake-2'
    );
    expect(IDENTITY_KEYS.opaquePendingLogin.ttlSeconds).toBe(120);
  });

  it('tracks active sessions per user and session for the cookie lifetime', () => {
    expect(IDENTITY_KEYS.sessionActive.buildKey('u1', 's1')).toBe('sessions:user:active:u1:s1');
    expect(IDENTITY_KEYS.sessionActive.ttlSeconds).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it('tracks the password-changed-at watermark per user for the cookie lifetime', () => {
    expect(IDENTITY_KEYS.passwordChangedAt.buildKey('u1')).toBe('auth:pw-changed:u1');
    expect(IDENTITY_KEYS.passwordChangedAt.ttlSeconds).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it('locks out login per identifier at 50 attempts per 15 minutes', () => {
    expect(IDENTITY_KEYS.loginLockout.buildKey('alice@example.com')).toBe(
      'ratelimit:identity:login:lockout:alice@example.com'
    );
    expect(IDENTITY_KEYS.loginLockout).toMatchObject({
      kind: 'reservation',
      maxAttempts: 50,
      windowSeconds: 900,
    });
  });

  it('locks out login per account-and-network at 5 attempts per 15 minutes', () => {
    expect(IDENTITY_KEYS.loginLockoutPerNetwork.buildKey('deadbeef')).toBe(
      'ratelimit:identity:login:lockout-per-network:deadbeef'
    );
    expect(IDENTITY_KEYS.loginLockoutPerNetwork).toMatchObject({
      kind: 'reservation',
      maxAttempts: 5,
      windowSeconds: 900,
    });
  });

  it('keys the per-network lockout on the account and the network together', async () => {
    const key = await loginNetworkLockoutKey('alice@example.com', 'f0');

    expect(key).toMatch(/^ratelimit:identity:login:lockout-per-network:[0-9a-f]{64}$/);
    expect(key).not.toBe(await loginNetworkLockoutKey('alice@example.com', 'f1'));
    expect(key).not.toBe(await loginNetworkLockoutKey('bob@example.com', 'f0'));
  });

  it('names the per-network login key the counter spends', async () => {
    const id = await loginNetworkLockoutId('alice@example.com', 'f0');

    expect(await loginNetworkLockoutKey('alice@example.com', 'f0')).toBe(
      rateLimitKey(IDENTITY_KEYS.loginLockoutPerNetwork, id)._unsafeUnwrap()
    );
  });

  it('locks out recovery wrapped-key retrieval per identifier at 30 attempts per hour', () => {
    expect(IDENTITY_KEYS.recoveryGetKeyLockout.buildKey('alice@example.com')).toBe(
      'ratelimit:identity:recovery-getkey:lockout:alice@example.com'
    );
    expect(IDENTITY_KEYS.recoveryGetKeyLockout).toMatchObject({
      kind: 'reservation',
      maxAttempts: 30,
      windowSeconds: 3600,
    });
  });

  it('locks out wrapped-key retrieval per account-and-network at 3 attempts per hour', () => {
    expect(IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork.buildKey('deadbeef')).toBe(
      'ratelimit:identity:recovery-getkey:lockout-per-network:deadbeef'
    );
    expect(IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork).toMatchObject({
      kind: 'reservation',
      maxAttempts: 3,
      windowSeconds: 3600,
    });
  });

  it('throttles verification-email resend per email at 1 per 60 seconds', () => {
    expect(IDENTITY_KEYS.resendVerifyRateLimit.buildKey('alice@example.com')).toBe(
      'ratelimit:identity:resend-verify:email:alice@example.com'
    );
    expect(IDENTITY_KEYS.resendVerifyRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 1,
      windowSeconds: 60,
    });
  });

  it('throttles email-verification token consume per token at 10 per hour', () => {
    expect(IDENTITY_KEYS.verifyTokenRateLimit.buildKey('tok-1')).toBe(
      'ratelimit:identity:verify-email:token:tok-1'
    );
    expect(IDENTITY_KEYS.verifyTokenRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 10,
      windowSeconds: 3600,
    });
  });

  it('locks out recovery reset per identifier at 30 attempts per hour', () => {
    expect(IDENTITY_KEYS.recoveryResetLockout.buildKey('alice@example.com')).toBe(
      'ratelimit:identity:recovery-reset:lockout:alice@example.com'
    );
    expect(IDENTITY_KEYS.recoveryResetLockout).toMatchObject({
      kind: 'reservation',
      maxAttempts: 30,
      windowSeconds: 3600,
    });
  });

  it('locks out recovery reset per account-and-network at 3 attempts per hour', () => {
    expect(IDENTITY_KEYS.recoveryResetLockoutPerNetwork.buildKey('deadbeef')).toBe(
      'ratelimit:identity:recovery-reset:lockout-per-network:deadbeef'
    );
    expect(IDENTITY_KEYS.recoveryResetLockoutPerNetwork).toMatchObject({
      kind: 'reservation',
      maxAttempts: 3,
      windowSeconds: 3600,
    });
  });

  it('keys both recovery per-network lockouts on the identifier and the network together', async () => {
    const [getKey, resetKey] = await recoveryNetworkLockoutKeys('alice@example.com', 'f0');
    const anotherNetwork = await recoveryNetworkLockoutKeys('alice@example.com', 'f1');
    const anotherAccount = await recoveryNetworkLockoutKeys('bob@example.com', 'f0');

    expect(getKey).toMatch(/^ratelimit:identity:recovery-getkey:lockout-per-network:[0-9a-f]{64}$/);
    expect(resetKey).toMatch(
      /^ratelimit:identity:recovery-reset:lockout-per-network:[0-9a-f]{64}$/
    );
    expect(anotherNetwork).not.toContain(getKey);
    expect(anotherNetwork).not.toContain(resetKey);
    expect(anotherAccount).not.toContain(getKey);
    expect(anotherAccount).not.toContain(resetKey);
  });

  it('names the per-network recovery keys the counters spend', async () => {
    const id = await recoveryNetworkLockoutId('alice@example.com', 'f0');

    expect(await recoveryNetworkLockoutKeys('alice@example.com', 'f0')).toEqual([
      rateLimitKey(IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork, id)._unsafeUnwrap(),
      rateLimitKey(IDENTITY_KEYS.recoveryResetLockoutPerNetwork, id)._unsafeUnwrap(),
    ]);
  });

  it('keys the billing-portal credential’s liveness on its own prefix, never the session one', () => {
    expect(IDENTITY_KEYS.billingPortalActive.buildKey('u1', 'c1')).toBe(
      'billing:portal:active:u1:c1'
    );
    expect(IDENTITY_KEYS.billingPortalActive.buildKey('u1', 'c1')).not.toBe(
      IDENTITY_KEYS.sessionActive.buildKey('u1', 'c1')
    );
    expect(IDENTITY_KEYS.billingPortalActive.ttlSeconds).toBe(BILLING_PORTAL_MAX_AGE_SECONDS);
  });

  it('keys billing login tokens by the token itself with the legacy 60-second TTL', () => {
    expect(IDENTITY_KEYS.billingLoginToken.buildKey('token-1')).toBe('billing:login-token:token-1');
    expect(IDENTITY_KEYS.billingLoginToken.ttlSeconds).toBe(60);
  });

  it('gates account-deletion guessing per user, locking on the 3rd failed step-up within an hour', () => {
    expect(IDENTITY_KEYS.deleteAccountLockout.buildKey('u1')).toBe(
      'ratelimit:identity:delete-account:lockout:u1'
    );
    // maxAttempts: 2 — the reserve-before-verify gate admits exactly two before
    // locking the third, reproducing legacy's `count >= 3` (lock on 3rd failure).
    expect(IDENTITY_KEYS.deleteAccountLockout).toMatchObject({
      kind: 'reservation',
      maxAttempts: 2,
      windowSeconds: 3600,
    });
  });

  it('holds a separate 24-hour account-deletion hard lock per user', () => {
    expect(IDENTITY_KEYS.deleteAccountHardLock.buildKey('u1')).toBe('delete-account:hard-lock:u1');
    expect(IDENTITY_KEYS.deleteAccountHardLock.ttlSeconds).toBe(86_400);
  });

  it('rate-limits registration per email at 3 attempts per hour', () => {
    expect(IDENTITY_KEYS.registerRateLimit.buildKey('new@example.com')).toBe(
      'ratelimit:identity:register:email:new@example.com'
    );
    expect(IDENTITY_KEYS.registerRateLimit).toMatchObject({
      kind: 'throttle',
      maxAttempts: 3,
      windowSeconds: 3600,
    });
  });
});
