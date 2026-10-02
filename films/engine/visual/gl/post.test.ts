import { describe, expect, it } from 'vitest';

import { NEUTRAL_POST, assertPost, framePost, gaussianKernel } from './post.js';

import type { PostSettings } from './post.js';

describe('assertPost', () => {
  it('accepts the neutral chain', () => {
    expect(() => {
      assertPost(NEUTRAL_POST);
    }).not.toThrow();
  });

  it.each(['bloom', 'aberration', 'vignette', 'flash'] as const)(
    'refuses a %s that is not finite, naming it',
    (key) => {
      expect(() => {
        assertPost({ ...NEUTRAL_POST, [key]: Number.NaN });
      }).toThrow(new RegExp(String.raw`post\.${key}`));
    }
  );

  type Case = [name: string, accepted: PostSettings, refused: PostSettings];
  const cases: Case[] = [
    [
      'bloom at least 0',
      { ...NEUTRAL_POST, bloom: 0 },
      { ...NEUTRAL_POST, bloom: -Number.MIN_VALUE },
    ],
    [
      'aberration at least 0',
      { ...NEUTRAL_POST, aberration: 0 },
      { ...NEUTRAL_POST, aberration: -Number.MIN_VALUE },
    ],
    [
      'flash at least 0',
      { ...NEUTRAL_POST, flash: 0 },
      { ...NEUTRAL_POST, flash: -Number.MIN_VALUE },
    ],
    [
      'vignette at least 0',
      { ...NEUTRAL_POST, vignette: 0 },
      { ...NEUTRAL_POST, vignette: -Number.MIN_VALUE },
    ],
    [
      'vignette at most 1',
      { ...NEUTRAL_POST, vignette: 1 },
      { ...NEUTRAL_POST, vignette: 1 + Number.EPSILON },
    ],
  ];

  it.each(cases)('accepts the last value inside the bound: %s', (_, accepted) => {
    expect(() => {
      assertPost(accepted);
    }).not.toThrow();
  });

  it.each(cases)('refuses the first value outside the bound: %s', (_, __, refused) => {
    expect(() => {
      assertPost(refused);
    }).toThrow(RangeError);
  });
});

describe('gaussianKernel', () => {
  it('holds the centre tap and one side of the kernel', () => {
    expect(gaussianKernel(4, 2)).toHaveLength(5);
  });

  it('falls away from the centre', () => {
    const weights = gaussianKernel(8, 3);
    expect(
      weights.every((weight, index) => index === 0 || weight < (weights[index - 1] ?? 0))
    ).toBe(true);
  });

  it('refuses a radius below one tap', () => {
    expect(() => gaussianKernel(0, 1)).toThrow(RangeError);
  });

  it('refuses a width of 0', () => {
    expect(() => gaussianKernel(1, 0)).toThrow(RangeError);
  });

  it('refuses a radius that is not a number', () => {
    expect(() => gaussianKernel(Number.NaN, 1)).toThrow(RangeError);
  });

  it('refuses a width that is not a number', () => {
    expect(() => gaussianKernel(1, Number.NaN)).toThrow(RangeError);
  });
});

describe('framePost', () => {
  it('leaves a frame with no post chain unfinished', () => {
    expect(framePost([])).toBeNull();
  });

  it("finishes a frame with its one post chain's settings", () => {
    const post: PostSettings = { ...NEUTRAL_POST, bloom: 0.5 };

    expect(framePost([post])).toBe(post);
  });

  it('refuses two post chains on one canvas, counting them', () => {
    expect(() => framePost([NEUTRAL_POST, NEUTRAL_POST])).toThrow(/one PostChain.*holds 2/);
  });

  it('refuses a post chain whose settings no frame can draw, naming the setting', () => {
    expect(() => framePost([{ ...NEUTRAL_POST, vignette: 2 }])).toThrow(/post\.vignette/);
  });
});
