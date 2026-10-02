import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { at } from '@hushbox/shared/test-utilities';
import {
  createAccount,
  unwrapAccountKeyWithPassword,
  recoverAccountFromMnemonic,
  rewrapAccountKeyForPasswordChange,
  regenerateRecoveryPhrase,
} from './account.js';
import {
  createFirstEpoch,
  openChainLink,
  openEpochWrap,
  performEpochRotation,
} from './content/epoch-lifecycle.js';
import { wrapContentKeyToEpoch, unwrapContentKeyFromEpoch } from './content/epoch.js';
import { encryptContentEnvelope, decryptContentEnvelope } from './wrap/envelope.js';
import {
  asEpochPrivateKey,
  asEpochPublicKey,
  asShareSecret,
  generateContentKey,
} from './primitives/keys.js';
import { wrapEpochKeyForNewMember } from './content/member.js';
import { createSharedLink, deriveKeysFromLinkSecret } from './content/link.js';
import { createShare, openShare } from './content/message-share.js';
import { DecryptionFailedError } from './errors.js';
import type { ContentKey } from './primitives/keys.js';
import type { ContentLocation } from './wrap/envelope.js';
import type { WrappedSecret } from './wrap/wrap.js';

/**
 * Test helpers that mirror what the server actually writes: one content key per
 * message wrapped once to the epoch, and one location-bound content envelope
 * per item. Building the bytes any other way would prove a format nothing
 * reads.
 */
