import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concatBytes, randomBytes } from '@noble/hashes/utils.js';
import { decodeCodecPayload, encodeCodecPayload } from '../primitives/compression.js';
import { DecryptionFailedError, MalformedBlobError } from '../errors.js';
import {
  BLOB_FORMAT_VERSION,
  NONCE_BYTES,
  TAG_BYTES,
  assertKnownVersion,
  bytesField,
  u64Field,
  utf8Field,
} from '../primitives/format.js';
import { assertNotZeroed } from '../primitives/keys.js';
import type { CompressionPolicy } from '../primitives/compression.js';
import type { ContentKey } from '../primitives/keys.js';
import type { WrappedSecret } from './wrap.js';

/**
 * Content envelope: XChaCha20-Poly1305 under a per-content key, with the
 * full location tuple (version, conversationId, messageId, contentItemId,
 * position, epochNumber, senderId) AND the wrapped content key bound as AAD.
 *
 * The AAD is location-binding, not authorship: anyone holding the epoch
 * public key (including the server) can mint valid ciphertext, but a valid
 * ciphertext spliced into any other location — or paired with any other key
 * wrap — fails authentication instead of decrypting.
 *
 * Compress-then-encrypt is safe in this scheme: each envelope compresses a
 * single source's content in its own stream, so there is no cross-source
 * co-compression and no CRIME-shaped length leak (padding optional).
 *
 * Every plaintext is framed `[codec flag][data]` before encryption, uniformly
 * for text and media. Whether the data is deflated is per-writer policy
 * (`CompressionPolicy`), declared by every writer.
 */

const MIN_BLOB_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

/**
 * What an envelope encrypts. The policy is a required field rather than a
 * default over bare bytes: an inherited `raw` is a policy a writer of
 * compressible content can miss silently, and every writer already knows which
 * kind of content it holds.
 */
export interface EnvelopeContent {
  readonly plaintext: Uint8Array;
  readonly compression: CompressionPolicy;
}

export interface ContentLocation {
  conversationId: string;
  messageId: string;
  contentItemId: string;
  position: number;
  epochNumber: number;
  senderId: string;
}

function locationAad(wrappedContentKey: WrappedSecret, location: ContentLocation): Uint8Array {
  return concatBytes(
    Uint8Array.of(BLOB_FORMAT_VERSION),
    utf8Field(location.conversationId),
    utf8Field(location.messageId),
    utf8Field(location.contentItemId),
    u64Field(location.position, 'position'),
    u64Field(location.epochNumber, 'epochNumber'),
    utf8Field(location.senderId),
    bytesField(wrappedContentKey)
  );
}

export function encryptContentEnvelope(
  contentKey: ContentKey,
  wrappedContentKey: WrappedSecret,
  location: ContentLocation,
  content: EnvelopeContent
): Uint8Array {
  // The key slot only: empty content frames to a lone zero codec flag, so a
  // zeroed *payload* is legal here, while a zeroed content key encrypts happily
  // into a blob that opens to nothing and no later layer can tell.
  assertNotZeroed('the content key', contentKey);

  const aad = locationAad(wrappedContentKey, location);
  const nonce = randomBytes(NONCE_BYTES);
  const payload = encodeCodecPayload(content.plaintext, content.compression);
  const ciphertextAndTag = xchacha20poly1305(contentKey, nonce, aad).encrypt(payload);

  return concatBytes(Uint8Array.of(BLOB_FORMAT_VERSION), nonce, ciphertextAndTag);
}

export function decryptContentEnvelope(
  contentKey: ContentKey,
  wrappedContentKey: WrappedSecret,
  location: ContentLocation,
  blob: Uint8Array
): Uint8Array {
  // Ahead of the blob checks and outside the try below: a zeroed key otherwise
  // clears both and surfaces as a decryption failure, blaming the stored blob
  // for a defect in the caller's own buffer.
  assertNotZeroed('the content key', contentKey);
  assertKnownVersion(blob);
  if (blob.length < MIN_BLOB_BYTES) {
    throw new MalformedBlobError(
      `Envelope too short: ${String(blob.length)} bytes, minimum ${String(MIN_BLOB_BYTES)}`
    );
  }

  const aad = locationAad(wrappedContentKey, location);
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const ciphertextAndTag = blob.subarray(1 + NONCE_BYTES);

  let payload: Uint8Array;
  try {
    payload = xchacha20poly1305(contentKey, nonce, aad).decrypt(ciphertextAndTag);
  } catch {
    throw new DecryptionFailedError(
      'Content envelope decryption failed: wrong key, tampered blob, or location mismatch'
    );
  }
  // Decoding stays outside the catch: a bad codec flag or an over-cap inflate is
  // its own typed failure, never laundered into "decryption failed".
  return decodeCodecPayload(payload);
}
