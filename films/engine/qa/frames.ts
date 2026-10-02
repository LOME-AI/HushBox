import { FPS } from '../time/grid.js';

import { filmFrame } from './delivered.js';
import { gateResult } from './gate.js';

import type { CueKind } from '../film/spec.js';
import type { GateFailure, GateResult } from './gate.js';

/** A frame's BT.709 luma, mean and population standard deviation, on the 0–255 scale. */
export interface LumaStats {
  mean: number;
  deviation: number;
}

/** A half-open frame span `[from, to)`. */
interface Span {
  from: number;
  to: number;
}

/** What the frame rules read of a film spec. */
export interface FramesSpec {
  durationInFrames: number;
  shots: readonly Span[];
  cues: readonly { id: string; from: number; kind: CueKind }[];
  silences: readonly (Span & { cueId: string })[];
}

/** An inclusive run of delivered frames, each identical to the one before it but the first. */
export interface DeliveredRun {
  first: number;
  last: number;
}

export interface FramesEvidence {
  spec: FramesSpec;
  /** The probe frames, each judged for near-uniformity. */
  probes: readonly number[];
  /** Luma stats of the master's frames: every probe frame and every cut's neighbours. */
  stats: ReadonlyMap<number, LumaStats>;
  /** Runs of identical decoded frames in the delivered MP4, in delivered frames. */
  identicalRuns: readonly DeliveredRun[];
}

/** Luma standard deviation, on the 0–255 scale, below which a frame is near-uniform. */
const UNIFORM_DEVIATION = 2;
/** Mean luma, on the 0–255 scale, by which a cut frame may stand out from both neighbours. */
const SEAM_STEP = 40;

function inSilence(frame: number, silences: FramesSpec['silences']): boolean {
  return silences.some(({ from, to }) => frame >= from && frame < to);
}

function statsOf(stats: FramesEvidence['stats'], frame: number): LumaStats {
  const found = stats.get(frame);
  if (found === undefined) {
    throw new RangeError(
      `the frame rules need the luma of frame ${String(frame)}, which was not given`
    );
  }
  return found;
}

function nearUniform(filmId: string, evidence: FramesEvidence): GateFailure[] {
  return evidence.probes.flatMap((frame): GateFailure[] => {
    const { deviation } = statsOf(evidence.stats, frame);
    if (deviation >= UNIFORM_DEVIATION || inSilence(frame, evidence.spec.silences)) {
      return [];
    }
    return [
      {
        filmId,
        rule: 'near-uniform',
        at: `frame ${String(frame)}`,
        detail: `luma standard deviation ${deviation.toFixed(2)}/255 is below ${String(UNIFORM_DEVIATION)}/255 outside any silence span`,
      },
    ];
  });
}

function seamAt(filmId: string, cut: number, evidence: FramesEvidence): GateFailure[] {
  const { spec, stats } = evidence;
  if (spec.cues.some(({ from, kind }) => from === cut && kind === 'flash')) {
    return [];
  }
  const own = statsOf(stats, cut).mean;
  const neighbours = [cut - 1, cut + 1]
    .filter((frame) => frame < spec.durationInFrames)
    .map((frame) => statsOf(stats, frame).mean);
  if ([own, ...neighbours].some((mean) => Number.isNaN(mean))) {
    return [
      {
        filmId,
        rule: 'seam',
        at: `frame ${String(cut)}`,
        detail: 'a mean luma of the cut frame or a neighbour is not a number',
      },
    ];
  }
  const brighter = neighbours.every((mean) => own - mean > SEAM_STEP);
  const darker = neighbours.every((mean) => mean - own > SEAM_STEP);
  if (!brighter && !darker) {
    return [];
  }
  const against = neighbours.map((mean) => mean.toFixed(2)).join(' and ');
  return [
    {
      filmId,
      rule: 'seam',
      at: `frame ${String(cut)}`,
      detail: `the cut frame is ${brighter ? 'brighter' : 'darker'} than both neighbours by more than ${String(SEAM_STEP)}/255 (mean luma ${own.toFixed(2)} against ${against}) with no flash cue on it`,
    },
  ];
}

function frozen(filmId: string, evidence: FramesEvidence): GateFailure[] {
  return evidence.identicalRuns.flatMap(({ first, last }): GateFailure[] => {
    let outside = 0;
    for (let delivered = first; delivered <= last; delivered++) {
      outside += inSilence(filmFrame(delivered), evidence.spec.silences) ? 0 : 1;
    }
    if (outside <= FPS) {
      return [];
    }
    return [
      {
        filmId,
        rule: 'frozen',
        at: `frames ${String(filmFrame(first))}–${String(filmFrame(last))}`,
        detail: `${String(outside)} consecutive identical decoded frames outside any silence span, more than one second`,
      },
    ];
  });
}

/**
 * The frame rules: no probe frame near-uniform outside a silence span; no cut
 * frame standing out from both neighbours by more than 40/255 mean luma unless
 * a flash cue sits on it; and no run of identical decoded frames in the
 * delivered MP4 longer than one second outside silence spans.
 */
export function framesGate(filmId: string, evidence: FramesEvidence): GateResult {
  const cuts = evidence.spec.shots.filter(({ from }) => from > 0).map(({ from }) => from);
  const failures = [
    ...nearUniform(filmId, evidence),
    ...cuts.flatMap((cut) => seamAt(filmId, cut, evidence)),
    ...frozen(filmId, evidence),
  ];
  return gateResult('frames', failures, [
    `${String(evidence.probes.length)} probe frames judged for near-uniformity`,
    `${String(cuts.length)} cuts judged for seams`,
    `${String(evidence.identicalRuns.length)} ${evidence.identicalRuns.length === 1 ? 'run' : 'runs'} of identical decoded frames found`,
  ]);
}

/** The runs of frames equal to the frame before, from each frame's comparison with its predecessor. */
export function identicalRuns(sameAsPrevious: readonly boolean[]): DeliveredRun[] {
  const runs: DeliveredRun[] = [];
  for (const [frame, same] of sameAsPrevious.entries()) {
    const open = runs.at(-1);
    if (!same) {
      continue;
    }
    if (open?.last === frame - 1) {
      open.last = frame;
    } else {
      runs.push({ first: frame - 1, last: frame });
    }
  }
  return runs;
}
