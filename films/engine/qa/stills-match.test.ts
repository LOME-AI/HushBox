import { describe, expect, it } from 'vitest';

import { judgeProbe, lumaMse, stillsMatchGate } from './stills-match.js';

import type { StillsMatchProbe } from './stills-match.js';

const PIXELS = 64;

/** A luma plane of a ramp starting at `base`: every frame's content differs by its base. */
function plane(base: number): Uint8Array {
  return Uint8Array.from({ length: PIXELS }, (_, index) => base + index);
}

/** `source` with every other pixel raised by `amount`: encode noise of MSE amount² / 2. */
function noisy(source: Uint8Array, amount: number): Uint8Array {
  return source.map((value, index) => (index % 2 === 0 ? value + amount : value));
}

/** Probe `frame` whose references are frames frame − 1, frame, frame + 1 with bases `spacing` apart. */
function probe(frame: number, decoded: Uint8Array, spacing = 5): StillsMatchProbe {
  return {
    frame,
    decoded,
    references: new Map([
      [frame - 1, plane(100 - spacing)],
      [frame, plane(100)],
      [frame + 1, plane(100 + spacing)],
    ]),
  };
}

/** Frame 5 decoded with the given differences over ten pixels, its neighbour far away. */
function floorProbe(differences: readonly number[]): StillsMatchProbe {
  const reference = new Uint8Array(10).fill(100);
  const decoded = reference.map((value, index) => value + (differences[index] ?? 0));
  return {
    frame: 5,
    decoded,
    references: new Map([
      [5, reference],
      [6, new Uint8Array(10).fill(250)],
    ]),
  };
}

describe('stillsMatchGate: measures that are not numbers', () => {
  const neighbour = { frame: 6, error: 50, distance: 50 };

  it('refuses a probe whose own error is not a number', () => {
    const failures = stillsMatchGate('film', [
      { frame: 5, own: Number.NaN, neighbours: [neighbour] },
    ]).failures;

    expect(failures).toContain(
      'film: stills-match: frame 5: luma PSNR NaN dB against its own master frame, below 30 dB'
    );
  });

  it('refuses a probe whose error against a neighbour is not a number', () => {
    const judged = [{ frame: 5, own: 1, neighbours: [{ ...neighbour, error: Number.NaN }] }];

    expect(stillsMatchGate('film', judged).failures[0]).toContain('nearer master frame 6');
  });

  it('refuses a probe whose neighbour distance is not a number', () => {
    const judged = [{ frame: 5, own: 60, neighbours: [{ ...neighbour, distance: Number.NaN }] }];

    expect(stillsMatchGate('film', judged).failures[0]).toContain('nearer master frame 6');
  });
});

describe('lumaMse', () => {
  it('is 0 for identical planes', () => {
    expect(lumaMse(plane(5), plane(5))).toBe(0);
  });

  it('is the mean squared difference', () => {
    expect(lumaMse(plane(5), plane(8))).toBe(9);
  });

  it('refuses planes of different sizes', () => {
    expect(() => lumaMse(plane(5), new Uint8Array(3))).toThrow(/64 and 3/);
  });
});

/** The gate over probes, each judged first as the driver does. */
function gate(probes: readonly StillsMatchProbe[]): ReturnType<typeof stillsMatchGate> {
  return stillsMatchGate(
    'film',
    probes.map((candidate) => judgeProbe(candidate))
  );
}

describe('stillsMatchGate', () => {
  it('passes a decoded frame that is its reference plus small noise', () => {
    expect(gate([probe(5, noisy(plane(100), 2))]).passed).toBe(true);
  });

  it('fails a decoded frame nearer the next frame, naming the film, the rule, the frame and the neighbour', () => {
    expect(gate([probe(5, noisy(plane(105), 2))]).failures).toEqual([
      'film: stills-match: frame 5: the delivered frame is nearer master frame 6 (luma MSE 2.00) than frame 5 (luma MSE 37.00)',
    ]);
  });

  it('fails a decoded frame nearer the previous frame', () => {
    expect(gate([probe(5, noisy(plane(95), 2))]).failures[0]).toContain('nearer master frame 4');
  });

  it('passes a decoded frame nearer a neighbour that cannot be told apart at this noise', () => {
    // The neighbour differs by 1 (D = 1) while the noise error against it is 4.5.
    const close = probe(5, noisy(plane(101), 3), 1);

    expect(gate([close, probe(9, noisy(plane(100), 1))]).passed).toBe(true);
  });

  it('fails a decoded frame whose luma PSNR against its reference is below 30 dB', () => {
    // Noise of 46 on every other pixel is an MSE of 1058: 17.9 dB.
    const failures = gate([probe(5, noisy(plane(100), 46), 100)]).failures;

    expect(failures).toContain(
      'film: stills-match: frame 5: luma PSNR 17.9 dB against its own master frame, below 30 dB'
    );
  });

  it('accepts a luma MSE of 65, just inside the 30 dB floor', () => {
    // 25² + 5² over ten pixels is an MSE of 65; the floor is an MSE of 65.025.
    expect(gate([floorProbe([25, 5])]).passed).toBe(true);
  });

  it('fails a luma MSE of 65.1, just outside the 30 dB floor', () => {
    expect(gate([floorProbe([25, 5, 1])]).passed).toBe(false);
  });

  it('fails as unwitnessed when no probe frame has a distinguishable neighbour', () => {
    const still = probe(5, noisy(plane(100), 3), 0);

    expect(gate([still]).failures).toEqual([
      "film: stills-match: every probe frame: alignment unwitnessed: no probe frame has a neighbour distinguishable from it at this encode's noise",
    ]);
  });

  it('fails a film with no probe frame as unwitnessed, measuring nothing', () => {
    const result = gate([]);

    expect([result.failures.length, result.measured]).toEqual([1, []]);
  });

  it('uses only the neighbour that exists at the first frame', () => {
    const first: StillsMatchProbe = {
      frame: 0,
      decoded: noisy(plane(105), 2),
      references: new Map([
        [0, plane(100)],
        [1, plane(105)],
      ]),
    };

    expect(gate([first]).failures[0]).toContain('nearer master frame 1');
  });

  it('refuses a probe with no reference of its own frame', () => {
    const orphan: StillsMatchProbe = {
      frame: 5,
      decoded: plane(100),
      references: new Map([[6, plane(105)]]),
    };

    expect(() => judgeProbe(orphan)).toThrow(/frame 5/);
  });

  it('reports the worst PSNR and the smallest neighbour margin', () => {
    expect(gate([probe(5, noisy(plane(100), 2))]).measured).toEqual([
      'worst luma PSNR 45.1 dB at frame 5, 15.1 dB above the 30 dB floor',
      'smallest neighbour margin 9.3 dB (frame 5 against frame 6); 1 of 1 probe frames witness alignment',
    ]);
  });
});
