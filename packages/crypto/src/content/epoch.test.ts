import { describe, it, expect } from 'vitest';
import {
  EPOCH_CONFIRMATION_BYTES,
  computeEpochConfirmation,
  verifyEpochConfirmation,
  wrapContentKeyToEpoch,
  unwrapContentKeyFromEpoch,
} from './epoch.js';
import { generateContentKey, generateEpochKeyPair } from '../primitives/keys.js';
import { unwrapSecret } from '../wrap/wrap.js';
import { DecryptionFailedError, InvalidParameterError } from '../errors.js';
import { WRAP_LABELS } from '../wrap/labels.js';

const CONVERSATION_ID = 'conv-abc';

describe('epoch', () => {
  describe('computeEpochConfirmation', () => {
    it('is deterministic for the same key and context', () => {
      const epoch = generateEpochKeyPair();

      const first = computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 3);
      const second = computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 3);

      expect(first).toEqual(second);
      expect(first.length).toBe(EPOCH_CONFIRMATION_BYTES);
    });

    it('differs across epoch private keys', () => {
      const confirmationA = computeEpochConfirmation(
        generateEpochKeyPair().privateKey,
        CONVERSATION_ID,
        3
      );
      const confirmationB = computeEpochConfirmation(
        generateEpochKeyPair().privateKey,
        CONVERSATION_ID,
        3
      );

      expect(confirmationA).not.toEqual(confirmationB);
    });

    it('differs across conversations (no cross-conversation replay)', () => {
      const epoch = generateEpochKeyPair();

      const here = computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 3);
      const there = computeEpochConfirmation(epoch.privateKey, 'conv-other', 3);

      expect(here).not.toEqual(there);
    });

    it('differs across epoch numbers', () => {
      const epoch = generateEpochKeyPair();

      const three = computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 3);
      const four = computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 4);

      expect(three).not.toEqual(four);
    });

    it('rejects a negative epoch number', () => {
      const epoch = generateEpochKeyPair();

      expect(() => computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, -1)).toThrow(
        InvalidParameterError
      );
    });
  });

  describe('verifyEpochConfirmation', () => {
    it('returns true for a matching confirmation', () => {
      const epoch = generateEpochKeyPair();
      const confirmation = computeEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 2);

      expect(verifyEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 2, confirmation)).toBe(
        true
      );
    });

    it('returns false for a confirmation from a different key', () => {
      const epoch = generateEpochKeyPair();
      const other = generateEpochKeyPair();
      const confirmation = computeEpochConfirmation(other.privateKey, CONVERSATION_ID, 2);

      expect(verifyEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 2, confirmation)).toBe(
        false
      );
    });

    it('returns false for a confirmation of the wrong length', () => {
      const epoch = generateEpochKeyPair();

      expect(verifyEpochConfirmation(epoch.privateKey, CONVERSATION_ID, 2, new Uint8Array(8))).toBe(
        false
      );
    });
  });

  describe('wrapContentKeyToEpoch / unwrapContentKeyFromEpoch', () => {
    it('round-trips a content key through an epoch wrap', () => {
      const epoch = generateEpochKeyPair();
      const contentKey = generateContentKey();

      const wrapped = wrapContentKeyToEpoch(epoch.publicKey, contentKey);
      const unwrapped = unwrapContentKeyFromEpoch(epoch.privateKey, wrapped);

      expect(new Uint8Array(unwrapped)).toEqual(new Uint8Array(contentKey));
    });

    it('fails with the wrong epoch private key', () => {
      const epoch = generateEpochKeyPair();
      const other = generateEpochKeyPair();

      const wrapped = wrapContentKeyToEpoch(epoch.publicKey, generateContentKey());

      expect(() => unwrapContentKeyFromEpoch(other.privateKey, wrapped)).toThrow(
        DecryptionFailedError
      );
    });

    it('wraps under the exported domain-separation label', () => {
      const epoch = generateEpochKeyPair();
      const contentKey = generateContentKey();

      const wrapped = wrapContentKeyToEpoch(epoch.publicKey, contentKey);

      expect(unwrapSecret(epoch.privateKey, wrapped, WRAP_LABELS.contentKeyEpoch)).toEqual(
        new Uint8Array(contentKey)
      );
      expect(() => unwrapSecret(epoch.privateKey, wrapped, WRAP_LABELS.epochKeyMember)).toThrow(
        DecryptionFailedError
      );
    });
  });
});
