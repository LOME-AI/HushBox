// What the instrument tests share: rendering the way a score renders, the
// measurements the instrument contract is stated in, and the contract's own
// tests, which every instrument's test file runs over its parameters.

import { Buffer } from 'node:buffer';

import { expect, it } from 'vitest';

import { rand } from '../../rand/rand.js';

import type { StereoBuffer } from '../dsp/index.js';
import type { Instrument, Rendered } from './instrument.js';

/** The tempo tests render at unless they say otherwise: 24 frames per beat. */
export const TEST_FRAMES_PER_BEAT = 24;

/** −60 dBFS as an amplitude: a sample above it is heard. */
export const ONSET_LEVEL = 1e-3;

/** An instrument rendered from raw parameters, the way a score renders it. */
export function renderWith<P>(
  instrument: Instrument<P>,
  raw: unknown,
  options: { key?: string; framesPerBeat?: number } = {}
): Rendered {
  return instrument.render(instrument.params.parse(raw), {
    rand: rand(options.key ?? 'fixture'),
    framesPerBeat: options.framesPerBeat ?? TEST_FRAMES_PER_BEAT,
  });
}

/** Both channels' bytes, left then right. */
function bytesOf(buffer: StereoBuffer): Buffer {
  return Buffer.concat(
    [buffer.left, buffer.right].map((channel) =>
      Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength)
    )
  );
}

/** The loudest magnitude in either channel, measured apart from the code under test. */
export function peakOf(buffer: StereoBuffer): number {
  return Math.max(0, ...[buffer.left, buffer.right].map((channel) => loudest(channel)));
}

function loudest(channel: Float32Array): number {
  let peak = 0;
  for (const sample of channel) {
    if (Math.abs(sample) > peak) {
      peak = Math.abs(sample);
    }
  }
  return peak;
}

export function hasNaN(buffer: StereoBuffer): boolean {
  return [buffer.left, buffer.right].some((channel) =>
    channel.some((sample) => Number.isNaN(sample))
  );
}

/** The first index at which either channel is above −60 dBFS; Infinity when neither ever is. */
export function firstOnset(buffer: StereoBuffer): number {
  const onsets = [buffer.left, buffer.right]
    .map((channel) => channel.findIndex((sample) => Math.abs(sample) > ONSET_LEVEL))
    .filter((index) => index >= 0);
  return Math.min(...onsets);
}

/** Positive-going zero crossings: one per cycle of a steady tone. */
export function risingCrossings(signal: Float32Array): number {
  let count = 0;
  let previous = Number.NaN;
  for (const sample of signal) {
    if (previous < 0 && sample >= 0) {
      count++;
    }
    previous = sample;
  }
  return count;
}

/** Whether any sample of either channel is above −60 dBFS. */
export function isAudible(buffer: StereoBuffer): boolean {
  return peakOf(buffer) > ONSET_LEVEL;
}

/**
 * The instrument contract's tests over one set of raw parameters: audible, no
 * NaN, no sample past full scale, the cue on the first sample, and bytes that
 * depend on the parameters and seed alone. An instrument declared percussive is
 * also heard from its first sample, so its audible onset is the sample it is
 * scheduled on.
 */
export function itKeepsTheContract<P>(
  instrument: Instrument<P>,
  options: { raw: unknown; framesPerBeat?: number }
): void {
  const framesPerBeat = options.framesPerBeat ?? TEST_FRAMES_PER_BEAT;
  const render = (key: string): Rendered =>
    renderWith(instrument, options.raw, { key, framesPerBeat });

  it('is audible', () => {
    expect(isAudible(render('contract').buffer)).toBe(true);
  });

  it('renders no NaN', () => {
    expect(hasNaN(render('contract').buffer)).toBe(false);
  });

  it('keeps every sample within full scale', () => {
    expect(peakOf(render('contract').buffer)).toBeLessThanOrEqual(1);
  });

  it('lands its cue on its first sample', () => {
    expect(render('contract').anchorOffset).toBe(0);
  });

  it('renders the same bytes from the same parameters and seed', () => {
    expect(bytesOf(render('contract').buffer).equals(bytesOf(render('contract').buffer))).toBe(
      true
    );
  });

  it('renders different bytes from a different seed', () => {
    expect(bytesOf(render('contract').buffer).equals(bytesOf(render('other').buffer))).toBe(false);
  });

  if (instrument.percussive) {
    it('is heard from its first sample: the first sample above −60 dBFS is index 0', () => {
      expect(firstOnset(render('contract').buffer)).toBe(0);
    });
  }
}

/** A parameter's bound: the last value it accepts and the first it refuses. */
interface Bound {
  key: string;
  accepted: unknown;
  refused: unknown;
  /** The tempo the accepted value renders at, where it is not the default. */
  framesPerBeat?: number;
}

/**
 * Each bound pinned on both sides, and NaN refused for every parameter bounded.
 * The accepted value must render as every value a score may pass must: audible,
 * free of NaN and within full scale.
 */
export function itHoldsBounds<P>(instrument: Instrument<P>, bounds: readonly Bound[]): void {
  it.each(bounds)(
    'accepts $key = $accepted and renders it audible, within full scale, free of NaN',
    ({ key, accepted, framesPerBeat }) => {
      const { buffer } = renderWith(
        instrument,
        { [key]: accepted },
        { framesPerBeat: framesPerBeat ?? TEST_FRAMES_PER_BEAT }
      );
      expect(isAudible(buffer)).toBe(true);
      expect(hasNaN(buffer)).toBe(false);
      expect(peakOf(buffer)).toBeLessThanOrEqual(1);
    }
  );

  it.each(bounds)('refuses $key = $refused', ({ key, refused }) => {
    expect(instrument.params.safeParse({ [key]: refused }).success).toBe(false);
  });

  // A list parameter's bound is on its members, so NaN goes in as a member.
  const notANumber = [...new Map(bounds.map(({ key, accepted }) => [key, accepted]))].map(
    ([key, accepted]) => ({ key, refused: Array.isArray(accepted) ? [Number.NaN] : Number.NaN })
  );
  it.each(notANumber)('refuses $key = $refused', ({ key, refused }) => {
    expect(instrument.params.safeParse({ [key]: refused }).success).toBe(false);
  });
}
