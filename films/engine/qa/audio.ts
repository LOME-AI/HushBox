import {
  MOMENTARY_WINDOW,
  amplitudeToDb,
  clipCount,
  dcOffset,
  firstOnsetSample,
  kWeightStereo,
  lowBandCorrelation,
  measureLoudness,
  momentaryLufsAt,
  truePeakDbtp,
} from '../analyze/index.js';
import { FPS, SAMPLE_RATE, frameToSample } from '../time/grid.js';

import { gateResult } from './gate.js';
import { highestBy } from './pick.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { CueKind } from '../film/spec.js';
import type { GateFailure, GateResult } from './gate.js';

const TARGET_LUFS = -14;
const LOUDNESS_TOLERANCE_LU = 0.5;
const CEILING_DBTP = -1;
const DC_LIMIT = 0.001;
const LOW_BAND_FLOOR = 0.9;
/** The level, relative to the track's gain, a percussive stem is first heard at. */
const ONSET_DB = -60;
/** A rise into a cue beyond this many dB startles. */
const STARTLE_DB = 6;
/** The meter reads momentary loudness every 100 ms. */
const READING_STEP = SAMPLE_RATE / 10;
/** Readings over the second before a cue, ending on it. */
const READINGS_BEFORE = 10;
/** Readings over the 400 ms after a cue. */
const READINGS_AFTER = MOMENTARY_WINDOW / READING_STEP;
/** A cue this soon after a silence ends, or after the film starts, may rise freely. */
const RETURN_FRAMES = 0.8 * FPS;

export interface AudioEvidence {
  cues: readonly { id: string; from: number; kind: CueKind }[];
  silences: readonly { cueId: string; from: number; to: number }[];
  /** The master as delivered in the WAV, dither included. */
  master: StereoBuffer;
  placements: readonly { track: string; cueId: string | null; sample: number }[];
  /** Each percussive track's stem, placed with its gain and pan, and its linear gain. */
  percussive: readonly { track: string; gain: number; stem: StereoBuffer }[];
}

type Fail = (rule: string, at: string, detail: string) => GateFailure;

function placementFailures(evidence: AudioEvidence, fail: Fail): GateFailure[] {
  const length = evidence.master.left.length;
  return evidence.placements.flatMap(({ track, cueId, sample }): GateFailure[] => {
    const at =
      cueId === null
        ? `track ${JSON.stringify(track)}`
        : `cue ${JSON.stringify(cueId)}, track ${JSON.stringify(track)}`;
    if (!(Number.isInteger(sample) && sample >= 0 && sample <= length)) {
      return [
        fail(
          'placement',
          at,
          `sample ${String(sample)} is not a whole sample of the master's ${String(length)}`
        ),
      ];
    }
    if (cueId === null) {
      return [];
    }
    const cue = evidence.cues.find(({ id }) => id === cueId);
    if (cue === undefined) {
      return [fail('placement', at, 'names no cue of the film')];
    }
    const expected = frameToSample(cue.from);
    return sample === expected
      ? []
      : [
          fail(
            'placement',
            at,
            `placed at sample ${String(sample)}, not the cue's sample ${String(expected)}`
          ),
        ];
  });
}

function stemFailures(evidence: AudioEvidence, fail: Fail): GateFailure[] {
  return evidence.percussive.flatMap(({ track, gain, stem }): GateFailure[] => {
    const scheduled = Math.min(
      ...evidence.placements
        .filter((placement) => placement.track === track)
        .map(({ sample }) => sample)
    );
    if (!Number.isFinite(scheduled)) {
      return [];
    }
    const at = `track ${JSON.stringify(track)}`;
    const onset = firstOnsetSample(stem, ONSET_DB + amplitudeToDb(gain));
    if (onset === null) {
      return [
        fail(
          'stem-onset',
          at,
          `never rises above ${String(ONSET_DB).replace('-', '−')} dB relative to its gain`
        ),
      ];
    }
    return onset === scheduled
      ? []
      : [
          fail(
            'stem-onset',
            at,
            `first onset at sample ${String(onset)}, not its scheduled sample ${String(scheduled)}`
          ),
        ];
  });
}

/** The master's levels, as the level rules read them. */
export interface MasterLevels {
  integratedLufs: number;
  truePeakDbtp: number;
  clips: number;
  dc: { left: number; right: number };
  /** null when the low band is silent in either channel. */
  lowBandCorrelation: number | null;
}

