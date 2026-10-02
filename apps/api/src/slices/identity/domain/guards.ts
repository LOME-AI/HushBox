import {
  KEY_BYTES,
  RESET_CHALLENGE_NONCE_BYTES,
  asWrappingPublicKey,
  generateAccountKeyPair,
  rewrapAccountKeyForPasswordChange,
  sealResetChallenge,
} from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { Result, err, ok } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { IdentityUserRecord } from '../ports/index.js';

/** An authenticated principal whose user row vanished is a defect, never a Result. */
export function requireUser(user: IdentityUserRecord | null): IdentityUserRecord {
  if (user === null) {
    throw new Error('identity: authenticated principal resolved to no user row');
  }
  return user;
}

/** Decodes a client-supplied base64 field; malformed input is a validation Result. */
export function decodeBase64Field(value: string, field: string): Result<Uint8Array, DomainError> {
  return Result.fromThrowable(
    () => fromBase64(value),
    (cause) => validationError(`malformed base64 ${field}`, cause)
  )();
}

/**
 * A real stored wrapped key is an ECIES wrap of the 32-byte X25519 account
 * private key: one fixed version byte, then wrap-specific bytes (ephemeral
 * public key + nonce + ciphertext + tag). This reference wrap measures both
 * facts — total length and the version byte — against the crypto package
 * itself, so a blob-format change can never reopen the gap.
 *
 * Computed lazily and memoized: the ECIES wrap draws CSPRNG bytes, which
 * workerd forbids at global eval — a module-scope wrap breaks worker boot.
 *
 * The wrapped key is real generated key material rather than a placeholder
 * constant because the wrap refuses an all-zero secret outright — a zeroed
 * buffer is the wiped-key defect it exists to catch. Only the blob's length
 * and version byte are read here, and neither depends on the key's bytes.
 */
let referenceWrappedKey: Uint8Array | undefined;

export function getReferenceWrappedKey(): Uint8Array {
  referenceWrappedKey ??= rewrapAccountKeyForPasswordChange(
    generateAccountKeyPair().privateKey,
    new Uint8Array(KEY_BYTES)
  );
  return referenceWrappedKey;
}

/**
 * The account's stored key material is its only copy, and nothing below this
 * point checks it: the column is a bare `bytea`. Wrong bytes accepted here are
 * either data the user can never decrypt again or a reset path that can never
 * run, so shape is a write-boundary condition rather than a read-time surprise.
 */
export function decodeWrappedKeyField(
  value: string,
  field: string
): Result<Uint8Array, DomainError> {
  const reference = getReferenceWrappedKey();
  return decodeBase64Field(value, field).andThen((bytes) =>
    bytes.length === reference.length && bytes[0] === reference[0]
      ? ok(bytes)
      : err(validationError(`malformed ${field}: not a wrapped key blob`))
  );
}

/** An X25519 public key is exactly one key length; nothing else is a recipient. */
export function decodePublicKeyField(
  value: string,
  field: string
): Result<Uint8Array, DomainError> {
  return decodeBase64Field(value, field).andThen((bytes) =>
    bytes.length === KEY_BYTES
      ? ok(bytes)
      : err(validationError(`malformed ${field}: not a ${String(KEY_BYTES)}-byte public key`))
  );
}

/**
 * The probe secret the usability seal consumes. Its value is irrelevant — the
 * wrap is discarded — so it is a constant rather than fresh randomness. It
 * must not be all zeros: the wrap refuses those as a zeroed-buffer defect.
 */
const RECIPIENT_PROBE_SECRET = new Uint8Array(RESET_CHALLENGE_NONCE_BYTES).fill(1);

/**
 * The recovery public key must additionally be a key the server can seal to:
 * `/reset/init` wraps the phrase challenge to it on a public, unauthenticated
 * route. A low-order or all-zero point is length-legal but makes the X25519
 * shared secret zero, which `@noble/curves` reports by throwing — so an
 * attacker who could store one would plant a permanent failure on the victim's
 * own reset path and a 500 on a public route.
 *
 * The check is the operation it guards, run once against a throwaway secret:
 * a separately maintained small-order table could drift from what the curve
 * actually refuses, and this cannot. The typed `InvalidKeyError` that
 * `sealResetChallenge` raises becomes a validation Result here, the way
 * malformed base64 does above.
 */
export function decodeRecoveryPublicKeyField(value: string): Result<Uint8Array, DomainError> {
  return decodePublicKeyField(value, 'recoveryPublicKey').andThen((bytes) =>
    Result.fromThrowable(
      () => sealResetChallenge(asWrappingPublicKey(bytes), RECIPIENT_PROBE_SECRET),
      (cause) =>
        validationError('malformed recoveryPublicKey: not a usable X25519 recipient', cause)
    )().map(() => bytes)
  );
}
