import { describe, expect, it } from 'vitest';

import {
  controlAt,
  controlInRange,
  createStereo,
  requireControl,
  requireEqualChannels,
  sampleAt,
} from './buffer.js';

const CUTOFF_RANGE = { min: 0, max: 24_000, maxOpen: true };

describe('createStereo', () => {
  it('returns two silent channels of the requested length', () => {
    const buffer = createStereo(4);
    expect([...buffer.left, ...buffer.right]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('gives each channel its own storage', () => {
    const buffer = createStereo(2);
    buffer.left[0] = 1;
    expect(buffer.right[0]).toBe(0);
  });

  it('accepts zero samples', () => {
    expect(createStereo(0).left).toHaveLength(0);
  });

  it('refuses minus one sample', () => {
    expect(() => createStereo(-1)).toThrow(/samples must be a whole number/);
  });
});

describe('requireEqualChannels', () => {
  it('accepts channels of equal length', () => {
    expect(() => {
      requireEqualChannels(createStereo(3));
    }).not.toThrow();
  });

  it('refuses channels of different lengths, naming both', () => {
    expect(() => {
      requireEqualChannels({ left: new Float32Array(4), right: new Float32Array(3) });
    }).toThrow('left and right hold 4 and 3 samples: a stereo buffer needs equal channels');
  });
});

describe('sampleAt', () => {
  it('reads the sample at an index', () => {
    expect(sampleAt(new Float32Array([0.5, 0.25]), 1)).toBe(0.25);
  });

  it('throws naming the index and the length past the end', () => {
    expect(() => sampleAt(new Float32Array(2), 2)).toThrow(
      'sample 2 is outside a buffer of 2 samples'
    );
  });
});

describe('controlAt', () => {
  it('reads a constant at every index', () => {
    expect([controlAt(440, 0), controlAt(440, 999)]).toEqual([440, 440]);
  });

  it('reads a per-sample control at its index', () => {
    expect(controlAt(new Float32Array([100, 200]), 1)).toBe(200);
  });
});

describe('requireControl', () => {
  it('accepts a constant inside the interval for any length', () => {
    expect(() => {
      requireControl('cutoff', 1000, 64, CUTOFF_RANGE);
    }).not.toThrow();
  });

  it('refuses a constant outside the interval, naming the parameter', () => {
    expect(() => {
      requireControl('cutoff', 24_000, 64, CUTOFF_RANGE);
    }).toThrow('cutoff must be in [0, 24000), got 24000');
  });

  it('accepts a per-sample control exactly as long as the output', () => {
    expect(() => {
      requireControl('cutoff', new Float32Array(64), 64, CUTOFF_RANGE);
    }).not.toThrow();
  });

  it('refuses a per-sample control one sample short', () => {
    expect(() => {
      requireControl('cutoff', new Float32Array(63), 64, CUTOFF_RANGE);
    }).toThrow(
      'cutoff holds 63 values for 64 samples: a per-sample control needs one value per sample'
    );
  });

  it('refuses a per-sample control one sample long', () => {
    expect(() => {
      requireControl('cutoff', new Float32Array(65), 64, CUTOFF_RANGE);
    }).toThrow(RangeError);
  });
});

describe('controlInRange', () => {
  it('reads a per-sample value inside the interval', () => {
    expect(controlInRange('cutoff', new Float32Array([100, 200]), 1, CUTOFF_RANGE)).toBe(200);
  });

  it('refuses a per-sample value outside the interval, naming its sample', () => {
    expect(() =>
      controlInRange('cutoff', new Float32Array([100, 24_000]), 1, CUTOFF_RANGE)
    ).toThrow('cutoff[1] must be in [0, 24000), got 24000');
  });
});
