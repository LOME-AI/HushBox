import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { eciesEncrypt, eciesDecrypt } from './ecies.js';
import { symmetricEncrypt, symmetricDecrypt } from './symmetric.js';

export const CONTENT_KEY_LENGTH = 32;

export const SHARE_WRAP_INFO = 'share-wrap-v1';
const SHARE_WRAP_INFO_BYTES = new TextEncoder().encode(SHARE_WRAP_INFO);

export type ContentKey = Uint8Array;
export type WrappedContentKey = Uint8Array;

export function generateContentKey(): ContentKey {
  return randomBytes(CONTENT_KEY_LENGTH);
}

export function wrapContentKeyForEpoch(
  epochPublicKey: Uint8Array,
  contentKey: ContentKey
): WrappedContentKey {
  return eciesEncrypt(epochPublicKey, contentKey);
}

export function unwrapContentKeyForEpoch(
  epochPrivateKey: Uint8Array,
  wrapped: WrappedContentKey
): ContentKey {
  return eciesDecrypt(epochPrivateKey, wrapped);
}

export function wrapContentKeyForShare(
  shareSecret: Uint8Array,
  contentKey: ContentKey
): WrappedContentKey {
  const key = hkdf(sha256, shareSecret, undefined, SHARE_WRAP_INFO_BYTES, 32);
  return symmetricEncrypt(key, contentKey);
}

export function unwrapContentKeyForShare(
  shareSecret: Uint8Array,
  wrapped: WrappedContentKey
): ContentKey {
  const key = hkdf(sha256, shareSecret, undefined, SHARE_WRAP_INFO_BYTES, 32);
  return symmetricDecrypt(key, wrapped);
}
