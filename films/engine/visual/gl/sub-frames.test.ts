import { describe, expect, it } from 'vitest';

import { passOffsets, subFrameOffsets } from './sub-frames.js';

describe('subFrameOffsets', () => {
  it('is the frame itself for one sample', () => {
    expect(subFrameOffsets(1)).toEqual([0]);
  });

  it('spreads eight samples evenly across a half-frame shutter centred on the frame', () => {
    expect(subFrameOffsets(8)).toEqual([
      -0.218_75, -0.156_25, -0.093_75, -0.031_25, 0.031_25, 0.093_75, 0.156_25, 0.218_75,
    ]);
  });

  it('accepts one sample, the fewest', () => {
    expect(() => subFrameOffsets(1)).not.toThrow();
  });

  it('refuses zero samples', () => {
    expect(() => subFrameOffsets(0)).toThrow(RangeError);
  });

  it('refuses a fractional sample count', () => {
    expect(() => subFrameOffsets(2.5)).toThrow(/whole number/);
  });

  it('refuses a sample count that is not a number', () => {
    expect(() => subFrameOffsets(Number.NaN)).toThrow(RangeError);
  });
});

describe('passOffsets', () => {
  it('needs no extra pass when every layer draws only its own frame', () => {
    expect(passOffsets([1, 1])).toEqual([]);
  });

  it('is the sub-frame offsets of the one blurred layer', () => {
    expect(passOffsets([1, 4])).toEqual(subFrameOffsets(4));
  });

  it('leaves out the frame itself, which the primary pass already draws', () => {
    expect(passOffsets([3])).toEqual(subFrameOffsets(3).filter((offset) => offset !== 0));
  });

  it('merges the offsets of layers with different sample counts, once each and ascending', () => {
    const merged = passOffsets([2, 4, 4]);
    expect(merged).toEqual(
      [...new Set([...subFrameOffsets(2), ...subFrameOffsets(4)])].toSorted((a, b) => a - b)
    );
  });

  it('refuses a layer whose sample count is not a whole number of at least one', () => {
    expect(() => passOffsets([8, 0])).toThrow(RangeError);
  });
});
