import { describe, it, expect } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils.js';
import { FINGERPRINT_BYTES, fingerprintOf } from './fingerprint.js';
import { DERIVE_LABELS } from '../wrap/labels.js';

const SECRET = hexToBytes('b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0');
const OTHER_SECRET = hexToBytes('d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0');

describe('fingerprintOf', () => {
  it('is eight bytes wide', () => {
    const fingerprint = fingerprintOf(SECRET, DERIVE_LABELS.opaqueKekFingerprint);

    expect(fingerprint).toBeInstanceOf(Uint8Array);
    expect(fingerprint).toHaveLength(FINGERPRINT_BYTES);
    expect(FINGERPRINT_BYTES).toBe(8);
  });

  it('is deterministic for one secret under one label', () => {
    const first = fingerprintOf(SECRET, DERIVE_LABELS.opaqueKekFingerprint);
    const second = fingerprintOf(SECRET, DERIVE_LABELS.opaqueKekFingerprint);

    expect(first).toEqual(second);
  });

  it('differs across labels for one secret', () => {
    const asKek = fingerprintOf(SECRET, DERIVE_LABELS.opaqueKekFingerprint);
    const asTotpKey = fingerprintOf(SECRET, DERIVE_LABELS.totpKeyFingerprint);

    expect(asKek).not.toEqual(asTotpKey);
  });

  it('differs across secrets under one label', () => {
    const first = fingerprintOf(SECRET, DERIVE_LABELS.opaqueKekFingerprint);
    const second = fingerprintOf(OTHER_SECRET, DERIVE_LABELS.opaqueKekFingerprint);

    expect(first).not.toEqual(second);
  });
});
