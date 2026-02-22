import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { symmetricEncrypt, symmetricDecrypt } from './symmetric.js';
import { encodeForEncryption, decodeFromDecryption } from './message-codec.js';

export const SHARE_INFO = 'share-msg-v1';
const SHARE_INFO_BYTES = new TextEncoder().encode(SHARE_INFO);

export interface CreateMessageShareResult {
  shareSecret: Uint8Array;
  shareBlob: Uint8Array;
}

export function createMessageShare(plaintext: string): CreateMessageShareResult {
  const shareSecret = randomBytes(32);
  const key = hkdf(sha256, shareSecret, undefined, SHARE_INFO_BYTES, 32);
  const payload = encodeForEncryption(plaintext);
  const shareBlob = symmetricEncrypt(key, payload);

  return { shareSecret, shareBlob };
}

export function decryptMessageShare(secret: Uint8Array, blob: Uint8Array): string {
  const key = hkdf(sha256, secret, undefined, SHARE_INFO_BYTES, 32);
  const payload = symmetricDecrypt(key, blob);
  return decodeFromDecryption(payload);
}
