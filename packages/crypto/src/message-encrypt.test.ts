import { describe, it, expect } from 'vitest';
import { encryptMessageForStorage, decryptMessage } from './message-encrypt.js';
import { generateKeyPair } from './sharing.js';
import { DecryptionError } from './errors.js';

describe('message-encrypt', () => {
  describe('encryptMessageForStorage', () => {
    it('returns a Uint8Array blob', () => {
      const { publicKey } = generateKeyPair();

      const blob = encryptMessageForStorage(publicKey, 'Hello, World!');

      expect(blob).toBeInstanceOf(Uint8Array);
    });

    it('blob starts with ECIES version byte 0x01', () => {
      const { publicKey } = generateKeyPair();

      const blob = encryptMessageForStorage(publicKey, 'Hello');

      expect(blob[0]).toBe(0x01);
    });

    it('produces different blobs for same plaintext', () => {
      const { publicKey } = generateKeyPair();

      const blob1 = encryptMessageForStorage(publicKey, 'Hello');
      const blob2 = encryptMessageForStorage(publicKey, 'Hello');

      expect(blob1).not.toEqual(blob2);
    });
  });

  describe('decryptMessage', () => {
    it('round-trips short message without compression', () => {
      const keyPair = generateKeyPair();
      const text = 'Hello, World!';

      const blob = encryptMessageForStorage(keyPair.publicKey, text);
      const result = decryptMessage(keyPair.privateKey, blob);

      expect(result).toBe(text);
    });

    it('round-trips large message with compression', () => {
      const keyPair = generateKeyPair();
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(500);

      const blob = encryptMessageForStorage(keyPair.publicKey, text);
      const result = decryptMessage(keyPair.privateKey, blob);

      expect(result).toBe(text);
    });

    it('compressed message produces smaller blob than uncompressed', () => {
      const keyPair = generateKeyPair();
      const text = 'A'.repeat(10_000);

      const blob = encryptMessageForStorage(keyPair.publicKey, text);

      const overhead = 49 + 1; // ECIES overhead + flag byte minimum
      expect(blob.length).toBeLessThan(text.length + overhead);
    });

    it('handles empty string', () => {
      const keyPair = generateKeyPair();

      const blob = encryptMessageForStorage(keyPair.publicKey, '');
      const result = decryptMessage(keyPair.privateKey, blob);

      expect(result).toBe('');
    });

    it('handles unicode content', () => {
      const keyPair = generateKeyPair();
      const text = '密码🔐émojis 日本語 العربية';

      const blob = encryptMessageForStorage(keyPair.publicKey, text);
      const result = decryptMessage(keyPair.privateKey, blob);

      expect(result).toBe(text);
    });

    it('throws DecryptionError with wrong private key', () => {
      const keyPair = generateKeyPair();
      const wrongKeyPair = generateKeyPair();
      const text = 'Secret message';

      const blob = encryptMessageForStorage(keyPair.publicKey, text);

      expect(() => decryptMessage(wrongKeyPair.privateKey, blob)).toThrow(DecryptionError);
    });

    it('throws with tampered blob', () => {
      const keyPair = generateKeyPair();
      const text = 'Secret message';

      const blob = encryptMessageForStorage(keyPair.publicKey, text);
      const tampered = new Uint8Array(blob);
      tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;

      expect(() => decryptMessage(keyPair.privateKey, tampered)).toThrow();
    });
  });
});
