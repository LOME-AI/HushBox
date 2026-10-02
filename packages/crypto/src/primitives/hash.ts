import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { bytesToHex as nobleBytesToHex } from '@noble/hashes/utils.js';

export function sha256Hash(data: Uint8Array): Uint8Array {
  return sha256(data);
}

/**
 * Named arguments, not positional: `salt` and `info` are both optional byte
 * labels that derive different keys, so a silent swap between them would
 * re-derive every stored artifact. Both are required properties — a caller
 * that uses only one still has to say which.
 */
export function hkdfSha256(args: {
  ikm: Uint8Array;
  salt: Uint8Array | undefined;
  info: Uint8Array | undefined;
  length: number;
}): Uint8Array {
  return hkdf(sha256, args.ikm, args.salt, args.info, args.length);
}

export function bytesToHex(data: Uint8Array): string {
  return nobleBytesToHex(data);
}
