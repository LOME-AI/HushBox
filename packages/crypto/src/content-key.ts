import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { eciesEncrypt, eciesDecrypt } from './ecies.js';
import { symmetricEncrypt, symmetricDecrypt } from './symmetric.js';

export const CONTENT_KEY_LENGTH = 32;

export const SHARE_WRAP_INFO = 'share-wrap-v1';
const SHARE_WRAP_INFO_BYTES = new TextEncoder().encode(SHARE_WRAP_INFO);

/**
 * Branded raw 32-byte content key — symmetric, never persisted, never sent
 * across the network in unwrapped form. Branding prevents accidentally
 * passing a wrapped (ciphertext) key into a function expecting the raw key.
 */
export type ContentKey = Uint8Array & { readonly __brand: 'ContentKey' };

/**
 * Branded wrapped content key — the ciphertext form persisted to the DB
 * (`messages.wrapped_content_key`) or sent over the wire. Decrypts to a
 * `ContentKey` via `unwrapContentKeyForEpoch` / `unwrapContentKeyForShare`.
 */
export type WrappedContentKey = Uint8Array & { readonly __brand: 'WrappedContentKey' };

export function generateContentKey(): ContentKey {
  return randomBytes(CONTENT_KEY_LENGTH) as ContentKey;
}

export function wrapContentKeyForEpoch(
  epochPublicKey: Uint8Array,
  contentKey: ContentKey
): WrappedContentKey {
  return eciesEncrypt(epochPublicKey, contentKey) as WrappedContentKey;
}

export function unwrapContentKeyForEpoch(
  epochPrivateKey: Uint8Array,
  wrapped: WrappedContentKey
): ContentKey {
  return eciesDecrypt(epochPrivateKey, wrapped) as ContentKey;
}

export function wrapContentKeyForShare(
  shareSecret: Uint8Array,
  contentKey: ContentKey
): WrappedContentKey {
  const key = hkdf(sha256, shareSecret, undefined, SHARE_WRAP_INFO_BYTES, 32);
  return symmetricEncrypt(key, contentKey) as WrappedContentKey;
}

export function unwrapContentKeyForShare(
  shareSecret: Uint8Array,
  wrapped: WrappedContentKey
): ContentKey {
  const key = hkdf(sha256, shareSecret, undefined, SHARE_WRAP_INFO_BYTES, 32);
  return symmetricDecrypt(key, wrapped) as ContentKey;
}
