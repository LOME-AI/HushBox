import { describe, it, expect } from 'vitest';
import { at } from '@hushbox/shared/test-utilities';
import { testUuidV7 } from '@hushbox/shared/test-time';
import {
  createFirstEpoch,
  performEpochRotation,
  openEpochWrap,
  openChainLink,
  epochWrapAad,
} from './epoch-lifecycle.js';
import { computeEpochConfirmation } from './epoch.js';
import { asAccountPublicKey, asEpochPrivateKey, generateKeyPair } from '../primitives/keys.js';
import { wrapSecretTo } from '../wrap/wrap.js';
import { WRAP_LABELS } from '../wrap/labels.js';
import { InvalidKeyError, InvalidParameterError } from '../errors.js';
import type { KeyPair } from '../primitives/keys.js';

const CONVERSATION_ID = testUuidV7(1);
const OTHER_CONVERSATION_ID = testUuidV7(2);

interface FirstEpochFixture {
  member: KeyPair;
  epoch: ReturnType<typeof createFirstEpoch>;
}

function firstEpoch(epochNumber = 1): FirstEpochFixture {
  const member = generateKeyPair();
  const epoch = createFirstEpoch([member.publicKey], CONVERSATION_ID, epochNumber);
  return { member, epoch };
}

function commitmentOf(
  epoch: { epochPublicKey: Uint8Array; confirmationHash: Uint8Array },
  epochNumber: number
): {
  conversationId: string;
  epochNumber: number;
  epochPublicKey: Uint8Array;
  confirmationHash: Uint8Array;
} {
  return {
    conversationId: CONVERSATION_ID,
    epochNumber,
    epochPublicKey: epoch.epochPublicKey,
    confirmationHash: epoch.confirmationHash,
  };
}

function olderOf(
  epoch: { epochPublicKey: Uint8Array; confirmationHash: Uint8Array },
  epochNumber: number
): { epochNumber: number; epochPublicKey: Uint8Array; confirmationHash: Uint8Array } {
  return {
    epochNumber,
    epochPublicKey: epoch.epochPublicKey,
    confirmationHash: epoch.confirmationHash,
  };
}

function rotate(
  predecessor: { epochPrivateKey: Uint8Array; epochPublicKey: Uint8Array },
  predecessorEpochNumber: number,
  memberPublicKeys: Uint8Array[],
  epochNumber: number
): ReturnType<typeof performEpochRotation> {
  return performEpochRotation({
    predecessor: {
      epochNumber: predecessorEpochNumber,
      privateKey: predecessor.epochPrivateKey,
      publicKey: predecessor.epochPublicKey,
    },
    memberPublicKeys,
    conversationId: CONVERSATION_ID,
    epochNumber,
  });
}

