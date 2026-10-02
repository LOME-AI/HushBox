import { describe, expect, it } from 'vitest';
import { hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { wrapSecretTo } from '../wrap/wrap.js';
import { DecryptionFailedError, InvalidKeyError, InvalidParameterError } from '../errors.js';
import { asWrappingPrivateKey, asWrappingPublicKey } from '../primitives/keys.js';
import {
  RESET_CHALLENGE_NONCE_BYTES,
  RESET_PROOF_BYTES,
  deriveResetProof,
  openResetChallenge,
  sealResetChallenge,
  verifyResetProof,
} from './challenge.js';
import { deriveRecoveryKeyPair } from '../primitives/key-derivation.js';
import { WRAP_LABELS } from '../wrap/labels.js';

async function recoveryPair(seedByte: number): Promise<{
  publicKey: ReturnType<typeof asWrappingPublicKey>;
  privateKey: ReturnType<typeof asWrappingPrivateKey>;
}> {
  const pair = await deriveRecoveryKeyPair(new Uint8Array(32).fill(seedByte));
  return {
    publicKey: asWrappingPublicKey(pair.publicKey),
    privateKey: asWrappingPrivateKey(pair.privateKey),
  };
}

/** The canonical order-8 X25519 point: length-legal, nonzero, and refused by the curve. */
const LOW_ORDER_POINT_HEX = 'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800';

const payload = {
  recoverySessionId: testUuidV7(1),
  canonicalIdentifier: 'victim@example.com',
  newRegistrationRecord: Uint8Array.of(1, 2, 3, 4),
  newPasswordWrappedPrivateKey: 'AQIDBA==',
};

describe('sealResetChallenge / openResetChallenge', () => {
  it('round-trips the nonce back to the recovery private key', async () => {
    const pair = await recoveryPair(1);
    const nonce = randomBytes(RESET_CHALLENGE_NONCE_BYTES);

    const sealed = sealResetChallenge(pair.publicKey, nonce);

    expect(openResetChallenge(pair.privateKey, sealed)).toEqual(nonce);
  });

  it('refuses a challenge sealed to a different recovery key', async () => {
    const owner = await recoveryPair(1);
    const stranger = await recoveryPair(2);
    const sealed = sealResetChallenge(owner.publicKey, randomBytes(RESET_CHALLENGE_NONCE_BYTES));

    expect(() => openResetChallenge(stranger.privateKey, sealed)).toThrow(DecryptionFailedError);
  });

  it('refuses a challenge opened under the account-key recovery wrap label', async () => {
    const pair = await recoveryPair(1);
    const accountKeyWrap = wrapSecretTo(
      pair.publicKey,
      randomBytes(RESET_CHALLENGE_NONCE_BYTES),
      WRAP_LABELS.accountKeyRecovery
    );

    expect(() => openResetChallenge(pair.privateKey, accountKeyWrap)).toThrow(
      DecryptionFailedError
    );
  });

  it('rejects a nonce that is not the fixed challenge length', async () => {
    const pair = await recoveryPair(1);

    expect(() => sealResetChallenge(pair.publicKey, randomBytes(16))).toThrow(
      InvalidParameterError
    );
  });

  it('reports an unusable recovery public key as a typed error', () => {
    const zeroKey = asWrappingPublicKey(new Uint8Array(32));

    expect(() => sealResetChallenge(zeroKey, randomBytes(RESET_CHALLENGE_NONCE_BYTES))).toThrow(
      InvalidKeyError
    );
  });

  it('blames the recovery public key when the curve refuses a low-order point', () => {
    const lowOrderKey = asWrappingPublicKey(hexToBytes(LOW_ORDER_POINT_HEX));

    expect(() => sealResetChallenge(lowOrderKey, randomBytes(RESET_CHALLENGE_NONCE_BYTES))).toThrow(
      'Recovery public key is not a usable X25519 point'
    );
  });

  it('blames the nonce, not the public key, when the nonce is zeroed', async () => {
    const pair = await recoveryPair(1);

    expect(() =>
      sealResetChallenge(pair.publicKey, new Uint8Array(RESET_CHALLENGE_NONCE_BYTES))
    ).toThrow(/secret/);
  });
});

describe('deriveResetProof', () => {
  const nonce = new Uint8Array(RESET_CHALLENGE_NONCE_BYTES).fill(9);

  it('derives a stable 32-byte proof for one nonce and payload', () => {
    const proof = deriveResetProof(nonce, payload);

    expect(proof).toHaveLength(32);
    expect(deriveResetProof(nonce, payload)).toEqual(proof);
  });

  it('derives a different proof under a different nonce', () => {
    const other = new Uint8Array(RESET_CHALLENGE_NONCE_BYTES).fill(10);

    expect(deriveResetProof(other, payload)).not.toEqual(deriveResetProof(nonce, payload));
  });

  it('binds the recovery session id', () => {
    const swapped = { ...payload, recoverySessionId: testUuidV7(2) };

    expect(deriveResetProof(nonce, swapped)).not.toEqual(deriveResetProof(nonce, payload));
  });

  it('binds the canonical identifier', () => {
    const swapped = { ...payload, canonicalIdentifier: 'attacker@example.com' };

    expect(deriveResetProof(nonce, swapped)).not.toEqual(deriveResetProof(nonce, payload));
  });

  it('binds the new registration record', () => {
    const swapped = { ...payload, newRegistrationRecord: Uint8Array.of(1, 2, 3, 5) };

    expect(deriveResetProof(nonce, swapped)).not.toEqual(deriveResetProof(nonce, payload));
  });

  it('binds the new password-wrapped private key', () => {
    const swapped = { ...payload, newPasswordWrappedPrivateKey: 'AQIDBQ==' };

    expect(deriveResetProof(nonce, swapped)).not.toEqual(deriveResetProof(nonce, payload));
  });

  it('keeps field boundaries unambiguous across adjacent fields', () => {
    const left = { ...payload, recoverySessionId: 'ab', canonicalIdentifier: 'c' };
    const right = { ...payload, recoverySessionId: 'a', canonicalIdentifier: 'bc' };

    expect(deriveResetProof(nonce, left)).not.toEqual(deriveResetProof(nonce, right));
  });
});

describe('verifyResetProof', () => {
  const nonce = new Uint8Array(RESET_CHALLENGE_NONCE_BYTES).fill(9);

  it('accepts the proof derived from the same nonce and payload', () => {
    expect(verifyResetProof(nonce, payload, deriveResetProof(nonce, payload))).toBe(true);
  });

  it('rejects a proof derived under a different nonce', () => {
    const other = new Uint8Array(RESET_CHALLENGE_NONCE_BYTES).fill(10);

    expect(verifyResetProof(nonce, payload, deriveResetProof(other, payload))).toBe(false);
  });

  it('rejects a proof bound to a different registration record', () => {
    const swapped = { ...payload, newRegistrationRecord: Uint8Array.of(9, 9, 9, 9) };

    expect(verifyResetProof(nonce, payload, deriveResetProof(nonce, swapped))).toBe(false);
  });

  it('rejects a proof bound to a different wrapped private key', () => {
    const swapped = { ...payload, newPasswordWrappedPrivateKey: 'BQQDAg==' };

    expect(verifyResetProof(nonce, payload, deriveResetProof(nonce, swapped))).toBe(false);
  });

  it('rejects a truncated prefix of the correct proof', () => {
    const truncated = deriveResetProof(nonce, payload).subarray(0, 16);

    expect(verifyResetProof(nonce, payload, truncated)).toBe(false);
  });

  it('rejects an empty proof', () => {
    expect(verifyResetProof(nonce, payload, new Uint8Array(0))).toBe(false);
  });

  it('rejects an all-zero proof of the right length', () => {
    expect(verifyResetProof(nonce, payload, new Uint8Array(RESET_PROOF_BYTES))).toBe(false);
  });
});
