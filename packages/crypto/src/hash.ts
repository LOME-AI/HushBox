import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { bytesToHex as nobleBytesToHex } from '@noble/hashes/utils.js';

export function sha256Hash(data: Uint8Array): Uint8Array {
  return sha256(data);
}

export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | undefined,
  info: Uint8Array | undefined,
  length: number
): Uint8Array {
  return hkdf(sha256, ikm, salt, info, length);
}

export function bytesToHex(data: Uint8Array): string {
  return nobleBytesToHex(data);
}
