import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { expectCompileTimeProof } from '@hushbox/shared/test-assertions';
import {
  DecryptionFailedError,
  InvalidKeyError,
  MalformedBlobError,
  UnknownBlobVersionError,
} from '../errors.js';
import { BLOB_FORMAT_VERSION } from '../primitives/format.js';
import { asEpochPrivateKey, asShareSecret, generateEpochKeyPair } from '../primitives/keys.js';
import { sealWithKey, openSealed } from './seal.js';
import { unwrapSecret, wrapSecretTo } from './wrap.js';
import { SEAL_LABELS, WRAP_LABELS } from './labels.js';
import type { SealedSecret } from './seal.js';
import type { WrappedSecret } from './wrap.js';
import type { SealLabel, WrapLabel } from './labels.js';

const LABEL = SEAL_LABELS.contentKeyShare;
const OTHER_LABEL = SEAL_LABELS.totpSecretServer;
const encoder = new TextEncoder();

/**
 * What the seal seam must do for every label in the registry, stated
 * independently of the module's own classification so that flipping an entry
 * there fails a test rather than silently unguarding key material.
 */
const EXPECTED_KEY_MATERIAL: Record<keyof typeof SEAL_LABELS, boolean> = {
  totpSecretServer: true,
  contentKeyShare: true,
  opaqueServerMaterial: true,
};

function sealLabelsWhere(keyMaterial: boolean): [string, SealLabel][] {
  return Object.entries(EXPECTED_KEY_MATERIAL)
    .filter(([, isKeyMaterial]) => isKeyMaterial === keyMaterial)
    .map(([name]) => [name, SEAL_LABELS[name as keyof typeof SEAL_LABELS]]);
}

