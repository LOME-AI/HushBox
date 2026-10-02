import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { DecryptionFailedError, InvalidKeyError } from '../errors.js';
import { BLOB_FORMAT_VERSION } from '../primitives/format.js';
import { asContentKey, asShareSecret, generateContentKey } from '../primitives/keys.js';
import { createShare, openShare } from './message-share.js';
import { openSealed, sealWithKey } from '../wrap/seal.js';
import { SEAL_LABELS } from '../wrap/labels.js';

describe('message-share', () => {
  describe('createShare', () => {
    it('returns a 32-byte share secret and a versioned sealed share key', () => {
      const contentKey = generateContentKey();

      const result = createShare(contentKey);

      expect(result.shareSecret.length).toBe(32);
      expect(result.wrappedShareKey.at(0)).toBe(BLOB_FORMAT_VERSION);
    });

    it('does not leak the content key in the sealed bytes', () => {
      const contentKey = generateContentKey();

      const { wrappedShareKey } = createShare(contentKey);

      expect(wrappedShareKey).not.toEqual(contentKey);
    });

    it('generates a unique share secret on each call', () => {
      const contentKey = generateContentKey();

      const first = createShare(contentKey);
      const second = createShare(contentKey);

      expect(first.shareSecret).not.toEqual(second.shareSecret);
    });

    it('seals a fresh blob on each call for the same content key', () => {
      const contentKey = generateContentKey();

      const first = createShare(contentKey);
      const second = createShare(contentKey);

      expect(first.wrappedShareKey).not.toEqual(second.wrappedShareKey);
    });

    it('refuses an all-zero content key', () => {
      expect(() => createShare(asContentKey(new Uint8Array(32)))).toThrow(InvalidKeyError);
    });
  });

  describe('openShare', () => {
    it('round-trips the content key with the matching share secret', () => {
      const contentKey = generateContentKey();

      const { shareSecret, wrappedShareKey } = createShare(contentKey);

      expect(openShare(shareSecret, wrappedShareKey)).toEqual(contentKey);
    });

    it('throws DecryptionFailedError with a wrong share secret', () => {
      const contentKey = generateContentKey();
      const wrongSecret = asShareSecret(randomBytes(32));

      const { wrappedShareKey } = createShare(contentKey);

      expect(() => openShare(wrongSecret, wrappedShareKey)).toThrow(DecryptionFailedError);
    });

    it('throws on a tampered sealed share key', () => {
      const contentKey = generateContentKey();

      const { shareSecret, wrappedShareKey } = createShare(contentKey);
      const tampered = new Uint8Array(wrappedShareKey) as typeof wrappedShareKey;
      tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;

      expect(() => openShare(shareSecret, tampered)).toThrow(DecryptionFailedError);
    });
  });

  /**
   * The negative the domain label exists for: the same 32-byte secret sealing
   * the same bytes under another purpose must not open here, so a blob minted
   * for one purpose can never be replayed as a share.
   */
  describe('domain separation', () => {
    it('refuses a blob sealed under another seal label', () => {
      const shareSecret = asShareSecret(randomBytes(32));
      const contentKey = generateContentKey();

      const foreign = sealWithKey(shareSecret, contentKey, SEAL_LABELS.totpSecretServer);

      expect(() => openShare(shareSecret, foreign)).toThrow(DecryptionFailedError);
    });

    it('seals under the share label, so only that label opens it', () => {
      const contentKey = generateContentKey();

      const { shareSecret, wrappedShareKey } = createShare(contentKey);

      expect(openSealed(shareSecret, wrappedShareKey, SEAL_LABELS.contentKeyShare)).toEqual(
        contentKey
      );
    });
  });
});
