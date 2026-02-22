import { describe, it, expect } from 'vitest';
import { createMessageShare, decryptMessageShare, SHARE_INFO } from './message-share.js';
import { DecryptionError } from './errors.js';
import { randomBytes } from '@noble/hashes/utils.js';

describe('message-share', () => {
  it('uses share-msg-v1 as HKDF info string', () => {
    expect(SHARE_INFO).toBe('share-msg-v1');
  });

  describe('createMessageShare', () => {
    it('returns shareSecret and shareBlob', () => {
      const result = createMessageShare('Hello, World!');

      expect(result.shareSecret).toBeInstanceOf(Uint8Array);
      expect(result.shareSecret.length).toBe(32);
      expect(result.shareBlob).toBeInstanceOf(Uint8Array);
    });

    it('generates unique secrets per call', () => {
      const result1 = createMessageShare('Hello');
      const result2 = createMessageShare('Hello');

      expect(result1.shareSecret).not.toEqual(result2.shareSecret);
      expect(result1.shareBlob).not.toEqual(result2.shareBlob);
    });
  });

  describe('decryptMessageShare', () => {
    it('round-trips short message', () => {
      const text = 'Hello, World!';

      const { shareSecret, shareBlob } = createMessageShare(text);
      const result = decryptMessageShare(shareSecret, shareBlob);

      expect(result).toBe(text);
    });

    it('round-trips large message with compression', () => {
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(500);

      const { shareSecret, shareBlob } = createMessageShare(text);
      const result = decryptMessageShare(shareSecret, shareBlob);

      expect(result).toBe(text);
    });

    it('handles empty string', () => {
      const { shareSecret, shareBlob } = createMessageShare('');
      const result = decryptMessageShare(shareSecret, shareBlob);

      expect(result).toBe('');
    });

    it('handles unicode content', () => {
      const text = '密码🔐émojis 日本語';

      const { shareSecret, shareBlob } = createMessageShare(text);
      const result = decryptMessageShare(shareSecret, shareBlob);

      expect(result).toBe(text);
    });

    it('throws DecryptionError with wrong secret', () => {
      const { shareBlob } = createMessageShare('Secret');
      const wrongSecret = randomBytes(32);

      expect(() => decryptMessageShare(wrongSecret, shareBlob)).toThrow(DecryptionError);
    });

    it('throws with tampered blob', () => {
      const { shareSecret, shareBlob } = createMessageShare('Secret');
      const tampered = new Uint8Array(shareBlob);
      tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;

      expect(() => decryptMessageShare(shareSecret, tampered)).toThrow();
    });

    it('compressed share blob is smaller than plaintext', () => {
      const text = 'A'.repeat(10_000);

      const { shareBlob } = createMessageShare(text);

      expect(shareBlob.length).toBeLessThan(text.length);
    });
  });
});
