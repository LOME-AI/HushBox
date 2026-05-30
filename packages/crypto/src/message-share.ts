import { randomBytes } from '@noble/hashes/utils.js';
import {
  wrapContentKeyForShare,
  unwrapContentKeyForShare,
  type ContentKey,
  type WrappedContentKey,
} from './content-key.js';

export interface CreateShareResult {
  shareSecret: Uint8Array;
  wrappedShareKey: WrappedContentKey;
}

export function createShare(contentKey: ContentKey): CreateShareResult {
  const shareSecret = randomBytes(32);
  const wrappedShareKey = wrapContentKeyForShare(shareSecret, contentKey);
  return { shareSecret, wrappedShareKey };
}

export function openShare(shareSecret: Uint8Array, wrappedShareKey: WrappedContentKey): ContentKey {
  return unwrapContentKeyForShare(shareSecret, wrappedShareKey);
}
