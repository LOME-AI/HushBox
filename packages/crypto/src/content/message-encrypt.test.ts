import { describe, it, expect } from 'vitest';
import { testUuidV7 } from '@hushbox/shared/test-time';
import {
  encryptTextForEpoch,
  decryptTextFromEpoch,
  encryptCustomInstructions,
  decryptCustomInstructions,
} from './message-encrypt.js';
import { generateKeyPair } from '../primitives/keys.js';
import { DecryptionFailedError } from '../errors.js';
import { MAX_DECOMPRESSED_MESSAGE_BYTES } from '../primitives/compression.js';

const CONVERSATION_A = testUuidV7(1);
const CONVERSATION_B = testUuidV7(0);
const USER_A = testUuidV7(2);
const USER_B = testUuidV7(3);
const EPOCH = 7;

const AT_A = { conversationId: CONVERSATION_A, epochNumber: EPOCH };

describe('message-encrypt', () => {
  describe('encryptTextForEpoch / decryptTextFromEpoch', () => {
    it('round-trips a title bound to its conversation and epoch', () => {
      const keyPair = generateKeyPair();
      const text = 'conversation title 密码🔐';

      const blob = encryptTextForEpoch(keyPair.publicKey, text, AT_A);

      expect(decryptTextFromEpoch(keyPair.privateKey, blob, AT_A)).toBe(text);
    });

    // An untitled conversation encodes to a lone zero codec flag — the one
    // legitimate all-zero wrap payload, which the wrap's zeroed-key guard
    // must not reject.
    it('round-trips an untitled conversation', () => {
      const keyPair = generateKeyPair();

      const blob = encryptTextForEpoch(keyPair.publicKey, '', AT_A);

      expect(decryptTextFromEpoch(keyPair.privateKey, blob, AT_A)).toBe('');
    });

    it('throws DecryptionFailedError with the wrong private key', () => {
      const keyPair = generateKeyPair();
      const wrongKeyPair = generateKeyPair();

      const blob = encryptTextForEpoch(keyPair.publicKey, 'secret', AT_A);

      expect(() => decryptTextFromEpoch(wrongKeyPair.privateKey, blob, AT_A)).toThrow(
        DecryptionFailedError
      );
    });

    it('refuses a title sealed for another conversation', () => {
      const keyPair = generateKeyPair();

      const blob = encryptTextForEpoch(keyPair.publicKey, 'Quarterly planning', AT_A);

      expect(() =>
        decryptTextFromEpoch(keyPair.privateKey, blob, {
          conversationId: CONVERSATION_B,
          epochNumber: EPOCH,
        })
      ).toThrow(DecryptionFailedError);
    });

    it('refuses a title sealed under an earlier epoch of the same conversation', () => {
      const keyPair = generateKeyPair();

      const blob = encryptTextForEpoch(keyPair.publicKey, 'Quarterly planning', AT_A);

      expect(() =>
        decryptTextFromEpoch(keyPair.privateKey, blob, {
          conversationId: CONVERSATION_A,
          epochNumber: EPOCH + 1,
        })
      ).toThrow(DecryptionFailedError);
    });

    it('deflates a compressible title that fits under the inflate cap', () => {
      const keyPair = generateKeyPair();
      const text = 'A'.repeat(10_000);

      const blob = encryptTextForEpoch(keyPair.publicKey, text, AT_A);

      expect(blob.length).toBeLessThan(text.length);
      expect(decryptTextFromEpoch(keyPair.privateKey, blob, AT_A)).toBe(text);
    });

    it('stores a title past the inflate cap raw, and reads it back', () => {
      const keyPair = generateKeyPair();
      const text = 'A'.repeat(MAX_DECOMPRESSED_MESSAGE_BYTES + 1);

      const blob = encryptTextForEpoch(keyPair.publicKey, text, AT_A);

      // Deflate would collapse this run to a few KB; a blob larger than the
      // plaintext is proof the write side declined to compress past the cap.
      expect(blob.length).toBeGreaterThan(text.length);
      expect(decryptTextFromEpoch(keyPair.privateKey, blob, AT_A)).toBe(text);
    });
  });

  describe('encryptCustomInstructions / decryptCustomInstructions', () => {
    it('round-trips instructions bound to their owner', () => {
      const keyPair = generateKeyPair();
      const text = 'Always answer concisely and cite sources.';

      const blob = encryptCustomInstructions(keyPair.publicKey, text, USER_A);

      expect(decryptCustomInstructions(keyPair.privateKey, blob, USER_A)).toBe(text);
    });

    it('throws DecryptionFailedError with the wrong private key', () => {
      const keyPair = generateKeyPair();
      const wrongKeyPair = generateKeyPair();

      const blob = encryptCustomInstructions(keyPair.publicKey, 'secret', USER_A);

      expect(() => decryptCustomInstructions(wrongKeyPair.privateKey, blob, USER_A)).toThrow(
        DecryptionFailedError
      );
    });

    it('refuses instructions sealed for another user', () => {
      const keyPair = generateKeyPair();

      const blob = encryptCustomInstructions(keyPair.publicKey, 'Be terse.', USER_A);

      expect(() => decryptCustomInstructions(keyPair.privateKey, blob, USER_B)).toThrow(
        DecryptionFailedError
      );
    });
  });
});
