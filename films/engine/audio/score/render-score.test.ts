import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { firstOnsetSample, measureLoudness, truePeakDbtp } from '../../analyze/index.js';
import { defineFilm } from '../../film/spec.js';
import { SAMPLES_PER_FRAME, frameToSample } from '../../time/grid.js';

import { defineScore } from './define-score.js';
import { pattern } from './pattern.js';
import { renderScore } from './render-score.js';
import { ScoreError } from './score-error.js';
import {
  FIXTURE_FILM,
  FIXTURE_GRID,
  FIXTURE_INPUT,
  FIXTURE_SCORE,
  PERCUSSIVE_TRACKS,
  renderedFixture,
} from './score-test-support.js';

import type { StereoBuffer } from '../dsp/index.js';
import type { ScoreInput, Track } from './schema.js';

/**
 * The SHA-256 of the fixture's master WAV. It stands on the bits of every
 * instrument, DSP block, `dmath` function and master stage the fixture uses: a
 * change to it changes every film's audio and must be deliberate.
 */
const FIXTURE_MASTER_SHA256 = '8fce157395301599875b599dbf7f53eaf370ca7e792fcc303ac25a7d378cfcea';

const SAMPLES_PER_BEAT = frameToSample(FIXTURE_GRID.framesPerBeat);

/** A one-bar film with a cue of each anchor, for scores that test one thing each. */
const BAR = defineFilm({
  id: 'score-bar',
  title: 'Score bar',
  seed: 'score-bar',
  grid: FIXTURE_GRID,
  beats: FIXTURE_GRID.beatsPerBar,
  shots: [{ id: 'all', fromBeat: 0, toBeat: FIXTURE_GRID.beatsPerBar, reads: [] }],
  text: [],
  cues: [
    { id: 'hit', beat: 1, kind: 'hit', anchor: 'start' },
    { id: 'swell', beat: 2, kind: 'whoosh', anchor: 'peak' },
    { id: 'rise', beat: 3, kind: 'riser-end', anchor: 'end' },
  ],
});

const BAR_SAMPLES = frameToSample(BAR.durationInFrames);

function barScore(tracks: Track[], master?: ScoreInput['master']): ScoreInput {
  return {
    tracks,
    buses: [{ id: 'main', role: 'music', effects: [] }],
    ...(master === undefined ? {} : { master }),
  };
}

function one(id: string, event: Track['events'][number], overrides: Partial<Track> = {}): Track {
  return { id, instrument: 'kick', bus: 'main', gainDb: 0, events: [event], ...overrides };
}

function stemOf(stems: Record<string, StereoBuffer>, id: string): StereoBuffer {
  const stem = stems[id];
  if (stem === undefined) {
    throw new Error(`no stem for track ${id}`);
  }
  return stem;
}

/** The index of the loudest sample of either channel. */
function loudestIndex(buffer: StereoBuffer): number {
  let best = 0;
  let loudest = -1;
  for (const [index, left] of buffer.left.entries()) {
    const level = Math.max(Math.abs(left), Math.abs(buffer.right[index] ?? 0));
    if (level > loudest) {
      loudest = level;
      best = index;
    }
  }
  return best;
}

/** The fixture's track ids, one per event, in the score's track order. */
function trackPerEvent(): string[] {
  const ids: string[] = [];
  for (const { id, events } of FIXTURE_SCORE.tracks) {
    ids.push(...Array.from({ length: events.length }, () => id));
  }
  return ids;
}

function isSilentFrom(channel: Float32Array, from: number): boolean {
  return channel.subarray(from).every((sample) => sample === 0);
}