describe('epoch lifecycle', () => {
  describe('createFirstEpoch', () => {
    it('returns epoch key pair, confirmation hash, member wraps', () => {
      const { epoch } = firstEpoch();

      expect(epoch.epochPublicKey).toBeInstanceOf(Uint8Array);
      expect(epoch.epochPublicKey.length).toBe(32);
      expect(epoch.epochPrivateKey).toBeInstanceOf(Uint8Array);
      expect(epoch.epochPrivateKey.length).toBe(32);
      expect(epoch.confirmationHash).toBeInstanceOf(Uint8Array);
      expect(epoch.confirmationHash.length).toBe(32);
      expect(epoch.memberWraps).toHaveLength(1);
    });

    it('creates one wrap per member', () => {
      const members = [generateKeyPair(), generateKeyPair(), generateKeyPair()];

      const epoch = createFirstEpoch(
        members.map((m) => m.publicKey),
        CONVERSATION_ID,
        1
      );

      expect(epoch.memberWraps).toHaveLength(3);
    });

    it('pairs each member wrap with that member public key', () => {
      const { member, epoch } = firstEpoch();

      expect(at(epoch.memberWraps, 0).memberPublicKey).toEqual(member.publicKey);
      expect(at(epoch.memberWraps, 0).wrap).toBeInstanceOf(Uint8Array);
    });

    it('lets every member open its wrap to the epoch private key', () => {
      const member1 = generateKeyPair();
      const member2 = generateKeyPair();
      const epoch = createFirstEpoch([member1.publicKey, member2.publicKey], CONVERSATION_ID, 1);

      const opened1 = openEpochWrap(
        member1.privateKey,
        at(epoch.memberWraps, 0).wrap,
        commitmentOf(epoch, 1)
      );
      const opened2 = openEpochWrap(
        member2.privateKey,
        at(epoch.memberWraps, 1).wrap,
        commitmentOf(epoch, 1)
      );

      expect(opened1).toEqual({ ok: true, key: epoch.epochPrivateKey });
      expect(opened2).toEqual({ ok: true, key: epoch.epochPrivateKey });
    });

    it('returns the keyed confirmation bound to conversation and epoch', () => {
      const { epoch } = firstEpoch();

      expect(epoch.confirmationHash).toEqual(
        computeEpochConfirmation(asEpochPrivateKey(epoch.epochPrivateKey), CONVERSATION_ID, 1)
      );
    });

    it('generates a fresh epoch key per call', () => {
      const member = generateKeyPair();

      const result1 = createFirstEpoch([member.publicKey], CONVERSATION_ID, 1);
      const result2 = createFirstEpoch([member.publicKey], CONVERSATION_ID, 1);

      expect(result1.epochPublicKey).not.toEqual(result2.epochPublicKey);
    });
  });

  describe('openEpochWrap binding', () => {
    it('refuses a wrap presented for another conversation', () => {
      const { member, epoch } = firstEpoch(4);

      const opened = openEpochWrap(member.privateKey, at(epoch.memberWraps, 0).wrap, {
        ...commitmentOf(epoch, 4),
        conversationId: OTHER_CONVERSATION_ID,
      });

      expect(opened).toEqual({ ok: false, reason: 'unwrap-failed' });
    });

    it('refuses a wrap presented for another epoch number', () => {
      const { member, epoch } = firstEpoch(4);

      const opened = openEpochWrap(
        member.privateKey,
        at(epoch.memberWraps, 0).wrap,
        commitmentOf(epoch, 5)
      );

      expect(opened).toEqual({ ok: false, reason: 'unwrap-failed' });
    });

    it('refuses a wrap presented for another epoch public key', () => {
      const { member, epoch } = firstEpoch(4);

      const opened = openEpochWrap(member.privateKey, at(epoch.memberWraps, 0).wrap, {
        ...commitmentOf(epoch, 4),
        epochPublicKey: generateKeyPair().publicKey,
      });

      expect(opened).toEqual({ ok: false, reason: 'unwrap-failed' });
    });
  });

  describe('openEpochWrap failures', () => {
    it('reports unwrap-failed for the wrong principal key', () => {
      const { epoch } = firstEpoch();

      const opened = openEpochWrap(
        generateKeyPair().privateKey,
        at(epoch.memberWraps, 0).wrap,
        commitmentOf(epoch, 1)
      );

      expect(opened).toEqual({ ok: false, reason: 'unwrap-failed' });
    });

    it('reports unwrap-failed for bytes that are not a wrap', () => {
      const { member, epoch } = firstEpoch();

      const opened = openEpochWrap(member.privateKey, new Uint8Array(0), commitmentOf(epoch, 1));

      expect(opened).toEqual({ ok: false, reason: 'unwrap-failed' });
    });

    it('reports public-key-mismatch for a key that does not derive the epoch public key', () => {
      const member = generateKeyPair();
      const foreign = generateKeyPair();
      const claimedPublicKey = generateKeyPair().publicKey;
      const location = { conversationId: CONVERSATION_ID, epochNumber: 1 };
      const confirmationHash = computeEpochConfirmation(
        asEpochPrivateKey(foreign.privateKey),
        CONVERSATION_ID,
        1
      );
      const wrap = wrapEpochKeyUnder(member.publicKey, foreign.privateKey, {
        ...location,
        epochPublicKey: claimedPublicKey,
      });

      const opened = openEpochWrap(member.privateKey, wrap, {
        ...location,
        epochPublicKey: claimedPublicKey,
        confirmationHash,
      });

      expect(opened).toEqual({ ok: false, reason: 'public-key-mismatch' });
    });

    it('reports invalid-key for a payload that is not a key', () => {
      const member = generateKeyPair();
      const claimedPublicKey = generateKeyPair().publicKey;
      const location = { conversationId: CONVERSATION_ID, epochNumber: 1 };
      const wrap = wrapEpochKeyUnder(member.publicKey, new Uint8Array(16).fill(7), {
        ...location,
        epochPublicKey: claimedPublicKey,
      });

      const opened = openEpochWrap(member.privateKey, wrap, {
        ...location,
        epochPublicKey: claimedPublicKey,
        confirmationHash: new Uint8Array(32),
      });

      expect(opened).toEqual({ ok: false, reason: 'invalid-key' });
    });

    it('throws for a zeroed principal key rather than blaming the wrap', () => {
      const { epoch } = firstEpoch();

      expect(() =>
        openEpochWrap(new Uint8Array(32), at(epoch.memberWraps, 0).wrap, commitmentOf(epoch, 1))
      ).toThrow(InvalidKeyError);
    });

    it('reports confirmation-mismatch for a confirmation the key does not produce', () => {
      const { member, epoch } = firstEpoch();

      const opened = openEpochWrap(member.privateKey, at(epoch.memberWraps, 0).wrap, {
        ...commitmentOf(epoch, 1),
        confirmationHash: new Uint8Array(32).fill(0xff),
      });

      expect(opened).toEqual({ ok: false, reason: 'confirmation-mismatch' });
    });
  });

  describe('performEpochRotation', () => {
    it('returns new epoch key pair, member wraps, and chain link', () => {
      const { member, epoch } = firstEpoch();

      const result = rotate(epoch, 1, [member.publicKey], 2);

      expect(result.epochPublicKey.length).toBe(32);
      expect(result.epochPrivateKey.length).toBe(32);
      expect(result.confirmationHash).toBeInstanceOf(Uint8Array);
      expect(result.memberWraps).toHaveLength(1);
      expect(result.chainLink).toBeInstanceOf(Uint8Array);
    });

    it('returns the keyed confirmation bound to the new epoch number', () => {
      const { member, epoch } = firstEpoch();

      const result = rotate(epoch, 1, [member.publicKey], 2);

      expect(result.confirmationHash).toEqual(
        computeEpochConfirmation(asEpochPrivateKey(result.epochPrivateKey), CONVERSATION_ID, 2)
      );
    });

    it('generates a key distinct from its predecessor', () => {
      const { member, epoch } = firstEpoch();

      const epoch2 = rotate(epoch, 1, [member.publicKey], 2);

      expect(epoch2.epochPublicKey).not.toEqual(epoch.epochPublicKey);
      expect(epoch2.epochPrivateKey).not.toEqual(epoch.epochPrivateKey);
    });

    it('wraps the new epoch key to each member at the new epoch', () => {
      const { member, epoch } = firstEpoch();

      const epoch2 = rotate(epoch, 1, [member.publicKey], 2);

      expect(
        openEpochWrap(member.privateKey, at(epoch2.memberWraps, 0).wrap, commitmentOf(epoch2, 2))
      ).toEqual({ ok: true, key: epoch2.epochPrivateKey });
    });

    it('seats only the member set it is given', () => {
      const member1 = generateKeyPair();
      const member2 = generateKeyPair();
      const epoch1 = createFirstEpoch([member1.publicKey, member2.publicKey], CONVERSATION_ID, 1);

      const epoch2 = rotate(epoch1, 1, [member1.publicKey], 2);

      expect(epoch2.memberWraps).toHaveLength(1);
      expect(at(epoch2.memberWraps, 0).memberPublicKey).toEqual(member1.publicKey);
    });

    it('builds a chain link that opens to the predecessor key', () => {
      const { member, epoch } = firstEpoch();
      const epoch2 = rotate(epoch, 1, [member.publicKey], 2);

      const opened = openChainLink(epoch2.epochPrivateKey, epoch2.chainLink, {
        conversationId: CONVERSATION_ID,
        newerEpochNumber: 2,
        older: olderOf(epoch, 1),
      });

      expect(opened).toEqual({ ok: true, key: epoch.epochPrivateKey });
    });

    it('builds a skip link to a predecessor below the epoch just under it', () => {
      const { member, epoch } = firstEpoch(2);
      const recovery = rotate(epoch, 2, [member.publicKey], 5);

      const opened = openChainLink(recovery.epochPrivateKey, recovery.chainLink, {
        conversationId: CONVERSATION_ID,
        newerEpochNumber: 5,
        older: olderOf(epoch, 2),
      });

      expect(opened).toEqual({ ok: true, key: epoch.epochPrivateKey });
    });

    it('supports walking several rotations back to the first epoch', () => {
      const { member, epoch: epoch1 } = firstEpoch();
      const epoch2 = rotate(epoch1, 1, [member.publicKey], 2);
      const epoch3 = rotate(epoch2, 2, [member.publicKey], 3);

      const key2 = openChainLink(epoch3.epochPrivateKey, epoch3.chainLink, {
        conversationId: CONVERSATION_ID,
        newerEpochNumber: 3,
        older: olderOf(epoch2, 2),
      });
      const key1 = openChainLink(epoch2.epochPrivateKey, epoch2.chainLink, {
        conversationId: CONVERSATION_ID,
        newerEpochNumber: 2,
        older: olderOf(epoch1, 1),
      });

      expect(key2).toEqual({ ok: true, key: epoch2.epochPrivateKey });
      expect(key1).toEqual({ ok: true, key: epoch1.epochPrivateKey });
    });

    it('refuses a predecessor that is not below the new epoch', () => {
      const { member, epoch } = firstEpoch(3);

      expect(() => rotate(epoch, 3, [member.publicKey], 3)).toThrow(InvalidParameterError);
    });

    it('refuses a predecessor public key that its private key does not derive', () => {
      const { member, epoch } = firstEpoch();

      expect(() =>
        rotate(
          { epochPrivateKey: epoch.epochPrivateKey, epochPublicKey: generateKeyPair().publicKey },
          1,
          [member.publicKey],
          2
        )
      ).toThrow(InvalidParameterError);
    });
  });

  describe('openChainLink binding', () => {
    function linkedPair(): {
      epoch1: ReturnType<typeof createFirstEpoch>;
      epoch4: ReturnType<typeof performEpochRotation>;
    } {
      const { member, epoch: epoch1 } = firstEpoch(2);
      const epoch4 = rotate(epoch1, 2, [member.publicKey], 4);
      return { epoch1, epoch4 };
    }

    it('refuses a link presented for another conversation', () => {
      const { epoch1, epoch4 } = linkedPair();

      const opened = openChainLink(epoch4.epochPrivateKey, epoch4.chainLink, {
        conversationId: OTHER_CONVERSATION_ID,
        newerEpochNumber: 4,
        older: olderOf(epoch1, 2),
      });

      expect(opened).toEqual({ ok: false, reason: 'unwrap-failed' });
    });

    it('refuses a link presented for another newer epoch number', () => {
      const { epoch1, epoch4 } = linkedPair();

      const opened = openChainLink(epoch4.epochPrivateKey, epoch4.chainLink, {
        conversationId: CONVERSATION_ID,
        newerEpochNumber: 3,
        older: olderOf(epoch1, 2),
      });

      expect(opened).toEqual({ ok: false, reason: 'unwrap-failed' });
    });

    it('refuses a link presented for another older epoch number', () => {
      const { epoch1, epoch4 } = linkedPair();

      const opened = openChainLink(epoch4.epochPrivateKey, epoch4.chainLink, {
        conversationId: CONVERSATION_ID,
        newerEpochNumber: 4,
        older: olderOf(epoch1, 1),
      });

      expect(opened).toEqual({ ok: false, reason: 'unwrap-failed' });
    });

    it('refuses a link presented for another older epoch public key', () => {
      const { epoch1, epoch4 } = linkedPair();

      const opened = openChainLink(epoch4.epochPrivateKey, epoch4.chainLink, {
        conversationId: CONVERSATION_ID,
        newerEpochNumber: 4,
        older: { ...olderOf(epoch1, 2), epochPublicKey: generateKeyPair().publicKey },
      });

      expect(opened).toEqual({ ok: false, reason: 'unwrap-failed' });
    });

    it('reports unwrap-failed for the wrong newer epoch key', () => {
      const { epoch1, epoch4 } = linkedPair();

      const opened = openChainLink(generateKeyPair().privateKey, epoch4.chainLink, {
        conversationId: CONVERSATION_ID,
        newerEpochNumber: 4,
        older: olderOf(epoch1, 2),
      });

      expect(opened).toEqual({ ok: false, reason: 'unwrap-failed' });
    });

    it('reports confirmation-mismatch for an older confirmation the key does not produce', () => {
      const { epoch1, epoch4 } = linkedPair();

      const opened = openChainLink(epoch4.epochPrivateKey, epoch4.chainLink, {
        conversationId: CONVERSATION_ID,
        newerEpochNumber: 4,
        older: { ...olderOf(epoch1, 2), confirmationHash: new Uint8Array(32) },
      });

      expect(opened).toEqual({ ok: false, reason: 'confirmation-mismatch' });
    });
  });
});

/**
 * A member wrap built outside the lifecycle functions, so a test can seal a
 * key that does not belong to the public key it is bound under — the one
 * thing no honest producer can do.
 */
function wrapEpochKeyUnder(
  recipientPublicKey: Uint8Array,
  epochPrivateKey: Uint8Array,
  location: { conversationId: string; epochNumber: number; epochPublicKey: Uint8Array }
): Uint8Array {
  return wrapSecretTo(
    asAccountPublicKey(recipientPublicKey),
    epochPrivateKey,
    WRAP_LABELS.epochKeyMember,
    epochWrapAad(location)
  );
}
