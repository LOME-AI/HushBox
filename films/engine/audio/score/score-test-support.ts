// The score the render tests share: a two-bar groove over a film with a cue
// of every kind the score reads, every bus effect, a sidechain, a silence span
// with an sfx bus sounding through it, and an event of every anchor.

import { defineFilm } from '../../film/spec.js';
import { INSTRUMENTS } from '../instruments/index.js';

import { defineScore } from './define-score.js';
import { pattern } from './pattern.js';
import { renderScore } from './render-score.js';

import type { FilmSpec } from '../../film/spec.js';
import type { Grid } from '../../time/grid.js';
import type { Score } from './define-score.js';
import type { RenderedScore } from './render-score.js';
import type { ScoreInput } from './schema.js';

export const FIXTURE_GRID: Grid = { framesPerBeat: 24, beatsPerBar: 4 };
const BEATS = 8;
const BARS: readonly [number, number] = [0, BEATS / FIXTURE_GRID.beatsPerBar];

export const FIXTURE_FILM: FilmSpec = defineFilm({
  id: 'score-fixture',
  title: 'Score fixture',
  seed: 'score-fixture',
  grid: FIXTURE_GRID,
  beats: BEATS,
  shots: [{ id: 'all', fromBeat: 0, toBeat: BEATS, reads: [] }],
  text: [],
  cues: [
    { id: 'open', beat: 0, kind: 'hit', anchor: 'start' },
    { id: 'drop', beat: 4, kind: 'impact', anchor: 'start' },
    { id: 'glitch', beat: 5, kind: 'stutter', anchor: 'start' },
    { id: 'gap', beat: 6, kind: 'silence', anchor: 'start' },
    { id: 'back', beat: 7, kind: 'impact', anchor: 'start' },
  ],
});

export const FIXTURE_INPUT: ScoreInput = {
  tracks: [
    {
      id: 'kick',
      instrument: 'kick',
      bus: 'drums',
      gainDb: -2,
      events: pattern({ grid: FIXTURE_GRID, bars: BARS, steps: 'x...x...x...x...' }),
    },
    {
      id: 'snare',
      instrument: 'snare',
      bus: 'drums',
      gainDb: -4,
      events: pattern({ grid: FIXTURE_GRID, bars: BARS, steps: '....x.......x...' }),
    },
    {
      id: 'hat',
      instrument: 'hat',
      bus: 'drums',
      gainDb: -14,
      pan: 0.3,
      events: pattern({
        grid: FIXTURE_GRID,
        bars: BARS,
        steps: '..x...x...x...x.',
        params: { variant: 'closed' },
      }),
    },
    { id: 'tom', instrument: 'tom', bus: 'drums', gainDb: -6, events: [{ at: { cue: 'drop' } }] },
    {
      id: 'clap',
      instrument: 'clap',
      bus: 'drums',
      gainDb: -8,
      pan: -0.3,
      events: [{ at: { frame: 100 } }],
    },
    {
      id: 'sub',
      instrument: 'sub808',
      bus: 'bass',
      gainDb: -3,
      events: [
        { at: { cue: 'open' }, params: { note: 38, beats: 2 } },
        { at: { beat: 2 }, params: { note: 36, glideFrom: 38, beats: 2 } },
        { at: { cue: 'drop' }, params: { note: 38, beats: 2 } },
      ],
    },
    {
      id: 'pad',
      instrument: 'pad',
      bus: 'keys',
      gainDb: -10,
      events: [
        { at: { cue: 'open' }, params: { notes: [50, 53, 57], beats: 4 } },
        { at: { beat: 6 }, anchor: 'peak', params: { notes: [50, 54, 57], beats: 2, attack: 0.5 } },
      ],
    },
    {
      id: 'saw',
      instrument: 'supersaw',
      bus: 'keys',
      gainDb: -12,
      events: [{ at: { cue: 'drop' }, anchor: 'end', params: { notes: [62, 65, 69], beats: 1 } }],
    },
    {
      id: 'bell',
      instrument: 'fmBell',
      bus: 'fx',
      gainDb: -9,
      events: [{ at: { frame: 30 } }, { at: { cue: 'gap' }, params: { note: 74, decay: 1.5 } }],
    },
  ],
  buses: [
    {
      id: 'drums',
      role: 'music',
      effects: [
        { kind: 'saturation', drive: 1.5 },
        { kind: 'filter', mode: 'highpass', cutoff: 30, resonance: 0 },
        { kind: 'stutter', cue: 'glitch', sliceBeats: 0.25, repeats: 4 },
      ],
    },
    {
      id: 'bass',
      role: 'music',
      effects: [{ kind: 'tapeStop', cue: 'glitch', beats: 1 }],
      sidechain: { cueKinds: ['impact'], depthDb: 6, releaseFrames: 12 },
    },
    {
      id: 'keys',
      role: 'music',
      effects: [
        { kind: 'reverb', rt60: 1.5, damping: 6000, mix: 0.25 },
        { kind: 'delay', beats: 0.75, feedback: 0.3, mix: 0.2 },
      ],
      sidechain: { cueKinds: ['impact', 'hit'], depthDb: 8, releaseFrames: 18 },
    },
    { id: 'fx', role: 'sfx', effects: [{ kind: 'reverb', rt60: 1, damping: 8000, mix: 0.3 }] },
  ],
};

export const FIXTURE_SCORE: Score = defineScore(FIXTURE_INPUT, FIXTURE_FILM);

/** The fixture's tracks whose instrument is percussive, each heard first on its first scheduled sample. */
export const PERCUSSIVE_TRACKS: readonly string[] = FIXTURE_INPUT.tracks
  .filter(({ instrument }) => INSTRUMENTS[instrument].percussive)
  .map(({ id }) => id);

let rendered: RenderedScore | undefined;

/** The fixture score rendered once and shared by every test that reads it. */
export function renderedFixture(): RenderedScore {
  rendered ??= renderScore(FIXTURE_SCORE);
  return rendered;
}
