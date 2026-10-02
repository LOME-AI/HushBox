import { at } from './at.js';
import { gateResult } from './gate.js';
import { highestBy, lowestBy } from './pick.js';

import type { GateFailure, GateResult } from './gate.js';

/** The luma PSNR, in dB, a delivered frame must reach against its own master frame. */
const FLOOR_DB = 30;

/**
 * A probe frame: the luma plane of the delivered frame that shows it, and the
 * luma of the master PNGs of the frame and of each neighbour it has, every
 * reference converted by the delivery's own RGB → Y′CbCr filter.
 */
export interface StillsMatchProbe {
  frame: number;
  decoded: Uint8Array;
  references: ReadonlyMap<number, Uint8Array>;
}

/** The mean squared difference of two luma planes. */
export function lumaMse(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) {
    throw new RangeError(
      `luma planes differ in size: ${String(a.length)} and ${String(b.length)} samples`
    );
  }
  let squares = 0;
  for (const [index, value] of a.entries()) {
    const difference = value - at(b, index);
    squares += difference * difference;
  }
  return squares / a.length;
}

function psnr(mse: number): number {
  return 10 * Math.log10((255 * 255) / mse);
}

export interface Neighbour {
  frame: number;
  /** The decoded frame's error against this neighbour's reference. */
  error: number;
  /** How far this neighbour's reference lies from the probe frame's own. */
  distance: number;
}

/** A probe frame's luma errors: against its own master frame, and against and between each neighbour. */
export interface JudgedProbe {
  frame: number;
  own: number;
  neighbours: Neighbour[];
}

type Judged = JudgedProbe;

/** The luma errors of one probe frame, so the planes can be dropped before the next is decoded. */
export function judgeProbe(probe: StillsMatchProbe): JudgedProbe {
  const reference = probe.references.get(probe.frame);
  if (reference === undefined) {
    throw new RangeError(
      `stills-match: probe frame ${String(probe.frame)} has no reference of its own`
    );
  }
  const neighbours = [probe.frame - 1, probe.frame + 1].flatMap((frame): Neighbour[] => {
    const other = probe.references.get(frame);
    return other === undefined
      ? []
      : [{ frame, error: lumaMse(probe.decoded, other), distance: lumaMse(reference, other) }];
  });
  return { frame: probe.frame, own: lumaMse(probe.decoded, reference), neighbours };
}

function probeFailures(filmId: string, { frame, own, neighbours }: Judged): GateFailure[] {
  const at = `frame ${String(frame)}`;
  const failures: GateFailure[] = [];
  if (Number.isNaN(own) || psnr(own) < FLOOR_DB) {
    failures.push({
      filmId,
      rule: 'stills-match',
      at,
      detail: `luma PSNR ${psnr(own).toFixed(1)} dB against its own master frame, below ${String(FLOOR_DB)} dB`,
    });
  }
  for (const neighbour of neighbours) {
    const { error, distance } = neighbour;
    const nearer = Number.isNaN(error) || error < own;
    const distinguishable = Number.isNaN(error) || Number.isNaN(distance) || distance >= error;
    if (nearer && distinguishable) {
      failures.push({
        filmId,
        rule: 'stills-match',
        at,
        detail: `the delivered frame is nearer master frame ${String(neighbour.frame)} (luma MSE ${neighbour.error.toFixed(2)}) than frame ${String(frame)} (luma MSE ${own.toFixed(2)})`,
      });
    }
  }
  return failures;
}

/** The neighbours that witness a probe's alignment: told apart from it by more than the encode's smallest error. */
function witnesses({ own, neighbours }: Judged): Neighbour[] {
  const noise = Math.min(own, ...neighbours.map(({ error }) => error));
  return neighbours.filter(({ distance }) => distance >= noise);
}

function measurements(judged: readonly Judged[]): string[] {
  const worst = highestBy(judged, ({ own }) => own);
  if (worst === null) {
    return [];
  }
  const lines = [
    `worst luma PSNR ${psnr(worst.own).toFixed(1)} dB at frame ${String(worst.frame)}, ${(psnr(worst.own) - FLOOR_DB).toFixed(1)} dB above the ${String(FLOOR_DB)} dB floor`,
  ];
  const margins = judged.flatMap(({ frame, own, neighbours }) =>
    witnesses({ frame, own, neighbours }).map((neighbour) => ({
      frame,
      neighbour: neighbour.frame,
      margin: 10 * Math.log10(neighbour.error / own),
    }))
  );
  const witnessed = judged.filter((probe) => witnesses(probe).length > 0).length;
  const smallest = lowestBy(margins, ({ margin }) => margin);
  if (smallest !== null) {
    lines.push(
      `smallest neighbour margin ${smallest.margin.toFixed(1)} dB (frame ${String(smallest.frame)} against frame ${String(smallest.neighbour)}); ${String(witnessed)} of ${String(judged.length)} probe frames witness alignment`
    );
  }
  return lines;
}

/**
 * Stills match the delivery: at each probe frame the delivered luma reaches
 * 30 dB PSNR against its own master frame, and is not nearer a neighbour's
 * master frame that the encode's noise can tell apart from it. A film where no
 * probe frame has such a neighbour fails as alignment unwitnessed, since its
 * alignment cannot be proven.
 */
export function stillsMatchGate(filmId: string, judged: readonly JudgedProbe[]): GateResult {
  const failures = judged.flatMap((probe) => probeFailures(filmId, probe));
  if (!judged.some((probe) => witnesses(probe).length > 0)) {
    failures.push({
      filmId,
      rule: 'stills-match',
      at: 'every probe frame',
      detail:
        "alignment unwitnessed: no probe frame has a neighbour distinguishable from it at this encode's noise",
    });
  }
  return gateResult('stills-match', failures, measurements(judged));
}
