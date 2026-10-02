import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
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
import { SEAL_LABELS } from './labels.js';
import type { SymmetricKey } from '../primitives/keys.js';
import type { SealLabel } from './labels.js';

/**
 * Domain-separated symmetric sealing (HKDF-SHA-256 → XChaCha20-Poly1305) for
 * secrets whose opener already holds the key. The mandatory label feeds the
 * HKDF info, so seals made under different labels derive incompatible keys.
 *
 * The counterpart to `wrapSecretTo`: asymmetric when the writer does not hold
 * the opening secret, seal when it does. The two derive under disjoint info
 * prefixes, so identical label text still yields incompatible keys, and the
 * branded key classes make passing the wrong key class a compile error.
 */

const MIN_BLOB_BYTES = 1 + NONCE_BYTES + TAG_BYTES;
// Domain-separation constant baked into key derivation: once any real data
// is sealed under this HKDF info string, it can never change.
const SEAL_INFO_PREFIX = 'hushbox/seal:';

const encoder = new TextEncoder();

export type SealedSecret = Uint8Array & { readonly __brand: 'crypto.SealedSecret' };

function deriveSealKey(key: SymmetricKey, label: SealLabel): Uint8Array {
  // No salt: the input is already a uniform 32-byte key, and the label carries
  // all the separation. `wrapSecretTo` salts because its input is a raw ECDH
  // point that also has to bind the transcript.
  return hkdfSha256({
    ikm: key,
    salt: undefined,
    info: encoder.encode(`${SEAL_INFO_PREFIX}${label}`),
    length: 32,
  });
}

/**
 * Caller AAD is a single trailing variable-length field, so plain
 * concatenation stays unambiguous. Callers binding more than one field encode
 * them with `format.ts`'s length-prefixed field encoders first.
 */
function sealAad(aad: Uint8Array | undefined): Uint8Array {
  const version = Uint8Array.of(BLOB_FORMAT_VERSION);
  return aad === undefined ? version : concatBytes(version, aad);
}

/**
 * Which seal purposes put key material in the `plaintext` slot. The zeroed-key
 * guard below applies to those and only those: a zeroed *payload* would be
 * ordinary, while zeroed key material is always a defect. Keyed by the
 * registry's own names with a boolean value, so a new seal label does not
 * compile until it is classified here, and an entry cannot claim to classify
 * one label while naming another.
 */
const KEY_MATERIAL_SEALS: Record<keyof typeof SEAL_LABELS, boolean> = {
  // The slot holds the TOTP secret — the HMAC key every future code is minted
  // from. It arrives as UTF-8 base32 text rather than a raw buffer, so the
  // wiped-buffer path cannot reach it; the reachable degenerate case is an
  // empty secret, which encodes to zero bytes and anchors the account's 2FA to
  // nothing. A real base32 secret can never collide with the guard.
  totpSecretServer: true,
  // The slot holds a raw 32-byte ContentKey. A wiped or never-filled buffer
  // seals into a share link whose recovered key decrypts nothing, and the
  // sharer is told the share succeeded.
  contentKeyShare: true,
  // The slot holds the OPRF seed and AKE private key a user's every OPAQUE
  // login runs on. A wiped buffer seals into a row no password can ever open.
  opaqueServerMaterial: true,
};

// Each label is read back out of the registry under the name that classified
// it, so an entry cannot be classified as one label while naming another.
const KEY_MATERIAL_LABELS: ReadonlySet<SealLabel> = new Set(
  Object.entries(KEY_MATERIAL_SEALS)
    .filter(([, isKeyMaterial]) => isKeyMaterial)
    .map(([name]) => SEAL_LABELS[name as keyof typeof SEAL_LABELS])
);

export function sealWithKey(
  key: SymmetricKey,
  plaintext: Uint8Array,
  label: SealLabel,
  aad?: Uint8Array
): SealedSecret {
  // The key slot is guarded unconditionally, independent of the label: no
  // classification can make an all-zero seal key legal, and HKDF would happily
  // derive a usable-looking key from one. Matches `wrapSecretTo`, which
  // asserts its recipient key the same way.
  assertNotZeroed('the seal key', key);
  if (KEY_MATERIAL_LABELS.has(label)) {
    assertNotZeroed('the sealed key material', plaintext);
  }

  const sealKey = deriveSealKey(key, label);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertextAndTag = xchacha20poly1305(sealKey, nonce, sealAad(aad)).encrypt(plaintext);

  return concatBytes(Uint8Array.of(BLOB_FORMAT_VERSION), nonce, ciphertextAndTag) as SealedSecret;
}

export function openSealed(
  key: SymmetricKey,
  sealed: SealedSecret,
  label: SealLabel,
  aad?: Uint8Array
): Uint8Array {
  assertNotZeroed('the seal key', key);
  assertKnownVersion(sealed);
  if (sealed.length < MIN_BLOB_BYTES) {
    throw new MalformedBlobError(
      `Sealed secret too short: ${String(sealed.length)} bytes, minimum ${String(MIN_BLOB_BYTES)}`
    );
  }

  const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
  const ciphertextAndTag = sealed.subarray(1 + NONCE_BYTES);
  const sealKey = deriveSealKey(key, label);

  try {
    return xchacha20poly1305(sealKey, nonce, sealAad(aad)).decrypt(ciphertextAndTag);
  } catch {
    throw new DecryptionFailedError(
      'Sealed secret open failed: wrong key, wrong domain label, wrong AAD, or tampered blob'
    );
  }
}
