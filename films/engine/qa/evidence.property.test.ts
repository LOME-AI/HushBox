import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createFrameSplitter } from './evidence.js';

/** The stream cut at each of the given offsets, in order. */
function chunks(stream: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const edges = [0, ...[...new Set(cuts)].toSorted((a, b) => a - b), stream.length];
  return edges.slice(1).map((end, index) => stream.subarray(edges[index], end));
}

/** Every frame the splitter hands back for the stream chunked at `cuts`, and the bytes it still holds. */
function split(
  frameBytes: number,
  stream: Uint8Array,
  cuts: readonly number[]
): [number[][], number] {
  const splitter = createFrameSplitter(frameBytes);
  const frames = chunks(stream, cuts).flatMap((chunk) => splitter.push(chunk));
  return [frames.map((frame) => [...frame]), splitter.pending()];
}

/** The whole frames of the stream taken in one piece, and the bytes left over. */
function whole(frameBytes: number, stream: Uint8Array): [number[][], number] {
  const count = Math.floor(stream.length / frameBytes);
  const frames = Array.from({ length: count }, (_, index) => [
    ...stream.subarray(index * frameBytes, (index + 1) * frameBytes),
  ]);
  return [frames, stream.length - count * frameBytes];
}

/** A frame size, a stream, and offsets to cut the stream at. */
const CASES = fc
  .tuple(fc.integer({ min: 1, max: 16 }), fc.uint8Array({ maxLength: 200 }))
  .chain(([frameBytes, stream]) =>
    fc.tuple(
      fc.constant(frameBytes),
      fc.constant(stream),
      fc.array(fc.integer({ min: 0, max: stream.length }), { maxLength: 20 })
    )
  );

describe('createFrameSplitter', () => {
  it('gives the same frames and the same remainder however the stream is chunked (fast-check frame sizes 1–16, streams up to 200 bytes, up to 20 cut offsets within the stream)', () => {
    fc.assert(
      fc.property(CASES, ([frameBytes, stream, cuts]) => {
        expect(split(frameBytes, stream, cuts)).toEqual(whole(frameBytes, stream));
      })
    );
  });
});
