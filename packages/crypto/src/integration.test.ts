import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  createAccount,
  unwrapAccountKeyWithPassword,
  recoverAccountFromMnemonic,
  rewrapAccountKeyForPasswordChange,
  regenerateRecoveryPhrase,
} from './account.js';
import {
  createFirstEpoch,
  performEpochRotation,
  unwrapEpochKey,
  traverseChainLink,
  verifyEpochKeyConfirmation,
} from './epoch.js';
import { encryptMessageForStorage, decryptMessage } from './message-encrypt.js';
import { wrapEpochKeyForNewMember } from './member.js';
import { createSharedLink, deriveKeysFromLinkSecret } from './link.js';
import { createMessageShare, decryptMessageShare } from './message-share.js';
import { DecryptionError } from './errors.js';
import { at } from '@hushbox/shared/src/test-utilities.js';

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
      const epoch = createFirstEpoch([account.publicKey]);
      expect(epoch.memberWraps).toHaveLength(1);

      // Unwrap epoch key
      const epochPrivKey = unwrapEpochKey(accountPrivKey, at(epoch.memberWraps, 0).wrap);
      expect(epochPrivKey).toEqual(epoch.epochPrivateKey);

      // Verify epoch key confirmation
      expect(verifyEpochKeyConfirmation(epochPrivKey, epoch.confirmationHash)).toBe(true);

      // Encrypt and decrypt a message
      const blob = encryptMessageForStorage(epoch.epochPublicKey, 'Hello world');
      const decrypted = decryptMessage(epochPrivKey, blob);
      expect(decrypted).toBe('Hello world');
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
      const epoch = createFirstEpoch([alice.publicKey, bob.publicKey]);
      expect(epoch.memberWraps).toHaveLength(2);

      // Both unwrap to same epoch key
      const aliceEpochKey = unwrapEpochKey(alicePriv, at(epoch.memberWraps, 0).wrap);
      const bobEpochKey = unwrapEpochKey(bobPriv, at(epoch.memberWraps, 1).wrap);
      expect(aliceEpochKey).toEqual(bobEpochKey);
      expect(aliceEpochKey).toEqual(epoch.epochPrivateKey);

      // Encrypt 3 messages
      const messages = ['First message', 'Second message', 'Third message with emoji 🎉'];
      const blobs = messages.map((m) => encryptMessageForStorage(epoch.epochPublicKey, m));

      // Both decrypt all 3
      for (const [index, message] of messages.entries()) {
        expect(decryptMessage(aliceEpochKey, at(blobs, index))).toBe(message);
        expect(decryptMessage(bobEpochKey, at(blobs, index))).toBe(message);
      }
    });
  });

  describe('3. Epoch rotation with chain traversal', () => {
    it('new key for new messages, chain link recovers old key for old messages', () => {
      const memberPriv = randomBytes(32);
      const memberPub = x25519.getPublicKey(memberPriv);

      // Epoch 1: encrypt 2 messages
      const epoch1 = createFirstEpoch([memberPub]);
      const msg1 = encryptMessageForStorage(epoch1.epochPublicKey, 'Message in epoch 1');
      const msg2 = encryptMessageForStorage(epoch1.epochPublicKey, 'Another epoch 1 message');

      // Rotate to epoch 2
      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [memberPub]);

      // Encrypt 2 messages in epoch 2
      const msg3 = encryptMessageForStorage(epoch2.epochPublicKey, 'Message in epoch 2');
      const msg4 = encryptMessageForStorage(epoch2.epochPublicKey, 'Another epoch 2 message');

      // Unwrap epoch 2 from member wrap
      const epoch2Key = unwrapEpochKey(memberPriv, at(epoch2.memberWraps, 0).wrap);

      // Decrypt epoch 2 messages
      expect(decryptMessage(epoch2Key, msg3)).toBe('Message in epoch 2');
      expect(decryptMessage(epoch2Key, msg4)).toBe('Another epoch 2 message');

      // Traverse chain link to get epoch 1 key
      const epoch1Key = traverseChainLink(epoch2Key, epoch2.chainLink);
      expect(epoch1Key).toEqual(epoch1.epochPrivateKey);

      // Decrypt epoch 1 messages
      expect(decryptMessage(epoch1Key, msg1)).toBe('Message in epoch 1');
      expect(decryptMessage(epoch1Key, msg2)).toBe('Another epoch 1 message');
    });
  });

  describe('4. Triple rotation — full chain walk', () => {
    it('three rotations, walk entire chain to decrypt all messages', () => {
      const priv = randomBytes(32);
      const pub = x25519.getPublicKey(priv);

      const epoch1 = createFirstEpoch([pub]);
      const msgE1 = encryptMessageForStorage(epoch1.epochPublicKey, 'Epoch 1 content');

      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [pub]);
      const msgE2 = encryptMessageForStorage(epoch2.epochPublicKey, 'Epoch 2 content');

      const epoch3 = performEpochRotation(epoch2.epochPrivateKey, [pub]);
      const msgE3 = encryptMessageForStorage(epoch3.epochPublicKey, 'Epoch 3 content');

      // Start from epoch 3 member wrap
      const key3 = unwrapEpochKey(priv, at(epoch3.memberWraps, 0).wrap);
      expect(decryptMessage(key3, msgE3)).toBe('Epoch 3 content');

      // Traverse 3→2
      const key2 = traverseChainLink(key3, epoch3.chainLink);
      expect(decryptMessage(key2, msgE2)).toBe('Epoch 2 content');

      // Traverse 2→1
      const key1 = traverseChainLink(key2, epoch2.chainLink);
      expect(decryptMessage(key1, msgE1)).toBe('Epoch 1 content');

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
      const epoch1 = createFirstEpoch([alicePub, bobPub]);
      const msg1 = encryptMessageForStorage(epoch1.epochPublicKey, 'Shared message');

      // Both can decrypt epoch 1
      const aliceEpoch1Key = unwrapEpochKey(alicePriv, at(epoch1.memberWraps, 0).wrap);
      const bobEpoch1Key = unwrapEpochKey(bobPriv, at(epoch1.memberWraps, 1).wrap);
      expect(decryptMessage(aliceEpoch1Key, msg1)).toBe('Shared message');
      expect(decryptMessage(bobEpoch1Key, msg1)).toBe('Shared message');

      // Remove Bob: rotate to epoch 2 with only Alice
      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [alicePub]);
      const msg2 = encryptMessageForStorage(epoch2.epochPublicKey, 'Alice-only message');

      // Alice can unwrap epoch 2 and decrypt new message
      const aliceEpoch2Key = unwrapEpochKey(alicePriv, at(epoch2.memberWraps, 0).wrap);
      expect(decryptMessage(aliceEpoch2Key, msg2)).toBe('Alice-only message');

      // Alice can traverse chain to decrypt old message
      const aliceRecoveredKey = traverseChainLink(aliceEpoch2Key, epoch2.chainLink);
      expect(decryptMessage(aliceRecoveredKey, msg1)).toBe('Shared message');

      // Bob: NO wrap exists for Bob in epoch 2
      const bobWraps = epoch2.memberWraps.filter((w) =>
        w.memberPublicKey.every((byte, index) => byte === bobPub[index])
      );
      expect(bobWraps).toHaveLength(0);

      // Bob: CANNOT decrypt epoch 2 messages with his account key
      expect(() => unwrapEpochKey(bobPriv, at(epoch2.memberWraps, 0).wrap)).toThrow(
        DecryptionError
      );

      // Bob: CAN still decrypt epoch 1 messages with his retained epoch 1 key
      expect(decryptMessage(bobEpoch1Key, msg1)).toBe('Shared message');
    });
  });

  describe('6. Password change', () => {
    it('re-wraps account key, old password loses access, all history preserved', async () => {
      const exportKey1 = randomBytes(64);
      const account = await createAccount(exportKey1);

      // Unwrap with original password
      const privKey = unwrapAccountKeyWithPassword(exportKey1, account.passwordWrappedPrivateKey);

      // Create epoch and encrypt messages
      const epoch = createFirstEpoch([account.publicKey]);
      const msg = encryptMessageForStorage(epoch.epochPublicKey, 'Before password change');

      // Change password
      const exportKey2 = randomBytes(64);
      const newPasswordBlob = rewrapAccountKeyForPasswordChange(privKey, exportKey2);

      // New password works
      const privKeyFromNew = unwrapAccountKeyWithPassword(exportKey2, newPasswordBlob);
      expect(privKeyFromNew).toEqual(privKey);

      // Decrypt messages with same account key
      const epochKey = unwrapEpochKey(privKeyFromNew, at(epoch.memberWraps, 0).wrap);
      expect(decryptMessage(epochKey, msg)).toBe('Before password change');

      // Old password CANNOT unwrap new blob
      expect(() => unwrapAccountKeyWithPassword(exportKey1, newPasswordBlob)).toThrow(
        DecryptionError
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

      // Create epoch and encrypt messages
      const epoch = createFirstEpoch([account.publicKey]);
      const msg = encryptMessageForStorage(epoch.epochPublicKey, 'Secret conversation');

      // Recover from mnemonic
      const recoveredPrivKey = await recoverAccountFromMnemonic(
        account.recoveryPhrase,
        account.recoveryWrappedPrivateKey
      );
      expect(recoveredPrivKey).toEqual(originalPrivKey);

      // Recovered key can decrypt everything
      const recoveredEpochKey = unwrapEpochKey(recoveredPrivKey, at(epoch.memberWraps, 0).wrap);
      expect(decryptMessage(recoveredEpochKey, msg)).toBe('Secret conversation');

      // Regenerate recovery phrase
      const regen = await regenerateRecoveryPhrase(originalPrivKey);
      expect(regen.recoveryPhrase).not.toBe(account.recoveryPhrase);

      // Old phrase CANNOT decrypt new blob
      await expect(
        recoverAccountFromMnemonic(account.recoveryPhrase, regen.recoveryWrappedPrivateKey)
      ).rejects.toThrow(DecryptionError);

      // New phrase CAN decrypt new blob
      const fromNewPhrase = await recoverAccountFromMnemonic(
        regen.recoveryPhrase,
        regen.recoveryWrappedPrivateKey
      );
      expect(fromNewPhrase).toEqual(originalPrivKey);
    });
  });

  describe('8. Shared link flow', () => {
    it('link holder gets epoch access, wrong secret fails', () => {
      const priv = randomBytes(32);
      const pub = x25519.getPublicKey(priv);

      const epoch = createFirstEpoch([pub]);
      const msg1 = encryptMessageForStorage(epoch.epochPublicKey, 'Visible via link');
      const msg2 = encryptMessageForStorage(epoch.epochPublicKey, 'Also visible');

      // Create shared link
      const link = createSharedLink(epoch.epochPrivateKey);

      // Link holder derives keys from secret
      const linkKeyPair = deriveKeysFromLinkSecret(link.linkSecret);
      expect(linkKeyPair.publicKey).toEqual(link.linkPublicKey);

      // Link holder unwraps epoch key
      const epochKeyFromLink = unwrapEpochKey(linkKeyPair.privateKey, link.linkWrap);
      expect(epochKeyFromLink).toEqual(epoch.epochPrivateKey);

      // Link holder decrypts messages
      expect(decryptMessage(epochKeyFromLink, msg1)).toBe('Visible via link');
      expect(decryptMessage(epochKeyFromLink, msg2)).toBe('Also visible');

      // Wrong secret derives wrong keys
      const wrongSecret = randomBytes(32);
      const wrongKeyPair = deriveKeysFromLinkSecret(wrongSecret);
      expect(wrongKeyPair.publicKey).not.toEqual(link.linkPublicKey);

      // Wrong secret CANNOT unwrap the link wrap
      expect(() => unwrapEpochKey(wrongKeyPair.privateKey, link.linkWrap)).toThrow(DecryptionError);
    });
  });

  describe('9. Message share — cryptographic isolation', () => {
    it('share uses independent encryption, isolated from epoch keys', () => {
      const priv = randomBytes(32);
      const pub = x25519.getPublicKey(priv);

      // Create epoch and encrypt a message
      const epoch = createFirstEpoch([pub]);
      const originalText = 'This message will be shared individually';
      const epochBlob = encryptMessageForStorage(epoch.epochPublicKey, originalText);

      // Decrypt to get plaintext
      const decrypted = decryptMessage(epoch.epochPrivateKey, epochBlob);
      expect(decrypted).toBe(originalText);

      // Create message share from plaintext
      const share = createMessageShare(decrypted);

      // Share holder decrypts
      const fromShare = decryptMessageShare(share.shareSecret, share.shareBlob);
      expect(fromShare).toBe(originalText);

      // Epoch private key CANNOT decrypt shareBlob (different scheme: symmetric vs ECIES)
      // shareBlob is symmetric (nonce||ct||tag), not ECIES (0x01||eph||ct||tag)
      // Attempting ECIES decrypt will fail due to format mismatch
      expect(() => decryptMessage(epoch.epochPrivateKey, share.shareBlob)).toThrow();

      // shareSecret has no relationship to epoch keys (randomly generated)
      // Prove: different share of same text produces different secret
      const share2 = createMessageShare(decrypted);
      expect(share2.shareSecret).not.toEqual(share.shareSecret);
      expect(share2.shareBlob).not.toEqual(share.shareBlob);

      // Wrong shareSecret CANNOT decrypt
      const wrongSecret = randomBytes(32);
      expect(() => decryptMessageShare(wrongSecret, share.shareBlob)).toThrow(DecryptionError);
    });
  });

  describe('10. Late-join member via wrapEpochKeyForNewMember', () => {
    it('late-joining member gets current and historical access via chain traversal', () => {
      const alicePriv = randomBytes(32);
      const alicePub = x25519.getPublicKey(alicePriv);
      const bobPriv = randomBytes(32);
      const bobPub = x25519.getPublicKey(bobPriv);

      // Epoch 1: Alice only, encrypt msg1
      const epoch1 = createFirstEpoch([alicePub]);
      const msg1 = encryptMessageForStorage(epoch1.epochPublicKey, 'Before Bob joined');

      // Rotate → epoch 2 (still Alice only), encrypt msg2
      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [alicePub]);
      const msg2 = encryptMessageForStorage(epoch2.epochPublicKey, 'Still before Bob');

      // Bob joins: admin wraps epoch 2 key for Bob
      const bobWrap = wrapEpochKeyForNewMember(epoch2.epochPrivateKey, bobPub);

      // Bob unwraps epoch 2 key
      const bobEpoch2Key = unwrapEpochKey(bobPriv, bobWrap);
      expect(bobEpoch2Key).toEqual(epoch2.epochPrivateKey);

      // Bob decrypts epoch 2 messages
      expect(decryptMessage(bobEpoch2Key, msg2)).toBe('Still before Bob');

      // Bob traverses chain link 2→1 to get epoch 1 key
      const bobEpoch1Key = traverseChainLink(bobEpoch2Key, epoch2.chainLink);
      expect(bobEpoch1Key).toEqual(epoch1.epochPrivateKey);

      // Bob decrypts epoch 1 messages (historical access)
      expect(decryptMessage(bobEpoch1Key, msg1)).toBe('Before Bob joined');
    });
  });

  describe('11. Password change + recovery phrase independence', () => {
    it('password change does not invalidate recovery phrase', async () => {
      const exportKey1 = randomBytes(64);
      const account = await createAccount(exportKey1);

      const privKey = unwrapAccountKeyWithPassword(exportKey1, account.passwordWrappedPrivateKey);

      // Create epoch and encrypt a message
      const epoch = createFirstEpoch([account.publicKey]);
      const msg = encryptMessageForStorage(epoch.epochPublicKey, 'Important data');

      // Change password
      const exportKey2 = randomBytes(64);
      const newPasswordBlob = rewrapAccountKeyForPasswordChange(privKey, exportKey2);

      // New password works
      const privKeyFromNew = unwrapAccountKeyWithPassword(exportKey2, newPasswordBlob);
      expect(privKeyFromNew).toEqual(privKey);

      // Old password CANNOT unwrap new blob
      expect(() => unwrapAccountKeyWithPassword(exportKey1, newPasswordBlob)).toThrow(
        DecryptionError
      );

      // Original recovery phrase STILL works (recovery blob was NOT changed)
      const recoveredPrivKey = await recoverAccountFromMnemonic(
        account.recoveryPhrase,
        account.recoveryWrappedPrivateKey
      );
      expect(recoveredPrivKey).toEqual(privKey);

      // Recovered key can decrypt messages
      const epochKey = unwrapEpochKey(recoveredPrivKey, at(epoch.memberWraps, 0).wrap);
      expect(decryptMessage(epochKey, msg)).toBe('Important data');
    });
  });

  describe('12. Link revocation — forward secrecy for links', () => {
    it('revoked link loses forward access but retains historical access', () => {
      const ownerPriv = randomBytes(32);
      const ownerPub = x25519.getPublicKey(ownerPriv);

      // Epoch 1: create conversation with shared link
      const epoch1 = createFirstEpoch([ownerPub]);
      const msg1 = encryptMessageForStorage(epoch1.epochPublicKey, 'Visible to link holder');

      // Create shared link for epoch 1
      const link = createSharedLink(epoch1.epochPrivateKey);
      const linkKeyPair = deriveKeysFromLinkSecret(link.linkSecret);

      // Link holder can decrypt epoch 1 messages
      const linkEpoch1Key = unwrapEpochKey(linkKeyPair.privateKey, link.linkWrap);
      expect(decryptMessage(linkEpoch1Key, msg1)).toBe('Visible to link holder');

      // Revoke link: rotate to epoch 2 WITHOUT including link's public key
      const epoch2 = performEpochRotation(epoch1.epochPrivateKey, [ownerPub]);
      const msg2 = encryptMessageForStorage(epoch2.epochPublicKey, 'After link revocation');

      // Owner can decrypt epoch 2 messages
      const ownerEpoch2Key = unwrapEpochKey(ownerPriv, at(epoch2.memberWraps, 0).wrap);
      expect(decryptMessage(ownerEpoch2Key, msg2)).toBe('After link revocation');

      // Link holder: NO wrap exists for link in epoch 2
      // epoch2.memberWraps only contains owner's wrap
      expect(epoch2.memberWraps).toHaveLength(1);
      expect(() => unwrapEpochKey(linkKeyPair.privateKey, at(epoch2.memberWraps, 0).wrap)).toThrow(
        DecryptionError
      );

      // Link holder: CAN still decrypt epoch 1 messages with retained key
      expect(decryptMessage(linkEpoch1Key, msg1)).toBe('Visible to link holder');
    });
  });
});
