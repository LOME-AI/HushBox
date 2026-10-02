import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  createAccount,
  unwrapAccountKeyWithPassword,
  recoverAccountFromMnemonic,
  rewrapAccountKeyForPasswordChange,
  regenerateRecoveryPhrase,
} from './account.js';
import { phraseToSeed, validatePhrase } from './recovery/phrase.js';
import { deriveRecoveryKeyPair } from './primitives/key-derivation.js';
import { asWrappingPublicKey } from './primitives/keys.js';
import { DecryptionFailedError, InvalidKeyError } from './errors.js';
import {
  RESET_CHALLENGE_NONCE_BYTES,
  openResetChallenge,
  sealResetChallenge,
} from './recovery/challenge.js';

/**
 * Argon2id has exactly one call site in the repo (`key-derivation.ts`), so
 * counting it here is what makes the web client's derivation count meaningful:
 * one `recoverAccountFromMnemonic` per reset must mean one 64 MiB derivation on
 * the user's device.
 */
const { argon2 } = vi.hoisted(() => ({ argon2: { calls: 0 } }));

vi.mock('hash-wasm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hash-wasm')>();
  return {
    ...actual,
    argon2id: (...args: Parameters<typeof actual.argon2id>) => {
      argon2.calls += 1;
      return actual.argon2id(...args);
    },
  };
});

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
      const { accountPrivateKey } = await recoverAccountFromMnemonic(
        result.recoveryPhrase,
        result.recoveryWrappedPrivateKey
      );

      expect(accountPrivateKey).toBeInstanceOf(Uint8Array);
      expect(accountPrivateKey.length).toBe(32);
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

      expect(fromPassword).toEqual(fromRecovery.accountPrivateKey);
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
      ).toThrow(DecryptionFailedError);
    });
  });

  describe('recoverAccountFromMnemonic', () => {
    it('recovers private key from mnemonic', async () => {
      const result = await createAccount(exportKey);

      const { accountPrivateKey } = await recoverAccountFromMnemonic(
        result.recoveryPhrase,
        result.recoveryWrappedPrivateKey
      );

      expect(accountPrivateKey.length).toBe(32);
    });

    it('throws with wrong mnemonic', async () => {
      const result = await createAccount(exportKey);
      const otherAccount = await createAccount(randomBytes(64));

      await expect(
        recoverAccountFromMnemonic(otherAccount.recoveryPhrase, result.recoveryWrappedPrivateKey)
      ).rejects.toThrow(DecryptionFailedError);
    });

    it('runs exactly one Argon2id derivation', async () => {
      const result = await createAccount(exportKey);
      argon2.calls = 0;

      await recoverAccountFromMnemonic(result.recoveryPhrase, result.recoveryWrappedPrivateKey);

      expect(argon2.calls).toBe(1);
    });

    it('returns the recovery private key that opens a challenge sealed to the account', async () => {
      const result = await createAccount(exportKey);
      const nonce = randomBytes(RESET_CHALLENGE_NONCE_BYTES);
      const sealed = sealResetChallenge(asWrappingPublicKey(result.recoveryPublicKey), nonce);

      const recovered = await recoverAccountFromMnemonic(
        result.recoveryPhrase,
        result.recoveryWrappedPrivateKey
      );

      expect(openResetChallenge(recovered.recoveryPrivateKey, sealed)).toEqual(nonce);
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

      expect(() => unwrapAccountKeyWithPassword(exportKey, newWrappedBlob)).toThrow(
        DecryptionFailedError
      );
    });

    it('refuses a zeroed account key', () => {
      expect(() => rewrapAccountKeyForPasswordChange(new Uint8Array(32), randomBytes(64))).toThrow(
        InvalidKeyError
      );
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

      expect(recovered.accountPrivateKey).toEqual(privateKey);
    });

    it('old recovery phrase cannot decrypt new blob', async () => {
      const result = await createAccount(exportKey);
      const privateKey = unwrapAccountKeyWithPassword(exportKey, result.passwordWrappedPrivateKey);

      const regen = await regenerateRecoveryPhrase(privateKey);

      await expect(
        recoverAccountFromMnemonic(result.recoveryPhrase, regen.recoveryWrappedPrivateKey)
      ).rejects.toThrow(DecryptionFailedError);
    });

    it('refuses a zeroed account key', async () => {
      await expect(regenerateRecoveryPhrase(new Uint8Array(32))).rejects.toThrow(InvalidKeyError);
    });
  });
});

describe('createAccount recovery public key', () => {
  it('returns the public half of the keypair the recovery phrase derives', async () => {
    const account = await createAccount(randomBytes(64));

    const seed = await phraseToSeed(account.recoveryPhrase);
    const derived = await deriveRecoveryKeyPair(seed);

    expect(account.recoveryPublicKey).toEqual(derived.publicKey);
  });

  it('derives a distinct recovery public key per account', async () => {
    const first = await createAccount(randomBytes(64));
    const second = await createAccount(randomBytes(64));

    expect(first.recoveryPublicKey).not.toEqual(second.recoveryPublicKey);
  });
});

describe('regenerateRecoveryPhrase recovery public key', () => {
  const exportKey = randomBytes(64);

  async function regenerate(): Promise<{
    account: Awaited<ReturnType<typeof createAccount>>;
    regen: Awaited<ReturnType<typeof regenerateRecoveryPhrase>>;
  }> {
    const account = await createAccount(exportKey);
    const privateKey = unwrapAccountKeyWithPassword(exportKey, account.passwordWrappedPrivateKey);
    return { account, regen: await regenerateRecoveryPhrase(privateKey) };
  }

  it('returns the public half of the keypair the new recovery phrase derives', async () => {
    const { regen } = await regenerate();

    const derived = await deriveRecoveryKeyPair(await phraseToSeed(regen.recoveryPhrase));

    expect(regen.recoveryPublicKey).toEqual(derived.publicKey);
  });

  it('returns a public key the superseded recovery phrase does not derive', async () => {
    const { account, regen } = await regenerate();

    expect(regen.recoveryPublicKey).not.toEqual(account.recoveryPublicKey);
  });
});