describe('seal', () => {
  describe('sealWithKey', () => {
    it('produces a versioned blob', () => {
      const key = asShareSecret(randomBytes(32));

      const sealed = sealWithKey(key, randomBytes(32), LABEL);

      expect(sealed.at(0)).toBe(BLOB_FORMAT_VERSION);
    });

    it('is randomized: sealing the same plaintext twice differs', () => {
      const key = asShareSecret(randomBytes(32));
      const plaintext = randomBytes(32);

      const first = sealWithKey(key, plaintext, LABEL);
      const second = sealWithKey(key, plaintext, LABEL);

      expect(first).not.toEqual(second);
    });

    it('accepts key material that merely contains zero bytes', () => {
      const key = asShareSecret(randomBytes(32));
      const plaintext = new Uint8Array(32);
      plaintext[31] = 1;

      const sealed = sealWithKey(key, plaintext, LABEL);

      expect(openSealed(key, sealed, LABEL)).toEqual(plaintext);
    });

    describe.each(sealLabelsWhere(true))('under the %s label', (_name, label) => {
      it('refuses an all-zero plaintext', () => {
        const key = asShareSecret(randomBytes(32));

        expect(() => sealWithKey(key, new Uint8Array(32), label)).toThrow(InvalidKeyError);
      });

      it('refuses a zero-length plaintext', () => {
        const key = asShareSecret(randomBytes(32));

        expect(() => sealWithKey(key, new Uint8Array(0), label)).toThrow(InvalidKeyError);
      });
    });

    describe.each(sealLabelsWhere(false))('under the %s label', (_name, label) => {
      it('accepts an all-zero payload', () => {
        const key = asShareSecret(randomBytes(32));
        const emptyPayload = new Uint8Array(1);

        const sealed = sealWithKey(key, emptyPayload, label);

        expect(openSealed(key, sealed, label)).toEqual(emptyPayload);
      });
    });

    /**
     * The classification is keyed on label values, so a value absent from the
     * registry takes the guard's false path — today the only way to reach it,
     * since every registered label is key material. This pins the guard as
     * conditional: collapsing it to an unconditional assert fails here.
     */
    it('leaves the plaintext unguarded under a label value absent from the registry', () => {
      const key = asShareSecret(randomBytes(32));
      const unregistered = 'unregistered.purpose' as SealLabel;
      const allZero = new Uint8Array(32);

      const sealed = sealWithKey(key, allZero, unregistered);

      expect(openSealed(key, sealed, unregistered)).toEqual(allZero);
    });

    it('refuses an all-zero key', () => {
      expect(() => sealWithKey(asShareSecret(new Uint8Array(32)), randomBytes(32), LABEL)).toThrow(
        InvalidKeyError
      );
    });

    it('refuses an all-zero key under a label that does not guard its plaintext', () => {
      const unregistered = 'unregistered.purpose' as SealLabel;

      expect(() =>
        sealWithKey(asShareSecret(new Uint8Array(32)), randomBytes(32), unregistered)
      ).toThrow(InvalidKeyError);
    });
  });

  describe('openSealed', () => {
    it('round-trips a sealed plaintext', () => {
      const key = asShareSecret(randomBytes(32));
      const plaintext = randomBytes(32);

      const sealed = sealWithKey(key, plaintext, LABEL);

      expect(openSealed(key, sealed, LABEL)).toEqual(plaintext);
    });

    it('round-trips a plaintext that is not key-sized', () => {
      const key = asShareSecret(randomBytes(32));
      const plaintext = encoder.encode('JBSWY3DPEHPK3PXP');

      const sealed = sealWithKey(key, plaintext, LABEL);

      expect(openSealed(key, sealed, LABEL)).toEqual(plaintext);
    });

    it('fails with a different domain-separation label', () => {
      const key = asShareSecret(randomBytes(32));

      const sealed = sealWithKey(key, randomBytes(32), LABEL);

      expect(() => openSealed(key, sealed, OTHER_LABEL)).toThrow(DecryptionFailedError);
    });

    it('fails with the wrong key', () => {
      const key = asShareSecret(randomBytes(32));
      const other = asShareSecret(randomBytes(32));

      const sealed = sealWithKey(key, randomBytes(32), LABEL);

      expect(() => openSealed(other, sealed, LABEL)).toThrow(DecryptionFailedError);
    });

    it('fails on a tampered blob', () => {
      const key = asShareSecret(randomBytes(32));

      const sealed = sealWithKey(key, randomBytes(32), LABEL);
      const tampered = new Uint8Array(sealed);
      const lastIndex = tampered.length - 1;
      tampered[lastIndex] = (tampered.at(lastIndex) ?? 0) ^ 0xff;

      expect(() => openSealed(key, tampered as SealedSecret, LABEL)).toThrow(DecryptionFailedError);
    });

    it('round-trips with caller-supplied AAD', () => {
      const key = asShareSecret(randomBytes(32));
      const plaintext = randomBytes(32);
      const aad = encoder.encode('user-1');

      const sealed = sealWithKey(key, plaintext, LABEL, aad);

      expect(openSealed(key, sealed, LABEL, aad)).toEqual(plaintext);
    });

    it('fails when opened with different AAD', () => {
      const key = asShareSecret(randomBytes(32));

      const sealed = sealWithKey(key, randomBytes(32), LABEL, encoder.encode('user-1'));

      expect(() => openSealed(key, sealed, LABEL, encoder.encode('user-2'))).toThrow(
        DecryptionFailedError
      );
    });

    it('fails when AAD is omitted on open', () => {
      const key = asShareSecret(randomBytes(32));

      const sealed = sealWithKey(key, randomBytes(32), LABEL, encoder.encode('user-1'));

      expect(() => openSealed(key, sealed, LABEL)).toThrow(DecryptionFailedError);
    });

    it('rejects an unknown version byte with a typed error', () => {
      const key = asShareSecret(randomBytes(32));

      const sealed = sealWithKey(key, randomBytes(32), LABEL);
      const downgraded = new Uint8Array(sealed);
      downgraded[0] = 0x01;

      expect(() => openSealed(key, downgraded as SealedSecret, LABEL)).toThrow(
        UnknownBlobVersionError
      );
    });

    it('refuses an all-zero key', () => {
      const key = asShareSecret(randomBytes(32));

      const sealed = sealWithKey(key, randomBytes(32), LABEL);

      expect(() => openSealed(asShareSecret(new Uint8Array(32)), sealed, LABEL)).toThrow(
        InvalidKeyError
      );
    });

    it('rejects a blob shorter than the minimum length', () => {
      const key = asShareSecret(randomBytes(32));
      const short = Uint8Array.of(BLOB_FORMAT_VERSION, 1, 2, 3);

      expect(() => openSealed(key, short as SealedSecret, LABEL)).toThrow(MalformedBlobError);
    });
  });

  /**
   * The two primitives derive under disjoint prefixes (`hushbox/seal:` vs
   * `hushbox/wrap:`), so identical label text still yields incompatible keys.
   * The registry cannot produce one text in two namespaces, so reaching the
   * case the prefixes exist to defeat takes a cast.
   */
  describe('disjointness from the asymmetric wrap primitive', () => {
    const SHARED_TEXT = 'content-key.share';
    const SHARED_SEAL_LABEL = SHARED_TEXT as SealLabel;
    const SHARED_WRAP_LABEL = SHARED_TEXT as WrapLabel;

    it('a sealed blob cannot be opened by unwrapSecret under the same label text', () => {
      const keyBytes = randomBytes(32);

      const sealed = sealWithKey(asShareSecret(keyBytes), randomBytes(32), SHARED_SEAL_LABEL);

      expect(() =>
        unwrapSecret(
          asEpochPrivateKey(new Uint8Array(keyBytes)),
          sealed as Uint8Array as WrappedSecret,
          SHARED_WRAP_LABEL
        )
      ).toThrow(DecryptionFailedError);
    });

    it('a wrapped blob cannot be opened by openSealed under the same label text', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), SHARED_WRAP_LABEL);

      expect(() =>
        openSealed(
          asShareSecret(new Uint8Array(recipient.privateKey)),
          wrapped as Uint8Array as SealedSecret,
          SHARED_SEAL_LABEL
        )
      ).toThrow(DecryptionFailedError);
    });
  });

  /**
   * Type tests: each @ts-expect-error line asserts that the marked call DOES
   * NOT compile. If a non-symmetric branded key ever became assignable to
   * `SymmetricKey`, the directive would be flagged unused and `pnpm typecheck`
   * would fail.
   */
  describe('branded key transposition (compile-time)', () => {
    const transposedEpoch = generateEpochKeyPair();
    const shareSecret = asShareSecret(randomBytes(32));

    it('rejects an epoch public key where a symmetric key is expected', () => {
      const epochPublicKeyAsSymmetricKey = (): SealedSecret =>
        // @ts-expect-error — EpochPublicKey is not assignable to SymmetricKey
        sealWithKey(transposedEpoch.publicKey, randomBytes(8), LABEL);
      expectCompileTimeProof(epochPublicKeyAsSymmetricKey);
    });

    it('rejects an epoch private key where a symmetric key is expected', () => {
      const epochPrivateKeyAsSymmetricKey = (): SealedSecret =>
        // @ts-expect-error — EpochPrivateKey is not assignable to SymmetricKey
        sealWithKey(transposedEpoch.privateKey, randomBytes(8), LABEL);
      expectCompileTimeProof(epochPrivateKeyAsSymmetricKey);
    });

    it('rejects a raw Uint8Array where a symmetric key is expected', () => {
      const rawBytesAsSymmetricKey = (): SealedSecret =>
        // @ts-expect-error — unbranded Uint8Array is not assignable to SymmetricKey
        sealWithKey(randomBytes(32), randomBytes(8), LABEL);
      expectCompileTimeProof(rawBytesAsSymmetricKey);
    });

    it('rejects a wrapped secret where a sealed secret is expected', () => {
      const transposedWrapped = wrapSecretTo(
        transposedEpoch.publicKey,
        randomBytes(32),
        WRAP_LABELS.contentKeyEpoch
      );
      const wrappedSecretAsSealedSecret = (): Uint8Array =>
        // @ts-expect-error — WrappedSecret is not assignable to SealedSecret
        openSealed(shareSecret, transposedWrapped, LABEL);
      expectCompileTimeProof(wrappedSecretAsSealedSecret);
    });
  });
});
