import { eciesEncrypt, eciesDecrypt } from './ecies.js';
import { symmetricEncrypt, symmetricDecrypt } from './symmetric.js';
import {
  encodeForEncryption,
  decodeFromDecryption,
  encodeBinary,
  decodeBinary,
} from './message-codec.js';
import {
  generateContentKey,
  wrapContentKeyForEpoch,
  unwrapContentKeyForEpoch,
  type ContentKey,
  type WrappedContentKey,
} from './content-key.js';

/* ------------------------------------------------------------------ *
 * Generic single-blob ECIES helpers — used for encrypted bytea fields *
 * on non-message tables: conversations.title, projects.encryptedName, *
 * projects.encryptedDescription, users.custom_instructions_encrypted, *
 * etc. Messages use the wrap-once envelope helpers below.             *
 * ------------------------------------------------------------------ */

export function encryptTextForEpoch(epochPublicKey: Uint8Array, plaintext: string): Uint8Array {
  const payload = encodeForEncryption(plaintext);
  return eciesEncrypt(epochPublicKey, payload);
}

export function decryptTextFromEpoch(epochPrivateKey: Uint8Array, blob: Uint8Array): string {
  const payload = eciesDecrypt(epochPrivateKey, blob);
  return decodeFromDecryption(payload);
}

export interface MessageEnvelope {
  contentKey: ContentKey;
  wrappedContentKey: WrappedContentKey;
}

export function beginMessageEnvelope(epochPublicKey: Uint8Array): MessageEnvelope {
  const contentKey = generateContentKey();
  const wrappedContentKey = wrapContentKeyForEpoch(epochPublicKey, contentKey);
  return { contentKey, wrappedContentKey };
}

export function openMessageEnvelope(
  epochPrivateKey: Uint8Array,
  wrappedContentKey: WrappedContentKey
): ContentKey {
  return unwrapContentKeyForEpoch(epochPrivateKey, wrappedContentKey);
}

export function encryptTextWithContentKey(contentKey: ContentKey, plaintext: string): Uint8Array {
  const payload = encodeForEncryption(plaintext);
  return symmetricEncrypt(contentKey, payload);
}

export function decryptTextWithContentKey(contentKey: ContentKey, ciphertext: Uint8Array): string {
  const payload = symmetricDecrypt(contentKey, ciphertext);
  return decodeFromDecryption(payload);
}

export function encryptBinaryWithContentKey(
  contentKey: ContentKey,
  plaintext: Uint8Array
): Uint8Array {
  const payload = encodeBinary(plaintext);
  return symmetricEncrypt(contentKey, payload);
}

export function decryptBinaryWithContentKey(
  contentKey: ContentKey,
  ciphertext: Uint8Array
): Uint8Array {
  const payload = symmetricDecrypt(contentKey, ciphertext);
  return decodeBinary(payload);
}
