import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { expectCompileTimeProof } from '@hushbox/shared/test-assertions';
import { encryptContentEnvelope } from '../wrap/envelope.js';
import { wrapContentKeyToEpoch, unwrapContentKeyFromEpoch } from '../content/epoch.js';
import { generateContentKey, generateEpochKeyPair, generateAccountKeyPair } from './keys.js';
import type { ContentLocation } from '../wrap/envelope.js';

/**
 * Type tests: each @ts-expect-error line asserts that the marked call DOES
 * NOT compile. If a branded key class ever became assignable where another
 * is expected, the directive would be flagged unused and `pnpm typecheck`
 * would fail — transposition is blocked at the type level. The runtime calls
 * exist only to keep the thunks referenced against TypeScript erasure.
 */

const location: ContentLocation = {
  conversationId: 'conv-1',
  messageId: 'msg-1',
  contentItemId: 'item-1',
  position: 0,
  epochNumber: 1,
  senderId: 'user-1',
};

const account = generateAccountKeyPair();
const epoch = generateEpochKeyPair();
const contentKey = generateContentKey();
const wrapped = wrapContentKeyToEpoch(epoch.publicKey, contentKey);

describe('branded key transposition (compile-time)', () => {
  it('rejects an epoch private key where a content key is expected', () => {
    const epochPrivateKeyAsContentKey = (): Uint8Array =>
      encryptContentEnvelope(
        // @ts-expect-error — EpochPrivateKey is not assignable to ContentKey
        epoch.privateKey,
        wrapped,
        location,
        { plaintext: randomBytes(8), compression: 'raw' }
      );
    expectCompileTimeProof(epochPrivateKeyAsContentKey);
  });

  it('rejects an epoch public key where a content key is expected', () => {
    const epochPublicKeyAsContentKey = (): Uint8Array =>
      // @ts-expect-error — EpochPublicKey is not assignable to ContentKey
      encryptContentEnvelope(epoch.publicKey, wrapped, location, {
        plaintext: randomBytes(8),
        compression: 'raw',
      });
    expectCompileTimeProof(epochPublicKeyAsContentKey);
  });

  it('rejects a content key where an epoch public key is expected', () => {
    const contentKeyAsEpochPublicKey = (): Uint8Array =>
      // @ts-expect-error — ContentKey is not assignable to EpochPublicKey
      wrapContentKeyToEpoch(contentKey, contentKey);
    expectCompileTimeProof(contentKeyAsEpochPublicKey);
  });

  it('rejects an account private key where an epoch private key is expected', () => {
    const accountPrivateKeyAsEpochPrivateKey = (): Uint8Array =>
      // @ts-expect-error — AccountPrivateKey is not assignable to EpochPrivateKey
      unwrapContentKeyFromEpoch(account.privateKey, wrapped);
    expectCompileTimeProof(accountPrivateKeyAsEpochPrivateKey);
  });

  it('rejects a raw Uint8Array where a content key is expected', () => {
    const rawBytesAsContentKey = (): Uint8Array =>
      encryptContentEnvelope(
        // @ts-expect-error — unbranded Uint8Array is not assignable to ContentKey
        randomBytes(32),
        wrapped,
        location,
        { plaintext: randomBytes(8), compression: 'raw' }
      );
    expectCompileTimeProof(rawBytesAsContentKey);
  });

  it('rejects a raw Uint8Array where a wrapped secret is expected', () => {
    const rawBytesAsWrappedSecret = (): Uint8Array =>
      // @ts-expect-error — unbranded Uint8Array is not assignable to WrappedSecret
      unwrapContentKeyFromEpoch(epoch.privateKey, randomBytes(81));
    expectCompileTimeProof(rawBytesAsWrappedSecret);
  });
});

describe('branded keys at their own primitives', () => {
  it('accepts a correctly branded content key at encryptContentEnvelope', () => {
    expect(
      encryptContentEnvelope(contentKey, wrapped, location, {
        plaintext: randomBytes(8),
        compression: 'raw',
      })
    ).toBeInstanceOf(Uint8Array);
  });
});
