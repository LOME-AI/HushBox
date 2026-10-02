import { describe, expect, it } from 'vitest';

import { createStereo } from './buffer.js';
import { nextAfter } from './dsp-test-support.js';
import { mixInto, pan, panGains, width } from './stereo.js';

import type { StereoBuffer } from './buffer.js';
import type { Placement } from './stereo.js';

const CENTRE: Placement = { atSample: 0, gain: 1, pan: 0 };

function unitImpulse(): Float32Array {
  return new Float32Array([1]);
}

/** The indices of a channel's nonzero samples. */
function nonzero(channel: Float32Array): number[] {
  return [...channel.keys()].filter((index) => channel[index] !== 0);
}

describe('panGains', () => {
  it('gives both sides the same gain at the centre', () => {
    const [left, right] = panGains(0);
    expect(left).toBe(right);
    expect(left).toBeCloseTo(Math.SQRT1_2, 15);
  });

  it('sends everything left at −1', () => {
    expect(panGains(-1)).toEqual([1, 0]);
  });

  it('sends everything right at 1', () => {
    expect(panGains(1)).toEqual([0, 1]);
  });

  it('accepts a pan of −1', () => {
    expect(() => panGains(-1)).not.toThrow();
  });

  it('refuses the double just left of −1', () => {
    expect(() => panGains(nextAfter(-1, -1))).toThrow(/pan must be in \[-1, 1\]/);
  });

  it('accepts a pan of 1', () => {
    expect(() => panGains(1)).not.toThrow();
  });

  it('refuses the double just right of 1', () => {
    expect(() => panGains(nextAfter(1, 1))).toThrow(RangeError);
  });
});

describe('pan', () => {
  it('scales a mono signal into each side by the pan gains', () => {
    const [left, right] = panGains(0.5);
    const panned = pan(new Float32Array([0.5, -1]), 0.5);
    expect([...panned.left]).toEqual([Math.fround(0.5 * left), Math.fround(-left)]);
    expect([...panned.right]).toEqual([Math.fround(0.5 * right), Math.fround(-right)]);
  });

  it('refuses a pan past 1', () => {
    expect(() => pan(new Float32Array(1), nextAfter(1, 1))).toThrow(RangeError);
  });
});

