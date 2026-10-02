// What the sound-design tests share: the instrument contract for a sound of any
// anchor, the placement a score makes, measured the way a listener's meter finds
// a sound's onset or end, and the measurements the sound tests are stated in.

import { createHash } from 'node:crypto';

import { expect, it } from 'vitest';

import { SAMPLES_PER_FRAME, SAMPLE_RATE, frameToSample } from '../../../time/grid.js';
import { bandPower, goertzelPower } from '../../dsp/dsp-test-support.js';
import { createStereo, mixInto, sampleAt } from '../../dsp/index.js';
import {
  ONSET_LEVEL,
  TEST_FRAMES_PER_BEAT,
  firstOnset,
  hasNaN,
  isAudible,
  itKeepsTheContract,
  peakOf,
  renderWith,
} from '../instrument-test-support.js';

import type { Window } from '../../dsp/dsp-test-support.js';
import type { StereoBuffer } from '../../dsp/index.js';
import type { Instrument, Rendered } from '../instrument.js';

/** A frequency band, in Hz: (low, high]. */
export interface Band {
  low: number;
  high: number;
}

/** The summed squares of the samples: a signal's energy. */
export function energy(signal: Float32Array): number {
  return signal.reduce((sum, sample) => sum + sample * sample, 0);
}

/** A window of `length` samples starting `seconds` in, to the nearest sample. */
export function windowAt(seconds: number, length: number): Window {
  return { from: Math.round(seconds * SAMPLE_RATE), length };
}

/** The samples a window covers. */
export function within(signal: Float32Array, window: Window): Float32Array {
  return signal.subarray(window.from, window.from + window.length);
}

/** The highest frequency `centroid` weighs, and the spacing of the frequencies it weighs. */
const CENTROID_TOP_HZ = 12_000;
const CENTROID_STEP_HZ = 20;

/** The power-weighted mean frequency of a window, over 20 Hz steps up to 12 kHz. */
export function centroid(signal: Float32Array, window: Window): number {
  let weighted = 0;
  let total = 0;
  for (let hertz = CENTROID_STEP_HZ; hertz <= CENTROID_TOP_HZ; hertz += CENTROID_STEP_HZ) {
    const power = goertzelPower(signal, hertz, window);
    weighted += hertz * power;
    total += power;
  }
  return weighted / total;
}

/** The share of a window's power in `band`, of the power in `band` and `rest` together. */
export function bandShare(
  signal: Float32Array,
  bands: { band: Band; rest: Band },
  window: Window
): number {
  const inBand = bandPower(signal, bands.band, window);
  return inBand / (inBand + bandPower(signal, bands.rest, window));
}

/** The SHA-256 of both channels' bytes, left then right: a render's fingerprint. */
function fingerprint(buffer: StereoBuffer): string {
  const hash = createHash('sha256');
  for (const channel of [buffer.left, buffer.right]) {
    hash.update(new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength));
  }
  return hash.digest('hex');
}

/** The first frame's sample at which the whole sound, anchored there, starts at or after sample 0. */
function scheduledFor(rendered: Rendered): number {
  return frameToSample(Math.ceil(rendered.anchorOffset / SAMPLES_PER_FRAME) + 1);
}

/** The sound mixed into silence the way a score places it: its anchor on `scheduled`. */
function placed(rendered: Rendered, scheduled: number): StereoBuffer {
  const mix = createStereo(scheduled + rendered.buffer.left.length + SAMPLES_PER_FRAME);
  mixInto(mix, rendered.buffer, {
    atSample: scheduled - rendered.anchorOffset,
    gain: 1,
    pan: 0,
  });
  return mix;
}

/** Whether both channels are exactly silent before sample `index`. */
function silentBefore(mix: StereoBuffer, index: number): boolean {
  return [mix.left, mix.right].every((channel) =>
    channel.subarray(0, index).every((sample) => sample === 0)
  );
}

/**
 * Where a meter finds the anchor in a mix: for `start` the first sample above
 * −60 dBFS, and for `end` one past the last sample above it. A peak anchor is
 * the peak of the sound's designed envelope, which no meter reads off one
 * render of seeded noise, so it has no measurement here.
 */
export function measuredAnchor(mix: StereoBuffer, anchor: 'start' | 'end'): number {
  if (anchor === 'start') {
    return firstOnset(mix);
  }
  const heard = mix.left.map((left, index) =>
    Math.max(Math.abs(left), Math.abs(sampleAt(mix.right, index)))
  );
  return heard.findLastIndex((magnitude) => magnitude > ONSET_LEVEL) + 1;
}

interface CommonOptions {
  raw: unknown;
  framesPerBeat?: number;
}

/** A sound whose cue lands on its first sample; one declared percussive is also heard from it. */
interface StartOptions extends CommonOptions {
  anchor: 'start';
}

/** A sound whose cue lands one past its last sample. */
interface EndOptions extends CommonOptions {
  anchor: 'end';
}

/**
 * A sound whose cue lands on the peak of its designed envelope, whatever the
 * seed puts in its loudest sample.
 */
interface PeakOptions extends CommonOptions {
  anchor: 'peak';
}

type ContractOptions = StartOptions | EndOptions | PeakOptions;

