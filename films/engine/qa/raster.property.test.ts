import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { linearLight, linearLuminance, relativeLuminance } from './raster.js';

const CHANNEL = fc.integer({ min: 0, max: 255 });

describe('relativeLuminance', () => {
  it('is linearLuminance of the linear-light channels for every whole-channel colour (fast-check 8-bit integer triples)', () => {
    fc.assert(
      fc.property(CHANNEL, CHANNEL, CHANNEL, (red, green, blue) => {
        expect(
          Object.is(
            relativeLuminance(red, green, blue),
            linearLuminance(linearLight(red), linearLight(green), linearLight(blue))
          )
        ).toBe(true);
      })
    );
  });
});
