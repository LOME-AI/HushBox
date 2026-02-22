import { describe, it, expect } from 'vitest';
import {
  deriveWrappingKeyPair,
  deriveRecoveryKeyPair,
  generateSalt,
  KDF_PARAMS,
} from './key-derivation.js';

describe('key-derivation', () => {
  describe('generateSalt', () => {
    it('generates a 16-byte salt by default', () => {
      const salt = generateSalt();
      expect(salt).toBeInstanceOf(Uint8Array);
      expect(salt.length).toBe(16);
    });

    it('generates unique salts on each call', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      expect(salt1).not.toEqual(salt2);
    });

    it('allows custom salt length', () => {
      const salt = generateSalt(32);
      expect(salt.length).toBe(32);
    });
  });

  describe('deriveWrappingKeyPair', () => {
    it('returns a key pair with 32-byte keys', () => {
      const exportKey = new Uint8Array(64).fill(42);

      const { publicKey, privateKey } = deriveWrappingKeyPair(exportKey);

      expect(publicKey).toBeInstanceOf(Uint8Array);
      expect(privateKey).toBeInstanceOf(Uint8Array);
      expect(publicKey.length).toBe(32);
      expect(privateKey.length).toBe(32);
    });

    it('produces deterministic output for same export key', () => {
      const exportKey = new Uint8Array(64).fill(42);

      const kp1 = deriveWrappingKeyPair(exportKey);
      const kp2 = deriveWrappingKeyPair(exportKey);

      expect(kp1.publicKey).toEqual(kp2.publicKey);
      expect(kp1.privateKey).toEqual(kp2.privateKey);
    });

    it('produces different output for different export keys', () => {
      const kp1 = deriveWrappingKeyPair(new Uint8Array(64).fill(1));
      const kp2 = deriveWrappingKeyPair(new Uint8Array(64).fill(2));

      expect(kp1.publicKey).not.toEqual(kp2.publicKey);
      expect(kp1.privateKey).not.toEqual(kp2.privateKey);
    });

    it('public key corresponds to private key', async () => {
      const exportKey = new Uint8Array(64).fill(42);
      const { publicKey, privateKey } = deriveWrappingKeyPair(exportKey);

      const { x25519 } = await import('@noble/curves/ed25519.js');
      const derivedPub = x25519.getPublicKey(privateKey);
      expect(publicKey).toEqual(derivedPub);
    });
  });

  describe('deriveRecoveryKeyPair', () => {
    it('returns a key pair with 32-byte keys', async () => {
      const seed = new Uint8Array(64).fill(42);

      const { publicKey, privateKey } = await deriveRecoveryKeyPair(seed);

      expect(publicKey).toBeInstanceOf(Uint8Array);
      expect(privateKey).toBeInstanceOf(Uint8Array);
      expect(publicKey.length).toBe(32);
      expect(privateKey.length).toBe(32);
    });

    it('produces deterministic output for same seed', async () => {
      const seed = new Uint8Array(64).fill(42);

      const kp1 = await deriveRecoveryKeyPair(seed);
      const kp2 = await deriveRecoveryKeyPair(seed);

      expect(kp1.publicKey).toEqual(kp2.publicKey);
      expect(kp1.privateKey).toEqual(kp2.privateKey);
    });

    it('produces different output for different seeds', async () => {
      const kp1 = await deriveRecoveryKeyPair(new Uint8Array(64).fill(1));
      const kp2 = await deriveRecoveryKeyPair(new Uint8Array(64).fill(2));

      expect(kp1.publicKey).not.toEqual(kp2.publicKey);
      expect(kp1.privateKey).not.toEqual(kp2.privateKey);
    });

    it('public key corresponds to private key', async () => {
      const seed = new Uint8Array(64).fill(42);
      const { publicKey, privateKey } = await deriveRecoveryKeyPair(seed);

      const { x25519 } = await import('@noble/curves/ed25519.js');
      const derivedPub = x25519.getPublicKey(privateKey);
      expect(publicKey).toEqual(derivedPub);
    });

    it('uses Argon2id internally (slow due to memory-hard KDF)', async () => {
      const seed = new Uint8Array(64).fill(42);

      const start = performance.now();
      await deriveRecoveryKeyPair(seed);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeGreaterThan(50);
    });
  });

  describe('removed functions', () => {
    it('does not export derivePasswordKEK', async () => {
      const module_ = await import('./key-derivation.js');
      expect('derivePasswordKEK' in module_).toBe(false);
    });

    it('does not export deriveRecoveryKEK', async () => {
      const module_ = await import('./key-derivation.js');
      expect('deriveRecoveryKEK' in module_).toBe(false);
    });

    it('does not export deriveConversationKey', async () => {
      const module_ = await import('./key-derivation.js');
      expect('deriveConversationKey' in module_).toBe(false);
    });

    it('does not export deriveMessageKey', async () => {
      const module_ = await import('./key-derivation.js');
      expect('deriveMessageKey' in module_).toBe(false);
    });
  });

  describe('KDF_PARAMS', () => {
    it('exports Argon2id parameters', () => {
      expect(KDF_PARAMS).toHaveProperty('memory');
      expect(KDF_PARAMS).toHaveProperty('iterations');
      expect(KDF_PARAMS).toHaveProperty('parallelism');
      expect(KDF_PARAMS).toHaveProperty('keyLength');
    });

    it('uses secure parameters', () => {
      expect(KDF_PARAMS.memory).toBeGreaterThanOrEqual(65_536);
      expect(KDF_PARAMS.iterations).toBeGreaterThanOrEqual(3);
      expect(KDF_PARAMS.parallelism).toBeGreaterThanOrEqual(1);
      expect(KDF_PARAMS.keyLength).toBe(32);
    });
  });
});
