import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { concatBytes, randomBytes } from '@noble/hashes/utils.js';
import { DecryptionFailedError, MalformedBlobError } from '../errors.js';
import {
  BLOB_FORMAT_VERSION,
  NONCE_BYTES,
  TAG_BYTES,
  assertKnownVersion,
} from '../primitives/format.js';
import { hkdfSha256 } from '../primitives/hash.js';
import { assertNotZeroed } from '../primitives/keys.js';
import { WRAP_LABELS } from './labels.js';
import type { PrivateKey, PublicKey } from '../primitives/keys.js';
import type { WrapLabel } from './labels.js';

/**
 * Domain-separated asymmetric secret wrapping (ECIES: ephemeral X25519 →
 * HKDF-SHA-256 → XChaCha20-Poly1305). The mandatory label feeds the HKDF
 * info, so wraps made under different labels derive incompatible keys: a
 * blob wrapped for one purpose can never be unwrapped in another context,
 * even with the same recipient key material.
 *
 * The label separates purposes; the optional context AAD separates instances
 * of one purpose. A caller whose blob has a location (which conversation,
 * which epoch, whose account) binds that location so a blob valid in one
 * place fails authentication when a hostile server serves it in another.
 */

const EPHEMERAL_PUB_BYTES = 32;
const HEADER_BYTES = 1 + EPHEMERAL_PUB_BYTES + NONCE_BYTES;
const MIN_BLOB_BYTES = HEADER_BYTES + TAG_BYTES;
// Domain-separation constant baked into key derivation: once any real data
// is encrypted under this HKDF info string, it can never change.
const WRAP_INFO_PREFIX = 'hushbox/wrap:';
const EMPTY_CONTEXT = new Uint8Array(0);

const encoder = new TextEncoder();

export type WrappedSecret = Uint8Array & { readonly __brand: 'crypto.WrappedSecret' };

function deriveWrapKey(
  sharedPoint: Uint8Array,
  ephemeralPub: Uint8Array,
  recipientPub: Uint8Array,
  label: WrapLabel
): Uint8Array {
  return hkdfSha256({
    ikm: sharedPoint,
    salt: concatBytes(ephemeralPub, recipientPub),
    info: encoder.encode(`${WRAP_INFO_PREFIX}${label}`),
    length: 32,
  });
}

/**
 * The version byte is always bound. Context bytes append to it, so omitting
 * them yields exactly the version-only AAD every context-free wrap uses.
 * Callers pass fields already length-prefixed by `format.ts` — raw
 * concatenation would make the binding ambiguous.
 */
function wrapAad(contextAad: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(BLOB_FORMAT_VERSION), contextAad);
}

/**
 * Which wrap purposes put key material in the `secret` slot. The zeroed-key
 * guard below applies to those and only those: a zeroed *payload* is ordinary
 * — an untitled conversation encodes to a lone zero codec flag — while a
 * zeroed key is always a defect. Keyed by the registry's own names with a
 * boolean value, so a new label does not compile until it is classified here,
 * and an entry cannot claim to classify one label while naming another.
 */
const KEY_MATERIAL_WRAPS: Record<keyof typeof WRAP_LABELS, boolean> = {
  accountKeyPassword: true,
  accountKeyRecovery: true,
  epochKeyMember: true,
  epochKeyChainLink: true,
  contentKeyEpoch: true,
  // The reset nonce is the secret the phrase holder must return, so an
  // all-zero one would make the proof forgeable by anyone.
  resetChallengeRecovery: true,
  conversationTitleEpoch: false,
  customInstructionsAccount: false,
};

// Each label is read back out of the registry under the name that classified
// it, so an entry cannot be classified as one label while naming another.
const KEY_MATERIAL_LABELS: ReadonlySet<WrapLabel> = new Set(
  Object.entries(KEY_MATERIAL_WRAPS)
    .filter(([, isKeyMaterial]) => isKeyMaterial)
    .map(([name]) => WRAP_LABELS[name as keyof typeof WRAP_LABELS])
);

export function wrapSecretTo(
  recipientPublicKey: PublicKey,
  secret: Uint8Array,
  label: WrapLabel,
  contextAad: Uint8Array = EMPTY_CONTEXT
): WrappedSecret {
  if (KEY_MATERIAL_LABELS.has(label)) {
    assertNotZeroed('the wrapped secret', secret);
  }
  // The curve already rejects the all-zero recipient (the shared secret would
  // be zero) but as an untyped library error; asserting it here makes the
  // failure this package's own typed one on both halves.
  assertNotZeroed('the recipient public key', recipientPublicKey);

  const ephemeral = x25519.keygen();
  const sharedPoint = x25519.getSharedSecret(ephemeral.secretKey, recipientPublicKey);
  const key = deriveWrapKey(sharedPoint, ephemeral.publicKey, recipientPublicKey, label);

  const nonce = randomBytes(NONCE_BYTES);
  const aad = wrapAad(contextAad);
  const ciphertextAndTag = xchacha20poly1305(key, nonce, aad).encrypt(secret);

  return concatBytes(
    Uint8Array.of(BLOB_FORMAT_VERSION),
    ephemeral.publicKey,
    nonce,
    ciphertextAndTag
  ) as WrappedSecret;
}

export function unwrapSecret(
  recipientPrivateKey: PrivateKey,
  wrapped: WrappedSecret,
  label: WrapLabel,
  contextAad: Uint8Array = EMPTY_CONTEXT
): Uint8Array {
  // An all-zero scalar clamps to a valid one, so the ECDH below succeeds on the
  // wrong shared secret and a zeroed caller buffer reads as a decryption failure
  // — blaming the blob, not the buffer. Must stay outside the try, which would
  // catch this and restore exactly that misdiagnosis.
  assertNotZeroed('the recipient private key', recipientPrivateKey);
  assertKnownVersion(wrapped);
  if (wrapped.length < MIN_BLOB_BYTES) {
    throw new MalformedBlobError(
      `Wrapped secret too short: ${String(wrapped.length)} bytes, minimum ${String(MIN_BLOB_BYTES)}`
    );
  }

  const ephemeralPub = wrapped.subarray(1, 1 + EPHEMERAL_PUB_BYTES);
  const nonce = wrapped.subarray(1 + EPHEMERAL_PUB_BYTES, HEADER_BYTES);
  const ciphertextAndTag = wrapped.subarray(HEADER_BYTES);

  const aad = wrapAad(contextAad);
  // The ECDH must sit inside the typed-error boundary: noble rejects an
  // all-zero or low-order ephemeral point by throwing from getSharedSecret
  // (the shared secret would be all zeros). A forged point in a stored blob
  // is adversarial input, so it surfaces as DecryptionFailedError — the same
  // typed failure as any other tampered blob — never as a raw Error.
  try {
    const recipientPub = x25519.getPublicKey(recipientPrivateKey);
    const sharedPoint = x25519.getSharedSecret(recipientPrivateKey, ephemeralPub);
    const key = deriveWrapKey(sharedPoint, ephemeralPub, recipientPub, label);
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertextAndTag);
  } catch {
    throw new DecryptionFailedError(
      'Secret unwrap failed: wrong recipient key, wrong domain label, invalid ephemeral point, or tampered blob'
    );
  }
}
