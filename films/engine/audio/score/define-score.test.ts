import { describe, expect, it } from 'vitest';

import { defineFilm } from '../../film/spec.js';
import { SAMPLES_PER_FRAME, frameToSample } from '../../time/grid.js';
import { nextAfter } from '../dsp/dsp-test-support.js';
import { DEFAULT_CEILING_DBTP, DEFAULT_TARGET_LUFS } from '../master/index.js';

import { defineScore } from './define-score.js';
import { ScoreError } from './score-error.js';

import type { FilmSpec } from '../../film/spec.js';
import type { Grid } from '../../time/grid.js';
import type { Score } from './define-score.js';
import type { Bus, ScoreEvent, ScoreInput, Track } from './schema.js';

const GRID: Grid = { framesPerBeat: 24, beatsPerBar: 4 };
const BEATS = 8;
const SAMPLES_PER_BEAT = frameToSample(GRID.framesPerBeat);
const DURATION = BEATS * GRID.framesPerBeat;
const TOTAL = frameToSample(DURATION);

const FILM: FilmSpec = defineFilm({
  id: 'score-define',
  title: 'Score define',
  seed: 'score-define',
  grid: GRID,
  beats: BEATS,
  shots: [{ id: 'all', fromBeat: 0, toBeat: BEATS, reads: [] }],
  text: [],
  cues: [
    { id: 'open', beat: 0, kind: 'hit', anchor: 'start' },
    { id: 'swell', beat: 2, kind: 'whoosh', anchor: 'peak' },
    { id: 'rise', beat: 4, kind: 'riser-end', anchor: 'end' },
    { id: 'drop', beat: 4, kind: 'impact', anchor: 'start' },
    { id: 'glitch', beat: 5, kind: 'stutter', anchor: 'start' },
    { id: 'gap', beat: 6, kind: 'silence', anchor: 'start' },
    { id: 'back', beat: 7, kind: 'impact', anchor: 'start' },
    { id: 'last', beat: BEATS, kind: 'riser-end', anchor: 'end' },
  ],
});

const MUSIC: Bus = { id: 'music', role: 'music', effects: [] };

function track(events: ScoreEvent[], overrides: Partial<Track> = {}): Track {
  return { id: 'kick', instrument: 'kick', bus: 'music', gainDb: 0, events, ...overrides };
}

function scoreOf(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return { tracks: [track([{ at: { cue: 'open' } }])], buses: [MUSIC], ...overrides };
}

function eventsOf(
  events: ScoreEvent[],
  overrides: Partial<Track> = {}
): Score['tracks'][number]['events'] {
  const [first] = defineScore(scoreOf({ tracks: [track(events, overrides)] }), FILM).tracks;
  if (first === undefined) {
    throw new Error('the score defined no track');
  }
  return first.events;
}

function busOf(bus: Bus): Score['buses'][number] {
  const [first] = defineScore(scoreOf({ buses: [bus] }), FILM).buses;
  if (first === undefined) {
    throw new Error('the score defined no bus');
  }
  return first;
}

