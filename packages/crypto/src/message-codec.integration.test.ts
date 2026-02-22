import { describe, it, expect } from 'vitest';
import { encodeForEncryption, decodeFromDecryption } from './message-codec.js';
import { eciesEncrypt, eciesDecrypt } from './ecies.js';
import { generateKeyPair } from './sharing.js';

describe('message-codec integration', () => {
  describe('ECIES encrypt/decrypt with compression', () => {
    it('small message is NOT compressed through ECIES cycle', () => {
      const { privateKey, publicKey } = generateKeyPair();
      const text = 'Short msg';

      const payload = encodeForEncryption(text);
      expect(payload[0]).toBe(0x00);

      const blob = eciesEncrypt(publicKey, payload);
      const decryptedPayload = eciesDecrypt(privateKey, blob);
      const result = decodeFromDecryption(decryptedPayload);

      expect(result).toBe(text);
    });

    it('large message IS compressed through ECIES cycle', () => {
      const { privateKey, publicKey } = generateKeyPair();
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(500);

      const payload = encodeForEncryption(text);
      expect(payload[0]).toBe(0x01);

      const blob = eciesEncrypt(publicKey, payload);
      const decryptedPayload = eciesDecrypt(privateKey, blob);
      const result = decodeFromDecryption(decryptedPayload);

      expect(result).toBe(text);
    });

    it('preserves flag byte through encrypt/decrypt cycle', () => {
      const { privateKey, publicKey } = generateKeyPair();
      const text = 'Repeated content for compression. '.repeat(500);

      const payload = encodeForEncryption(text);
      expect(payload[0]).toBe(0x01);

      const blob = eciesEncrypt(publicKey, payload);
      const decryptedPayload = eciesDecrypt(privateKey, blob);

      expect(decryptedPayload[0]).toBe(0x01);

      const result = decodeFromDecryption(decryptedPayload);
      expect(result).toBe(text);
    });

    it('handles uncompressed message through full cycle', () => {
      const { privateKey, publicKey } = generateKeyPair();
      const text = 'Hi';

      const payload = encodeForEncryption(text);
      expect(payload[0]).toBe(0x00);

      const blob = eciesEncrypt(publicKey, payload);
      const decryptedPayload = eciesDecrypt(privateKey, blob);

      expect(decryptedPayload[0]).toBe(0x00);

      const result = decodeFromDecryption(decryptedPayload);
      expect(result).toBe(text);
    });
  });
});