function refusal(render: () => unknown): ScoreError {
  try {
    render();
  } catch (error) {
    if (error instanceof ScoreError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a ScoreError, but nothing was thrown');
}

describe('renderScore: the fixture master', () => {
  it('holds exactly durationInFrames × SAMPLES_PER_FRAME samples', () => {
    const { master, wav } = renderedFixture();
    const samples = FIXTURE_FILM.durationInFrames * SAMPLES_PER_FRAME;
    expect(master.left).toHaveLength(samples);
    expect(master.right).toHaveLength(samples);
    expect(wav).toHaveLength(44 + samples * 6);
  });

  it('measures −14.0 ±0.5 LUFS integrated with the analysis meter', () => {
    expect(
      Math.abs(measureLoudness(renderedFixture().master).integratedLufs + 14)
    ).toBeLessThanOrEqual(0.5);
  });

  it('peaks at or below −1.0 dBTP with the analysis meter', () => {
    expect(truePeakDbtp(renderedFixture().master)).toBeLessThanOrEqual(-1);
  });

  it('matches the golden SHA-256 of its WAV', () => {
    expect(createHash('sha256').update(renderedFixture().wav).digest('hex')).toBe(
      FIXTURE_MASTER_SHA256
    );
  });
});

describe('renderScore: determinism', () => {
  it('renders byte-identical WAVs from two renders of the same one-bar score', () => {
    const tracks: Track[] = [
      one('kick', { at: { cue: 'hit' } }),
      {
        id: 'hat',
        instrument: 'hat',
        bus: 'main',
        gainDb: -12,
        events: pattern({ grid: FIXTURE_GRID, bars: [0, 1], steps: 'x.x.x.x.x.x.x.x.' }),
      },
      one(
        'swell',
        { at: { cue: 'swell' } },
        { instrument: 'pad', events: [{ at: { cue: 'swell' }, params: { beats: 1 } }] }
      ),
    ];
    const render = (): Uint8Array => renderScore(defineScore(barScore(tracks), BAR)).wav;
    expect(Buffer.from(render()).equals(Buffer.from(render()))).toBe(true);
  });
});

describe('renderScore: dither', () => {
  it('lays a noise floor of at most one step over digital silence', () => {
    // A 50 ms kick at the start of a 1.6 s bar: by its last 0.4 s every tail is
    // far below half a 24-bit step, so the master there is silence before dither.
    const kick = one('kick', { at: { frame: 0 }, params: { decay: 0.05 } });
    const { master } = renderScore(defineScore(barScore([kick], { targetLufs: -30 }), BAR));
    const step = 1 / 8_388_607;
    const tail = [
      ...master.left.subarray(BAR_SAMPLES - SAMPLES_PER_BEAT),
      ...master.right.subarray(BAR_SAMPLES - SAMPLES_PER_BEAT),
    ];
    expect(Math.max(...tail.map((sample) => Math.abs(sample)))).toBeLessThanOrEqual(
      Math.fround(step)
    );
    // TPDF dither of ±1 step rounds away from zero on about a quarter of samples.
    expect(tail.filter((sample) => sample !== 0).length / tail.length).toBeGreaterThan(0.1);
  });
});

describe('renderScore: stems and buses', () => {
  it.each(PERCUSSIVE_TRACKS)(
    'hears the %s stem first on its first scheduled sample, to the sample',
    (id) => {
      const track = FIXTURE_SCORE.tracks.find((candidate) => candidate.id === id);
      const scheduled = Math.min(...(track?.events.map(({ sample }) => sample) ?? []));
      expect(firstOnsetSample(stemOf(renderedFixture().stems, id), -60)).toBe(scheduled);
    }
  );

  it('holds every music bus at digital zero across a silence span while an sfx bus sounds', () => {
    const { buses } = renderedFixture();
    const [span] = FIXTURE_SCORE.film.silences;
    expect(span).toBeDefined();
    const { from, to } = span ?? { from: 0, to: 0 };
    for (const bus of FIXTURE_SCORE.buses.filter(({ role }) => role === 'music')) {
      const signal = stemOf(buses, bus.id);
      expect(
        [...signal.left.subarray(from, to), ...signal.right.subarray(from, to)].every(
          (sample) => sample === 0
        )
      ).toBe(true);
    }
    const fx = stemOf(buses, 'fx');
    const inSpan = { left: fx.left.slice(from, to), right: fx.right.slice(from, to) };
    expect(firstOnsetSample(inSpan, -60)).not.toBeNull();
  });

  it('gives every track a stem and every bus a signal as long as the master', () => {
    const { stems, buses, master } = renderedFixture();
    expect(Object.keys(stems)).toEqual(FIXTURE_INPUT.tracks.map(({ id }) => id));
    expect(Object.keys(buses)).toEqual(FIXTURE_INPUT.buses.map(({ id }) => id));
    for (const signal of [...Object.values(stems), ...Object.values(buses)]) {
      expect(signal.left).toHaveLength(master.left.length);
    }
  });

  it('logs every placement, track by track in time order', () => {
    const { placements } = renderedFixture();
    const kick = placements.filter(({ track }) => track === 'kick').map(({ sample }) => sample);
    expect(kick).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((beat) => beat * SAMPLES_PER_BEAT));
    expect(placements.filter(({ track }) => track === 'pad')).toEqual([
      { track: 'pad', cueId: 'open', sample: 0, anchor: 'start' },
      { track: 'pad', cueId: null, sample: 6 * SAMPLES_PER_BEAT, anchor: 'peak' },
    ]);
    expect(placements.map(({ track }) => track)).toEqual(trackPerEvent());
  });
});

describe('renderScore: placement', () => {
  const tracks: Track[] = [
    one('cue-start', { at: { cue: 'hit' } }),
    one(
      'cue-peak',
      { at: { cue: 'swell' } },
      { instrument: 'pad', events: [{ at: { cue: 'swell' }, params: { beats: 1 } }] }
    ),
    one('cue-end', { at: { cue: 'rise' } }),
    one('beat-start', { at: { beat: 0.25 }, anchor: 'start' }),
    one(
      'beat-peak',
      { at: { beat: 2.5 }, anchor: 'peak' },
      { instrument: 'pad', events: [{ at: { beat: 2.5 }, anchor: 'peak', params: { beats: 1 } }] }
    ),
    one('beat-end', { at: { beat: 3.5 }, anchor: 'end' }),
    one('frame-start', { at: { frame: 7 }, anchor: 'start' }),
    one(
      'frame-peak',
      { at: { frame: 60 }, anchor: 'peak' },
      { instrument: 'pad', events: [{ at: { frame: 60 }, anchor: 'peak', params: { beats: 1 } }] }
    ),
    one('frame-end', { at: { frame: BAR.durationInFrames }, anchor: 'end' }),
    one('unanchored', { at: { frame: 11 } }),
  ];
  let rendered: ReturnType<typeof renderScore> | undefined;
  const placed = (): ReturnType<typeof renderScore> => {
    rendered ??= renderScore(defineScore(barScore(tracks), BAR));
    return rendered;
  };

  it('logs each event’s track, cue, anchor and exact sample', () => {
    expect(placed().placements).toEqual([
      { track: 'cue-start', cueId: 'hit', sample: SAMPLES_PER_BEAT, anchor: 'start' },
      { track: 'cue-peak', cueId: 'swell', sample: 2 * SAMPLES_PER_BEAT, anchor: 'peak' },
      { track: 'cue-end', cueId: 'rise', sample: 3 * SAMPLES_PER_BEAT, anchor: 'end' },
      { track: 'beat-start', cueId: null, sample: SAMPLES_PER_BEAT / 4, anchor: 'start' },
      { track: 'beat-peak', cueId: null, sample: 2.5 * SAMPLES_PER_BEAT, anchor: 'peak' },
      { track: 'beat-end', cueId: null, sample: 3.5 * SAMPLES_PER_BEAT, anchor: 'end' },
      { track: 'frame-start', cueId: null, sample: 7 * SAMPLES_PER_FRAME, anchor: 'start' },
      { track: 'frame-peak', cueId: null, sample: 60 * SAMPLES_PER_FRAME, anchor: 'peak' },
      { track: 'frame-end', cueId: null, sample: BAR_SAMPLES, anchor: 'end' },
      { track: 'unanchored', cueId: null, sample: 11 * SAMPLES_PER_FRAME, anchor: 'start' },
    ]);
  });

  it.each(['cue-start', 'beat-start', 'frame-start', 'unanchored'])(
    'starts the %s sound on its sample',
    (id) => {
      const placement = placed().placements.find(({ track }) => track === id);
      expect(firstOnsetSample(stemOf(placed().stems, id), -60)).toBe(placement?.sample);
    }
  );

  it.each(['cue-peak', 'beat-peak', 'frame-peak'])(
    'puts the %s sound’s loudest sample on its sample',
    (id) => {
      const placement = placed().placements.find(({ track }) => track === id);
      expect(loudestIndex(stemOf(placed().stems, id))).toBe(placement?.sample);
    }
  );

  it.each(['cue-end', 'beat-end', 'frame-end'])(
    'ends the %s sound on the sample before its own',
    (id) => {
      const sample = placed().placements.find(({ track }) => track === id)?.sample ?? Number.NaN;
      const stem = stemOf(placed().stems, id);
      expect(isSilentFrom(stem.left, sample)).toBe(true);
      expect(stem.left[sample - 1]).not.toBe(0);
    }
  );

  it('seeds two events on one sample differently', () => {
    const doubled = one('double', { at: { cue: 'hit' } });
    doubled.events.push({ at: { frame: 24 } });
    const single = one('single', { at: { cue: 'hit' } });
    const { stems } = renderScore(defineScore(barScore([doubled, single]), BAR));
    const twice = stemOf(stems, 'single').left.map((sample) => sample * 2);
    expect([...stemOf(stems, 'double').left]).not.toEqual([...twice]);
  });
});

describe('renderScore: bounds and failures', () => {
  it.each([
    [-1, 'right'],
    [1, 'left'],
  ] as const)('pans a track hard to %s, silencing the %s channel', (pan, silent) => {
    const { stems } = renderScore(
      defineScore(barScore([one('kick', { at: { cue: 'hit' } }, { pan })]), BAR)
    );
    const stem = stemOf(stems, 'kick');
    expect(stem[silent].every((sample) => sample === 0)).toBe(true);
    expect(firstOnsetSample(stem, -60)).toBe(SAMPLES_PER_BEAT);
  });

  it('masters to the lowest target it accepts, −60 LUFS', () => {
    const score = defineScore(
      barScore([one('kick', { at: { cue: 'hit' } })], { targetLufs: -60 }),
      BAR
    );
    expect(
      Math.abs(measureLoudness(renderScore(score).master).integratedLufs + 60)
    ).toBeLessThanOrEqual(0.5);
  });

  it('masters under the highest ceiling it accepts, 0 dBTP', () => {
    const score = defineScore(
      barScore([one('kick', { at: { cue: 'hit' } })], { ceilingDbtp: 0 }),
      BAR
    );
    expect(truePeakDbtp(renderScore(score).master)).toBeLessThanOrEqual(0);
  });

  it('names the track and event whose sound cannot render', () => {
    const tracks = [
      one(
        'pad',
        { at: { cue: 'hit' } },
        { instrument: 'pad', events: [{ at: { cue: 'hit' }, params: { beats: 0.123_456_7 } }] }
      ),
    ];
    const error = refusal(() => renderScore(defineScore(barScore(tracks), BAR)));
    expect(error.rule).toBe('render');
    expect(error.subject).toBe('track "pad" event 0');
    expect(error.message).toContain('a note needs a whole number of samples');
    expect(error.cause).toBeInstanceOf(RangeError);
  });

  it('names the master when it cannot reach its target under its ceiling', () => {
    const score = defineScore(
      barScore([one('kick', { at: { cue: 'hit' } })], { targetLufs: -1, ceilingDbtp: -6 }),
      BAR
    );
    const error = refusal(() => renderScore(score));
    expect(error.rule).toBe('master');
    expect(error.message).toContain('film "score-bar", score rule "master", the master:');
    expect(error.message).toContain('cannot hold -1 LUFS');
  });
});
