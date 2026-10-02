/**
 * Deflate and bounded inflate are inverse exactly up to the cap the caller
 * names: at or below it the original bytes come back, and past it inflation
 * aborts naming the cap it exceeded rather than returning truncated output.
 *
 * The draws are deliberate rather than uniform. `size: 'max'` is what makes a
 * declared maximum the reach — the library's default size governs array length
 * otherwise, holding every draw under about ten bytes whatever maximum is
 * declared. The payload is drawn in shapes that do not reach one another's
 * ground: a tiled motif is what deflate shrinks, and bytes it has little to
 * work with are what carry a stream past the inflater's slice boundary. And
 * each cap boundary is drawn as a constant rather than left to the interval it
 * bounds, because how often a uniform draw lands on an endpoint falls off with
 * that interval's width — which for the admitting cap runs to the message cap
 * and for the refusing cap no further than the payload's own length.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { boundedInflate } from './bounded-inflate.js';
import { MAX_DECOMPRESSED_MESSAGE_BYTES, compress } from './compression.js';
import { DecompressionCapError } from '../errors.js';

const MAX_GENERATED_BYTES = 4096;
const MAX_MOTIF_BYTES = 8;
const MAX_DEGENERATE_BYTES = 2;

/** Bytes deflate has little to work with: what carries a stream past the inflater's slice size. */
function uniformBytes(minLength: number): fc.Arbitrary<Uint8Array> {
  return fc.uint8Array({ minLength, maxLength: MAX_GENERATED_BYTES, size: 'max' });
}

/** A short motif tiled to length: what deflate shrinks, a single repeated byte included. */
function tiledBytes(minLength: number): fc.Arbitrary<Uint8Array> {
  return fc
    .tuple(
      fc.uint8Array({ minLength: 1, maxLength: MAX_MOTIF_BYTES, size: 'max' }),
      fc.integer({ min: Math.max(minLength, 1), max: MAX_GENERATED_BYTES })
    )
    .map(([motif, length]) => {
      const bytes = new Uint8Array(length);
      for (let offset = 0; offset < length; offset += motif.length) {
        bytes.set(motif.subarray(0, Math.min(motif.length, length - offset)), offset);
      }
      return bytes;
    });
}

function payloadArb(minLength: number): fc.Arbitrary<Uint8Array> {
  return fc.oneof(
    { arbitrary: uniformBytes(minLength), weight: 3 },
    { arbitrary: tiledBytes(minLength), weight: 3 },
    {
      arbitrary: fc.uint8Array({ minLength, maxLength: MAX_DEGENERATE_BYTES, size: 'max' }),
      weight: 1,
    }
  );
}

/** A cap at the payload's own length, at the message cap production inflates under, or between. */
function admittingCap(payloadLength: number): fc.Arbitrary<number> {
  const min = Math.max(1, payloadLength);
  return fc.oneof(
    { arbitrary: fc.constant(min), weight: 1 },
    { arbitrary: fc.constant(MAX_DECOMPRESSED_MESSAGE_BYTES), weight: 1 },
    { arbitrary: fc.integer({ min, max: MAX_DECOMPRESSED_MESSAGE_BYTES }), weight: 2 }
  );
}

/** A cap one byte short of the payload, a cap of one, or between. */
function refusingCap(payloadLength: number): fc.Arbitrary<number> {
  const max = payloadLength - 1;
  return fc.oneof(
    { arbitrary: fc.constant(max), weight: 1 },
    { arbitrary: fc.constant(1), weight: 1 },
    { arbitrary: fc.integer({ min: 1, max }), weight: 2 }
  );
}

const withAdmittingCap = payloadArb(0).chain((bytes) =>
  fc.tuple(fc.constant(bytes), admittingCap(bytes.length))
);

const withRefusingCap = payloadArb(2).chain((bytes) =>
  fc.tuple(fc.constant(bytes), refusingCap(bytes.length))
);

/** The abort raised by inflating past `cap`; anything else fails the case. */
function capAbortFrom(bytes: Uint8Array, cap: number): DecompressionCapError {
  try {
    boundedInflate(compress(bytes), cap);
  } catch (error) {
    if (error instanceof DecompressionCapError) return error;
    throw error;
  }
  throw new Error(
    `Inflating ${String(bytes.length)} bytes under a cap of ${String(cap)} returned instead of aborting`
  );
}

describe('deflating then inflating', () => {
  it('returns the original bytes under every cap at or above their length', () => {
    fc.assert(
      fc.property(withAdmittingCap, ([bytes, cap]) => {
        expect(boundedInflate(compress(bytes), cap)).toEqual(bytes);
      })
    );
  });

  it('aborts naming the cap it exceeded when the output would run past it', () => {
    fc.assert(
      fc.property(withRefusingCap, ([bytes, cap]) => {
        const abort = capAbortFrom(bytes, cap);

        expect(abort.capBytes).toBe(cap);
        expect(abort.bytesInflated).toBeGreaterThan(cap);
      })
    );
  });
});
