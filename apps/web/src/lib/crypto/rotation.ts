/**
 * Proactive epoch rotation builder.
 * DESIGN: Rotation happens at the point of action (add/remove/revoke/link mint)
 * or in epoch maintenance after a departure or a bad rotation, NOT deferred to
 * message send. The send path has zero rotation logic.
 */

import {
  encryptTextForEpoch,
  getPublicKeyFromPrivate,
  performEpochRotation,
} from '@hushbox/crypto';
import { ERROR_CODES, toBase64 } from '@hushbox/shared';
import { getErrorBody } from '../api/api.js';
import { client, fetchJson } from '../api-client.js';
import { getEpochKey, getCurrentEpoch, getEpochVerdict } from './epoch-key-cache.js';
import type { StreamChatRotation } from '@hushbox/shared';

export interface RotationMember {
  publicKey: Uint8Array;
}

/** A verified epoch key the new epoch's chain link opens to. */
interface RotationPredecessor {
  epochNumber: number;
  privateKey: Uint8Array;
}

interface BuildRotationInput {
  conversationId: string;
  /** The conversation's current epoch; the new epoch is the one after it. */
  currentEpochNumber: number;
  /** The current epoch itself, or, for a recovery, an earlier one whose keys verified. */
  predecessor: RotationPredecessor;
  members: RotationMember[];
  plaintextTitle: string;
}

interface RotationResult {
  params: StreamChatRotation;
  newEpochPrivateKey: Uint8Array;
  newEpochNumber: number;
}

export interface MemberKeyResponse {
  memberId: string;
  userId: string | null;
  linkId: string | null;
  publicKey: string;
  privilege: string;
  visibleFromEpoch: number;
}

interface ExecuteWithRotationInput {
  conversationId: string;
  currentEpochPrivateKey: Uint8Array;
  currentEpochNumber: number;
  plaintextTitle: string;
  filterMembers: (allKeys: MemberKeyResponse[]) => RotationMember[];
  execute: (rotation: StreamChatRotation) => Promise<unknown>;
  /** Builds and submissions allowed, the stale-epoch rebuild included; defaults to {@link MAX_ROTATION_ATTEMPTS}. */
  maxAttempts?: number;
}

const MAX_ROTATION_ATTEMPTS = 2;

/**
 * A rotation refused because this client's keychain for the conversation did
 * not verify, or verified at an epoch other than the one this client holds a
 * key for: a verified current key is not enough when a chain link below it is
 * bad, and building on it would extend a chain nobody can trust. Only a
 * recovery rotation builds past a bad epoch. The message is the error code the
 * caller's error surface maps to copy.
 */
export class UnverifiedKeyChainError extends Error {
  constructor() {
    super(ERROR_CODES.EPOCH_KEYS_RESTORING);
    this.name = 'UnverifiedKeyChainError';
  }
}

export function buildRotation(input: BuildRotationInput): RotationResult {
  const { predecessor } = input;
  if (predecessor.privateKey.every((b) => b === 0)) {
    throw new Error('Cannot rotate: epoch key unavailable');
  }
  const newEpochNumber = input.currentEpochNumber + 1;
  const rotation = performEpochRotation({
    predecessor: {
      epochNumber: predecessor.epochNumber,
      privateKey: predecessor.privateKey,
      publicKey: getPublicKeyFromPrivate(predecessor.privateKey),
    },
    memberPublicKeys: input.members.map((m) => m.publicKey),
    conversationId: input.conversationId,
    epochNumber: newEpochNumber,
  });
  // Bound to the epoch the title is re-encrypted UNDER, not the one being
  // rotated away from: when the server accepts this title it stores
  // `titleEpochNumber = expectedEpoch + 1`. It accepts on a rotation that seats
  // a new key holder, and on a departure rotation only from the owner —
  // otherwise it discards this ciphertext and the stored title keeps its older
  // epoch. Readers decrypt against the `titleEpochNumber` the server returns,
  // so a discarded title needs nothing from this side.
  const encryptedTitle = encryptTextForEpoch(rotation.epochPublicKey, input.plaintextTitle, {
    conversationId: input.conversationId,
    epochNumber: newEpochNumber,
  });

  const params: StreamChatRotation = {
    expectedEpoch: input.currentEpochNumber,
    epochPublicKey: toBase64(rotation.epochPublicKey),
    confirmationHash: toBase64(rotation.confirmationHash),
    chainLink: toBase64(rotation.chainLink),
    encryptedTitle: toBase64(encryptedTitle),
    memberWraps: rotation.memberWraps.map((w) => ({
      memberPublicKey: toBase64(w.memberPublicKey),
      wrap: toBase64(w.wrap),
    })),
  };

  return {
    params,
    newEpochPrivateKey: rotation.epochPrivateKey,
    newEpochNumber,
  };
}

function isStaleEpochError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'status' in error &&
    (error as Error & { status: number }).status === 409
  );
}

/**
 * The conversation's epoch as the server reported it while refusing a stale
 * rotation. A `STALE_EPOCH` refusal carries it in the `details` of the
 * `{ code, details }` body every route follows; the other 409s these routes
 * produce carry none. The value is untrusted wire data, so it is narrowed
 * rather than asserted and anything unreadable reads as absent.
 */
function refusedAgainstEpoch(error: unknown): number | undefined {
  const reported = getErrorBody(error)?.details?.['currentEpoch'];
  return typeof reported === 'number' && Number.isInteger(reported) ? reported : undefined;
}

