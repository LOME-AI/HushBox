import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { x25519 } from '@noble/curves/ed25519.js';
import {
  KEY_BYTES,
  asAccountPrivateKey,
  asAccountPublicKey,
  asWrappingPrivateKey,
  asWrappingPublicKey,
  asEpochPrivateKey,
  asEpochPublicKey,
  asContentKey,
  asShareSecret,
  asTotpEncryptionKey,
  asOpaqueKek,
  generateAccountKeyPair,
  generateEpochKeyPair,
  generateContentKey,
  generateKeyPair,
  deriveKeyPairFromSeed,
  getPublicKeyFromPrivate,
  assertNotZeroed,
} from './keys.js';
import { InvalidKeyError } from '../errors.js';
import { DERIVE_LABELS } from '../wrap/labels.js';

const validators = [
  ['asAccountPrivateKey', asAccountPrivateKey],
  ['asAccountPublicKey', asAccountPublicKey],
  ['asWrappingPrivateKey', asWrappingPrivateKey],
  ['asWrappingPublicKey', asWrappingPublicKey],
  ['asEpochPrivateKey', asEpochPrivateKey],
  ['asEpochPublicKey', asEpochPublicKey],
  ['asContentKey', asContentKey],
  ['asShareSecret', asShareSecret],
  ['asTotpEncryptionKey', asTotpEncryptionKey],
  ['asOpaqueKek', asOpaqueKek],
] as const;

describe('keys', () => {
  it('KEY_BYTES is 32', () => {
    expect(KEY_BYTES).toBe(32);
  });

  describe.each(validators)('%s', (_name, validate) => {
    it('brands 32-byte material, preserving the bytes', () => {
      const bytes = randomBytes(KEY_BYTES);

      const key = validate(bytes);

      expect(new Uint8Array(key)).toEqual(new Uint8Array(bytes));
      expect(key.length).toBe(KEY_BYTES);
    });

    it('rejects material shorter than 32 bytes', () => {
      expect(() => validate(randomBytes(KEY_BYTES - 1))).toThrow(InvalidKeyError);
    });

    it('rejects material longer than 32 bytes', () => {
      expect(() => validate(randomBytes(KEY_BYTES + 1))).toThrow(InvalidKeyError);
    });

    it('rejects empty material', () => {
      expect(() => validate(new Uint8Array(0))).toThrow(InvalidKeyError);
    });
  });

  describe('generateAccountKeyPair', () => {
    it('returns an X25519 keypair whose public key matches the private key', () => {
      const pair = generateAccountKeyPair();

      expect(new Uint8Array(pair.publicKey)).toEqual(x25519.getPublicKey(pair.privateKey));
    });

    it('returns fresh material per call', () => {
      expect(generateAccountKeyPair().privateKey).not.toEqual(generateAccountKeyPair().privateKey);
    });
  });

  describe('generateEpochKeyPair', () => {
    it('returns an X25519 keypair whose public key matches the private key', () => {
      const pair = generateEpochKeyPair();

      expect(new Uint8Array(pair.publicKey)).toEqual(x25519.getPublicKey(pair.privateKey));
    });

    it('returns fresh material per call', () => {
      expect(generateEpochKeyPair().privateKey).not.toEqual(generateEpochKeyPair().privateKey);
    });
  });

  describe('generateContentKey', () => {
    it('returns 32 random bytes', () => {
      const key = generateContentKey();

      expect(key.length).toBe(KEY_BYTES);
    });

    it('returns fresh material per call', () => {
      expect(generateContentKey()).not.toEqual(generateContentKey());
    });
  });

  describe('generateKeyPair', () => {
    it('generates a key pair with 32-byte keys', () => {
      const { publicKey, privateKey } = generateKeyPair();

      expect(publicKey.length).toBe(KEY_BYTES);
      expect(privateKey.length).toBe(KEY_BYTES);
    });

    it('generates unique key pairs on each call', () => {
      const first = generateKeyPair();
      const second = generateKeyPair();

      expect(first.publicKey).not.toEqual(second.publicKey);
      expect(first.privateKey).not.toEqual(second.privateKey);
    });

    it('public key is different from private key', () => {
      const { publicKey, privateKey } = generateKeyPair();

      expect(publicKey).not.toEqual(privateKey);
    });
  });

  describe('deriveKeyPairFromSeed', () => {
    it('derives a key pair with 32-byte keys', () => {
      const seed = new Uint8Array(32).fill(42);

      const { publicKey, privateKey } = deriveKeyPairFromSeed(seed, DERIVE_LABELS.linkKeyPair);

      expect(publicKey.length).toBe(KEY_BYTES);
      expect(privateKey.length).toBe(KEY_BYTES);
    });

    it('produces deterministic output for same seed and label', () => {
      const seed = new Uint8Array(32).fill(42);

      const first = deriveKeyPairFromSeed(seed, DERIVE_LABELS.linkKeyPair);
      const second = deriveKeyPairFromSeed(seed, DERIVE_LABELS.linkKeyPair);

      expect(first.publicKey).toEqual(second.publicKey);
      expect(first.privateKey).toEqual(second.privateKey);
    });

    it('produces different output for different seeds', () => {
      const first = deriveKeyPairFromSeed(new Uint8Array(32).fill(1), DERIVE_LABELS.linkKeyPair);
      const second = deriveKeyPairFromSeed(new Uint8Array(32).fill(2), DERIVE_LABELS.linkKeyPair);

      expect(first.publicKey).not.toEqual(second.publicKey);
      expect(first.privateKey).not.toEqual(second.privateKey);
    });

    it('produces different output for different derive labels', () => {
      const seed = new Uint8Array(32).fill(42);

      const first = deriveKeyPairFromSeed(seed, DERIVE_LABELS.accountWrapKeyPair);
      const second = deriveKeyPairFromSeed(seed, DERIVE_LABELS.recoveryWrapKeyPair);

      expect(first.publicKey).not.toEqual(second.publicKey);
      expect(first.privateKey).not.toEqual(second.privateKey);
    });

    it('public key corresponds to private key', () => {
      const seed = new Uint8Array(32).fill(42);

      const { publicKey, privateKey } = deriveKeyPairFromSeed(seed, DERIVE_LABELS.linkKeyPair);

      expect(publicKey).toEqual(x25519.getPublicKey(privateKey));
    });
  });

  describe('getPublicKeyFromPrivate', () => {
    it('derives the public key matching generateKeyPair output', () => {
      const keyPair = generateKeyPair();

      expect(getPublicKeyFromPrivate(keyPair.privateKey)).toEqual(keyPair.publicKey);
    });

    it('returns 32 bytes', () => {
      const derived = getPublicKeyFromPrivate(generateKeyPair().privateKey);

      expect(derived.length).toBe(KEY_BYTES);
    });
  });

  describe('assertNotZeroed', () => {
    it('rejects an all-zero buffer with a typed error', () => {
      expect(() => {
        assertNotZeroed('a test key', new Uint8Array(32));
      }).toThrow(InvalidKeyError);
    });

    it('rejects an empty buffer with a typed error', () => {
      expect(() => {
        assertNotZeroed('a test key', new Uint8Array(0));
      }).toThrow(InvalidKeyError);
    });

    it('accepts a buffer that merely contains zero bytes', () => {
      const bytes = new Uint8Array(32);
      bytes[31] = 1;

      expect(() => {
        assertNotZeroed('a test key', bytes);
      }).not.toThrow();
    });
  });
});
