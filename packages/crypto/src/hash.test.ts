import { describe, it, expect } from 'vitest';
import { sha256Hash, hkdfSha256, bytesToHex } from './hash.js';

describe('sha256Hash', () => {
  it('returns a 32-byte hash', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const hash = sha256Hash(data);

    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(32);
  });

  it('produces deterministic output for same input', () => {
    const data = new Uint8Array([1, 2, 3, 4]);

    const hash1 = sha256Hash(data);
    const hash2 = sha256Hash(data);

    expect(hash1).toEqual(hash2);
  });

  it('produces different output for different input', () => {
    const data1 = new Uint8Array([1, 2, 3, 4]);
    const data2 = new Uint8Array([5, 6, 7, 8]);

    const hash1 = sha256Hash(data1);
    const hash2 = sha256Hash(data2);

    expect(hash1).not.toEqual(hash2);
  });

  it('handles empty input', () => {
    const data = new Uint8Array([]);
    const hash = sha256Hash(data);

    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(32);
  });

  it('matches known SHA-256 vector for empty input', () => {
    const data = new Uint8Array([]);
    const hash = sha256Hash(data);

    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const expected = new Uint8Array([
      0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f, 0xb9,
      0x24, 0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b, 0x78, 0x52,
      0xb8, 0x55,
    ]);
    expect(hash).toEqual(expected);
  });

  it('matches known SHA-256 vector for "abc"', () => {
    const data = new TextEncoder().encode('abc');
    const hash = sha256Hash(data);

    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const expected = new Uint8Array([
      0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22,
      0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00,
      0x15, 0xad,
    ]);
    expect(hash).toEqual(expected);
  });
});

describe('hkdfSha256', () => {
  it('derives a key of the requested length', () => {
    const ikm = new Uint8Array(32).fill(0xaa);
    const salt = new TextEncoder().encode('test-salt');
    const result = hkdfSha256(ikm, salt, undefined, 32);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toHaveLength(32);
  });

  it('returns different keys for different salts', () => {
    const ikm = new Uint8Array(32).fill(0xbb);
    const a = hkdfSha256(ikm, new TextEncoder().encode('salt-a'), undefined, 32);
    const b = hkdfSha256(ikm, new TextEncoder().encode('salt-b'), undefined, 32);
    expect(a).not.toEqual(b);
  });

  it('returns consistent output for same inputs', () => {
    const ikm = new Uint8Array(32).fill(0xcc);
    const salt = new TextEncoder().encode('stable');
    const a = hkdfSha256(ikm, salt, undefined, 32);
    const b = hkdfSha256(ikm, salt, undefined, 32);
    expect(a).toEqual(b);
  });

  it('supports different output lengths', () => {
    const ikm = new Uint8Array(32).fill(0xdd);
    const salt = new TextEncoder().encode('len-test');
    const short = hkdfSha256(ikm, salt, undefined, 16);
    const long = hkdfSha256(ikm, salt, undefined, 48);
    expect(short).toHaveLength(16);
    expect(long).toHaveLength(48);
  });

  it('accepts info parameter', () => {
    const ikm = new Uint8Array(32).fill(0xee);
    const salt = new TextEncoder().encode('info-test');
    const a = hkdfSha256(ikm, salt, new TextEncoder().encode('info-a'), 32);
    const b = hkdfSha256(ikm, salt, new TextEncoder().encode('info-b'), 32);
    expect(a).not.toEqual(b);
  });
});

describe('bytesToHex', () => {
  it('converts empty array to empty string', () => {
    expect(bytesToHex(new Uint8Array([]))).toBe('');
  });

  it('converts bytes to lowercase hex', () => {
    expect(bytesToHex(new Uint8Array([0x0a, 0xff, 0x00]))).toBe('0aff00');
  });

  it('pads single-digit hex values with leading zero', () => {
    expect(bytesToHex(new Uint8Array([0x01]))).toBe('01');
  });

  it('handles all-zeros', () => {
    expect(bytesToHex(new Uint8Array([0, 0, 0]))).toBe('000000');
  });
});
