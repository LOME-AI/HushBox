import { describe, it, expect } from 'vitest';
import { encodeForEncryption, decodeFromDecryption } from './message-codec.js';

const FLAG_UNCOMPRESSED = 0x00;
const FLAG_COMPRESSED = 0x01;

describe('message-codec', () => {
  describe('encodeForEncryption', () => {
    it('prepends 0x00 flag for short string that does not benefit from compression', () => {
      const result = encodeForEncryption('Hello');

      expect(result[0]).toBe(FLAG_UNCOMPRESSED);
      expect(result.length).toBeGreaterThan(1);
    });

    it('prepends 0x01 flag for long repetitive string that compresses well', () => {
      const result = encodeForEncryption('A'.repeat(10_000));

      expect(result[0]).toBe(FLAG_COMPRESSED);
      // Compressed payload should be much smaller than original
      expect(result.length).toBeLessThan(10_000);
    });

    it('produces payload whose data portion matches original bytes when uncompressed', () => {
      const text = 'Hello';
      const result = encodeForEncryption(text);
      const originalBytes = new TextEncoder().encode(text);

      // Skip flag byte, rest should be original bytes
      expect(result.subarray(1)).toEqual(originalBytes);
    });

    it('handles empty string', () => {
      const result = encodeForEncryption('');

      expect(result[0]).toBe(FLAG_UNCOMPRESSED);
      // Flag byte + empty data (deflate of empty would be larger)
      expect(result.length).toBe(1);
    });

    it('handles unicode text', () => {
      const text = '你好世界 🌍 مرحبا';
      const result = encodeForEncryption(text);

      expect(result[0]).toBe(FLAG_UNCOMPRESSED);
      expect(result.length).toBeGreaterThan(1);
    });
  });

  describe('decodeFromDecryption', () => {
    it('decodes uncompressed payload (0x00 flag)', () => {
      const text = 'Hello, World!';
      const textBytes = new TextEncoder().encode(text);
      const payload = new Uint8Array(1 + textBytes.length);
      payload[0] = FLAG_UNCOMPRESSED;
      payload.set(textBytes, 1);

      const result = decodeFromDecryption(payload);

      expect(result).toBe(text);
    });

    it('decodes compressed payload (0x01 flag)', () => {
      // First encode to get a compressed payload, then decode it
      const text = 'B'.repeat(10_000);
      const encoded = encodeForEncryption(text);

      expect(encoded[0]).toBe(FLAG_COMPRESSED);

      const result = decodeFromDecryption(encoded);

      expect(result).toBe(text);
    });

    it('handles empty string payload', () => {
      const payload = new Uint8Array([FLAG_UNCOMPRESSED]);

      const result = decodeFromDecryption(payload);

      expect(result).toBe('');
    });
  });

  describe('round-trip', () => {
    it('round-trips short text through encode/decode', () => {
      const text = 'Short message';

      const encoded = encodeForEncryption(text);
      const decoded = decodeFromDecryption(encoded);

      expect(decoded).toBe(text);
    });

    it('round-trips long text through encode/decode', () => {
      const text = 'This is a longer message that should compress. '.repeat(500);

      const encoded = encodeForEncryption(text);
      const decoded = decodeFromDecryption(encoded);

      expect(decoded).toBe(text);
    });

    it('round-trips unicode text', () => {
      const text = '你好世界 🌍 مرحبا '.repeat(200);

      const encoded = encodeForEncryption(text);
      const decoded = decodeFromDecryption(encoded);

      expect(decoded).toBe(text);
    });

    it('round-trips empty string', () => {
      const text = '';

      const encoded = encodeForEncryption(text);
      const decoded = decodeFromDecryption(encoded);

      expect(decoded).toBe(text);
    });
  });
});
