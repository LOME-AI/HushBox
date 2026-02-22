import { describe, it, expect } from 'vitest';
import { compress, decompress, compressIfSmaller } from './compression.js';

describe('compression', () => {
  describe('compress/decompress', () => {
    it('compresses and decompresses data correctly', () => {
      const original = new TextEncoder().encode('Hello, World! '.repeat(100));

      const compressed = compress(original);
      const decompressed = decompress(compressed);

      expect(decompressed).toEqual(original);
    });

    it('compressed data is smaller than original for repetitive content', () => {
      const original = new TextEncoder().encode('AAAAAAAAAA'.repeat(1000));

      const compressed = compress(original);

      expect(compressed.length).toBeLessThan(original.length);
    });

    it('uses raw deflate format (no gzip header)', () => {
      const original = new TextEncoder().encode('Hello, World! '.repeat(100));

      const compressed = compress(original);

      // Gzip format starts with magic bytes 0x1f 0x8b
      // Raw deflate does NOT have these bytes
      const hasGzipHeader = compressed[0] === 0x1f && compressed[1] === 0x8b;
      expect(hasGzipHeader).toBe(false);
    });

    it('handles empty data', () => {
      const original = new Uint8Array(0);

      const compressed = compress(original);
      const decompressed = decompress(compressed);

      expect(decompressed).toEqual(original);
    });

    it('handles unicode text', () => {
      const text = '你好世界 🌍 مرحبا '.repeat(50);
      const original = new TextEncoder().encode(text);

      const compressed = compress(original);
      const decompressed = decompress(compressed);

      expect(new TextDecoder().decode(decompressed)).toBe(text);
    });
  });

  describe('compressIfSmaller', () => {
    it('returns compressed data when smaller', () => {
      const original = new TextEncoder().encode('AAAAAAAAAA'.repeat(1000));

      const { result, compressed } = compressIfSmaller(original);

      expect(compressed).toBe(true);
      expect(result.length).toBeLessThan(original.length);
    });

    it('returns original data when compression makes it larger', () => {
      // Random data doesn't compress well
      const original = new Uint8Array(100);
      for (let index = 0; index < original.length; index++) {
        original[index] = Math.floor(Math.random() * 256);
      }

      const { result, compressed } = compressIfSmaller(original);

      expect(compressed).toBe(false);
      expect(result).toEqual(original);
    });

    it('decompressed result matches original when compressed', () => {
      const original = new TextEncoder().encode('Hello, World! '.repeat(100));

      const { result, compressed } = compressIfSmaller(original);

      if (compressed) {
        const decompressed = decompress(result);
        expect(decompressed).toEqual(original);
      } else {
        expect(result).toEqual(original);
      }
    });
  });
});
