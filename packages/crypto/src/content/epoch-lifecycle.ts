import { concatBytes } from '@noble/hashes/utils.js';
import { computeEpochConfirmation, verifyEpochConfirmation } from './epoch.js';
import {
  DecryptionFailedError,
  InvalidParameterError,
  MalformedBlobError,
  UnknownBlobVersionError,
} from '../errors.js';
import { constantTimeCompare } from '../primitives/constant-time.js';
import { bytesField, u64Field, utf8Field } from '../primitives/format.js';
import {
  asAccountPrivateKey,
  asAccountPublicKey,
  asEpochPrivateKey,
  asEpochPublicKey,
  assertNotZeroed,
  generateKeyPair,
  getPublicKeyFromPrivate,
} from '../primitives/keys.js';
import { wrapSecretTo, unwrapSecret } from '../wrap/wrap.js';
import { WRAP_LABELS } from '../wrap/labels.js';
import type { WrappedSecret } from '../wrap/wrap.js';

/*
 * Every epoch wrap and chain link binds where it lives, so a hostile server
 * cannot serve one conversation's or one epoch's blob as another's. The label
 * separates the two purposes; these tuples separate instances of one purpose.
 */

/** Where an epoch key wrapped to a principal belongs. */
export interface EpochLocation {
  readonly conversationId: string;
  readonly epochNumber: number;
  readonly epochPublicKey: Uint8Array;
}

/** An epoch's published record: its location plus its stored confirmation. */
export interface EpochCommitment extends EpochLocation {
  readonly confirmationHash: Uint8Array;
}

/** A chain link carried by the newer epoch, opening to the older epoch's key. */
interface ChainLinkBinding {
  readonly conversationId: string;
  readonly newerEpochNumber: number;
  readonly older: Omit<EpochCommitment, 'conversationId'>;
}

export type EpochKeyFailure =
  | 'unwrap-failed'
  | 'invalid-key'
  | 'public-key-mismatch'
  | 'confirmation-mismatch';

export type OpenedEpochKey =
  | { readonly ok: true; readonly key: Uint8Array }
  | { readonly ok: false; readonly reason: EpochKeyFailure };

interface EpochMemberWrap {
  memberPublicKey: Uint8Array;
  wrap: Uint8Array;
}

interface CreateEpochResult {
  epochPublicKey: Uint8Array;
  epochPrivateKey: Uint8Array;
  confirmationHash: Uint8Array;
  memberWraps: EpochMemberWrap[];
}

interface EpochRotationResult extends CreateEpochResult {
  chainLink: Uint8Array;
}

interface EpochRotationInput {
  readonly predecessor: {
    readonly epochNumber: number;
    readonly privateKey: Uint8Array;
    readonly publicKey: Uint8Array;
  };
  readonly memberPublicKeys: Uint8Array[];
  readonly conversationId: string;
  readonly epochNumber: number;
}

/** The context bound into every member, link and full-history wrap. */
export function epochWrapAad(location: EpochLocation): Uint8Array {
  return concatBytes(
    utf8Field(location.conversationId),
    u64Field(location.epochNumber, 'epochNumber'),
    bytesField(location.epochPublicKey)
  );
}

/**
 * The newer epoch's public key is the recipient, already bound through the
 * wrap's key derivation, so the tuple carries only the older side.
 */
function chainLinkAad(binding: {
  conversationId: string;
  newerEpochNumber: number;
  olderEpochNumber: number;
  olderEpochPublicKey: Uint8Array;
}): Uint8Array {
  return concatBytes(
    utf8Field(binding.conversationId),
    u64Field(binding.newerEpochNumber, 'newerEpochNumber'),
    u64Field(binding.olderEpochNumber, 'olderEpochNumber'),
    bytesField(binding.olderEpochPublicKey)
  );
}

function wrapForMembers(
  epochPrivateKey: Uint8Array,
  memberPublicKeys: Uint8Array[],
  location: EpochLocation
): EpochMemberWrap[] {
  const aad = epochWrapAad(location);
  return memberPublicKeys.map((memberPublicKey) => ({
    memberPublicKey,
    wrap: wrapSecretTo(
      asAccountPublicKey(memberPublicKey),
      epochPrivateKey,
      WRAP_LABELS.epochKeyMember,
      aad
    ),
  }));
}

function newEpoch(
  memberPublicKeys: Uint8Array[],
  conversationId: string,
  epochNumber: number
): CreateEpochResult {
  const epoch = generateKeyPair();
  const confirmationHash = computeEpochConfirmation(
    asEpochPrivateKey(epoch.privateKey),
    conversationId,
    epochNumber
  );
  const memberWraps = wrapForMembers(epoch.privateKey, memberPublicKeys, {
    conversationId,
    epochNumber,
    epochPublicKey: epoch.publicKey,
  });

  return {
    epochPublicKey: epoch.publicKey,
    epochPrivateKey: epoch.privateKey,
    confirmationHash,
    memberWraps,
  };
}