/** Runs `define` and returns the ScoreError it throws. */
function refusal(define: () => unknown): ScoreError {
  try {
    define();
  } catch (error) {
    if (error instanceof ScoreError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a ScoreError, but nothing was thrown');
}

function refusalOf(input: ScoreInput): ScoreError {
  return refusal(() => defineScore(input, FILM));
}

/**
 * Hands defineScore input its types would refuse, as an untyped caller could.
 * The input is malformed on purpose, so the one cast here is the point of the test.
 */
function refusalOfUntyped(input: unknown): ScoreError {
  return refusal(() => defineScore(input as ScoreInput, FILM));
}

describe('defineScore: events', () => {
  it('lands a cue event on its cue’s sample, with the cue’s anchor and id', () => {
    expect(eventsOf([{ at: { cue: 'rise' } }])).toEqual([
      expect.objectContaining({ sample: 4 * SAMPLES_PER_BEAT, anchor: 'end', cueId: 'rise' }),
    ]);
  });

  it('lands a beat event on the beat’s sample, sub-frame beats included, with no anchor of its own', () => {
    expect(eventsOf([{ at: { beat: 1 / 16 } }])).toEqual([
      expect.objectContaining({ sample: SAMPLES_PER_BEAT / 16, anchor: null, cueId: null }),
    ]);
  });

  it('lands a frame event on the frame’s first sample', () => {
    expect(eventsOf([{ at: { frame: 30 } }])).toEqual([
      expect.objectContaining({ sample: 30 * SAMPLES_PER_FRAME, anchor: null, cueId: null }),
    ]);
  });

  it('lets an event’s own anchor override its cue’s', () => {
    expect(eventsOf([{ at: { cue: 'drop' }, anchor: 'peak' }])).toEqual([
      expect.objectContaining({ sample: 4 * SAMPLES_PER_BEAT, anchor: 'peak', cueId: 'drop' }),
    ]);
  });

  it('keeps the events in the order they are declared', () => {
    const samples = eventsOf([{ at: { frame: 40 } }, { at: { frame: 10 } }]).map(
      ({ sample }) => sample
    );
    expect(samples).toEqual([40 * SAMPLES_PER_FRAME, 10 * SAMPLES_PER_FRAME]);
  });

  it('fills the instrument’s parameter defaults', () => {
    const [event] = eventsOf([{ at: { cue: 'open' }, params: { decay: 0.5 } }]);
    expect(event?.params).toEqual({ startHz: 180, endHz: 48, decay: 0.5, drive: 2 });
  });

  it('refuses an event naming a cue the film does not declare', () => {
    const error = refusalOf(
      scoreOf({ tracks: [track([{ at: { frame: 0 } }, { at: { cue: 'dorp' } }])] })
    );
    expect(error.message).toBe(
      'film "score-define", score rule "unknown-cue", track "kick" event 1: names cue "dorp", which the film does not declare'
    );
  });

  it('refuses a beat that lands between samples', () => {
    const error = refusalOf(scoreOf({ tracks: [track([{ at: { beat: 1 / 7 } }])] }));
    expect(error.rule).toBe('sample-grid');
    expect(error.message).toContain('track "kick" event 0');
    expect(error.message).toContain(
      `beat ${String(1 / 7)} lands between samples at framesPerBeat 24`
    );
  });

  it('refuses a frame that is not a whole frame', () => {
    const error = refusalOf(scoreOf({ tracks: [track([{ at: { frame: 1.5 } }])] }));
    expect(error.rule).toBe('shape');
    expect(error.subject).toBe('track "kick"');
  });

  it.each([
    [{ beat: -Number.MIN_VALUE }],
    [{ beat: Number.NaN }],
    [{ frame: -1 }],
    [{ frame: Number.NaN }],
  ])('refuses an event at %j', (at) => {
    expect(refusalOf(scoreOf({ tracks: [track([{ at }])] })).rule).toBe('shape');
  });

  it.each([[{ beat: 0 }], [{ frame: 0 }]])(
    'accepts an event at the film’s first sample: %j',
    (at) => {
      expect(eventsOf([{ at }])).toEqual([expect.objectContaining({ sample: 0 })]);
    }
  );

  it('accepts an unanchored event on the film’s last frame', () => {
    expect(eventsOf([{ at: { frame: DURATION - 1 } }])).toHaveLength(1);
  });

  it('accepts an unanchored event on the film’s last sample', () => {
    const beat = (TOTAL - 1) / SAMPLES_PER_BEAT;
    expect(beat * SAMPLES_PER_BEAT).toBe(TOTAL - 1);
    expect(eventsOf([{ at: { beat } }])).toEqual([expect.objectContaining({ sample: TOTAL - 1 })]);
  });

  it.each(['start', 'peak', undefined] as const)(
    'refuses an event anchored %s one past the last sample',
    (anchor) => {
      const event: ScoreEvent =
        anchor === undefined ? { at: { frame: DURATION } } : { at: { frame: DURATION }, anchor };
      const error = refusalOf(scoreOf({ tracks: [track([event])] }));
      expect(error.rule).toBe('past-end');
      expect(error.message).toContain(
        `lands on sample ${String(TOTAL)}, past sample ${String(TOTAL - 1)}`
      );
    }
  );

  it('accepts an event anchored at its end one past the last sample: it finishes with the film', () => {
    expect(eventsOf([{ at: { frame: DURATION }, anchor: 'end' }])).toHaveLength(1);
    expect(eventsOf([{ at: { cue: 'last' } }])).toEqual([
      expect.objectContaining({ sample: TOTAL, anchor: 'end' }),
    ]);
  });

  it('refuses an event anchored at its end one sample past the end of the film', () => {
    const beat = (TOTAL + 1) / SAMPLES_PER_BEAT;
    expect(beat * SAMPLES_PER_BEAT).toBe(TOTAL + 1);
    const error = refusalOf(scoreOf({ tracks: [track([{ at: { beat }, anchor: 'end' }])] }));
    expect(error.rule).toBe('past-end');
    expect(error.message).toContain(
      `lands on sample ${String(TOTAL + 1)}, past sample ${String(TOTAL)}`
    );
  });

  it('refuses parameters the instrument does not accept, naming the track, event and instrument', () => {
    const error = refusalOf(
      scoreOf({ tracks: [track([{ at: { cue: 'open' }, params: { decay: 99 } }])] })
    );
    expect(error.rule).toBe('params');
    expect(error.subject).toBe('track "kick" event 0');
    expect(error.message).toContain('kick');
    expect(error.message).toContain('decay');
  });
});

describe('defineScore: tracks and buses', () => {
  it('resolves a track’s gain from dB and its pan, centred by default', () => {
    const [first] = defineScore(scoreOf({ tracks: [track([], { gainDb: -6.0206 })] }), FILM).tracks;
    expect(first?.gain).toBeCloseTo(0.5, 5);
    expect(first?.pan).toBe(0);
  });

  it.each([-1, 1])('accepts a pan of %s', (pan) => {
    const [first] = defineScore(scoreOf({ tracks: [track([], { pan })] }), FILM).tracks;
    expect(first?.pan).toBe(pan);
  });

  it.each([nextAfter(-1, -1), nextAfter(1, 1), Number.NaN])('refuses a pan of %s', (pan) => {
    expect(refusalOf(scoreOf({ tracks: [track([], { pan })] })).rule).toBe('shape');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('refuses a gain of %s dB', (gainDb) => {
    expect(refusalOf(scoreOf({ tracks: [track([], { gainDb })] })).subject).toBe('track "kick"');
  });

  it('refuses an instrument the registry does not hold, naming the track', () => {
    const error = refusalOfUntyped({
      ...scoreOf(),
      tracks: [{ ...track([]), instrument: 'kazoo' }],
    });
    expect(error.rule).toBe('shape');
    expect(error.subject).toBe('track "kick"');
    expect(error.message).toContain('must name a registered instrument');
  });

  it('refuses a track on a bus the score does not declare', () => {
    const error = refusalOf(scoreOf({ tracks: [track([], { bus: 'nowhere' })] }));
    expect(error.message).toBe(
      'film "score-define", score rule "unknown-bus", track "kick": plays on bus "nowhere", which the score does not declare'
    );
  });

  it('refuses two tracks with one id', () => {
    const error = refusalOf(scoreOf({ tracks: [track([]), track([])] }));
    expect(error.rule).toBe('unique-ids');
    expect(error.subject).toBe('track "kick"');
  });

  it('refuses two buses with one id', () => {
    const error = refusalOf(scoreOf({ buses: [MUSIC, MUSIC] }));
    expect(error.rule).toBe('unique-ids');
    expect(error.subject).toBe('bus "music"');
  });

  it('names a bus whose shape is wrong', () => {
    const buses = [MUSIC, { id: 'fx', role: 'loud', effects: [] }];
    expect(refusalOfUntyped({ ...scoreOf(), buses }).subject).toBe('bus "fx"');
  });

  it('names the score when the fault is not inside a track or bus', () => {
    const error = refusalOfUntyped({ tracks: 'none', buses: [MUSIC] });
    expect(error.subject).toBe('the score');
  });

  it('carries the film’s silences in samples', () => {
    expect(defineScore(scoreOf(), FILM).film.silences).toEqual([
      { cueId: 'gap', from: 6 * SAMPLES_PER_BEAT, to: 7 * SAMPLES_PER_BEAT },
    ]);
  });

  it('carries the film’s identity, seed, tempo and length', () => {
    const { film } = defineScore(scoreOf(), FILM);
    expect({
      id: film.id,
      seed: film.seed,
      framesPerBeat: film.framesPerBeat,
      samples: film.samples,
    }).toEqual({
      id: 'score-define',
      seed: 'score-define',
      framesPerBeat: GRID.framesPerBeat,
      samples: TOTAL,
    });
  });
});

describe('defineScore: master', () => {
  it('defaults to the delivery targets', () => {
    expect(defineScore(scoreOf(), FILM).master).toEqual({
      targetLufs: DEFAULT_TARGET_LUFS,
      ceilingDbtp: DEFAULT_CEILING_DBTP,
    });
  });

  it('keeps a target and ceiling it is given', () => {
    const master = { targetLufs: -60, ceilingDbtp: 0 };
    expect(defineScore(scoreOf({ master }), FILM).master).toEqual(master);
  });

  it('fills whichever of the two is left out', () => {
    expect(defineScore(scoreOf({ master: { ceilingDbtp: -2 } }), FILM).master).toEqual({
      targetLufs: DEFAULT_TARGET_LUFS,
      ceilingDbtp: -2,
    });
  });

  it.each([
    [{ targetLufs: nextAfter(-60, -1) }],
    [{ targetLufs: Number.NaN }],
    [{ ceilingDbtp: Number.MIN_VALUE }],
    [{ ceilingDbtp: Number.NaN }],
  ])('refuses master settings %j', (master) => {
    const error = refusalOf(scoreOf({ master }));
    expect(error.rule).toBe('shape');
    expect(error.subject).toBe('the master settings');
  });
});

describe('defineScore: bus effects', () => {
  it('resolves a delay’s length in beats to samples', () => {
    const bus = busOf({
      ...MUSIC,
      effects: [{ kind: 'delay', beats: 0.75, feedback: 0.4, mix: 0.3 }],
    });
    expect(bus.effects).toEqual([
      { kind: 'delay', samples: 0.75 * SAMPLES_PER_BEAT, feedback: 0.4, mix: 0.3 },
    ]);
  });

  it('resolves a stutter to its cue’s sample and its slice to samples', () => {
    const bus = busOf({
      ...MUSIC,
      effects: [{ kind: 'stutter', cue: 'glitch', sliceBeats: 0.25, repeats: 4 }],
    });
    expect(bus.effects).toEqual([
      {
        kind: 'stutter',
        from: 5 * SAMPLES_PER_BEAT,
        sliceSamples: SAMPLES_PER_BEAT / 4,
        repeats: 4,
      },
    ]);
  });

  it('resolves a tape stop to its cue’s sample and its length to samples', () => {
    const bus = busOf({ ...MUSIC, effects: [{ kind: 'tapeStop', cue: 'drop', beats: 1 }] });
    expect(bus.effects).toEqual([
      { kind: 'tapeStop', from: 4 * SAMPLES_PER_BEAT, samples: SAMPLES_PER_BEAT },
    ]);
  });

  it('passes the reverb, saturation and filter settings through', () => {
    const effects: Bus['effects'] = [
      { kind: 'reverb', rt60: 2, damping: 6000, mix: 0.2 },
      { kind: 'saturation', drive: 2 },
      { kind: 'filter', mode: 'highpass', cutoff: 120, resonance: 0.1 },
    ];
    expect(busOf({ ...MUSIC, effects }).effects).toEqual(effects);
  });

  it('refuses an effect naming a cue the film does not declare', () => {
    const buses: Bus[] = [{ ...MUSIC, effects: [{ kind: 'tapeStop', cue: 'nope', beats: 1 }] }];
    expect(refusalOf(scoreOf({ buses })).message).toBe(
      'film "score-define", score rule "unknown-cue", bus "music" effect 0: names cue "nope", which the film does not declare'
    );
  });

  it.each([
    [{ kind: 'delay', beats: 1 / 7, feedback: 0, mix: 1 }],
    [{ kind: 'stutter', cue: 'glitch', sliceBeats: 1 / 7, repeats: 2 }],
    [{ kind: 'tapeStop', cue: 'drop', beats: 1 / 7 }],
  ] as const)('refuses a length that lands between samples: %j', (effect) => {
    const error = refusalOf(scoreOf({ buses: [{ ...MUSIC, effects: [effect] }] }));
    expect(error.rule).toBe('sample-grid');
    expect(error.subject).toBe('bus "music" effect 0');
  });

  it('accepts effect lengths of a single sample', () => {
    const beats = 1 / SAMPLES_PER_BEAT;
    expect(beats * SAMPLES_PER_BEAT).toBe(1);
    const effects: Bus['effects'] = [
      { kind: 'delay', beats, feedback: 0, mix: 1 },
      { kind: 'stutter', cue: 'glitch', sliceBeats: beats, repeats: 2 },
      { kind: 'tapeStop', cue: 'drop', beats },
    ];
    expect(busOf({ ...MUSIC, effects }).effects).toHaveLength(3);
  });

  it('accepts a delay as long as the film and a stutter and tape stop that end with it', () => {
    const effects: Bus['effects'] = [
      { kind: 'delay', beats: BEATS, feedback: 0, mix: 1 },
      { kind: 'stutter', cue: 'gap', sliceBeats: 1, repeats: 2 },
      { kind: 'tapeStop', cue: 'back', beats: 1 },
    ];
    expect(busOf({ ...MUSIC, effects }).effects).toHaveLength(3);
  });

  /**
   * A length in beats for `samples` samples. Were it to land between samples the
   * effect would be refused under "sample-grid", so a "past-end" refusal also
   * proves the length exact.
   */
  const beatsOf = (samples: number): number => samples / SAMPLES_PER_BEAT;
  const BACK = 7 * SAMPLES_PER_BEAT;

  it.each([
    [
      { kind: 'delay', beats: beatsOf(TOTAL + 1), feedback: 0, mix: 1 },
      `delays ${String(TOTAL + 1)} samples`,
    ],
    [
      // 7 repeats of 2743 samples from the cue at beat 7 end one sample past the film.
      { kind: 'stutter', cue: 'back', sliceBeats: beatsOf((TOTAL + 1 - BACK) / 7), repeats: 7 },
      `runs to sample ${String(TOTAL + 1)}`,
    ],
    [
      { kind: 'tapeStop', cue: 'back', beats: beatsOf(TOTAL + 1 - BACK) },
      `runs to sample ${String(TOTAL + 1)}`,
    ],
  ] as const)('refuses an effect that runs past the film: %j', (effect, detail) => {
    const error = refusalOf(scoreOf({ buses: [{ ...MUSIC, effects: [effect] }] }));
    expect(error.rule).toBe('past-end');
    expect(error.message).toContain(detail);
  });

  it.each([
    [{ kind: 'reverb', rt60: 0, damping: 0, mix: 0 }],
    [{ kind: 'reverb', rt60: 1, damping: -Number.MIN_VALUE, mix: 0 }],
    [{ kind: 'reverb', rt60: 1, damping: 24_000, mix: 0 }],
    [{ kind: 'reverb', rt60: 1, damping: 0, mix: -Number.MIN_VALUE }],
    [{ kind: 'reverb', rt60: 1, damping: 0, mix: nextAfter(1, 1) }],
    [{ kind: 'reverb', rt60: Number.NaN, damping: 0, mix: 0 }],
    [{ kind: 'delay', beats: 0, feedback: 0, mix: 0 }],
    [{ kind: 'delay', beats: 1, feedback: 1, mix: 0 }],
    [{ kind: 'delay', beats: 1, feedback: -1, mix: 0 }],
    [{ kind: 'delay', beats: 1, feedback: Number.NaN, mix: 0 }],
    [{ kind: 'saturation', drive: nextAfter(0.5, -1) }],
    [{ kind: 'saturation', drive: nextAfter(8, 1) }],
    [{ kind: 'saturation', drive: Number.NaN }],
    [{ kind: 'filter', mode: 'lowpass', cutoff: -Number.MIN_VALUE, resonance: 0 }],
    [{ kind: 'filter', mode: 'lowpass', cutoff: 24_000, resonance: 0 }],
    [{ kind: 'filter', mode: 'lowpass', cutoff: 100, resonance: 1 }],
    [{ kind: 'filter', mode: 'lowpass', cutoff: 100, resonance: -Number.MIN_VALUE }],
    [{ kind: 'filter', mode: 'lowpass', cutoff: Number.NaN, resonance: 0 }],
    [{ kind: 'stutter', cue: 'glitch', sliceBeats: 0, repeats: 2 }],
    [{ kind: 'stutter', cue: 'glitch', sliceBeats: 0.25, repeats: 1 }],
    [{ kind: 'stutter', cue: 'glitch', sliceBeats: 0.25, repeats: 2.5 }],
    [{ kind: 'stutter', cue: 'glitch', sliceBeats: Number.NaN, repeats: 2 }],
    [{ kind: 'tapeStop', cue: 'drop', beats: 0 }],
    [{ kind: 'tapeStop', cue: 'drop', beats: Number.NaN }],
  ] as const)('refuses an effect setting outside its range: %j', (effect) => {
    const error = refusalOf(scoreOf({ buses: [{ ...MUSIC, effects: [effect] }] }));
    expect(error.rule).toBe('shape');
    expect(error.subject).toBe('bus "music"');
  });
});

describe('defineScore: sidechain', () => {
  it('resolves the ducking cues to their samples, in time order', () => {
    const bus = busOf({
      ...MUSIC,
      sidechain: { cueKinds: ['impact', 'hit'], depthDb: 6.0206, releaseFrames: 12 },
    });
    expect(bus.duck?.cueSamples).toEqual([0, 4 * SAMPLES_PER_BEAT, 7 * SAMPLES_PER_BEAT]);
    expect(bus.duck?.floor).toBeCloseTo(0.5, 5);
    expect(bus.duck?.releaseSamples).toBe(12 * SAMPLES_PER_FRAME);
  });

  it('leaves a bus with no sidechain unducked', () => {
    expect(busOf(MUSIC).duck).toBeNull();
  });

  it('accepts a depth of 0 dB and a release of one frame', () => {
    const bus = busOf({ ...MUSIC, sidechain: { cueKinds: ['hit'], depthDb: 0, releaseFrames: 1 } });
    expect(bus.duck).toEqual({ cueSamples: [0], floor: 1, releaseSamples: SAMPLES_PER_FRAME });
  });

  it.each([
    [{ cueKinds: [], depthDb: 6, releaseFrames: 12 }],
    [{ cueKinds: ['boom'], depthDb: 6, releaseFrames: 12 }],
    [{ cueKinds: ['hit'], depthDb: -Number.MIN_VALUE, releaseFrames: 12 }],
    [{ cueKinds: ['hit'], depthDb: Number.NaN, releaseFrames: 12 }],
    [{ cueKinds: ['hit'], depthDb: 6, releaseFrames: 0 }],
    [{ cueKinds: ['hit'], depthDb: 6, releaseFrames: 1.5 }],
  ])('refuses a sidechain of %j', (sidechain) => {
    expect(refusalOfUntyped({ ...scoreOf(), buses: [{ ...MUSIC, sidechain }] }).subject).toBe(
      'bus "music"'
    );
  });
});
