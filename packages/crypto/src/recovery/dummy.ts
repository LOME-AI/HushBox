import { hkdfSha256 } from '../primitives/hash.js';
import { InvalidKeyError } from '../errors.js';
import { DERIVE_LABELS } from '../wrap/labels.js';

/**
 * The server's enumeration-decoy secret, branded so it can never be transposed
 * with the (also string-shaped) identifier argument of the derivation below.
 * The raw bytes are UTF-8 of the secret string; length is not fixed (unlike
 * the 32-byte key classes), only non-emptiness is asserted.
 */
type ServerSecret = Uint8Array & { readonly __brand: 'crypto.ServerSecret' };

export function asServerSecret(bytes: Uint8Array): ServerSecret {
  if (bytes.length === 0) {
    throw new InvalidKeyError('ServerSecret must be non-empty');
  }
  return bytes as ServerSecret;
}

const PUBLIC_KEY_BYTES = 32;

const encoder = new TextEncoder();

/**
 * Deterministic per-identifier dummy for unknown accounts on the public
 * recovery wrapped-key endpoint — the enumeration-safe / timing-safe defense.
 * Every distinguisher an attacker could read off the response must match a
 * real account's blob: same length, same leading version byte, a body that
 * looks like ciphertext (never a recognizable constant), and stability across
 * repeated queries. HKDF-SHA-256 over the server secret, domain-separated by
 * {@link DERIVE_LABELS.recoveryDummyWrappedKey} and bound to the canonical
 * identifier, gives all four at once — indistinguishable from ciphertext
 * without the server secret.
 *
 * `referenceWrappedKey` is a real account-key wrap from this package (a public,
 * format-defining blob — NOT secret): only its length and leading version
 * byte are read, so the dummy tracks the live blob format and a format change
 * can never reopen the gap. X25519 accepts any 32 bytes, so HKDF output is
 * valid for the key-shaped region — with one canonical-encoding correction:
 * a real ephemeral public key is a little-endian u-coordinate below 2^255−19,
 * so the top bit of its final byte (blob index 32) is ALWAYS clear, while
 * uniform HKDF output would set it half the time — a certainty-grade
 * non-existence oracle. The mask keeps the dummy inside the real key-space
 * (the residual non-canonical range above the prime is ~19/2^255 — negligible).
 */
export function deriveDummyRecoveryWrappedKey(
  serverSecret: ServerSecret,
  canonicalIdentifier: string,
  referenceWrappedKey: Uint8Array
): Uint8Array {
  const info = encoder.encode(`${DERIVE_LABELS.recoveryDummyWrappedKey}:${canonicalIdentifier}`);
  // Body index 31 is blob index 32 — the final ephemeral-key byte.
  const body = hkdfSha256({
    ikm: serverSecret,
    salt: new Uint8Array(0),
    info,
    length: referenceWrappedKey.length - 1,
  }).map((byte, index) => (index === 31 ? byte & 0x7f : byte));
  const blob = new Uint8Array(referenceWrappedKey.length);
  blob.set(referenceWrappedKey.subarray(0, 1), 0);
  blob.set(body, 1);
  return blob;
}

/**
 * Deterministic stand-in recipient for the reset challenge of an unknown
 * identifier — the same enumeration-safety contract as
 * {@link deriveDummyRecoveryWrappedKey}, one derivation over from it.
 *
 * The challenge for an unknown account is sealed to this key by the ordinary
 * wrap, so every byte an attacker can read off the response — length, version
 * byte, the wrap's own freshly generated ephemeral public key, ciphertext and
 * tag — is produced by the same code as a real account's. Nothing here is
 * canonicalized by hand, so the ephemeral-key bias the wrapped-key dummy has to
 * mask cannot arise: X25519 accepts any 32 bytes as a recipient, and this key
 * itself never leaves the server.
 */
export function deriveDummyRecoveryPublicKey(
  serverSecret: ServerSecret,
  canonicalIdentifier: string
): Uint8Array {
  return hkdfSha256({
    ikm: serverSecret,
    salt: new Uint8Array(0),
    info: encoder.encode(`${DERIVE_LABELS.recoveryDummyResetChallenge}:${canonicalIdentifier}`),
    length: PUBLIC_KEY_BYTES,
  });
}
