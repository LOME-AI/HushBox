import { describe, expect, it } from 'vitest';

import { FPS } from '../time/grid.js';
import { LEAD_FRAMES } from '../render/delivery-timing.js';
import { framesGate, identicalRuns } from './frames.js';

import type { FramesEvidence, LumaStats } from './frames.js';

const DURATION = 4 * FPS;
const CUT = 2 * FPS;
const LAST = DURATION - 1;
const TEXTURED: LumaStats = { mean: 60, deviation: 30 };

/** Stats for every frame of a two-shot film, each textured at the same mean. */
function evidence(overrides: Partial<FramesEvidence> = {}): FramesEvidence {
  const stats = new Map<number, LumaStats>(
    Array.from({ length: DURATION }, (_, frame): [number, LumaStats] => [frame, TEXTURED])
  );
  return {
    spec: {
      durationInFrames: DURATION,
      shots: [
        { from: 0, to: CUT },
        { from: CUT, to: DURATION },
      ],
      cues: [],
      silences: [],
    },
    probes: [0, CUT - 1, CUT, LAST],
    stats,
    identicalRuns: [],
    ...overrides,
  };
}

function withStats(frames: Record<number, LumaStats>): Map<number, LumaStats> {
  const stats = new Map(evidence().stats);
  for (const [frame, value] of Object.entries(frames)) {
    stats.set(Number(frame), value);
  }
  return stats;
}

describe('framesGate: near-uniform probe frames', () => {
  it('passes textured probe frames', () => {
    expect(framesGate('film', evidence()).passed).toBe(true);
  });

  it('fails a probe frame whose luma deviation is below 2/255, naming the frame', () => {
    const stats = withStats({ 0: { mean: 60, deviation: 1.99 } });

    expect(framesGate('film', evidence({ stats })).failures).toEqual([
      'film: near-uniform: frame 0: luma standard deviation 1.99/255 is below 2/255 outside any silence span',
    ]);
  });

  it('fails a probe frame whose luma deviation is not a number', () => {
    const stats = withStats({ 0: { mean: 60, deviation: Number.NaN } });

    expect(framesGate('film', evidence({ stats })).failures).toEqual([
      'film: near-uniform: frame 0: luma standard deviation NaN/255 is below 2/255 outside any silence span',
    ]);
  });

  it('accepts a probe frame whose luma deviation is exactly 2/255', () => {
    const stats = withStats({ 0: { mean: 60, deviation: 2 } });

    expect(framesGate('film', evidence({ stats })).passed).toBe(true);
  });

  it('accepts a near-uniform probe frame inside a silence span', () => {
    const stats = withStats({ 0: { mean: 0, deviation: 0 } });
    const spec = { ...evidence().spec, silences: [{ cueId: 'hush', from: 0, to: 10 }] };

    expect(framesGate('film', evidence({ stats, spec })).passed).toBe(true);
  });

  it('fails a near-uniform probe frame on the frame a silence span ends', () => {
    const stats = withStats({ 10: { mean: 0, deviation: 0 } });
    const spec = { ...evidence().spec, silences: [{ cueId: 'hush', from: 0, to: 10 }] };

    expect(framesGate('film', evidence({ stats, spec, probes: [10] })).passed).toBe(false);
  });

  it('judges only the probe frames, not their neighbours', () => {
    const stats = withStats({ 1: { mean: 0, deviation: 0 } });

    expect(framesGate('film', evidence({ stats })).passed).toBe(true);
  });
});

