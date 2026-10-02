/**
 * Keychains built by `@hushbox/crypto`'s own encoder, served in the wire shape
 * the keychain route returns, so a test judges them with the package's one
 * verifier exactly as a browser would.
 */

import {
  createFirstEpoch,
  generateKeyPair,
  getPublicKeyFromPrivate,
  performEpochRotation,
} from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import type { KeyPair } from '@hushbox/crypto';
import type { KeyChainResponse } from '@hushbox/shared';

export interface BuiltEpoch {
  readonly epochNumber: number;
  readonly epochPrivateKey: Uint8Array;
  /** The public key the server publishes for this epoch. */
  readonly publishedPublicKey: Uint8Array;
  readonly confirmationHash: Uint8Array;
  /** The first seat's wrap; null serves the epoch with no wrap for the principal. */
  readonly wrap: Uint8Array | null;
  readonly previousEpochNumber: number | null;
  readonly chainLink: Uint8Array | null;
}

export function firstEpoch(conversationId: string, seats: readonly KeyPair[]): BuiltEpoch {
  const epoch = createFirstEpoch(
    seats.map((s) => s.publicKey),
    conversationId,
    1
  );
  return {
    epochNumber: 1,
    epochPrivateKey: epoch.epochPrivateKey,
    publishedPublicKey: epoch.epochPublicKey,
    confirmationHash: epoch.confirmationHash,
    wrap: epoch.memberWraps[0]?.wrap ?? null,
    previousEpochNumber: null,
    chainLink: null,
  };
}

export function rotateFrom(
  conversationId: string,
  seat: KeyPair,
  predecessor: BuiltEpoch,
  epochNumber: number
): BuiltEpoch {
  const epoch = performEpochRotation({
    predecessor: {
      epochNumber: predecessor.epochNumber,
      privateKey: predecessor.epochPrivateKey,
      publicKey: getPublicKeyFromPrivate(predecessor.epochPrivateKey),
    },
    memberPublicKeys: [seat.publicKey],
    conversationId,
    epochNumber,
  });
  return {
    epochNumber,
    epochPrivateKey: epoch.epochPrivateKey,
    publishedPublicKey: epoch.epochPublicKey,
    confirmationHash: epoch.confirmationHash,
    wrap: epoch.memberWraps[0]?.wrap ?? null,
    previousEpochNumber: predecessor.epochNumber,
    chainLink: epoch.chainLink,
  };
}

/** A rotation whose published public key is not the key its wraps carry. */
export function withForeignPublicKey(epoch: BuiltEpoch): BuiltEpoch {
  return { ...epoch, publishedPublicKey: generateKeyPair().publicKey };
}

export interface KeyChainOptions {
  /** The epochs whose wrap is served; every epoch with a wrap when absent. */
  readonly wrapsAt?: readonly number[];
  readonly rotationPending?: boolean;
}

export function keyChainOf(
  epochs: readonly BuiltEpoch[],
  options: KeyChainOptions = {}
): KeyChainResponse {
  const wrapsAt = options.wrapsAt ?? epochs.map((e) => e.epochNumber);
  return {
    epochs: epochs.map((e) => ({
      epochNumber: e.epochNumber,
      epochPublicKey: toBase64(e.publishedPublicKey),
      confirmationHash: toBase64(e.confirmationHash),
      previousEpochNumber: e.previousEpochNumber,
      chainLink: e.chainLink === null ? null : toBase64(e.chainLink),
    })),
    wraps: epochs.flatMap((e) =>
      e.wrap === null || !wrapsAt.includes(e.epochNumber)
        ? []
        : [{ epochNumber: e.epochNumber, wrap: toBase64(e.wrap) }]
    ),
    currentEpoch: Math.max(...epochs.map((e) => e.epochNumber)),
    rotationPending: options.rotationPending ?? false,
  };
}
