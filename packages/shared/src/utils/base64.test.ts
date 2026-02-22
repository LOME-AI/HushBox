import { describe, it, expect } from 'vitest';
import { toBase64, fromBase64, toStandardBase64, fromStandardBase64 } from './base64.js';

describe('base64', () => {
  describe('toBase64/fromBase64', () => {
    it('encodes and decodes data correctly', () => {
      const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

      const encoded = toBase64(original);
      const decoded = fromBase64(encoded);

      expect(decoded).toEqual(original);
    });

    it('returns a string for toBase64', () => {
      const data = new Uint8Array([1, 2, 3]);

      const encoded = toBase64(data);

      expect(typeof encoded).toBe('string');
    });

    it('returns Uint8Array for fromBase64', () => {
      const encoded = 'AQID'; // [1, 2, 3] in base64

      const decoded = fromBase64(encoded);

      expect(decoded).toBeInstanceOf(Uint8Array);
    });

    it('handles empty data', () => {
      const original = new Uint8Array(0);

      const encoded = toBase64(original);
      const decoded = fromBase64(encoded);

      expect(decoded).toEqual(original);
      expect(encoded).toBe('');
    });

    it('handles binary data with all byte values', () => {
      const original = new Uint8Array(256);
      for (let index = 0; index < 256; index++) {
        original[index] = index;
      }

      const encoded = toBase64(original);
      const decoded = fromBase64(encoded);

      expect(decoded).toEqual(original);
    });

    it('produces URL-safe base64 (no + or /)', () => {
      // Data that would produce + and / in standard base64
      const data = new Uint8Array([251, 255, 254, 253]);

      const encoded = toBase64(data);

      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
    });
  });

  describe('toStandardBase64/fromStandardBase64', () => {
    it('encodes and decodes data correctly', () => {
      const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

      const encoded = toStandardBase64(original);
      const decoded = fromStandardBase64(encoded);

      expect(decoded).toEqual(original);
    });

    it('returns a string for toStandardBase64', () => {
      const data = new Uint8Array([1, 2, 3]);

      const encoded = toStandardBase64(data);

      expect(typeof encoded).toBe('string');
    });

    it('returns Uint8Array for fromStandardBase64', () => {
      const encoded = 'AQID'; // [1, 2, 3] in standard base64

      const decoded = fromStandardBase64(encoded);

      expect(decoded).toBeInstanceOf(Uint8Array);
    });

    it('handles empty data', () => {
      const original = new Uint8Array(0);

      const encoded = toStandardBase64(original);
      const decoded = fromStandardBase64(encoded);

      expect(decoded).toEqual(original);
      expect(encoded).toBe('');
    });

    it('handles binary data with all byte values', () => {
      const original = new Uint8Array(256);
      for (let index = 0; index < 256; index++) {
        original[index] = index;
      }

      const encoded = toStandardBase64(original);
      const decoded = fromStandardBase64(encoded);

      expect(decoded).toEqual(original);
    });

    it('produces standard base64 with + / and = characters', () => {
      // Data that produces + and / in standard base64
      const data = new Uint8Array([251, 255, 254, 253]);

      const encoded = toStandardBase64(data);

      // Standard base64 should use + and / (not URL-safe - and _)
      expect(encoded).not.toContain('-');
      expect(encoded).not.toContain('_');
    });

    it('includes padding characters', () => {
      // 1 byte encodes to 4 chars with 2 padding chars
      const data = new Uint8Array([65]);

      const encoded = toStandardBase64(data);

      expect(encoded).toBe('QQ==');
    });

    it('matches native btoa output', () => {
      const text = 'test-webhook-secret';
      const bytes = new Uint8Array(text.length);
      for (let index = 0; index < text.length; index++) {
        bytes[index] = text.codePointAt(index) ?? 0;
      }

      const encoded = toStandardBase64(bytes);

      expect(encoded).toBe(btoa(text));
    });

    it('fromStandardBase64 matches native atob behavior', () => {
      const text = 'test-webhook-secret';
      const base64 = btoa(text);

      const decoded = fromStandardBase64(base64);

      const expected = Uint8Array.from(atob(base64), (c) => c.codePointAt(0) ?? 0);
      expect(decoded).toEqual(expected);
    });
  });
});
