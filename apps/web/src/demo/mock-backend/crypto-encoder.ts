/**
 * Encrypts the demo's canned plaintext fixtures into the EXACT base64 wire
 * shapes the real app expects, using the same `@hushbox/crypto` helpers the
 * production server uses. The demo's in-browser fake backend serves these so
 * the unmodified client decrypt path (`processKeyChain` → `openMessageEnvelope`
 * → `decryptTextWithContentKey`) runs verbatim — the demo genuinely exercises
 * the encryption stack rather than bypassing it.
 *
 * Encryption needs only the epoch PUBLIC key, so this works for both
 * fixture-seeded conversations (epoch created here) and conversations the user
 * creates live (epoch created client-side, only its public key sent to the
 * fake backend).
 */
import {
  createFirstEpoch,
  beginMessageEnvelope,
  encryptTextWithContentKey,
  encryptBinaryWithContentKey,
  encryptTextForEpoch,
} from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import type { KeyChainResponse } from '@/lib/epoch-key-cache';

export interface DemoEpoch {
  readonly epochNumber: number;
  readonly epochPublicKey: Uint8Array;
  readonly epochPrivateKey: Uint8Array;
  readonly confirmationHash: Uint8Array;
  readonly memberWrap: Uint8Array;
}

/** Create the first epoch for a demo conversation, wrapped to the demo account. */
export function createDemoEpoch(accountPublicKey: Uint8Array, epochNumber = 1): DemoEpoch {
  const epoch = createFirstEpoch([accountPublicKey]);
  const memberWrap = epoch.memberWraps[0];
  if (memberWrap === undefined) {
    throw new Error('createFirstEpoch returned no member wrap for the demo account');
  }
  return {
    epochNumber,
    epochPublicKey: epoch.epochPublicKey,
    epochPrivateKey: epoch.epochPrivateKey,
    confirmationHash: epoch.confirmationHash,
    memberWrap: memberWrap.wrap,
  };
}

/**
 * Build the `GET /api/keys/:id` (and `POST /api/keys/batch` per-conversation)
 * wire payload for a single-epoch conversation. `chainLinks` is empty because
 * demo conversations never rotate epochs.
 */
export function buildKeyChain(epoch: DemoEpoch): KeyChainResponse {
  return {
    wraps: [
      {
        epochNumber: epoch.epochNumber,
        wrap: toBase64(epoch.memberWrap),
        confirmationHash: toBase64(epoch.confirmationHash),
        visibleFromEpoch: 1,
      },
    ],
    chainLinks: [],
    currentEpoch: epoch.epochNumber,
  };
}

/**
 * Encrypt a single-blob ECIES field (conversation/list title) for an epoch.
 * Returns base64 for the `title` wire field.
 */
export function encryptForEpoch(epoch: DemoEpoch, plaintext: string): string {
  return toBase64(encryptTextForEpoch(epoch.epochPublicKey, plaintext));
}

export interface MessageEnvelope {
  /** base64 wrapped content key for `MessageResponse.wrappedContentKey`. */
  readonly wrappedContentKey: string;
  /** Encrypt a text content item → base64 for `ContentItemResponse.encryptedBlob`. */
  encryptText: (plaintext: string) => string;
  /** Encrypt a media asset → RAW ciphertext bytes to serve at a `data:`/`blob:` URL. */
  encryptBinary: (bytes: Uint8Array) => Uint8Array;
}

/**
 * Begin a per-message envelope. One content key per message is shared by every
 * content item (text and media) — mirrors the server's wrap-once model and the
 * client's `useMessageContentKey` (one unwrap per message).
 */
export function beginMessage(epoch: DemoEpoch): MessageEnvelope {
  const { contentKey, wrappedContentKey } = beginMessageEnvelope(epoch.epochPublicKey);
  return {
    wrappedContentKey: toBase64(wrappedContentKey),
    encryptText: (plaintext: string): string =>
      toBase64(encryptTextWithContentKey(contentKey, plaintext)),
    encryptBinary: (bytes: Uint8Array): Uint8Array =>
      encryptBinaryWithContentKey(contentKey, bytes),
  };
}