/** Every level of the master the rules judge. */
export function measureMaster(master: StereoBuffer): MasterLevels {
  return {
    integratedLufs: measureLoudness(master).integratedLufs,
    truePeakDbtp: truePeakDbtp(master),
    clips: clipCount(master),
    dc: dcOffset(master),
    lowBandCorrelation: lowBandCorrelation(master),
  };
}

function loudnessFailures(levels: MasterLevels, fail: Fail): GateFailure[] {
  const failures: GateFailure[] = [];
  const { integratedLufs, truePeakDbtp: peak, clips } = levels;
  const offTarget = Math.abs(integratedLufs - TARGET_LUFS);
  if (Number.isNaN(offTarget) || offTarget > LOUDNESS_TOLERANCE_LU) {
    failures.push(
      fail(
        'loudness',
        'master',
        `integrated loudness ${integratedLufs.toFixed(2)} LUFS is outside ${String(TARGET_LUFS)} ±${String(LOUDNESS_TOLERANCE_LU)} LUFS`
      )
    );
  }
  if (Number.isNaN(peak) || peak > CEILING_DBTP) {
    failures.push(
      fail(
        'true-peak',
        'master',
        `true peak ${peak.toFixed(2)} dBTP is above ${String(CEILING_DBTP)} dBTP`
      )
    );
  }
  if (!Number.isFinite(clips) || clips > 0) {
    failures.push(
      fail(
        'clips',
        'master',
        `${String(clips)} ${clips === 1 ? 'sample' : 'samples'} at or beyond full scale`
      )
    );
  }
  return failures;
}

function balanceFailures(levels: MasterLevels, fail: Fail): GateFailure[] {
  const failures: GateFailure[] = [];
  const channels = [
    ['left', levels.dc.left],
    ['right', levels.dc.right],
  ] as const;
  for (const [channel, mean] of channels) {
    const offset = Math.abs(mean);
    if (Number.isNaN(offset) || offset >= DC_LIMIT) {
      failures.push(
        fail(
          'dc-offset',
          'master',
          `${channel} channel mean ${mean.toFixed(5)} is not under ${String(DC_LIMIT)}`
        )
      );
    }
  }
  const correlation = levels.lowBandCorrelation;
  if (correlation !== null && (Number.isNaN(correlation) || correlation < LOW_BAND_FLOOR)) {
    failures.push(
      fail(
        'low-band',
        'master',
        `low-band mono correlation ${correlation.toFixed(3)} is below ${String(LOW_BAND_FLOOR)}`
      )
    );
  }
  return failures;
}

/**
 * The master level rules over measured levels: −14 ±0.5 LUFS integrated, at
 * most −1 dBTP, no clipped sample, a DC offset under 0.001 per channel and a low
 * band that holds in mono. A level that is not a number fails its rule.
 */
export function levelFailures(
  filmId: string,
  levels: MasterLevels
): { failures: GateFailure[]; measured: string[] } {
  const fail: Fail = (rule, at, detail) => ({ filmId, rule, at, detail });
  const { integratedLufs, truePeakDbtp: peak, clips, dc, lowBandCorrelation: correlation } = levels;
  return {
    failures: [...loudnessFailures(levels, fail), ...balanceFailures(levels, fail)],
    measured: [
      `integrated ${integratedLufs.toFixed(2)} LUFS, true peak ${peak.toFixed(2)} dBTP, ${String(clips)} clipped samples`,
      `DC offset ${dc.left.toExponential(2)} left, ${dc.right.toExponential(2)} right; low-band correlation ${correlation === null ? 'none (the low band is silent)' : correlation.toFixed(3)}`,
    ],
  };
}

/** Momentary loudness, as a meter reads it, at each sample: the 400 ms ending there; silence before the film. */
function meter(master: StereoBuffer): (end: number) => number {
  const lead = SAMPLE_RATE;
  const padded = {
    left: new Float32Array(lead + master.left.length),
    right: new Float32Array(lead + master.right.length),
  };
  padded.left.set(master.left, lead);
  padded.right.set(master.right, lead);
  const weighted = kWeightStereo(padded);
  return (end) => momentaryLufsAt(weighted, lead + end - MOMENTARY_WINDOW);
}

function meanLoudness(readings: readonly number[]): number {
  const power = readings.reduce((sum, lufs) => sum + 10 ** (lufs / 10), 0) / readings.length;
  return 10 * Math.log10(power);
}