describe('width', () => {
  const input: StereoBuffer = {
    left: new Float32Array([1, 0.5]),
    right: new Float32Array([0, 0.25]),
  };

  it('leaves a buffer unchanged at 1', () => {
    expect(width(input, 1)).toEqual(input);
  });

  it('folds to mono at 0', () => {
    const mono = width(input, 0);
    expect([...mono.left]).toEqual([0.5, 0.375]);
    expect([...mono.right]).toEqual([0.5, 0.375]);
  });

  it('doubles the side signal at 2', () => {
    const wide = width(input, 2);
    expect([...wide.left]).toEqual([1.5, 0.625]);
    expect([...wide.right]).toEqual([-0.5, 0.125]);
  });

  it('accepts a width of 0', () => {
    expect(() => width(input, 0)).not.toThrow();
  });

  it('refuses the double just below 0', () => {
    expect(() => width(input, -Number.MIN_VALUE)).toThrow(/width must be in \[0, Infinity\)/);
  });

  it('accepts the largest finite width', () => {
    expect(() => width(input, Number.MAX_VALUE)).not.toThrow();
  });

  it('refuses an infinite width', () => {
    expect(() => width(input, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('refuses channels of different lengths', () => {
    expect(() => width({ left: new Float32Array(2), right: new Float32Array(1) }, 1)).toThrow(
      /a stereo buffer needs equal channels/
    );
  });
});

describe('mixInto', () => {
  it.each([-1, -0.5, 0, 0.5, 1])(
    'places a unit impulse at exactly atSample in both channels by the constant-power law, pan %s',
    (position) => {
      const target = createStereo(2000);
      mixInto(target, unitImpulse(), { atSample: 1234, gain: 1, pan: position });
      const [left, right] = panGains(position);
      expect(target.left[1234]).toBe(Math.fround(left));
      expect(target.right[1234]).toBe(Math.fround(right));
      expect(nonzero(target.left).filter((index) => index !== 1234)).toEqual([]);
      expect(nonzero(target.right).filter((index) => index !== 1234)).toEqual([]);
      expect(left * left + right * right).toBeCloseTo(1, 15);
    }
  );

  it('scales by its gain', () => {
    const target = createStereo(4);
    mixInto(target, unitImpulse(), { atSample: 2, gain: 0.5, pan: -1 });
    expect(target.left[2]).toBe(0.5);
  });

  it('adds to what the target already holds', () => {
    const target = createStereo(2);
    target.left[1] = 0.25;
    mixInto(target, unitImpulse(), { atSample: 1, gain: 0.5, pan: -1 });
    expect(target.left[1]).toBe(0.75);
  });

  it('keeps a stereo source’s channels apart, at unity in each at the centre', () => {
    const target = createStereo(2);
    const source = { left: new Float32Array([0.5, 0]), right: new Float32Array([0, 0.25]) };
    mixInto(target, source, CENTRE);
    expect([...target.left]).toEqual([0.5, 0]);
    expect([...target.right]).toEqual([0, 0.25]);
  });

  it('balances a stereo source by the constant-power law scaled to unity at the centre', () => {
    const target = createStereo(1);
    const source = { left: new Float32Array([1]), right: new Float32Array([1]) };
    mixInto(target, source, { ...CENTRE, pan: -1 });
    expect([target.left[0], target.right[0]]).toEqual([Math.fround(Math.SQRT2), 0]);
  });

  it('drops the part of a source that starts before the target', () => {
    const target = createStereo(3);
    mixInto(target, new Float32Array([1, 2, 3]), { atSample: -1, gain: 1, pan: -1 });
    expect([...target.left]).toEqual([2, 3, 0]);
  });

  it('drops the part of a source that runs past the end of the target', () => {
    const target = createStereo(3);
    mixInto(target, new Float32Array([1, 2, 3]), { atSample: 2, gain: 1, pan: -1 });
    expect([...target.left]).toEqual([0, 0, 1]);
  });

  it('refuses a fractional atSample', () => {
    expect(() => {
      mixInto(createStereo(4), unitImpulse(), { ...CENTRE, atSample: 1.5 });
    }).toThrow('atSample must be a whole sample index, got 1.5');
  });

  it('accepts the largest safe atSample', () => {
    expect(() => {
      mixInto(createStereo(4), unitImpulse(), { ...CENTRE, atSample: Number.MAX_SAFE_INTEGER });
    }).not.toThrow();
  });

  it('refuses the first atSample past the safe range', () => {
    expect(() => {
      mixInto(createStereo(4), unitImpulse(), { ...CENTRE, atSample: Number.MAX_SAFE_INTEGER + 1 });
    }).toThrow(RangeError);
  });

  it('accepts the most negative safe atSample', () => {
    expect(() => {
      mixInto(createStereo(4), unitImpulse(), { ...CENTRE, atSample: -Number.MAX_SAFE_INTEGER });
    }).not.toThrow();
  });

  it('refuses the first atSample below the safe range', () => {
    expect(() => {
      mixInto(createStereo(4), unitImpulse(), {
        ...CENTRE,
        atSample: -Number.MAX_SAFE_INTEGER - 1,
      });
    }).toThrow(RangeError);
  });

  it('accepts the largest finite gain', () => {
    expect(() => {
      mixInto(createStereo(4), unitImpulse(), { ...CENTRE, gain: Number.MAX_VALUE });
    }).not.toThrow();
  });

  it('refuses an infinite gain', () => {
    expect(() => {
      mixInto(createStereo(4), unitImpulse(), { ...CENTRE, gain: Number.POSITIVE_INFINITY });
    }).toThrow(/gain must be in \(-Infinity, Infinity\)/);
  });

  it('accepts the most negative finite gain', () => {
    expect(() => {
      mixInto(createStereo(4), unitImpulse(), { ...CENTRE, gain: -Number.MAX_VALUE });
    }).not.toThrow();
  });

  it('refuses a gain of −Infinity', () => {
    expect(() => {
      mixInto(createStereo(4), unitImpulse(), { ...CENTRE, gain: Number.NEGATIVE_INFINITY });
    }).toThrow(RangeError);
  });

  it('refuses a pan past 1', () => {
    expect(() => {
      mixInto(createStereo(4), unitImpulse(), { ...CENTRE, pan: nextAfter(1, 1) });
    }).toThrow(RangeError);
  });

  it('refuses a target whose channels differ in length', () => {
    const target = { left: new Float32Array(2), right: new Float32Array(1) };
    expect(() => {
      mixInto(target, unitImpulse(), CENTRE);
    }).toThrow(/equal channels/);
  });

  it('refuses a stereo source whose channels differ in length', () => {
    const source = { left: new Float32Array(2), right: new Float32Array(1) };
    expect(() => {
      mixInto(createStereo(4), source, CENTRE);
    }).toThrow(/equal channels/);
  });
});
