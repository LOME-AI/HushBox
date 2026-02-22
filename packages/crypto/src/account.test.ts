import { describe, it, expect } from 'vitest';
import {
  createAccount,
  unwrapAccountKeyWithPassword,
  recoverAccountFromMnemonic,
  rewrapAccountKeyForPasswordChange,
  regenerateRecoveryPhrase,
} from './account.js';
import { validatePhrase } from './recovery-phrase.js';
import { randomBytes } from '@noble/hashes/utils.js';

describe('account', () => {
  const exportKey = randomBytes(64);

  describe('createAccount', () => {
    it('returns publicKey, passwordWrappedPrivateKey, recoveryWrappedPrivateKey, recoveryPhrase', async () => {
      const result = await createAccount(exportKey);

      expect(result.publicKey).toBeInstanceOf(Uint8Array);
      expect(result.publicKey.length).toBe(32);
      expect(result.passwordWrappedPrivateKey).toBeInstanceOf(Uint8Array);
      expect(result.recoveryWrappedPrivateKey).toBeInstanceOf(Uint8Array);
      expect(typeof result.recoveryPhrase).toBe('string');
    });

    it('generates a valid 12-word recovery phrase', async () => {
      const result = await createAccount(exportKey);

      expect(result.recoveryPhrase.split(' ').length).toBe(12);
      expect(validatePhrase(result.recoveryPhrase)).toBe(true);
    });

    it('generates unique key pairs on each call', async () => {
      const result1 = await createAccount(exportKey);
      const result2 = await createAccount(exportKey);

      expect(result1.publicKey).not.toEqual(result2.publicKey);
    });

    it('password-wrapped blob is decryptable with same export key', async () => {
      const result = await createAccount(exportKey);
      const privateKey = unwrapAccountKeyWithPassword(exportKey, result.passwordWrappedPrivateKey);

      expect(privateKey).toBeInstanceOf(Uint8Array);
      expect(privateKey.length).toBe(32);
    });

    it('recovery-wrapped blob is decryptable with recovery phrase', async () => {
      const result = await createAccount(exportKey);
      const privateKey = await recoverAccountFromMnemonic(
        result.recoveryPhrase,
        result.recoveryWrappedPrivateKey
      );

      expect(privateKey).toBeInstanceOf(Uint8Array);
      expect(privateKey.length).toBe(32);
    });

    it('both unwrap methods yield the same private key', async () => {
      const result = await createAccount(exportKey);

      const fromPassword = unwrapAccountKeyWithPassword(
        exportKey,
        result.passwordWrappedPrivateKey
      );
      const fromRecovery = await recoverAccountFromMnemonic(
        result.recoveryPhrase,
        result.recoveryWrappedPrivateKey
      );

      expect(fromPassword).toEqual(fromRecovery);
    });

    it('unwrapped private key derives the returned public key', async () => {
      const result = await createAccount(exportKey);
      const privateKey = unwrapAccountKeyWithPassword(exportKey, result.passwordWrappedPrivateKey);

      const { x25519 } = await import('@noble/curves/ed25519.js');
      const derivedPub = x25519.getPublicKey(privateKey);
      expect(derivedPub).toEqual(result.publicKey);
    });
  });

  describe('unwrapAccountKeyWithPassword', () => {
    it('decrypts password-wrapped private key', async () => {
      const result = await createAccount(exportKey);

      const privateKey = unwrapAccountKeyWithPassword(exportKey, result.passwordWrappedPrivateKey);

      expect(privateKey.length).toBe(32);
    });

    it('throws with wrong export key', async () => {
      const result = await createAccount(exportKey);
      const wrongExportKey = randomBytes(64);

      expect(() =>
        unwrapAccountKeyWithPassword(wrongExportKey, result.passwordWrappedPrivateKey)
      ).toThrow();
    });
  });

  describe('recoverAccountFromMnemonic', () => {
    it('recovers private key from mnemonic', async () => {
      const result = await createAccount(exportKey);

      const privateKey = await recoverAccountFromMnemonic(
        result.recoveryPhrase,
        result.recoveryWrappedPrivateKey
      );

      expect(privateKey.length).toBe(32);
    });

    it('throws with wrong mnemonic', async () => {
      const result = await createAccount(exportKey);
      const otherAccount = await createAccount(randomBytes(64));

      await expect(
        recoverAccountFromMnemonic(otherAccount.recoveryPhrase, result.recoveryWrappedPrivateKey)
      ).rejects.toThrow();
    });
  });

  describe('rewrapAccountKeyForPasswordChange', () => {
    it('returns a new password-wrapped blob', async () => {
      const result = await createAccount(exportKey);
      const privateKey = unwrapAccountKeyWithPassword(exportKey, result.passwordWrappedPrivateKey);

      const newExportKey = randomBytes(64);
      const newWrappedBlob = rewrapAccountKeyForPasswordChange(privateKey, newExportKey);

      expect(newWrappedBlob).toBeInstanceOf(Uint8Array);
    });

    it('new blob is decryptable with new export key', async () => {
      const result = await createAccount(exportKey);
      const privateKey = unwrapAccountKeyWithPassword(exportKey, result.passwordWrappedPrivateKey);

      const newExportKey = randomBytes(64);
      const newWrappedBlob = rewrapAccountKeyForPasswordChange(privateKey, newExportKey);

      const unwrapped = unwrapAccountKeyWithPassword(newExportKey, newWrappedBlob);
      expect(unwrapped).toEqual(privateKey);
    });

    it('old export key cannot decrypt new blob', async () => {
      const result = await createAccount(exportKey);
      const privateKey = unwrapAccountKeyWithPassword(exportKey, result.passwordWrappedPrivateKey);

      const newExportKey = randomBytes(64);
      const newWrappedBlob = rewrapAccountKeyForPasswordChange(privateKey, newExportKey);

      expect(() => unwrapAccountKeyWithPassword(exportKey, newWrappedBlob)).toThrow();
    });
  });

  describe('regenerateRecoveryPhrase', () => {
    it('returns a new recovery phrase and wrapped blob', async () => {
      const result = await createAccount(exportKey);
      const privateKey = unwrapAccountKeyWithPassword(exportKey, result.passwordWrappedPrivateKey);

      const regen = await regenerateRecoveryPhrase(privateKey);

      expect(typeof regen.recoveryPhrase).toBe('string');
      expect(regen.recoveryPhrase.split(' ').length).toBe(12);
      expect(validatePhrase(regen.recoveryPhrase)).toBe(true);
      expect(regen.recoveryWrappedPrivateKey).toBeInstanceOf(Uint8Array);
    });

    it('new recovery phrase differs from original', async () => {
      const result = await createAccount(exportKey);
      const privateKey = unwrapAccountKeyWithPassword(exportKey, result.passwordWrappedPrivateKey);

      const regen = await regenerateRecoveryPhrase(privateKey);

      expect(regen.recoveryPhrase).not.toBe(result.recoveryPhrase);
    });

    it('new blob is decryptable with new recovery phrase', async () => {
      const result = await createAccount(exportKey);
      const privateKey = unwrapAccountKeyWithPassword(exportKey, result.passwordWrappedPrivateKey);

      const regen = await regenerateRecoveryPhrase(privateKey);
      const recovered = await recoverAccountFromMnemonic(
        regen.recoveryPhrase,
        regen.recoveryWrappedPrivateKey
      );

      expect(recovered).toEqual(privateKey);
    });

    it('old recovery phrase cannot decrypt new blob', async () => {
      const result = await createAccount(exportKey);
      const privateKey = unwrapAccountKeyWithPassword(exportKey, result.passwordWrappedPrivateKey);

      const regen = await regenerateRecoveryPhrase(privateKey);

      await expect(
        recoverAccountFromMnemonic(result.recoveryPhrase, regen.recoveryWrappedPrivateKey)
      ).rejects.toThrow();
    });
  });
});