/** The contract's clauses every sound anchored on its peak or its end keeps. */
function itKeepsALateAnchor(render: (key: string) => Rendered): void {
  const contract = (): Rendered => render('contract');

  it('is audible', () => {
    expect(isAudible(contract().buffer)).toBe(true);
  });

  it('renders no NaN', () => {
    expect(hasNaN(contract().buffer)).toBe(false);
  });

  it('keeps every sample within full scale', () => {
    expect(peakOf(contract().buffer)).toBeLessThanOrEqual(1);
  });

  it('renders the same bytes from the same parameters and seed', () => {
    expect(fingerprint(contract().buffer)).toBe(fingerprint(contract().buffer));
  });

  it('renders different bytes from a different seed', () => {
    expect(fingerprint(render('other').buffer)).not.toBe(fingerprint(contract().buffer));
  });
}

/** How many seeds a peak-anchored sound's loudness is averaged over, and how far each sample's loudness is smoothed. */
const ENVELOPE_SEEDS = 16;
const ENVELOPE_SMOOTHING = SAMPLE_RATE / 100;
/**
 * How close, as a share of the sound's length, the anchor must sit to the peak
 * of that averaged loudness. A noise sound's envelope widens with its length,
 * so the estimate of its peak loosens with it: measured on the whoosh, sixteen
 * seeds smoothed over 10 ms find the peak within 1.5% of the length.
 */
const ENVELOPE_TOLERANCE = 0.02;

/**
 * The sample at which a sound's loudness peaks, averaged over renders of the
 * same parameters with different seeds and smoothed over a centred window of
 * `smoothing` samples: the envelope the sound was designed with, as heard
 * through its noise.
 */
function envelopePeak(renders: readonly [Rendered, ...Rendered[]], smoothing: number): number {
  const length = renders[0].buffer.left.length;
  const power = new Float64Array(length);
  for (const { buffer } of renders) {
    for (const [index, left] of buffer.left.entries()) {
      const right = sampleAt(buffer.right, index);
      power[index] = sampleAt(power, index) + left * left + right * right;
    }
  }
  const running = new Float64Array(length + 1);
  for (const [index, value] of power.entries()) {
    running[index + 1] = sampleAt(running, index) + value;
  }
  const half = Math.floor(smoothing / 2);
  let peak = 0;
  let loudest = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < length; index++) {
    const from = Math.max(0, index - half);
    const to = Math.min(length, index + half + 1);
    const level = (sampleAt(running, to) - sampleAt(running, from)) / (to - from);
    if (level > loudest) {
      loudest = level;
      peak = index;
    }
  }
  return peak;
}

/** Whether a sound's anchor sits on the peak of its loudness averaged over sixteen seeds. */
export function anchorsOnItsLoudnessPeak(render: (key: string) => Rendered): boolean {
  const first = render('envelope-0');
  const others = Array.from({ length: ENVELOPE_SEEDS - 1 }, (_zero, seed) =>
    render(`envelope-${String(seed + 1)}`)
  );
  const renders: [Rendered, ...Rendered[]] = [first, ...others];
  const tolerance = first.buffer.left.length * ENVELOPE_TOLERANCE;
  return Math.abs(envelopePeak(renders, ENVELOPE_SMOOTHING) - first.anchorOffset) <= tolerance;
}

/**
 * The instrument contract for a sound of any anchor, then the sound placed as a
 * score places it. A start-anchored sound keeps the music instruments' contract
 * and sounds nothing before its cue, and one declared percussive is also heard
 * from its cue sample. An end-anchored sound is measured finishing exactly on its cue
 * sample. A peak-anchored sound lands its cue on the peak of its loudness
 * averaged over many seeds, and on the same sample whatever the seed.
 */
export function itKeepsTheSfxContract<P>(
  instrument: Instrument<P>,
  options: ContractOptions
): void {
  const framesPerBeat = options.framesPerBeat ?? TEST_FRAMES_PER_BEAT;
  const render = (key: string): Rendered =>
    renderWith(instrument, options.raw, { key, framesPerBeat });

  if (options.anchor === 'start') {
    itKeepsTheContract(instrument, {
      raw: options.raw,
      framesPerBeat,
    });
    it('sounds nothing before its cue sample once placed', () => {
      const rendered = render('placed');
      const scheduled = scheduledFor(rendered);
      expect(silentBefore(placed(rendered, scheduled), scheduled)).toBe(true);
    });
    if (instrument.percussive) {
      it('is measured at its start on the scheduled sample once placed', () => {
        const rendered = render('placed');
        const scheduled = scheduledFor(rendered);
        expect(measuredAnchor(placed(rendered, scheduled), 'start')).toBe(scheduled);
      });
    }
    return;
  }

  itKeepsALateAnchor(render);
  if (options.anchor === 'end') {
    it('lands its cue one past its last sample', () => {
      const rendered = render('contract');
      expect(rendered.anchorOffset).toBe(rendered.buffer.left.length);
    });
    it('is measured at its end on the scheduled sample once placed', () => {
      const rendered = render('placed');
      const scheduled = scheduledFor(rendered);
      expect(measuredAnchor(placed(rendered, scheduled), 'end')).toBe(scheduled);
    });
    return;
  }

  it('lands its cue on the peak of its loudness averaged over sixteen seeds', () => {
    expect(anchorsOnItsLoudnessPeak(render)).toBe(true);
  });
  it('lands its cue on the same sample whatever the seed', () => {
    expect(render('other').anchorOffset).toBe(render('contract').anchorOffset);
  });
}
