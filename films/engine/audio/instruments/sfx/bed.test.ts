import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { nextAfter } from '../../dsp/dsp-test-support.js';

import { bedBeatsSchema } from './bed.js';

describe('bedBeatsSchema', () => {
  it('fills its default', () => {
    expect(z.object({ beats: bedBeatsSchema(4) }).parse({})).toEqual({ beats: 4 });
  });

  it.each([1 / 16, 1024])('accepts a bed of %f beats', (beats) => {
    expect(bedBeatsSchema(4).parse(beats)).toBe(beats);
  });

  it.each([nextAfter(1 / 16, -1), nextAfter(1024, 1), Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a bed of %f beats',
    (beats) => {
      expect(bedBeatsSchema(4).safeParse(beats).success).toBe(false);
    }
  );
});
