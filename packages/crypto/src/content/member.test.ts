import { describe, it, expect } from 'vitest';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { wrapEpochKeyForNewMember } from './member.js';
import { generateKeyPair } from '../primitives/keys.js';
import { createFirstEpoch, openEpochWrap } from './epoch-lifecycle.js';

const CONVERSATION_ID = testUuidV7(3);
const OTHER_CONVERSATION_ID = testUuidV7(4);
const EPOCH_NUMBER = 6;

function existingEpoch(): ReturnType<typeof createFirstEpoch> {
  return createFirstEpoch([generateKeyPair().publicKey], CONVERSATION_ID, EPOCH_NUMBER);
}

function locationOf(epoch: ReturnType<typeof createFirstEpoch>): {
  conversationId: string;
  epochNumber: number;
  epochPublicKey: Uint8Array;
} {
  return {
    conversationId: CONVERSATION_ID,
    epochNumber: EPOCH_NUMBER,
    epochPublicKey: epoch.epochPublicKey,
  };
}

describe('wrapEpochKeyForNewMember', () => {
  it('lets the new member open the wrap to the epoch private key', () => {
    const newMember = generateKeyPair();
    const epoch = existingEpoch();

    const wrap = wrapEpochKeyForNewMember(
      epoch.epochPrivateKey,
      newMember.publicKey,
      locationOf(epoch)
    );

    expect(
      openEpochWrap(newMember.privateKey, wrap, {
        ...locationOf(epoch),
        confirmationHash: epoch.confirmationHash,
      })
    ).toEqual({ ok: true, key: epoch.epochPrivateKey });
  });

  it('refuses another principal key', () => {
    const newMember = generateKeyPair();
    const epoch = existingEpoch();

    const wrap = wrapEpochKeyForNewMember(
      epoch.epochPrivateKey,
      newMember.publicKey,
      locationOf(epoch)
    );

    expect(
      openEpochWrap(generateKeyPair().privateKey, wrap, {
        ...locationOf(epoch),
        confirmationHash: epoch.confirmationHash,
      })
    ).toEqual({ ok: false, reason: 'unwrap-failed' });
  });

  it.each([
    ['conversation', { conversationId: OTHER_CONVERSATION_ID }],
    ['epoch number', { epochNumber: EPOCH_NUMBER + 1 }],
    ['epoch public key', { epochPublicKey: generateKeyPair().publicKey }],
  ])('binds the wrap to its %s', (_field, override) => {
    const newMember = generateKeyPair();
    const epoch = existingEpoch();

    const wrap = wrapEpochKeyForNewMember(
      epoch.epochPrivateKey,
      newMember.publicKey,
      locationOf(epoch)
    );

    expect(
      openEpochWrap(newMember.privateKey, wrap, {
        ...locationOf(epoch),
        confirmationHash: epoch.confirmationHash,
        ...override,
      })
    ).toEqual({ ok: false, reason: 'unwrap-failed' });
  });

  it('produces a different blob per call', () => {
    const member = generateKeyPair();
    const epoch = existingEpoch();

    const wrap1 = wrapEpochKeyForNewMember(
      epoch.epochPrivateKey,
      member.publicKey,
      locationOf(epoch)
    );
    const wrap2 = wrapEpochKeyForNewMember(
      epoch.epochPrivateKey,
      member.publicKey,
      locationOf(epoch)
    );

    expect(wrap1).not.toEqual(wrap2);
  });
});