async function fetchMemberKeys(conversationId: string): Promise<MemberKeyResponse[]> {
  const response = await fetchJson(
    client.conversations[':conversationId']['member-keys'].$get({
      param: { conversationId },
    })
  );
  return response.members;
}

interface RotationTarget {
  epochNumber: number;
  epochPrivateKey: Uint8Array;
}

/**
 * The newest epoch this client both knows of and holds the key for. The server
 * rejects a rotation whose `expectedEpoch` is not the conversation's current
 * epoch. A newer epoch, this client's own rotations included, reaches this
 * client only through a refetched key chain that verifies into the epoch-key
 * cache, whatever prompted the refetch, so the cache is where a newer epoch
 * arrives from. A cached epoch whose key has not been unwrapped cannot be
 * rotated against, so the known target stands.
 */
function newestKnownEpoch(conversationId: string, known: RotationTarget): RotationTarget {
  const cachedNumber = getCurrentEpoch(conversationId);
  if (cachedNumber === undefined || cachedNumber <= known.epochNumber) return known;
  const cachedKey = getEpochKey(conversationId, cachedNumber);
  if (cachedKey === undefined) return known;
  return { epochNumber: cachedNumber, epochPrivateKey: cachedKey };
}

/**
 * The epoch a refused rotation may be rebuilt against, or `undefined` when no
 * rebuild can still be accepted and the refusal belongs to the caller. Only an
 * epoch past the refused one qualifies: a refusal whose named epoch is at or
 * below the one it refused is not evidence the chain moved, and rebuilding
 * against the same epoch would let one server answer double every submission.
 *
 * The number a refusal names is the server's epoch *as of the refusal*, and the
 * epoch column never moves backwards — so it is a lower bound on where the
 * server is now, not the one value a rebuild can still be accepted against. The
 * cache is a lower bound too: it is written only from the key chain's current
 * epoch, never speculatively. A
 * cache that has reached that number or moved past it is therefore
 * server-derived evidence that a rebuild against it can still be accepted,
 * while a cache still behind it is behind the server too, and rebuilding against
 * it buys a member-keys fetch, an ECIES rebuild and a mutation that are all
 * guaranteed to be refused. A refusal naming no epoch says only that the client
 * was behind, and then the newest epoch it has learned is the best candidate
 * there is.
 */
function retryTargetAfterRefusal(
  error: unknown,
  conversationId: string,
  refused: RotationTarget
): RotationTarget | undefined {
  const refreshed = newestKnownEpoch(conversationId, refused);
  const serverEpoch = refusedAgainstEpoch(error);
  const canStillBeCurrent =
    refreshed.epochNumber > refused.epochNumber &&
    (serverEpoch === undefined || refreshed.epochNumber >= serverEpoch);
  return canStillBeCurrent ? refreshed : undefined;
}

/**
 * Checked against the target picked after the last await, so a keychain that
 * lands mid-fetch cannot pair a verdict about one epoch with a key from another.
 */
function assertKeyChainVerified(conversationId: string, target: RotationTarget): void {
  const verdict = getEpochVerdict(conversationId);
  if (verdict?.rotation !== 'ok' || verdict.currentEpoch !== target.epochNumber) {
    throw new UnverifiedKeyChainError();
  }
}

export async function executeWithRotation(
  input: ExecuteWithRotationInput
): Promise<RotationResult> {
  let lastError: unknown;
  let target: RotationTarget = {
    epochNumber: input.currentEpochNumber,
    epochPrivateKey: input.currentEpochPrivateKey,
  };

  const maxAttempts = input.maxAttempts ?? MAX_ROTATION_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const memberKeys = await fetchMemberKeys(input.conversationId);
    const members = input.filterMembers(memberKeys);
    target = newestKnownEpoch(input.conversationId, target);
    assertKeyChainVerified(input.conversationId, target);
    const result = buildRotation({
      conversationId: input.conversationId,
      currentEpochNumber: target.epochNumber,
      predecessor: { epochNumber: target.epochNumber, privateKey: target.epochPrivateKey },
      members,
      plaintextTitle: input.plaintextTitle,
    });

    try {
      // The new key is not cached here: it reaches the cache only when the
      // keychain the server now serves verifies it, like every other key.
      await input.execute(result.params);
      return result;
    } catch (error: unknown) {
      if (!isStaleEpochError(error)) throw error;
      const retry = retryTargetAfterRefusal(error, input.conversationId, target);
      if (retry === undefined) throw error;
      lastError = error;
      target = retry;
    }
  }

  throw lastError;
}

interface ExecuteRecoveryRotationInput {
  conversationId: string;
  currentEpochNumber: number;
  predecessor: RotationPredecessor;
  plaintextTitle: string;
  filterMembers: (allKeys: MemberKeyResponse[]) => RotationMember[];
  execute: (rotation: StreamChatRotation) => Promise<unknown>;
}

/**
 * A rotation that chains past a bad epoch to the last one whose keys verified.
 * One attempt: a refusal means the chain moved, and whether a recovery is
 * still needed is for the next verified keychain to say, never a rebuild.
 */
export async function executeRecoveryRotation(
  input: ExecuteRecoveryRotationInput
): Promise<RotationResult> {
  const memberKeys = await fetchMemberKeys(input.conversationId);
  const result = buildRotation({
    conversationId: input.conversationId,
    currentEpochNumber: input.currentEpochNumber,
    predecessor: input.predecessor,
    members: input.filterMembers(memberKeys),
    plaintextTitle: input.plaintextTitle,
  });
  await input.execute(result.params);
  return result;
}
