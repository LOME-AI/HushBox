import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { constantTimeCompare } from '../primitives/constant-time.js';
import { u64Field, utf8Field } from '../primitives/format.js';
import { asContentKey } from '../primitives/keys.js';
import { wrapSecretTo, unwrapSecret } from '../wrap/wrap.js';
import { DERIVE_LABELS, WRAP_LABELS } from '../wrap/labels.js';
import type { ContentKey, EpochPrivateKey, EpochPublicKey } from '../primitives/keys.js';
import type { WrappedSecret } from '../wrap/wrap.js';

export const EPOCH_CONFIRMATION_BYTES = 32;

const encoder = new TextEncoder();

/**
 * Keyed epoch confirmation: HKDF-SHA-256 over the epoch private key, bound
 * to the conversation and epoch number. Only holders of the epoch private
 * key can compute it — unlike a bare hash of the key, it is useless as a
 * public commitment oracle and cannot be replayed across conversations or
 * epochs.
 */
export function computeEpochConfirmation(
  epochPrivateKey: EpochPrivateKey,
  conversationId: string,
  epochNumber: number
): Uint8Array {
  const info = concatBytes(
    encoder.encode(DERIVE_LABELS.epochConfirmation),
    utf8Field(conversationId),
    u64Field(epochNumber, 'epochNumber')
  );
  return hkdf(sha256, epochPrivateKey, undefined, info, EPOCH_CONFIRMATION_BYTES);
}

export function verifyEpochConfirmation(
  epochPrivateKey: EpochPrivateKey,
  conversationId: string,
  epochNumber: number,
  expected: Uint8Array
): boolean {
  const computed = computeEpochConfirmation(epochPrivateKey, conversationId, epochNumber);
  return constantTimeCompare(computed, expected);
}

export function wrapContentKeyToEpoch(
  epochPublicKey: EpochPublicKey,
  contentKey: ContentKey
): WrappedSecret {
  return wrapSecretTo(epochPublicKey, contentKey, WRAP_LABELS.contentKeyEpoch);
}

export function unwrapContentKeyFromEpoch(
  epochPrivateKey: EpochPrivateKey,
  wrapped: WrappedSecret
): ContentKey {
  return asContentKey(unwrapSecret(epochPrivateKey, wrapped, WRAP_LABELS.contentKeyEpoch));
}
