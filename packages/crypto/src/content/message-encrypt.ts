import { concatBytes } from '@noble/hashes/utils.js';
import { decodeCodecPayload, encodeCodecPayload } from '../primitives/compression.js';
import { u64Field, utf8Field } from '../primitives/format.js';
import {
  asAccountPrivateKey,
  asAccountPublicKey,
  asEpochPrivateKey,
  asEpochPublicKey,
} from '../primitives/keys.js';
import { wrapSecretTo, unwrapSecret } from '../wrap/wrap.js';
import { WRAP_LABELS } from '../wrap/labels.js';
import type { WrappedSecret } from '../wrap/wrap.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/*
 * Single-blob text wraps for encrypted bytea columns outside the message
 * tables. Each purpose carries its own domain-separation label, so a blob
 * written for one column can never be opened as another even when both are
 * encrypted to the same recipient key. Messages use the content envelope
 * (`envelope.ts`) instead.
 *
 * Both purposes also bind where the blob lives, because the label alone leaves
 * a blob replayable within its own purpose: a title would be movable between
 * conversations and rollable back to an earlier epoch of the same one (the
 * epoch a title was written under is a column of its own, so nothing else ties
 * the ciphertext to the epoch it claims), and instructions would be movable
 * between accounts.
 */

/** The conversation and epoch a title's ciphertext is bound to. */
interface TitleLocation {
  readonly conversationId: string;
  readonly epochNumber: number;
}

function titleAad(location: TitleLocation): Uint8Array {
  return concatBytes(
    utf8Field(location.conversationId),
    u64Field(location.epochNumber, 'epochNumber')
  );
}

function instructionsAad(userId: string): Uint8Array {
  return utf8Field(userId);
}

export function encryptTextForEpoch(
  epochPublicKey: Uint8Array,
  plaintext: string,
  location: TitleLocation
): Uint8Array {
  return wrapSecretTo(
    asEpochPublicKey(epochPublicKey),
    encodeCodecPayload(encoder.encode(plaintext), 'auto'),
    WRAP_LABELS.conversationTitleEpoch,
    titleAad(location)
  );
}

export function decryptTextFromEpoch(
  epochPrivateKey: Uint8Array,
  blob: Uint8Array,
  location: TitleLocation
): string {
  const payload = unwrapSecret(
    asEpochPrivateKey(epochPrivateKey),
    blob as WrappedSecret,
    WRAP_LABELS.conversationTitleEpoch,
    titleAad(location)
  );
  return decoder.decode(decodeCodecPayload(payload));
}

export function encryptCustomInstructions(
  accountPublicKey: Uint8Array,
  plaintext: string,
  userId: string
): Uint8Array {
  return wrapSecretTo(
    asAccountPublicKey(accountPublicKey),
    encodeCodecPayload(encoder.encode(plaintext), 'auto'),
    WRAP_LABELS.customInstructionsAccount,
    instructionsAad(userId)
  );
}

export function decryptCustomInstructions(
  accountPrivateKey: Uint8Array,
  blob: Uint8Array,
  userId: string
): string {
  const payload = unwrapSecret(
    asAccountPrivateKey(accountPrivateKey),
    blob as WrappedSecret,
    WRAP_LABELS.customInstructionsAccount,
    instructionsAad(userId)
  );
  return decoder.decode(decodeCodecPayload(payload));
}