export function createFirstEpoch(
  memberPublicKeys: Uint8Array[],
  conversationId: string,
  epochNumber: number
): CreateEpochResult {
  return newEpoch(memberPublicKeys, conversationId, epochNumber);
}

export function performEpochRotation(input: EpochRotationInput): EpochRotationResult {
  const { predecessor, conversationId, epochNumber } = input;
  if (predecessor.epochNumber >= epochNumber) {
    throw new InvalidParameterError(
      `Predecessor epoch ${String(predecessor.epochNumber)} is not below epoch ${String(epochNumber)}`
    );
  }
  if (
    !constantTimeCompare(getPublicKeyFromPrivate(predecessor.privateKey), predecessor.publicKey)
  ) {
    throw new InvalidParameterError('Predecessor public key does not match its private key');
  }

  const epoch = newEpoch(input.memberPublicKeys, conversationId, epochNumber);
  const chainLink = wrapSecretTo(
    asEpochPublicKey(epoch.epochPublicKey),
    predecessor.privateKey,
    WRAP_LABELS.epochKeyChainLink,
    chainLinkAad({
      conversationId,
      newerEpochNumber: epochNumber,
      olderEpochNumber: predecessor.epochNumber,
      olderEpochPublicKey: predecessor.publicKey,
    })
  );

  return { ...epoch, chainLink };
}

/**
 * What a hostile server can make an open raise by serving bytes and numbers:
 * a blob that does not open, or a location with no encoding. Anything else,
 * such as `InvalidKeyError` refusing the key the caller passed in, is the
 * caller's defect and propagates.
 */
function isUnopenable(error: unknown): boolean {
  return (
    error instanceof DecryptionFailedError ||
    error instanceof MalformedBlobError ||
    error instanceof UnknownBlobVersionError ||
    error instanceof InvalidParameterError
  );
}

/**
 * A key a blob yields passes the package's own key checks before anything
 * uses it. An all-zero key is self-consistent — the curve clamps the zero
 * scalar to a valid one, so it derives a public key and a confirmation — yet
 * every later unwrap under it throws. The checks refuse by throwing, and on
 * server-supplied bytes a refusal is a verdict, not a failure.
 */
function isUsableKey(key: Uint8Array): boolean {
  try {
    assertNotZeroed('an opened epoch key', asEpochPrivateKey(key));
    return true;
  } catch {
    return false;
  }
}

function checkEpochKey(
  key: Uint8Array,
  commitment: Omit<EpochCommitment, 'conversationId'>,
  conversationId: string
): OpenedEpochKey {
  if (!isUsableKey(key)) return { ok: false, reason: 'invalid-key' };
  if (!constantTimeCompare(getPublicKeyFromPrivate(key), commitment.epochPublicKey)) {
    return { ok: false, reason: 'public-key-mismatch' };
  }
  if (
    !verifyEpochConfirmation(
      asEpochPrivateKey(key),
      conversationId,
      commitment.epochNumber,
      commitment.confirmationHash
    )
  ) {
    return { ok: false, reason: 'confirmation-mismatch' };
  }
  return { ok: true, key };
}

function tryUnwrap(unwrap: () => Uint8Array): Uint8Array | undefined {
  try {
    return unwrap();
  } catch (error) {
    if (isUnopenable(error)) return undefined;
    throw error;
  }
}

/**
 * Opens a principal's wrap of an epoch key and checks the key against the
 * epoch's published record: it must derive the published public key and
 * reproduce the published confirmation.
 */
export function openEpochWrap(
  principalPrivateKey: Uint8Array,
  wrap: Uint8Array,
  epoch: EpochCommitment
): OpenedEpochKey {
  const key = tryUnwrap(() =>
    unwrapSecret(
      asAccountPrivateKey(principalPrivateKey),
      wrap as WrappedSecret,
      WRAP_LABELS.epochKeyMember,
      epochWrapAad(epoch)
    )
  );
  if (key === undefined) return { ok: false, reason: 'unwrap-failed' };
  return checkEpochKey(key, epoch, epoch.conversationId);
}

/**
 * Opens a chain link with the newer epoch's key and checks the key it yields
 * against the older epoch's published record.
 */
export function openChainLink(
  newerEpochPrivateKey: Uint8Array,
  chainLink: Uint8Array,
  binding: ChainLinkBinding
): OpenedEpochKey {
  const key = tryUnwrap(() =>
    unwrapSecret(
      asEpochPrivateKey(newerEpochPrivateKey),
      chainLink as WrappedSecret,
      WRAP_LABELS.epochKeyChainLink,
      chainLinkAad({
        conversationId: binding.conversationId,
        newerEpochNumber: binding.newerEpochNumber,
        olderEpochNumber: binding.older.epochNumber,
        olderEpochPublicKey: binding.older.epochPublicKey,
      })
    )
  );
  if (key === undefined) return { ok: false, reason: 'unwrap-failed' };
  return checkEpochKey(key, binding.older, binding.conversationId);
}
