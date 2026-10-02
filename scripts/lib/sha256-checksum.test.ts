import { describe, expect, it } from 'vitest';

import { sha256Hex, verifySha256 } from './sha256-checksum.js';

const ABC = new TextEncoder().encode('abc');
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('sha256Hex', () => {
  it('hashes empty input', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('hashes "abc"', () => {
    expect(sha256Hex(ABC)).toBe(ABC_SHA256);
  });
});

describe('verifySha256', () => {
  it('accepts bytes whose SHA-256 is the pinned one', () => {
    expect(() => {
      verifySha256(ABC, ABC_SHA256, 'sample.zip');
    }).not.toThrow();
  });

  it('refuses bytes whose SHA-256 differs, naming the archive', () => {
    expect(() => {
      verifySha256(ABC, 'deadbeef', 'sample.zip');
    }).toThrow(`checksum mismatch for sample.zip (expected deadbeef, got ${ABC_SHA256}).`);
  });
});
