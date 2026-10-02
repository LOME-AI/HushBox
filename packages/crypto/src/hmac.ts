import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();

/**
 * HMAC-SHA-256 of a UTF-8 message under a UTF-8 key, as lowercase hex.
 *
 * Synchronous on purpose: WebCrypto's HMAC answers a promise, and a caller
 * that derives a value inside a synchronous encoder would otherwise have to
 * turn every one of its own callers async to key it.
 */
export function hmacSha256Hex(key: string, message: string): string {
  return bytesToHex(hmac(sha256, encoder.encode(key), encoder.encode(message)));
}
