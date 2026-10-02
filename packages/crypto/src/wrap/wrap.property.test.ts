/**
 * Wrapping is invertible: whatever `wrapSecretTo` accepts, `unwrapSecret`
 * returns byte for byte under the same label and the same context.
 *
 * The draws are deliberate rather than uniform. `size: 'max'` is what makes a
 * declared maximum the reach — the library's default size governs array length
 * otherwise, holding every draw under about ten bytes whatever maximum is
 * declared. And the all-zero payload — the seam's one refusal on the payload,
 * the empty buffer at length zero included — is a shape of its own rather than
 * something random bytes are waited on to produce, so every label in the
 * registry is crossed with it.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { unwrapSecret, wrapSecretTo } from './wrap.js';
import { WRAP_LABELS } from './labels.js';
import {
  KEY_BYTES,
  asAccountPrivateKey,
  asAccountPublicKey,
  getPublicKeyFromPrivate,
} from '../primitives/keys.js';
import { InvalidKeyError } from '../errors.js';
import type { WrappedSecret } from './wrap.js';

const MAX_PAYLOAD_BYTES = 512;
const MAX_CONTEXT_BYTES = 64;
const MAX_DEGENERATE_BYTES = 2;

/**
 * Any 32 bytes but the all-zero buffer: the curve clamps every other scalar
 * into a usable key, and the all-zero one is what both halves of the seam
 * refuse. The filter binds shrinking too, so a minimised counterexample is
 * still a key the module admits.
 */
const recipientPrivateKeyArb = fc
  .uint8Array({ minLength: KEY_BYTES, maxLength: KEY_BYTES })
  .filter((bytes) => bytes.some((byte) => byte !== 0));

const labelArb = fc.constantFrom(...Object.values(WRAP_LABELS));

const payloadArb = fc.oneof(
  { arbitrary: fc.uint8Array({ maxLength: MAX_PAYLOAD_BYTES, size: 'max' }), weight: 3 },
  {
    arbitrary: fc
      .integer({ min: 0, max: MAX_PAYLOAD_BYTES })
      .map((length) => new Uint8Array(length)),
    weight: 1,
  },
  { arbitrary: fc.uint8Array({ maxLength: MAX_DEGENERATE_BYTES, size: 'max' }), weight: 1 }
);

const contextArb = fc.oneof(
  { arbitrary: fc.uint8Array({ maxLength: MAX_CONTEXT_BYTES, size: 'max' }), weight: 3 },
  { arbitrary: fc.uint8Array({ maxLength: 1, size: 'max' }), weight: 1 }
);

describe('wrapping a secret', () => {
  it('unwraps to the bytes that went in, under every label, key and context', () => {
    fc.assert(
      fc.property(
        recipientPrivateKeyArb,
        labelArb,
        payloadArb,
        contextArb,
        (keyBytes, label, payload, context) => {
          let wrapped: WrappedSecret | undefined;
          let refusal: unknown;
          try {
            wrapped = wrapSecretTo(
              asAccountPublicKey(getPublicKeyFromPrivate(keyBytes)),
              payload,
              label,
              context
            );
          } catch (error) {
            refusal = error;
          }

          if (wrapped === undefined) {
            // An empty or all-zero secret is the seam's one refusal on the
            // payload, and which labels make it is the registry's own business:
            // reading the refusal reaches those payloads under every label
            // without a second copy of that classification.
            expect(refusal).toBeInstanceOf(InvalidKeyError);
            expect(payload.every((byte) => byte === 0)).toBe(true);
            return;
          }
          expect(unwrapSecret(asAccountPrivateKey(keyBytes), wrapped, label, context)).toEqual(
            payload
          );
        }
      )
    );
  });
});
