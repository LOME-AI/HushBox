import { describe, expect, it } from 'vitest';
import { IDENTITY_KEYS } from '../keys.js';
import { recoverySaveFinishBodySchema, recoverySaveInitBodySchema } from './save.js';

const keArray = (length: number): number[] => Array.from({ length }, () => 0);

const finishBody = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  ke3: keArray(4),
  recoverySaveSessionId: crypto.randomUUID(),
  recoveryWrappedPrivateKey: 'blob',
  recoveryPublicKey: 'pub',
  ...overrides,
});

describe('recovery-save KE-array cap', () => {
  it('accepts a ke1 array of exactly 1024 elements', () => {
    expect(recoverySaveInitBodySchema.safeParse({ ke1: keArray(1024) }).success).toBe(true);
  });

  it('rejects a ke1 array of 1025 elements', () => {
    expect(recoverySaveInitBodySchema.safeParse({ ke1: keArray(1025) }).success).toBe(false);
  });

  it('accepts a ke3 array of exactly 1024 elements', () => {
    expect(recoverySaveFinishBodySchema.safeParse(finishBody({ ke3: keArray(1024) })).success).toBe(
      true
    );
  });

  it('rejects a ke3 array of 1025 elements', () => {
    expect(recoverySaveFinishBodySchema.safeParse(finishBody({ ke3: keArray(1025) })).success).toBe(
      false
    );
  });
});

describe('recovery-save finish body', () => {
  it('rejects a handshake id that is not a uuid', () => {
    expect(
      recoverySaveFinishBodySchema.safeParse(finishBody({ recoverySaveSessionId: 'not-a-uuid' }))
        .success
    ).toBe(false);
  });

  it('rejects a body carrying no recovery public key', () => {
    const body = finishBody();
    delete body['recoveryPublicKey'];
    expect(recoverySaveFinishBodySchema.safeParse(body).success).toBe(false);
  });

  it('rejects a body carrying no recovery-wrapped private key', () => {
    const body = finishBody();
    delete body['recoveryWrappedPrivateKey'];
    expect(recoverySaveFinishBodySchema.safeParse(body).success).toBe(false);
  });
});

/**
 * A handshake minted for one sensitive op must not finish another: the finish
 * round resolves its id under its own feature's key prefix only, so the prefixes
 * are what carry that separation.
 */
describe('recovery-save handshake key', () => {
  it('keys the handshake by server-issued id with the shared step-up TTL', () => {
    expect(IDENTITY_KEYS.opaquePendingRecoverySave.buildKey('handshake-1')).toBe(
      'opaque:recovery-save:handshake-1'
    );
    expect(IDENTITY_KEYS.opaquePendingRecoverySave.ttlSeconds).toBe(300);
  });

  it('does not share a key with any other step-up feature', () => {
    const others = [
      IDENTITY_KEYS.opaquePendingChangePassword,
      IDENTITY_KEYS.opaquePending2FADisable,
      IDENTITY_KEYS.opaquePendingDeleteAccount,
      IDENTITY_KEYS.opaquePendingRecoveryReset,
    ].map((definition) => definition.buildKey('shared-id'));

    expect(others).not.toContain(IDENTITY_KEYS.opaquePendingRecoverySave.buildKey('shared-id'));
  });
});