describe('framesGate: seams', () => {
  it('fails a cut frame brighter than both neighbours by more than 40/255, naming the frame', () => {
    const stats = withStats({ [CUT]: { mean: 100.01, deviation: 30 } });

    expect(framesGate('film', evidence({ stats })).failures).toEqual([
      `film: seam: frame ${String(CUT)}: the cut frame is brighter than both neighbours by more than 40/255 (mean luma 100.01 against 60.00 and 60.00) with no flash cue on it`,
    ]);
  });

  it('fails a cut frame darker than both neighbours by more than 40/255', () => {
    const stats = withStats({ [CUT]: { mean: 19.99, deviation: 30 } });

    expect(framesGate('film', evidence({ stats })).failures[0]).toContain('darker than both');
  });

  it('accepts a cut frame exactly 40/255 brighter than both neighbours', () => {
    const stats = withStats({ [CUT]: { mean: 100, deviation: 30 } });

    expect(framesGate('film', evidence({ stats })).passed).toBe(true);
  });

  it('accepts a cut frame brighter than only one neighbour', () => {
    const stats = withStats({
      [CUT]: { mean: 120, deviation: 30 },
      [CUT + 1]: { mean: 120, deviation: 30 },
    });

    expect(framesGate('film', evidence({ stats })).passed).toBe(true);
  });

  it('accepts a bright cut frame with a flash cue on it', () => {
    const stats = withStats({ [CUT]: { mean: 255, deviation: 30 } });
    const spec = { ...evidence().spec, cues: [{ id: 'pop', from: CUT, kind: 'flash' as const }] };

    expect(framesGate('film', evidence({ stats, spec })).passed).toBe(true);
  });

  it('fails a bright cut frame whose cue there is not a flash', () => {
    const stats = withStats({ [CUT]: { mean: 255, deviation: 30 } });
    const spec = { ...evidence().spec, cues: [{ id: 'pop', from: CUT, kind: 'hit' as const }] };

    expect(framesGate('film', evidence({ stats, spec })).passed).toBe(false);
  });

  it('compares a cut on the last frame with the one neighbour it has', () => {
    const spec = {
      ...evidence().spec,
      shots: [
        { from: 0, to: LAST },
        { from: LAST, to: DURATION },
      ],
    };
    const stats = withStats({ [LAST]: { mean: 200, deviation: 30 } });

    expect(framesGate('film', evidence({ stats, spec })).failures[0]).toContain(
      `seam: frame ${String(LAST)}`
    );
  });

  it('refuses a frame it needs and was not given, as a defect of the caller', () => {
    const stats = withStats({});
    stats.delete(CUT + 1);

    expect(() => framesGate('film', evidence({ stats }))).toThrow(/frame 121/);
  });
});

describe('framesGate: seam measures that are not numbers', () => {
  it('refuses a cut frame whose mean luma is not a number', () => {
    const stats = withStats({ [CUT]: { mean: Number.NaN, deviation: 30 } });

    expect(framesGate('film', evidence({ stats })).failures[0]).toMatch(/^film: seam: frame 120: /);
  });

  it('refuses a cut whose neighbour mean luma is not a number', () => {
    const stats = withStats({ [CUT - 1]: { mean: Number.NaN, deviation: 30 } });

    expect(framesGate('film', evidence({ stats })).failures[0]).toMatch(/^film: seam: frame 120: /);
  });
});

describe('framesGate: frozen runs', () => {
  it('fails a run of identical delivered frames longer than one second, naming its frames', () => {
    const run = { first: 30, last: 30 + FPS };

    expect(framesGate('film', evidence({ identicalRuns: [run] })).failures).toEqual([
      `film: frozen: frames ${String(30 - LEAD_FRAMES)}–${String(30 + FPS - LEAD_FRAMES)}: ${String(FPS + 1)} consecutive identical decoded frames outside any silence span, more than one second`,
    ]);
  });

  it('accepts a run of exactly one second', () => {
    const run = { first: 30, last: 30 + FPS - 1 };

    expect(framesGate('film', evidence({ identicalRuns: [run] })).passed).toBe(true);
  });

  it('accepts a long run inside a silence span', () => {
    const spec = { ...evidence().spec, silences: [{ cueId: 'hush', from: 0, to: 2 * FPS }] };
    const run = { first: LEAD_FRAMES + 10, last: LEAD_FRAMES + 10 + FPS * 1.5 };

    expect(framesGate('film', evidence({ spec, identicalRuns: [run] })).passed).toBe(true);
  });

  it('counts the lead copies of frame 0 as delivered frames of the run', () => {
    const run = { first: 0, last: FPS };

    expect(framesGate('film', evidence({ identicalRuns: [run] })).failures[0]).toContain(
      `frozen: frames 0–${String(FPS - LEAD_FRAMES)}`
    );
  });
});

describe('framesGate: measurements', () => {
  it('counts one run of identical frames in the singular', () => {
    expect(
      framesGate('film', evidence({ identicalRuns: [{ first: 0, last: 2 }] })).measured
    ).toContain('1 run of identical decoded frames found');
  });

  it('counts several runs in the plural', () => {
    const runs = [
      { first: 0, last: 2 },
      { first: 9, last: 10 },
    ];

    expect(framesGate('film', evidence({ identicalRuns: runs })).measured).toContain(
      '2 runs of identical decoded frames found'
    );
  });
});

describe('identicalRuns', () => {
  it('finds each run of frames equal to the one before', () => {
    expect(identicalRuns([false, true, true, false, false, true])).toEqual([
      { first: 0, last: 2 },
      { first: 4, last: 5 },
    ]);
  });

  it('finds none when every frame differs from the one before', () => {
    expect(identicalRuns([false, false, false])).toEqual([]);
  });
});
