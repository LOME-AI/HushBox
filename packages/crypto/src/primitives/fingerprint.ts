import { hkdfSha256 } from './hash.js';
import type { DeriveLabel } from '../wrap/labels.js';

/** Width of a key fingerprint: the key id a sealed blob carries for the key that sealed it. */
export const FINGERPRINT_BYTES = 8;

const encoder = new TextEncoder();

/**
 * A short, non-secret identifier of a key: HKDF-SHA-256 over the key under a
 * per-consumer label, truncated to {@link FINGERPRINT_BYTES}. Derived rather
 * than assigned, so it can never disagree with the key it names.
 */
export function fingerprintOf(secret: Uint8Array, label: DeriveLabel): Uint8Array {
  return hkdfSha256({
    ikm: secret,
    salt: undefined,
    info: encoder.encode(label),
    length: FINGERPRINT_BYTES,
  });
}
