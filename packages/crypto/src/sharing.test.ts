import { describe, it, expect } from 'vitest';
import { generateKeyPair, deriveKeyPairFromSeed, getPublicKeyFromPrivate } from './sharing.js';

describe('sharing', () => {
  describe('generateKeyPair', () => {
    it('generates a key pair with 32-byte keys', () => {
      const { publicKey, privateKey } = generateKeyPair();

      expect(publicKey).toBeInstanceOf(Uint8Array);
      expect(privateKey).toBeInstanceOf(Uint8Array);
      expect(publicKey.length).toBe(32);
      expect(privateKey.length).toBe(32);
    });

    it('generates unique key pairs on each call', () => {
      const keyPair1 = generateKeyPair();
      const keyPair2 = generateKeyPair();

      expect(keyPair1.publicKey).not.toEqual(keyPair2.publicKey);
      expect(keyPair1.privateKey).not.toEqual(keyPair2.privateKey);
    });

    it('public key is different from private key', () => {
      const { publicKey, privateKey } = generateKeyPair();

      expect(publicKey).not.toEqual(privateKey);
    });
  });

  describe('deriveKeyPairFromSeed', () => {
    it('derives a key pair with 32-byte keys', () => {
      const seed = new Uint8Array(32).fill(42);
      const { publicKey, privateKey } = deriveKeyPairFromSeed(seed, 'test-info-v1');

      expect(publicKey).toBeInstanceOf(Uint8Array);
      expect(privateKey).toBeInstanceOf(Uint8Array);
      expect(publicKey.length).toBe(32);
      expect(privateKey.length).toBe(32);
    });

    it('produces deterministic output for same seed and info', () => {
      const seed = new Uint8Array(32).fill(42);

      const kp1 = deriveKeyPairFromSeed(seed, 'test-info-v1');
      const kp2 = deriveKeyPairFromSeed(seed, 'test-info-v1');

      expect(kp1.publicKey).toEqual(kp2.publicKey);
      expect(kp1.privateKey).toEqual(kp2.privateKey);
    });

    it('produces different output for different seeds', () => {
      const seed1 = new Uint8Array(32).fill(1);
      const seed2 = new Uint8Array(32).fill(2);

      const kp1 = deriveKeyPairFromSeed(seed1, 'test-info-v1');
      const kp2 = deriveKeyPairFromSeed(seed2, 'test-info-v1');

      expect(kp1.publicKey).not.toEqual(kp2.publicKey);
      expect(kp1.privateKey).not.toEqual(kp2.privateKey);
    });

    it('produces different output for different info strings', () => {
      const seed = new Uint8Array(32).fill(42);

      const kp1 = deriveKeyPairFromSeed(seed, 'info-a');
      const kp2 = deriveKeyPairFromSeed(seed, 'info-b');

      expect(kp1.publicKey).not.toEqual(kp2.publicKey);
      expect(kp1.privateKey).not.toEqual(kp2.privateKey);
    });

    it('public key corresponds to private key', async () => {
      const seed = new Uint8Array(32).fill(42);
      const { publicKey, privateKey } = deriveKeyPairFromSeed(seed, 'test-info-v1');

      const { x25519 } = await import('@noble/curves/ed25519.js');
      const derivedPub = x25519.getPublicKey(privateKey);
      expect(publicKey).toEqual(derivedPub);
    });
  });

  describe('getPublicKeyFromPrivate', () => {
    it('derives correct public key matching generateKeyPair output', () => {
      const keyPair = generateKeyPair();
      const derivedPublic = getPublicKeyFromPrivate(keyPair.privateKey);

      expect(derivedPublic).toEqual(keyPair.publicKey);
    });

    it('returns 32-byte Uint8Array', () => {
      const keyPair = generateKeyPair();
      const derivedPublic = getPublicKeyFromPrivate(keyPair.privateKey);

      expect(derivedPublic).toBeInstanceOf(Uint8Array);
      expect(derivedPublic.length).toBe(32);
    });
  });
});
