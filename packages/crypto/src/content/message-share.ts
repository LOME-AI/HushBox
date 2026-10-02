import { randomBytes } from '@noble/hashes/utils.js';
import { KEY_BYTES, asContentKey, asShareSecret } from '../primitives/keys.js';
import { openSealed, sealWithKey } from '../wrap/seal.js';
import { SEAL_LABELS } from '../wrap/labels.js';
import type { ContentKey, ShareSecret } from '../primitives/keys.js';
import type { SealedSecret } from '../wrap/seal.js';

/**
 * A public share re-seals the message's existing content key under a fresh
 * per-share secret; the ciphertext and the media bytes are never touched. The
 * share secret rides the URL fragment, so it never reaches the server, and the
 * seal's domain label keeps this blob from opening as any other purpose.
 */

export interface CreateShareResult {
  shareSecret: ShareSecret;
  wrappedShareKey: SealedSecret;
}

export function createShare(contentKey: ContentKey): CreateShareResult {
  const shareSecret = asShareSecret(randomBytes(KEY_BYTES));
  const wrappedShareKey = sealWithKey(shareSecret, contentKey, SEAL_LABELS.contentKeyShare);
  return { shareSecret, wrappedShareKey };
}

export function openShare(shareSecret: ShareSecret, wrappedShareKey: SealedSecret): ContentKey {
  return asContentKey(openSealed(shareSecret, wrappedShareKey, SEAL_LABELS.contentKeyShare));
}
