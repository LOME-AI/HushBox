import { describe, it, expect, vi } from 'vitest';
import { generateSync } from 'otplib';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concatBytes, randomBytes } from '@noble/hashes/utils.js';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { expectCompileTimeProof } from '@hushbox/shared/test-assertions';
import {
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  decryptTotpSecret,
  generateTotpSecret,
  generateTotpUri,
  verifyTotpCode,
  generateTotpCodeSync,
  decryptAndVerifyTotp,
  totpKeyFingerprint,
} from './totp.js';
import {
  CryptoError,
  DecryptionFailedError,
  MalformedBlobError,
  UnknownKeyVersionError,
} from './errors.js';
import { FINGERPRINT_BYTES, fingerprintOf } from './primitives/fingerprint.js';
import { BLOB_FORMAT_VERSION, NONCE_BYTES, TAG_BYTES, utf8Field } from './primitives/format.js';
import { bytesToHex } from './primitives/hash.js';
import { generateContentKey } from './primitives/keys.js';
import { sealWithKey } from './wrap/seal.js';
import { DERIVE_LABELS, SEAL_LABELS } from './wrap/labels.js';

const TEST_ENCRYPTION_SECRET = new Uint8Array(32).fill(1);
const OTHER_ENCRYPTION_SECRET = new Uint8Array(32).fill(2);
const USER_ID = testUuidV7(1);
const OTHER_USER_ID = testUuidV7(2);
/** Nonce width of the superseded unlabelled symmetric path, reproduced below. */
const SUPERSEDED_NONCE_BYTES = 24;

