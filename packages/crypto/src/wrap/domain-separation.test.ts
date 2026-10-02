import { describe, it, expect } from 'vitest';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { DecryptionFailedError } from '../errors.js';
import {
  createFirstEpoch,
  openChainLink,
  openEpochWrap,
  performEpochRotation,
} from '../content/epoch-lifecycle.js';
import {
  encryptTextForEpoch,
  decryptTextFromEpoch,
  encryptCustomInstructions,
  decryptCustomInstructions,
} from '../content/message-encrypt.js';
import { generateKeyPair } from '../primitives/keys.js';

const CONVERSATION_ID = testUuidV7(1);
const USER_ID = testUuidV7(2);
const ROTATED_TITLE_LOCATION = { conversationId: CONVERSATION_ID, epochNumber: 2 };
const FIRST_TITLE_LOCATION = { conversationId: CONVERSATION_ID, epochNumber: 1 };

/**
 * Every wrap in the key hierarchy derives its key under a purpose label, so a
 * blob made for one purpose can never be opened as another even when both are
 * encrypted to the same recipient key. These are the two sets that share a
 * recipient in production: the epoch public key receives both the chain link
 * and the conversation title, and the account public key receives both the
 * epoch member wrap and the custom instructions.
 */
describe('wrap domain separation', () => {
  describe('blobs encrypted to the epoch public key', () => {
    function rotatedEpoch(): {
      first: ReturnType<typeof createFirstEpoch>;
      rotated: ReturnType<typeof performEpochRotation>;
    } {
      const account = generateKeyPair();
      const first = createFirstEpoch([account.publicKey], CONVERSATION_ID, 1);
      const rotated = performEpochRotation({
        predecessor: {
          epochNumber: 1,
          privateKey: first.epochPrivateKey,
          publicKey: first.epochPublicKey,
        },
        memberPublicKeys: [account.publicKey],
        conversationId: CONVERSATION_ID,
        epochNumber: 2,
      });
      return { first, rotated };
    }

    it('rejects a conversation title presented where a chain link is expected', () => {
      const { first, rotated } = rotatedEpoch();
      const title = encryptTextForEpoch(
        rotated.epochPublicKey,
        'Quarterly planning',
        ROTATED_TITLE_LOCATION
      );

      expect(
        openChainLink(rotated.epochPrivateKey, title, {
          conversationId: CONVERSATION_ID,
          newerEpochNumber: 2,
          older: {
            epochNumber: 1,
            epochPublicKey: first.epochPublicKey,
            confirmationHash: first.confirmationHash,
          },
        })
      ).toEqual({ ok: false, reason: 'unwrap-failed' });
    });

    it('rejects a chain link presented where a conversation title is expected', () => {
      const { rotated } = rotatedEpoch();

      expect(() =>
        decryptTextFromEpoch(rotated.epochPrivateKey, rotated.chainLink, ROTATED_TITLE_LOCATION)
      ).toThrow(DecryptionFailedError);
    });
  });

  describe('blobs encrypted to the account public key', () => {
    it('rejects custom instructions presented where an epoch member wrap is expected', () => {
      const account = generateKeyPair();
      const instructions = encryptCustomInstructions(
        account.publicKey,
        'Always answer concisely.',
        USER_ID
      );

      const epoch = createFirstEpoch([account.publicKey], CONVERSATION_ID, 1);

      expect(
        openEpochWrap(account.privateKey, instructions, {
          conversationId: CONVERSATION_ID,
          epochNumber: 1,
          epochPublicKey: epoch.epochPublicKey,
          confirmationHash: epoch.confirmationHash,
        })
      ).toEqual({ ok: false, reason: 'unwrap-failed' });
    });

    it('rejects an epoch member wrap presented where custom instructions are expected', () => {
      const account = generateKeyPair();
      const first = createFirstEpoch([account.publicKey], CONVERSATION_ID, 1);
      const memberWrap = first.memberWraps[0]?.wrap;
      if (!memberWrap) throw new Error('expected a member wrap');

      expect(() => decryptCustomInstructions(account.privateKey, memberWrap, USER_ID)).toThrow(
        DecryptionFailedError
      );
    });
  });

  describe('custom instructions against conversation titles', () => {
    it('rejects custom instructions presented where a conversation title is expected', () => {
      const account = generateKeyPair();
      const instructions = encryptCustomInstructions(
        account.publicKey,
        'Always answer concisely.',
        USER_ID
      );

      expect(() =>
        decryptTextFromEpoch(account.privateKey, instructions, FIRST_TITLE_LOCATION)
      ).toThrow(DecryptionFailedError);
    });

    it('rejects a conversation title presented where custom instructions are expected', () => {
      const account = generateKeyPair();
      const title = encryptTextForEpoch(
        account.publicKey,
        'Quarterly planning',
        FIRST_TITLE_LOCATION
      );

      expect(() => decryptCustomInstructions(account.privateKey, title, USER_ID)).toThrow(
        DecryptionFailedError
      );
    });
  });
});
