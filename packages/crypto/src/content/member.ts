import { epochWrapAad } from './epoch-lifecycle.js';
import { asAccountPublicKey } from '../primitives/keys.js';
import { wrapSecretTo } from '../wrap/wrap.js';
import { WRAP_LABELS } from '../wrap/labels.js';
import type { EpochLocation } from './epoch-lifecycle.js';

export function wrapEpochKeyForNewMember(
  epochPrivateKey: Uint8Array,
  memberPublicKey: Uint8Array,
  location: EpochLocation
): Uint8Array {
  return wrapSecretTo(
    asAccountPublicKey(memberPublicKey),
    epochPrivateKey,
    WRAP_LABELS.epochKeyMember,
    epochWrapAad(location)
  );
}
