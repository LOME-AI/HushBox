/**
 * The location bindings are invertible: a member wrap and a chain link built
 * at any conversation and any epoch numbers open at exactly that location.
 *
 * The draws reach the edges of each field rather than sampling typical
 * values: conversation ids of any length including the empty string, and
 * epoch numbers across the whole range the u64 field admits, so a builder
 * that truncated or re-encoded a field would meet a value it mangles.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createFirstEpoch,
  openChainLink,
  openEpochWrap,
  performEpochRotation,
} from './epoch-lifecycle.js';
import { wrapEpochKeyForNewMember } from './member.js';
import { KEY_BYTES, getPublicKeyFromPrivate } from '../primitives/keys.js';

// Every case pays several curve operations, so this property is dear and
// states a smaller count than the repository default.
const RUNS = 300;
const MAX_CONVERSATION_ID_LENGTH = 64;

const privateKeyArb = fc
  .uint8Array({ minLength: KEY_BYTES, maxLength: KEY_BYTES })
  .filter((bytes) => bytes.some((byte) => byte !== 0));

const conversationIdArb = fc.string({ maxLength: MAX_CONVERSATION_ID_LENGTH, size: 'max' });

const epochNumberArb = fc.oneof(
  fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  fc.constantFrom(0, 1, Number.MAX_SAFE_INTEGER)
);

describe('binding an epoch wrap to its location', () => {
  it('opens a member wrap at the location it was built for', () => {
    fc.assert(
      fc.property(
        privateKeyArb,
        conversationIdArb,
        epochNumberArb,
        (memberKey, conversationId, epochNumber) => {
          const epoch = createFirstEpoch([], conversationId, epochNumber);
          const location = { conversationId, epochNumber, epochPublicKey: epoch.epochPublicKey };

          const wrap = wrapEpochKeyForNewMember(
            epoch.epochPrivateKey,
            getPublicKeyFromPrivate(memberKey),
            location
          );

          expect(
            openEpochWrap(memberKey, wrap, {
              ...location,
              confirmationHash: epoch.confirmationHash,
            })
          ).toEqual({ ok: true, key: epoch.epochPrivateKey });
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('opens a chain link at the location it was built for', () => {
    fc.assert(
      fc.property(
        conversationIdArb,
        epochNumberArb,
        epochNumberArb,
        (conversationId, first, second) => {
          fc.pre(first !== second);
          const olderEpochNumber = Math.min(first, second);
          const newerEpochNumber = Math.max(first, second);
          const older = createFirstEpoch([], conversationId, olderEpochNumber);

          const newer = performEpochRotation({
            predecessor: {
              epochNumber: olderEpochNumber,
              privateKey: older.epochPrivateKey,
              publicKey: older.epochPublicKey,
            },
            memberPublicKeys: [],
            conversationId,
            epochNumber: newerEpochNumber,
          });

          expect(
            openChainLink(newer.epochPrivateKey, newer.chainLink, {
              conversationId,
              newerEpochNumber,
              older: {
                epochNumber: olderEpochNumber,
                epochPublicKey: older.epochPublicKey,
                confirmationHash: older.confirmationHash,
              },
            })
          ).toEqual({ ok: true, key: older.epochPrivateKey });
        }
      ),
      { numRuns: RUNS }
    );
  });
});
