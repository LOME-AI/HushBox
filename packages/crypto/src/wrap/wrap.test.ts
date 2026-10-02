import { describe, it, expect } from 'vitest';
import { hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { wrapSecretTo, unwrapSecret } from './wrap.js';
import {
  asEpochPrivateKey,
  asEpochPublicKey,
  generateAccountKeyPair,
  generateEpochKeyPair,
} from '../primitives/keys.js';
import {
  DecryptionFailedError,
  InvalidKeyError,
  MalformedBlobError,
  UnknownBlobVersionError,
} from '../errors.js';
import { BLOB_FORMAT_VERSION, utf8Field } from '../primitives/format.js';
import { WRAP_LABELS } from './labels.js';
import type { WrappedSecret } from './wrap.js';
import type { WrapLabel } from './labels.js';

const LABEL = WRAP_LABELS.epochKeyMember;
const OTHER_LABEL = WRAP_LABELS.epochKeyChainLink;

/**
 * The canonical order-8 X25519 point (little-endian). noble rejects it (and
 * the all-zero point) by throwing from getSharedSecret because the resulting
 * shared secret is all zeros.
 */
const LOW_ORDER_POINT_HEX = 'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800';

function withEphemeralPoint(wrapped: WrappedSecret, point: Uint8Array): WrappedSecret {
  const forged = new Uint8Array(wrapped);
  forged.set(point, 1);
  return forged as WrappedSecret;
}

/**
 * What the seam must do for every label in the registry, stated independently
 * of the module's own classification so that flipping an entry there fails a
 * test rather than silently unguarding a key.
 */
const EXPECTED_KEY_MATERIAL: Record<keyof typeof WRAP_LABELS, boolean> = {
  accountKeyPassword: true,
  accountKeyRecovery: true,
  epochKeyMember: true,
  epochKeyChainLink: true,
  contentKeyEpoch: true,
  resetChallengeRecovery: true,
  conversationTitleEpoch: false,
  customInstructionsAccount: false,
};

function labelsWhere(keyMaterial: boolean): [string, WrapLabel][] {
  return Object.entries(EXPECTED_KEY_MATERIAL)
    .filter(([, isKeyMaterial]) => isKeyMaterial === keyMaterial)
    .map(([name]) => [name, WRAP_LABELS[name as keyof typeof WRAP_LABELS]]);
}

describe('wrap', () => {
  describe('wrapSecretTo', () => {
    it('produces a versioned blob', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);

      expect(wrapped.at(0)).toBe(BLOB_FORMAT_VERSION);
    });

    it('is randomized: wrapping the same secret twice differs', () => {
      const recipient = generateEpochKeyPair();
      const secret = randomBytes(32);

      const first = wrapSecretTo(recipient.publicKey, secret, LABEL);
      const second = wrapSecretTo(recipient.publicKey, secret, LABEL);

      expect(first).not.toEqual(second);
    });

    it('refuses an all-zero recipient public key with a typed error', () => {
      expect(() =>
        wrapSecretTo(asEpochPublicKey(new Uint8Array(32)), randomBytes(32), LABEL)
      ).toThrow(InvalidKeyError);
    });

    it('accepts a secret that merely contains zero bytes', () => {
      const recipient = generateEpochKeyPair();
      const secret = new Uint8Array(32);
      secret[31] = 1;

      const wrapped = wrapSecretTo(recipient.publicKey, secret, LABEL);

      expect(unwrapSecret(recipient.privateKey, wrapped, LABEL)).toEqual(secret);
    });

    it('refuses a zero-length secret with a typed error', () => {
      const recipient = generateEpochKeyPair();

      expect(() => wrapSecretTo(recipient.publicKey, new Uint8Array(0), LABEL)).toThrow(
        InvalidKeyError
      );
    });

    describe.each(labelsWhere(true))('under the %s label', (_name, label) => {
      it('refuses an all-zero secret', () => {
        const recipient = generateEpochKeyPair();

        expect(() => wrapSecretTo(recipient.publicKey, new Uint8Array(32), label)).toThrow(
          InvalidKeyError
        );
      });
    });

    describe.each(labelsWhere(false))('under the %s label', (_name, label) => {
      it('accepts an all-zero payload', () => {
        const recipient = generateEpochKeyPair();
        const emptyPayload = new Uint8Array(1);

        const wrapped = wrapSecretTo(recipient.publicKey, emptyPayload, label);

        expect(unwrapSecret(recipient.privateKey, wrapped, label)).toEqual(emptyPayload);
      });
    });
  });

  describe('unwrapSecret', () => {
    it('round-trips a secret wrapped to an epoch key', () => {
      const recipient = generateEpochKeyPair();
      const secret = randomBytes(32);

      const wrapped = wrapSecretTo(recipient.publicKey, secret, LABEL);
      const unwrapped = unwrapSecret(recipient.privateKey, wrapped, LABEL);

      expect(unwrapped).toEqual(secret);
    });

    it('round-trips a secret wrapped to an account key', () => {
      const recipient = generateAccountKeyPair();
      const secret = randomBytes(48);

      const wrapped = wrapSecretTo(recipient.publicKey, secret, LABEL);
      const unwrapped = unwrapSecret(recipient.privateKey, wrapped, LABEL);

      expect(unwrapped).toEqual(secret);
    });

    it('fails with a different domain-separation label', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);

      expect(() => unwrapSecret(recipient.privateKey, wrapped, OTHER_LABEL)).toThrow(
        DecryptionFailedError
      );
    });

    it('fails with the wrong recipient private key', () => {
      const recipient = generateEpochKeyPair();
      const other = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);

      expect(() => unwrapSecret(other.privateKey, wrapped, LABEL)).toThrow(DecryptionFailedError);
    });

    it('fails on a tampered blob', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);
      const tampered = new Uint8Array(wrapped);
      const lastIndex = tampered.length - 1;
      tampered[lastIndex] = (tampered.at(lastIndex) ?? 0) ^ 0xff;

      expect(() => unwrapSecret(recipient.privateKey, tampered as typeof wrapped, LABEL)).toThrow(
        DecryptionFailedError
      );
    });

    it('throws DecryptionFailedError for an all-zero ephemeral point', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);
      const forged = withEphemeralPoint(wrapped, new Uint8Array(32));

      expect(() => unwrapSecret(recipient.privateKey, forged, LABEL)).toThrow(
        DecryptionFailedError
      );
    });

    it('throws DecryptionFailedError for a low-order ephemeral point', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);
      const forged = withEphemeralPoint(wrapped, hexToBytes(LOW_ORDER_POINT_HEX));

      expect(() => unwrapSecret(recipient.privateKey, forged, LABEL)).toThrow(
        DecryptionFailedError
      );
    });

    it('rejects an unknown version byte with a typed error', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);
      const downgraded = new Uint8Array(wrapped);
      downgraded[0] = 0x01;

      expect(() => unwrapSecret(recipient.privateKey, downgraded as typeof wrapped, LABEL)).toThrow(
        UnknownBlobVersionError
      );
    });

    it('rejects a blob shorter than the minimum length', () => {
      const recipient = generateEpochKeyPair();
      const short = Uint8Array.of(BLOB_FORMAT_VERSION, 1, 2, 3);

      expect(() => unwrapSecret(recipient.privateKey, short as never, LABEL)).toThrow(
        MalformedBlobError
      );
    });

    it('refuses an all-zero recipient private key with a typed error', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL);

      expect(() => unwrapSecret(asEpochPrivateKey(new Uint8Array(32)), wrapped, LABEL)).toThrow(
        InvalidKeyError
      );
    });

    it('reports the zeroed key ahead of a malformed blob, naming the caller-side defect', () => {
      const short = Uint8Array.of(BLOB_FORMAT_VERSION, 1, 2, 3);

      expect(() =>
        unwrapSecret(asEpochPrivateKey(new Uint8Array(32)), short as never, LABEL)
      ).toThrow(InvalidKeyError);
    });
  });

  describe('context AAD', () => {
    const CONTEXT = utf8Field(testUuidV7(1));
    const OTHER_CONTEXT = utf8Field(testUuidV7(0));

    it('round-trips a secret bound to a context AAD', () => {
      const recipient = generateEpochKeyPair();
      const secret = randomBytes(32);

      const wrapped = wrapSecretTo(recipient.publicKey, secret, LABEL, CONTEXT);

      expect(unwrapSecret(recipient.privateKey, wrapped, LABEL, CONTEXT)).toEqual(secret);
    });

    it('fails when unwrapped under a different context AAD', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL, CONTEXT);

      expect(() => unwrapSecret(recipient.privateKey, wrapped, LABEL, OTHER_CONTEXT)).toThrow(
        DecryptionFailedError
      );
    });

    it('fails when a context-bound blob is unwrapped with no context', () => {
      const recipient = generateEpochKeyPair();

      const wrapped = wrapSecretTo(recipient.publicKey, randomBytes(32), LABEL, CONTEXT);

      expect(() => unwrapSecret(recipient.privateKey, wrapped, LABEL)).toThrow(
        DecryptionFailedError
      );
    });

    it('treats an omitted context as an empty one, so existing blobs are unaffected', () => {
      const recipient = generateEpochKeyPair();
      const secret = randomBytes(32);

      const wrapped = wrapSecretTo(recipient.publicKey, secret, LABEL);

      expect(unwrapSecret(recipient.privateKey, wrapped, LABEL, new Uint8Array(0))).toEqual(secret);
    });
  });
});