describe('totp', () => {
  describe('deriveTotpEncryptionKey', () => {
    it('derives a 32-byte encryption key', () => {
      const key = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);

      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it('produces consistent key for same encryption secret', () => {
      const key1 = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
      const key2 = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);

      expect(key1).toEqual(key2);
    });

    it('produces different keys for different encryption secrets', () => {
      const key1 = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
      const key2 = deriveTotpEncryptionKey(OTHER_ENCRYPTION_SECRET);

      expect(key1).not.toEqual(key2);
    });

    it('reproduces the pinned vector, so stored secrets stay decryptable', () => {
      // Every stored two-factor secret is encrypted under this key. Any change
      // to the derivation — including moving the label between the HKDF salt
      // and info slots — makes every one of them undecryptable.
      expect(bytesToHex(deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET))).toBe(
        '8d70bbce047233432dc242fee09fd38b95f53eb102fd470f77ac0495b61c285a'
      );
    });
  });

  describe('generateTotpSecret', () => {
    it('returns a base32 encoded string', () => {
      const secret = generateTotpSecret();

      expect(typeof secret).toBe('string');
      expect(secret.length).toBeGreaterThan(0);
      expect(secret).toMatch(/^[A-Z2-7]+$/);
    });

    it('generates unique secrets', () => {
      const secret1 = generateTotpSecret();
      const secret2 = generateTotpSecret();

      expect(secret1).not.toBe(secret2);
    });
  });

  describe('totpKeyFingerprint', () => {
    it('is the fingerprint of the key under the TOTP key label', () => {
      const key = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);

      expect(totpKeyFingerprint(key)).toEqual(fingerprintOf(key, DERIVE_LABELS.totpKeyFingerprint));
      expect(totpKeyFingerprint(key)).toHaveLength(FINGERPRINT_BYTES);
    });
  });

  describe('encryptTotpSecret / decryptTotpSecret', () => {
    it('encrypts and decrypts a secret correctly', () => {
      const originalSecret = generateTotpSecret();
      const encryptionKey = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);

      const blob = encryptTotpSecret(encryptionKey, USER_ID, originalSecret);
      const decrypted = decryptTotpSecret(encryptionKey, USER_ID, blob);

      expect(decrypted).toBe(originalSecret);
    });

    it('returns a Uint8Array blob', () => {
      const secret = generateTotpSecret();
      const encryptionKey = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);

      const blob = encryptTotpSecret(encryptionKey, USER_ID, secret);

      expect(blob).toBeInstanceOf(Uint8Array);
    });

    it('lays the blob out as the key fingerprint followed by the sealed secret', () => {
      const secret = generateTotpSecret();
      const encryptionKey = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);

      const blob = encryptTotpSecret(encryptionKey, USER_ID, secret);

      expect(blob.subarray(0, FINGERPRINT_BYTES)).toEqual(totpKeyFingerprint(encryptionKey));
      expect(blob.at(FINGERPRINT_BYTES)).toBe(BLOB_FORMAT_VERSION);
      expect(blob.length).toBe(FINGERPRINT_BYTES + 1 + NONCE_BYTES + secret.length + TAG_BYTES);
    });

    it('produces different ciphertext for same input (random nonce)', () => {
      const secret = generateTotpSecret();
      const encryptionKey = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);

      const blob1 = encryptTotpSecret(encryptionKey, USER_ID, secret);
      const blob2 = encryptTotpSecret(encryptionKey, USER_ID, secret);

      expect(blob1).not.toEqual(blob2);
    });

    it('throws UnknownKeyVersionError, carrying the blob fingerprint, under another key', () => {
      const secret = generateTotpSecret();
      const encryptionKey = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
      const otherKey = deriveTotpEncryptionKey(OTHER_ENCRYPTION_SECRET);
      const blob = encryptTotpSecret(encryptionKey, USER_ID, secret);

      let thrown: unknown;
      try {
        decryptTotpSecret(otherKey, USER_ID, blob);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CryptoError);
      expect(thrown).toBeInstanceOf(UnknownKeyVersionError);
      expect((thrown as UnknownKeyVersionError).fingerprint).toEqual(
        totpKeyFingerprint(encryptionKey)
      );
    });

    it('refuses a blob sealed for another user, under the same key', () => {
      const secret = generateTotpSecret();
      const encryptionKey = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);

      const blob = encryptTotpSecret(encryptionKey, USER_ID, secret);

      expect(() => decryptTotpSecret(encryptionKey, OTHER_USER_ID, blob)).toThrow(
        DecryptionFailedError
      );
    });

    it('refuses a blob whose fingerprint was substituted, before touching the ciphertext', () => {
      const secret = generateTotpSecret();
      const encryptionKey = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
      const blob = new Uint8Array(encryptTotpSecret(encryptionKey, USER_ID, secret));
      blob[0] = (blob[0] ?? 0) ^ 0x01;

      expect(() => decryptTotpSecret(encryptionKey, USER_ID, blob)).toThrow(UnknownKeyVersionError);
    });

    it('refuses a blob written by the superseded unlabelled symmetric path', () => {
      const secret = generateTotpSecret();
      const encryptionKey = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);

      // The superseded path wrote `nonce ‖ XChaCha20-Poly1305 under the raw
      // key` — no key fingerprint, no domain label, no AAD. Its leading bytes
      // are pinned to the values the framing checks accept, so the blob
      // reaches the AEAD and is refused by the seal's derivation rather than
      // by a length or fingerprint gate.
      const nonce = randomBytes(SUPERSEDED_NONCE_BYTES);
      nonce.set(totpKeyFingerprint(encryptionKey), 0);
      nonce[FINGERPRINT_BYTES] = BLOB_FORMAT_VERSION;
      const supersededBlob = concatBytes(
        nonce,
        xchacha20poly1305(encryptionKey, nonce).encrypt(new TextEncoder().encode(secret))
      );

      expect(() => decryptTotpSecret(encryptionKey, USER_ID, supersededBlob)).toThrow(
        DecryptionFailedError
      );
    });

    it('refuses an empty blob', () => {
      const encryptionKey = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);

      expect(() => decryptTotpSecret(encryptionKey, USER_ID, new Uint8Array(0))).toThrow(
        MalformedBlobError
      );
    });

    it('refuses a blob shorter than a fingerprint', () => {
      const encryptionKey = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);

      expect(() =>
        decryptTotpSecret(encryptionKey, USER_ID, randomBytes(FINGERPRINT_BYTES - 1))
      ).toThrow(MalformedBlobError);
    });

    /**
     * Pins the AAD bytes themselves. The positive half fixes the encoding as
     * `utf8Field(userId) ‖ fingerprint`; the negative half proves the
     * fingerprint is authenticated rather than merely read, so a substituted
     * fingerprint can never select a different key.
     */
    describe('AAD binding', () => {
      const totpAad = (userId: string, fingerprint: Uint8Array): Uint8Array =>
        concatBytes(utf8Field(userId), fingerprint);

      it('opens a blob sealed under the pinned AAD encoding', () => {
        const secret = generateTotpSecret();
        const encryptionKey = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
        const fingerprint = totpKeyFingerprint(encryptionKey);
        const sealed = sealWithKey(
          encryptionKey,
          new TextEncoder().encode(secret),
          SEAL_LABELS.totpSecretServer,
          totpAad(USER_ID, fingerprint)
        );

        const blob = concatBytes(fingerprint, sealed);

        expect(decryptTotpSecret(encryptionKey, USER_ID, blob)).toBe(secret);
      });

      it('refuses a blob whose AAD names a different fingerprint', () => {
        const secret = generateTotpSecret();
        const encryptionKey = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
        const fingerprint = totpKeyFingerprint(encryptionKey);
        const sealed = sealWithKey(
          encryptionKey,
          new TextEncoder().encode(secret),
          SEAL_LABELS.totpSecretServer,
          totpAad(USER_ID, totpKeyFingerprint(deriveTotpEncryptionKey(OTHER_ENCRYPTION_SECRET)))
        );

        const blob = concatBytes(fingerprint, sealed);

        expect(() => decryptTotpSecret(encryptionKey, USER_ID, blob)).toThrow(
          DecryptionFailedError
        );
      });
    });

    /**
     * Type test: the @ts-expect-error line asserts the marked call DOES NOT
     * compile. If another symmetric key class ever became assignable to
     * `TotpEncryptionKey`, the directive would be flagged unused and
     * `pnpm typecheck` would fail.
     */
    it('rejects a content key where the TOTP key is expected (compile-time)', () => {
      const contentKeyAsTotpKey = (): Uint8Array =>
        // @ts-expect-error — ContentKey is not assignable to TotpEncryptionKey
        encryptTotpSecret(generateContentKey(), USER_ID, generateTotpSecret());
      expectCompileTimeProof(contentKeyAsTotpKey);
    });
  });

  describe('generateTotpUri', () => {
    it('generates valid otpauth URI', () => {
      const secret = generateTotpSecret();
      const accountLabel = 'user@example.com';

      const uri = generateTotpUri(accountLabel, secret);

      expect(uri).toContain('otpauth://totp/');
      expect(uri).toContain('HushBox');
      expect(uri).toContain(encodeURIComponent(accountLabel));
      expect(uri).toContain(`secret=${secret}`);
    });

    it('encodes special characters in account label', () => {
      const secret = generateTotpSecret();
      const accountLabel = 'user+test@example.com';

      const uri = generateTotpUri(accountLabel, secret);

      expect(uri).toContain(encodeURIComponent(accountLabel));
    });
  });

  describe('verifyTotpCode', () => {
    it('returns false for invalid code format', async () => {
      const secret = generateTotpSecret();

      expect(await verifyTotpCode('invalid', secret)).toBe(false);
      expect(await verifyTotpCode('12345', secret)).toBe(false);
      expect(await verifyTotpCode('1234567', secret)).toBe(false);
    });

    it('returns false for wrong code', async () => {
      const secret = generateTotpSecret();

      // Very unlikely to be the current valid code
      expect(await verifyTotpCode('000000', secret)).toBe(false);
    });

    it('returns true for a valid code generated by generateTotpCodeSync', async () => {
      const secret = generateTotpSecret();
      const code = generateTotpCodeSync(secret);

      expect(await verifyTotpCode(code, secret)).toBe(true);
    });

    it('accepts a code from the previous time step (30-second tolerance)', async () => {
      const secret = generateTotpSecret();
      const previousEpoch = Math.floor(Date.now() / 1000) - 30;
      const previousCode = generateSync({ secret, epoch: previousEpoch });

      expect(await verifyTotpCode(previousCode, secret)).toBe(true);
    });

    it('accepts a code from the next time step (30-second tolerance)', async () => {
      const secret = generateTotpSecret();
      const nextEpoch = Math.floor(Date.now() / 1000) + 30;
      const nextCode = generateSync({ secret, epoch: nextEpoch });

      expect(await verifyTotpCode(nextCode, secret)).toBe(true);
    });

    it('rejects a code from two time steps ago (outside tolerance)', async () => {
      const secret = generateTotpSecret();
      const oldEpoch = Math.floor(Date.now() / 1000) - 90;
      const oldCode = generateSync({ secret, epoch: oldEpoch });

      expect(await verifyTotpCode(oldCode, secret)).toBe(false);
    });
  });

  describe('generateTotpCodeSync', () => {
    it('returns a 6-digit numeric string', () => {
      const secret = generateTotpSecret();
      const code = generateTotpCodeSync(secret);

      expect(typeof code).toBe('string');
      expect(code).toMatch(/^\d{6}$/);
    });

    it('returns the same code for same secret within the same time window', () => {
      const secret = generateTotpSecret();
      const code1 = generateTotpCodeSync(secret);
      const code2 = generateTotpCodeSync(secret);

      expect(code1).toBe(code2);
    });

    it('returns different codes for different secrets', () => {
      const secret1 = generateTotpSecret();
      const secret2 = generateTotpSecret();
      const code1 = generateTotpCodeSync(secret1);
      const code2 = generateTotpCodeSync(secret2);

      expect(code1).not.toBe(code2);
    });
  });

  describe('decryptAndVerifyTotp', () => {
    it('returns { ok: true } for a correct code after round-trip encryption', async () => {
      const secret = generateTotpSecret();
      const key = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
      const encryptedSecret = encryptTotpSecret(key, USER_ID, secret);
      const code = generateTotpCodeSync(secret);

      const result = await decryptAndVerifyTotp({
        encryptionSecret: TEST_ENCRYPTION_SECRET,
        userId: USER_ID,
        encryptedSecret,
        code,
        now: new Date(),
      });

      expect(result).toEqual({ ok: true });
    });

    it('returns { ok: false, reason: "invalid-code" } for a wrong code', async () => {
      const secret = generateTotpSecret();
      const key = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
      const encryptedSecret = encryptTotpSecret(key, USER_ID, secret);

      const result = await decryptAndVerifyTotp({
        encryptionSecret: TEST_ENCRYPTION_SECRET,
        userId: USER_ID,
        encryptedSecret,
        code: '000000',
        now: new Date(),
      });

      expect(result).toEqual({ ok: false, reason: 'invalid-code' });
    });

    it('accepts a code from one window step earlier with default window', async () => {
      const secret = generateTotpSecret();
      const key = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
      const encryptedSecret = encryptTotpSecret(key, USER_ID, secret);
      const previousEpoch = Math.floor(Date.now() / 1000) - 30;
      const previousCode = generateSync({ secret, epoch: previousEpoch });

      const result = await decryptAndVerifyTotp({
        encryptionSecret: TEST_ENCRYPTION_SECRET,
        userId: USER_ID,
        encryptedSecret,
        code: previousCode,
        now: new Date(),
      });

      expect(result).toEqual({ ok: true });
    });

    it('rejects a code from two window steps earlier with default window', async () => {
      const secret = generateTotpSecret();
      const key = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
      const encryptedSecret = encryptTotpSecret(key, USER_ID, secret);
      const tooOldEpoch = Math.floor(Date.now() / 1000) - 90;
      const tooOldCode = generateSync({ secret, epoch: tooOldEpoch });

      const result = await decryptAndVerifyTotp({
        encryptionSecret: TEST_ENCRYPTION_SECRET,
        userId: USER_ID,
        encryptedSecret,
        code: tooOldCode,
        now: new Date(),
      });

      expect(result).toEqual({ ok: false, reason: 'invalid-code' });
    });

    it('returns { ok: false, reason: "decrypt-failed" } when ciphertext is corrupted', async () => {
      const secret = generateTotpSecret();
      const key = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
      const encryptedSecret = encryptTotpSecret(key, USER_ID, secret);
      const corrupted = new Uint8Array(encryptedSecret);
      const lastIndex = corrupted.length - 1;
      corrupted[lastIndex] = (corrupted[lastIndex] ?? 0) ^ 0x01;
      const code = generateTotpCodeSync(secret);

      const result = await decryptAndVerifyTotp({
        encryptionSecret: TEST_ENCRYPTION_SECRET,
        userId: USER_ID,
        encryptedSecret: corrupted,
        code,
        now: new Date(),
      });

      expect(result).toEqual({ ok: false, reason: 'decrypt-failed' });
    });

    it('throws UnknownKeyVersionError when the stored secret was sealed under another key', async () => {
      const secret = generateTotpSecret();
      const key = deriveTotpEncryptionKey(OTHER_ENCRYPTION_SECRET);
      const encryptedSecret = encryptTotpSecret(key, USER_ID, secret);

      await expect(
        decryptAndVerifyTotp({
          encryptionSecret: TEST_ENCRYPTION_SECRET,
          userId: USER_ID,
          encryptedSecret,
          code: generateTotpCodeSync(secret),
          now: new Date(),
        })
      ).rejects.toThrow(UnknownKeyVersionError);
    });

    it('returns { ok: false, reason: "decrypt-failed" } for another user\'s stored secret', async () => {
      const secret = generateTotpSecret();
      const key = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
      const encryptedSecret = encryptTotpSecret(key, USER_ID, secret);

      const result = await decryptAndVerifyTotp({
        encryptionSecret: TEST_ENCRYPTION_SECRET,
        userId: OTHER_USER_ID,
        encryptedSecret,
        code: generateTotpCodeSync(secret),
        now: new Date(),
      });

      expect(result).toEqual({ ok: false, reason: 'decrypt-failed' });
    });

    it('returns { ok: false, reason: "invalid-code" } when otplib verify throws on a malformed token', async () => {
      const secret = generateTotpSecret();
      const key = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
      const encryptedSecret = encryptTotpSecret(key, USER_ID, secret);

      const result = await decryptAndVerifyTotp({
        encryptionSecret: TEST_ENCRYPTION_SECRET,
        userId: USER_ID,
        encryptedSecret,
        code: 'not-a-number',
        now: new Date(),
      });

      expect(result).toEqual({ ok: false, reason: 'invalid-code' });
    });

    it('returns { ok: false, reason: "invalid-code" } when otplib.verify throws synchronously (catch branch)', async () => {
      const secret = generateTotpSecret();
      const key = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
      const encryptedSecret = encryptTotpSecret(key, USER_ID, secret);
      const code = generateTotpCodeSync(secret);

      const verifyMock = vi.fn(() => {
        throw new Error('synthetic otplib failure');
      });
      vi.resetModules();
      vi.doMock('otplib', async () => {
        const actual = await vi.importActual<typeof import('otplib')>('otplib');
        return { ...actual, verify: verifyMock };
      });
      try {
        const freshModule = await import('./totp.js');

        const result = await freshModule.decryptAndVerifyTotp({
          encryptionSecret: TEST_ENCRYPTION_SECRET,
          userId: USER_ID,
          encryptedSecret,
          code,
          now: new Date(),
        });

        expect(result).toEqual({ ok: false, reason: 'invalid-code' });
        expect(verifyMock).toHaveBeenCalledOnce();
      } finally {
        vi.doUnmock('otplib');
        vi.resetModules();
      }
    });

    it('accepts a code three steps away with a custom window of 3', async () => {
      const secret = generateTotpSecret();
      const key = deriveTotpEncryptionKey(TEST_ENCRYPTION_SECRET);
      const encryptedSecret = encryptTotpSecret(key, USER_ID, secret);
      const threeStepsAgoEpoch = Math.floor(Date.now() / 1000) - 90;
      const oldCode = generateSync({ secret, epoch: threeStepsAgoEpoch });

      const result = await decryptAndVerifyTotp({
        encryptionSecret: TEST_ENCRYPTION_SECRET,
        userId: USER_ID,
        encryptedSecret,
        code: oldCode,
        now: new Date(),
        window: 3,
      });

      expect(result).toEqual({ ok: true });
    });
  });
});
