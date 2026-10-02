import { concatBytes } from '@noble/hashes/utils.js';
import { constantTimeCompare } from '../primitives/constant-time.js';
import { InvalidKeyError, InvalidParameterError } from '../errors.js';
import { bytesField, utf8Field } from '../primitives/format.js';
import { hkdfSha256, sha256Hash } from '../primitives/hash.js';
import { unwrapSecret, wrapSecretTo } from '../wrap/wrap.js';
import { DERIVE_LABELS, WRAP_LABELS } from '../wrap/labels.js';
import type { WrappingPrivateKey, WrappingPublicKey } from '../primitives/keys.js';
import type { WrappedSecret } from '../wrap/wrap.js';

export const RESET_CHALLENGE_NONCE_BYTES = 32;
export const RESET_PROOF_BYTES = 32;

const encoder = new TextEncoder();

/** The reset request the proof commits to; every field is bound, none is optional. */
interface ResetProofPayload {
  readonly recoverySessionId: string;
  readonly canonicalIdentifier: string;
  readonly newRegistrationRecord: Uint8Array;
  readonly newPasswordWrappedPrivateKey: string;
}

/**
 * Seals a single-use reset nonce to the account's recovery public key: only the
 * holder of the recovery phrase can derive the private half and read it back.
 *
 * A low-order recipient key makes the X25519 shared secret zero, which
 * `@noble/curves` reports by throwing (the all-zero key is refused earlier, by
 * the wrap's own typed guard). The recipient key here comes from a stored
 * column, so that is adversarial input on a public route and must surface as a
 * typed error rather than an escaping raw throw.
 */
export function sealResetChallenge(
  recoveryPublicKey: WrappingPublicKey,
  nonce: Uint8Array
): WrappedSecret {
  if (nonce.length !== RESET_CHALLENGE_NONCE_BYTES) {
    throw new InvalidParameterError(
      `Reset challenge nonce must be ${String(RESET_CHALLENGE_NONCE_BYTES)} bytes, ` +
        `got ${String(nonce.length)}`
    );
  }
  try {
    return wrapSecretTo(recoveryPublicKey, nonce, WRAP_LABELS.resetChallengeRecovery);
  } catch (error) {
    // The wrap raises its own typed error for a zeroed buffer on either half,
    // and that message names which half. Only the curve's untyped throw needs
    // translating; blanket-translating would report a zeroed nonce as a bad
    // recovery key.
    if (error instanceof InvalidKeyError) {
      throw error;
    }
    throw new InvalidKeyError('Recovery public key is not a usable X25519 point');
  }
}

/**
 * Proves knowledge of the challenge nonce for exactly one reset request.
 *
 * Every field is length-prefixed before hashing, so no two distinct requests
 * share a preimage: without the prefixes, moving a byte across a field boundary
 * would let a rewritten request reuse a captured proof.
 */
export function deriveResetProof(nonce: Uint8Array, payload: ResetProofPayload): Uint8Array {
  const canonical = concatBytes(
    utf8Field(payload.recoverySessionId),
    utf8Field(payload.canonicalIdentifier),
    bytesField(payload.newRegistrationRecord),
    utf8Field(payload.newPasswordWrappedPrivateKey)
  );
  return hkdfSha256({
    ikm: nonce,
    salt: undefined,
    info: concatBytes(encoder.encode(DERIVE_LABELS.recoveryResetProof), sha256Hash(canonical)),
    length: RESET_PROOF_BYTES,
  });
}

/**
 * Derives the expected proof and compares it to the caller's in one step, so
 * the two halves of the check cannot be separated and only half performed.
 * Equal-length proofs are compared in constant time, and the comparison is
 * length-tolerant: a wrong-length proof is simply false, so a caller may hand
 * decoded client bytes straight in without a length check of its own.
 */
export function verifyResetProof(
  nonce: Uint8Array,
  payload: ResetProofPayload,
  providedProof: Uint8Array
): boolean {
  return constantTimeCompare(deriveResetProof(nonce, payload), providedProof);
}

/**
 * Recovers the nonce from a sealed challenge: any key but the one it was sealed
 * to throws, under whichever class `unwrapSecret` assigns it — a defective key
 * buffer is the caller's own `InvalidKeyError`, a merely wrong key a
 * `DecryptionFailedError`.
 */
export function openResetChallenge(
  recoveryPrivateKey: WrappingPrivateKey,
  sealedChallenge: Uint8Array
): Uint8Array {
  return unwrapSecret(
    recoveryPrivateKey,
    sealedChallenge as WrappedSecret,
    WRAP_LABELS.resetChallengeRecovery
  );
}