interface StoredMessage {
  wrappedContentKey: WrappedSecret;
  ciphertext: Uint8Array;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const CONVERSATION_ID = '00000000-0000-7000-8000-000000000abc';

/** What the server publishes for an epoch, which every open checks a key against. */
interface PublishedEpoch {
  epochPublicKey: Uint8Array;
  confirmationHash: Uint8Array;
}

function openWrap(
  principalPrivateKey: Uint8Array,
  wrap: Uint8Array,
  epoch: PublishedEpoch,
  epochNumber: number
): Uint8Array {
  const opened = openEpochWrap(principalPrivateKey, wrap, {
    conversationId: CONVERSATION_ID,
    epochNumber,
    epochPublicKey: epoch.epochPublicKey,
    confirmationHash: epoch.confirmationHash,
  });
  if (!opened.ok) throw new Error(`Epoch wrap refused: ${opened.reason}`);
  return opened.key;
}

function openLink(
  newerEpochPrivateKey: Uint8Array,
  newer: { chainLink: Uint8Array; epochNumber: number },
  older: PublishedEpoch & { epochNumber: number }
): Uint8Array {
  const opened = openChainLink(newerEpochPrivateKey, newer.chainLink, {
    conversationId: CONVERSATION_ID,
    newerEpochNumber: newer.epochNumber,
    older,
  });
  if (!opened.ok) throw new Error(`Chain link refused: ${opened.reason}`);
  return opened.key;
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

/**
 * The one item's location; every read must reproduce it to open the envelope.
 * Fixed across these tests on purpose — they exercise the key hierarchy above
 * the envelope, so the AAD only has to be the same bytes on both sides.
 */
const ITEM_LOCATION: ContentLocation = {
  conversationId: CONVERSATION_ID,
  messageId: '00000000-0000-7000-8000-00000000000f',
  contentItemId: '00000000-0000-7000-8000-000000000010',
  position: 0,
  epochNumber: 1,
  senderId: '00000000-0000-7000-8000-000000000011',
};

function storeMessage(epochPublicKey: Uint8Array, text: string): StoredMessage {
  const contentKey = generateContentKey();
  const wrappedContentKey = wrapContentKeyToEpoch(asEpochPublicKey(epochPublicKey), contentKey);
  const ciphertext = encryptContentEnvelope(contentKey, wrappedContentKey, ITEM_LOCATION, {
    plaintext: encoder.encode(text),
    compression: 'raw',
  });
  return { wrappedContentKey, ciphertext };
}

function readMessageWithKey(contentKey: ContentKey, stored: StoredMessage): string {
  return decoder.decode(
    decryptContentEnvelope(contentKey, stored.wrappedContentKey, ITEM_LOCATION, stored.ciphertext)
  );
}

function readMessage(epochPrivateKey: Uint8Array, stored: StoredMessage): string {
  const contentKey = unwrapContentKeyFromEpoch(
    asEpochPrivateKey(epochPrivateKey),
    stored.wrappedContentKey
  );
  return readMessageWithKey(contentKey, stored);
}

describe('integration', () => {
  describe('1. Full user lifecycle', () => {
    it('registration → key unwrap → conversation → message encrypt/decrypt', async () => {
      const exportKey = randomBytes(64);

      // Registration
      const account = await createAccount(exportKey);
      expect(account.publicKey.length).toBe(32);

      // Unwrap account private key
      const accountPrivKey = unwrapAccountKeyWithPassword(
        exportKey,
        account.passwordWrappedPrivateKey
      );
      expect(accountPrivKey.length).toBe(32);

      // Verify public key correspondence
      const derivedPub = x25519.getPublicKey(accountPrivKey);
      expect(derivedPub).toEqual(account.publicKey);

      // Create conversation (first epoch)
      const epoch = createFirstEpoch([account.publicKey], CONVERSATION_ID, 1);
      expect(epoch.memberWraps).toHaveLength(1);

      // Open the epoch key, checked against its public key and confirmation
      const epochPrivKey = openWrap(accountPrivKey, at(epoch.memberWraps, 0).wrap, epoch, 1);
      expect(epochPrivKey).toEqual(epoch.epochPrivateKey);

      // Store and read a message (wrap-once)
      const stored = storeMessage(epoch.epochPublicKey, 'Hello world');
      expect(readMessage(epochPrivKey, stored)).toBe('Hello world');
    });
  });

  describe('2. Multi-member conversation', () => {
    it('both members decrypt all messages with shared epoch key', async () => {
      const aliceExport = randomBytes(64);
      const bobExport = randomBytes(64);

      const alice = await createAccount(aliceExport);
      const bob = await createAccount(bobExport);

      const alicePriv = unwrapAccountKeyWithPassword(aliceExport, alice.passwordWrappedPrivateKey);
      const bobPriv = unwrapAccountKeyWithPassword(bobExport, bob.passwordWrappedPrivateKey);

      // Create epoch with both members
      const epoch = createFirstEpoch([alice.publicKey, bob.publicKey], CONVERSATION_ID, 1);
      expect(epoch.memberWraps).toHaveLength(2);

      // Both unwrap to same epoch key
      const aliceEpochKey = openWrap(alicePriv, at(epoch.memberWraps, 0).wrap, epoch, 1);
      const bobEpochKey = openWrap(bobPriv, at(epoch.memberWraps, 1).wrap, epoch, 1);
      expect(aliceEpochKey).toEqual(bobEpochKey);
      expect(aliceEpochKey).toEqual(epoch.epochPrivateKey);

      // Store 3 messages under the wrap-once envelope
      const messages = ['First message', 'Second message', 'Third message with emoji 🎉'];
      const stored = messages.map((m) => storeMessage(epoch.epochPublicKey, m));

      // Both decrypt all 3
      for (const [index, message] of messages.entries()) {
        expect(readMessage(aliceEpochKey, at(stored, index))).toBe(message);
        expect(readMessage(bobEpochKey, at(stored, index))).toBe(message);
      }
    });
  });

  describe('3. Epoch rotation with chain traversal', () => {
    it('new key for new messages, chain link recovers old key for old messages', () => {
      const memberPriv = randomBytes(32);
      const memberPub = x25519.getPublicKey(memberPriv);

      // Epoch 1: store 2 messages
      const epoch1 = createFirstEpoch([memberPub], CONVERSATION_ID, 1);
      const msg1 = storeMessage(epoch1.epochPublicKey, 'Message in epoch 1');
      const msg2 = storeMessage(epoch1.epochPublicKey, 'Another epoch 1 message');

      // Rotate to epoch 2
      const epoch2 = rotate(epoch1, 1, [memberPub], 2);

      // Store 2 messages in epoch 2
      const msg3 = storeMessage(epoch2.epochPublicKey, 'Message in epoch 2');
      const msg4 = storeMessage(epoch2.epochPublicKey, 'Another epoch 2 message');

      // Unwrap epoch 2 from member wrap
      const epoch2Key = openWrap(memberPriv, at(epoch2.memberWraps, 0).wrap, epoch2, 2);

      // Decrypt epoch 2 messages
      expect(readMessage(epoch2Key, msg3)).toBe('Message in epoch 2');
      expect(readMessage(epoch2Key, msg4)).toBe('Another epoch 2 message');

      // Traverse chain link to get epoch 1 key
      const epoch1Key = openLink(
        epoch2Key,
        { ...epoch2, epochNumber: 2 },
        { ...epoch1, epochNumber: 1 }
      );
      expect(epoch1Key).toEqual(epoch1.epochPrivateKey);

      // Decrypt epoch 1 messages
      expect(readMessage(epoch1Key, msg1)).toBe('Message in epoch 1');
      expect(readMessage(epoch1Key, msg2)).toBe('Another epoch 1 message');
    });
  });

  describe('4. Triple rotation — full chain walk', () => {
    it('three rotations, walk entire chain to decrypt all messages', () => {
      const priv = randomBytes(32);
      const pub = x25519.getPublicKey(priv);

      const epoch1 = createFirstEpoch([pub], CONVERSATION_ID, 1);
      const msgE1 = storeMessage(epoch1.epochPublicKey, 'Epoch 1 content');

      const epoch2 = rotate(epoch1, 1, [pub], 2);
      const msgE2 = storeMessage(epoch2.epochPublicKey, 'Epoch 2 content');

      const epoch3 = rotate(epoch2, 2, [pub], 3);
      const msgE3 = storeMessage(epoch3.epochPublicKey, 'Epoch 3 content');

      // Start from epoch 3 member wrap
      const key3 = openWrap(priv, at(epoch3.memberWraps, 0).wrap, epoch3, 3);
      expect(readMessage(key3, msgE3)).toBe('Epoch 3 content');

      // Traverse 3→2
      const key2 = openLink(key3, { ...epoch3, epochNumber: 3 }, { ...epoch2, epochNumber: 2 });
      expect(readMessage(key2, msgE2)).toBe('Epoch 2 content');

      // Traverse 2→1
      const key1 = openLink(key2, { ...epoch2, epochNumber: 2 }, { ...epoch1, epochNumber: 1 });
      expect(readMessage(key1, msgE1)).toBe('Epoch 1 content');

      // Verify chain integrity: keys match original epoch keys
      expect(key3).toEqual(epoch3.epochPrivateKey);
      expect(key2).toEqual(epoch2.epochPrivateKey);
      expect(key1).toEqual(epoch1.epochPrivateKey);
    });
  });

  describe('5. Member removal — forward secrecy', () => {
    it('removed member loses forward access but retains historical access', () => {
      const alicePriv = randomBytes(32);
      const alicePub = x25519.getPublicKey(alicePriv);
      const bobPriv = randomBytes(32);
      const bobPub = x25519.getPublicKey(bobPriv);

      // Epoch 1: both Alice and Bob
      const epoch1 = createFirstEpoch([alicePub, bobPub], CONVERSATION_ID, 1);
      const msg1 = storeMessage(epoch1.epochPublicKey, 'Shared message');

      // Both can decrypt epoch 1
      const aliceEpoch1Key = openWrap(alicePriv, at(epoch1.memberWraps, 0).wrap, epoch1, 1);
      const bobEpoch1Key = openWrap(bobPriv, at(epoch1.memberWraps, 1).wrap, epoch1, 1);
      expect(readMessage(aliceEpoch1Key, msg1)).toBe('Shared message');
      expect(readMessage(bobEpoch1Key, msg1)).toBe('Shared message');

      // Remove Bob: rotate to epoch 2 with only Alice
      const epoch2 = rotate(epoch1, 1, [alicePub], 2);
      const msg2 = storeMessage(epoch2.epochPublicKey, 'Alice-only message');

      // Alice can unwrap epoch 2 and decrypt new message
      const aliceEpoch2Key = openWrap(alicePriv, at(epoch2.memberWraps, 0).wrap, epoch2, 2);
      expect(readMessage(aliceEpoch2Key, msg2)).toBe('Alice-only message');

      // Alice can traverse chain to decrypt old message
      const aliceRecoveredKey = openLink(
        aliceEpoch2Key,
        { ...epoch2, epochNumber: 2 },
        { ...epoch1, epochNumber: 1 }
      );
      expect(readMessage(aliceRecoveredKey, msg1)).toBe('Shared message');

      // Bob: NO wrap exists for Bob in epoch 2
      const bobWraps = epoch2.memberWraps.filter((w) =>
        w.memberPublicKey.every((byte, index) => byte === bobPub[index])
      );
      expect(bobWraps).toHaveLength(0);

      // Bob: CANNOT decrypt epoch 2 messages with his account key
      expect(() => openWrap(bobPriv, at(epoch2.memberWraps, 0).wrap, epoch2, 2)).toThrow(
        'Epoch wrap refused: unwrap-failed'
      );

      // Bob: CAN still decrypt epoch 1 messages with his retained epoch 1 key
      expect(readMessage(bobEpoch1Key, msg1)).toBe('Shared message');
    });
  });

  describe('6. Password change', () => {
    it('re-wraps account key, old password loses access, all history preserved', async () => {
      const exportKey1 = randomBytes(64);
      const account = await createAccount(exportKey1);

      // Unwrap with original password
      const privKey = unwrapAccountKeyWithPassword(exportKey1, account.passwordWrappedPrivateKey);

      // Create epoch and store messages
      const epoch = createFirstEpoch([account.publicKey], CONVERSATION_ID, 1);
      const msg = storeMessage(epoch.epochPublicKey, 'Before password change');

      // Change password
      const exportKey2 = randomBytes(64);
      const newPasswordBlob = rewrapAccountKeyForPasswordChange(privKey, exportKey2);

      // New password works
      const privKeyFromNew = unwrapAccountKeyWithPassword(exportKey2, newPasswordBlob);
      expect(privKeyFromNew).toEqual(privKey);

      // Decrypt messages with same account key
      const epochKey = openWrap(privKeyFromNew, at(epoch.memberWraps, 0).wrap, epoch, 1);
      expect(readMessage(epochKey, msg)).toBe('Before password change');

      // Old password CANNOT unwrap new blob
      expect(() => unwrapAccountKeyWithPassword(exportKey1, newPasswordBlob)).toThrow(
        DecryptionFailedError
      );
    });
  });

  describe('7. Recovery phrase flow', () => {
    it('mnemonic recovers full access, regeneration invalidates old phrase', async () => {
      const exportKey = randomBytes(64);
      const account = await createAccount(exportKey);

      const originalPrivKey = unwrapAccountKeyWithPassword(
        exportKey,
        account.passwordWrappedPrivateKey
      );

      // Create epoch and store messages
      const epoch = createFirstEpoch([account.publicKey], CONVERSATION_ID, 1);
      const msg = storeMessage(epoch.epochPublicKey, 'Secret conversation');

      // Recover from mnemonic
      const { accountPrivateKey: recoveredPrivKey } = await recoverAccountFromMnemonic(
        account.recoveryPhrase,
        account.recoveryWrappedPrivateKey
      );
      expect(recoveredPrivKey).toEqual(originalPrivKey);

      // Recovered key can decrypt everything
      const recoveredEpochKey = openWrap(recoveredPrivKey, at(epoch.memberWraps, 0).wrap, epoch, 1);
      expect(readMessage(recoveredEpochKey, msg)).toBe('Secret conversation');

      // Regenerate recovery phrase
      const regen = await regenerateRecoveryPhrase(originalPrivKey);
      expect(regen.recoveryPhrase).not.toBe(account.recoveryPhrase);

      // Old phrase CANNOT decrypt new blob
      await expect(
        recoverAccountFromMnemonic(account.recoveryPhrase, regen.recoveryWrappedPrivateKey)
      ).rejects.toThrow(DecryptionFailedError);

      // New phrase CAN decrypt new blob
      const fromNewPhrase = await recoverAccountFromMnemonic(
        regen.recoveryPhrase,
        regen.recoveryWrappedPrivateKey
      );
      expect(fromNewPhrase.accountPrivateKey).toEqual(originalPrivKey);
    });
  });

  describe('8. Shared link flow', () => {
    it('link holder gets epoch access, wrong secret fails', () => {
      const priv = randomBytes(32);
      const pub = x25519.getPublicKey(priv);

      const epoch = createFirstEpoch([pub], CONVERSATION_ID, 1);
      const msg1 = storeMessage(epoch.epochPublicKey, 'Visible via link');
      const msg2 = storeMessage(epoch.epochPublicKey, 'Also visible');

      // Create shared link
      const link = createSharedLink(epoch.epochPrivateKey, {
        conversationId: CONVERSATION_ID,
        epochNumber: 1,
      });

      // Link holder derives keys from secret
      const linkKeyPair = deriveKeysFromLinkSecret(link.linkSecret);
      expect(linkKeyPair.publicKey).toEqual(link.linkPublicKey);

      // Link holder unwraps epoch key
      const epochKeyFromLink = openWrap(linkKeyPair.privateKey, link.linkWrap, epoch, 1);
      expect(epochKeyFromLink).toEqual(epoch.epochPrivateKey);

      // Link holder decrypts messages
      expect(readMessage(epochKeyFromLink, msg1)).toBe('Visible via link');
      expect(readMessage(epochKeyFromLink, msg2)).toBe('Also visible');

      // Wrong secret derives wrong keys
      const wrongSecret = randomBytes(32);
      const wrongKeyPair = deriveKeysFromLinkSecret(wrongSecret);
      expect(wrongKeyPair.publicKey).not.toEqual(link.linkPublicKey);

      // Wrong secret CANNOT unwrap the link wrap
      expect(() => openWrap(wrongKeyPair.privateKey, link.linkWrap, epoch, 1)).toThrow(
        'Epoch wrap refused: unwrap-failed'
      );
    });
  });

  describe('9. Message share — wrap-once rewrap of content key', () => {
    it('share rewraps the message content key under a shareSecret, same ciphertext decrypts', () => {
      const priv = randomBytes(32);
      const pub = x25519.getPublicKey(priv);

      // Create epoch and store a message (wrap-once)
      const epoch = createFirstEpoch([pub], CONVERSATION_ID, 1);
      const originalText = 'This message will be shared individually';
      const stored = storeMessage(epoch.epochPublicKey, originalText);

      // Member path: unwrap content key via epoch private key
      const epochMemberContentKey = unwrapContentKeyFromEpoch(
        asEpochPrivateKey(epoch.epochPrivateKey),
        stored.wrappedContentKey
      );
      expect(readMessageWithKey(epochMemberContentKey, stored)).toBe(originalText);

      // Owner creates a share: reseals the SAME content key under a new shareSecret
      const share = createShare(epochMemberContentKey);

      // Share recipient: open via shareSecret, decrypt the same ciphertext (no new R2 object, no new blob)
      const shareRecipientKey = openShare(share.shareSecret, share.wrappedShareKey);
      expect(shareRecipientKey).toEqual(epochMemberContentKey);
      // The share-recovered key opens the very envelope the server wrote — the
      // property the public share page depends on.
      expect(readMessageWithKey(shareRecipientKey, stored)).toBe(originalText);

      // The sealed share key is NOT the content key itself
      expect(share.wrappedShareKey).not.toEqual(epochMemberContentKey);

      // Two successive shares of the same content key produce distinct secrets and seals
      const share2 = createShare(epochMemberContentKey);
      expect(share2.shareSecret).not.toEqual(share.shareSecret);
      expect(share2.wrappedShareKey).not.toEqual(share.wrappedShareKey);

      // Wrong shareSecret CANNOT open the seal
      const wrongSecret = asShareSecret(randomBytes(32));
      expect(() => openShare(wrongSecret, share.wrappedShareKey)).toThrow(DecryptionFailedError);
    });
  });

  describe('10. Late-join member via wrapEpochKeyForNewMember', () => {
    it('late-joining member gets current and historical access via chain traversal', () => {
      const alicePriv = randomBytes(32);
      const alicePub = x25519.getPublicKey(alicePriv);
      const bobPriv = randomBytes(32);
      const bobPub = x25519.getPublicKey(bobPriv);

      // Epoch 1: Alice only, store msg1
      const epoch1 = createFirstEpoch([alicePub], CONVERSATION_ID, 1);
      const msg1 = storeMessage(epoch1.epochPublicKey, 'Before Bob joined');

      // Rotate → epoch 2 (still Alice only), store msg2
      const epoch2 = rotate(epoch1, 1, [alicePub], 2);
      const msg2 = storeMessage(epoch2.epochPublicKey, 'Still before Bob');

      // Bob joins: admin wraps epoch 2 key for Bob
      const bobWrap = wrapEpochKeyForNewMember(epoch2.epochPrivateKey, bobPub, {
        conversationId: CONVERSATION_ID,
        epochNumber: 2,
        epochPublicKey: epoch2.epochPublicKey,
      });

      // Bob unwraps epoch 2 key
      const bobEpoch2Key = openWrap(bobPriv, bobWrap, epoch2, 2);
      expect(bobEpoch2Key).toEqual(epoch2.epochPrivateKey);

      // Bob decrypts epoch 2 messages
      expect(readMessage(bobEpoch2Key, msg2)).toBe('Still before Bob');

      // Bob traverses chain link 2→1 to get epoch 1 key
      const bobEpoch1Key = openLink(
        bobEpoch2Key,
        { ...epoch2, epochNumber: 2 },
        { ...epoch1, epochNumber: 1 }
      );
      expect(bobEpoch1Key).toEqual(epoch1.epochPrivateKey);

      // Bob decrypts epoch 1 messages (historical access)
      expect(readMessage(bobEpoch1Key, msg1)).toBe('Before Bob joined');
    });
  });

  describe('11. Password change + recovery phrase independence', () => {
    it('password change does not invalidate recovery phrase', async () => {
      const exportKey1 = randomBytes(64);
      const account = await createAccount(exportKey1);

      const privKey = unwrapAccountKeyWithPassword(exportKey1, account.passwordWrappedPrivateKey);

      // Create epoch and store a message
      const epoch = createFirstEpoch([account.publicKey], CONVERSATION_ID, 1);
      const msg = storeMessage(epoch.epochPublicKey, 'Important data');

      // Change password
      const exportKey2 = randomBytes(64);
      const newPasswordBlob = rewrapAccountKeyForPasswordChange(privKey, exportKey2);

      // New password works
      const privKeyFromNew = unwrapAccountKeyWithPassword(exportKey2, newPasswordBlob);
      expect(privKeyFromNew).toEqual(privKey);

      // Old password CANNOT unwrap new blob
      expect(() => unwrapAccountKeyWithPassword(exportKey1, newPasswordBlob)).toThrow(
        DecryptionFailedError
      );

      // Original recovery phrase STILL works (recovery blob was NOT changed)
      const { accountPrivateKey: recoveredPrivKey } = await recoverAccountFromMnemonic(
        account.recoveryPhrase,
        account.recoveryWrappedPrivateKey
      );
      expect(recoveredPrivKey).toEqual(privKey);

      // Recovered key can decrypt messages
      const epochKey = openWrap(recoveredPrivKey, at(epoch.memberWraps, 0).wrap, epoch, 1);
      expect(readMessage(epochKey, msg)).toBe('Important data');
    });
  });

  describe('12. Link revocation — forward secrecy for links', () => {
    it('revoked link loses forward access but retains historical access', () => {
      const ownerPriv = randomBytes(32);
      const ownerPub = x25519.getPublicKey(ownerPriv);

      // Epoch 1: create conversation with shared link
      const epoch1 = createFirstEpoch([ownerPub], CONVERSATION_ID, 1);
      const msg1 = storeMessage(epoch1.epochPublicKey, 'Visible to link holder');

      // Create shared link for epoch 1
      const link = createSharedLink(epoch1.epochPrivateKey, {
        conversationId: CONVERSATION_ID,
        epochNumber: 1,
      });
      const linkKeyPair = deriveKeysFromLinkSecret(link.linkSecret);

      // Link holder can decrypt epoch 1 messages
      const linkEpoch1Key = openWrap(linkKeyPair.privateKey, link.linkWrap, epoch1, 1);
      expect(readMessage(linkEpoch1Key, msg1)).toBe('Visible to link holder');

      // Revoke link: rotate to epoch 2 WITHOUT including link's public key
      const epoch2 = rotate(epoch1, 1, [ownerPub], 2);
      const msg2 = storeMessage(epoch2.epochPublicKey, 'After link revocation');

      // Owner can decrypt epoch 2 messages
      const ownerEpoch2Key = openWrap(ownerPriv, at(epoch2.memberWraps, 0).wrap, epoch2, 2);
      expect(readMessage(ownerEpoch2Key, msg2)).toBe('After link revocation');

      // Link holder: NO wrap exists for link in epoch 2
      // epoch2.memberWraps only contains owner's wrap
      expect(epoch2.memberWraps).toHaveLength(1);
      expect(() =>
        openWrap(linkKeyPair.privateKey, at(epoch2.memberWraps, 0).wrap, epoch2, 2)
      ).toThrow('Epoch wrap refused: unwrap-failed');

      // Link holder: CAN still decrypt epoch 1 messages with retained key
      expect(readMessage(linkEpoch1Key, msg1)).toBe('Visible to link holder');
    });
  });
});