/** A cue's rise in momentary loudness, and whether its kind or place lets it rise freely. */
export interface CueRise {
  cueId: string;
  /** In dB, from the mean of the second before the cue to the loudest reading of the 400 ms after it. */
  rise: number;
  /** An impact, or a cue soon after a silence or the film's start, may rise freely. */
  exempt: boolean;
}

interface Rise extends CueRise {
  failure: GateFailure | null;
}

/** The startle rule for one cue: a rise of more than 6 dB into a cue that is not exempt fails. */
export function startleFailure(
  filmId: string,
  { cueId, rise, exempt }: CueRise
): GateFailure | null {
  const startled = Number.isNaN(rise) || rise > STARTLE_DB;
  if (!startled || exempt) {
    return null;
  }
  const size = rise === Number.POSITIVE_INFINITY ? 'from silence' : `${rise.toFixed(1)} dB`;
  return {
    filmId,
    rule: 'startle',
    at: `cue ${JSON.stringify(cueId)}`,
    detail: `momentary loudness rises ${size} from the second before to the 400 ms after, more than ${String(STARTLE_DB)} dB`,
  };
}

function startles(evidence: AudioEvidence & { filmId: string }): Rise[] {
  const length = evidence.master.left.length;
  const read = meter(evidence.master);
  const returns = [0, ...evidence.silences.map(({ to }) => to)];
  return evidence.cues.flatMap(({ id, from, kind }): Rise[] => {
    const sample = frameToSample(from);
    const after = Array.from(
      { length: READINGS_AFTER },
      (_, index) => sample + (index + 1) * READING_STEP
    ).filter((end) => end <= length);
    if (after.length === 0) {
      return [];
    }
    const before = meanLoudness(
      Array.from({ length: READINGS_BEFORE }, (_, index) =>
        read(Math.max(0, sample - index * READING_STEP))
      )
    );
    const loudest = Math.max(...after.map((end) => read(end)));
    // Digital silence on both sides reads −∞ twice, whose difference is no number: it is no rise.
    const silentThrough =
      loudest === Number.NEGATIVE_INFINITY && before === Number.NEGATIVE_INFINITY;
    const rise = silentThrough ? 0 : loudest - before;
    const returning = returns.some((end) => from >= end && from - end <= RETURN_FRAMES);
    const judged = { cueId: id, rise, exempt: kind === 'impact' || returning };
    return [{ ...judged, failure: startleFailure(evidence.filmId, judged) }];
  });
}

function startleFailures(
  filmId: string,
  evidence: AudioEvidence
): { failures: GateFailure[]; measured: string[] } {
  const rises = startles({ ...evidence, filmId });
  const largest = highestBy(
    rises.filter(({ exempt }) => !exempt),
    ({ rise }) => rise
  );
  const exempt = rises.filter((rise) => rise.exempt).length;
  const exemptions =
    exempt === 1
      ? '1 cue exempt as an impact or a return from silence'
      : `${String(exempt)} cues exempt as impacts or returns from silence`;
  return {
    failures: rises.flatMap(({ failure }) => failure ?? []),
    measured: [
      largest === null
        ? `no cue judged for a rise; ${exemptions}`
        : `largest rise into a judged cue ${largest.rise.toFixed(1)} dB (cue ${JSON.stringify(largest.cueId)}); ${exemptions}`,
    ],
  };
}

/**
 * The audio rules over the rendered score: every placement on its exact
 * sample; each percussive stem first heard on its scheduled sample; the master
 * at −14 ±0.5 LUFS integrated and at most −1 dBTP, with no clipped sample, a DC
 * offset under 0.001 and a low band that holds in mono; and no rise of more
 * than 6 dB into a cue unless it is an impact or a return from silence.
 */
export function audioGate(filmId: string, evidence: AudioEvidence): GateResult {
  const fail: Fail = (rule, at, detail) => ({ filmId, rule, at, detail });
  const levels = levelFailures(filmId, measureMaster(evidence.master));
  const startle = startleFailures(filmId, evidence);
  return gateResult(
    'audio',
    [
      ...placementFailures(evidence, fail),
      ...stemFailures(evidence, fail),
      ...levels.failures,
      ...startle.failures,
    ],
    [
      `${String(evidence.placements.length)} placements checked; ${String(evidence.percussive.length)} percussive stems checked`,
      ...levels.measured,
      ...startle.measured,
    ]
  );
}
