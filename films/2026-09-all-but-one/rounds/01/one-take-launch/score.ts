import { pattern } from '../../../../engine/audio/score/index.js';
import { defineFilm } from '../../../../engine/film/spec.js';

import { BEATS, CUES, GRID, ROWS } from './timeline.js';

import type { Bus, ScoreEvent, ScoreInput, Track } from '../../../../engine/audio/score/index.js';
import type { FilmDefinition } from '../../../../engine/film/spec.js';

// D minor for the Devil's keynote, resolving to D major on the reveal. MIDI note numbers.
const D1 = 26;
const D2 = 38;
const E_FLAT_2 = 39;
const F2 = 41;
const A1 = 33;
const B_FLAT_1 = 34;
const C2 = 36;
const D3 = 50;
const F3 = 53;
const F_SHARP_3 = 54;
const G3 = 55;
const A3 = 57;
const B_FLAT_3 = 58;
const C4 = 60;
const D4 = 62;
const F_SHARP_4 = 66;
const A4 = 69;
const D5 = 74;
const F5 = 77;
const F_SHARP_5 = 78;
const A5 = 81;
const C6 = 84;

const TRACKS = {
  kick: { instrument: 'kick', bus: 'drums', gainDb: -2 },
  clap: { instrument: 'clap', bus: 'drums', gainDb: -8 },
  snare: { instrument: 'snare', bus: 'drums', gainDb: -6 },
  hat: { instrument: 'hat', bus: 'drums', gainDb: -17, pan: 0.2 },
  bass: { instrument: 'sub808', bus: 'bass', gainDb: -6 },
  bell: { instrument: 'fmBell', bus: 'keys', gainDb: -13, pan: -0.15 },
  saw: { instrument: 'supersaw', bus: 'keys', gainDb: -14 },
  pad: { instrument: 'pad', bus: 'keys', gainDb: -12 },
  braam: { instrument: 'braam', bus: 'keys', gainDb: -8 },
  riser: { instrument: 'riser', bus: 'fx', gainDb: -12 },
  swell: { instrument: 'reverseSwell', bus: 'fx', gainDb: -12 },
  down: { instrument: 'downlifter', bus: 'fx', gainDb: -14 },
  whoosh: { instrument: 'whoosh', bus: 'hits', gainDb: -11 },
  impact: { instrument: 'impact', bus: 'hits', gainDb: -2 },
  pop: { instrument: 'pop', bus: 'hits', gainDb: -10 },
  tick: { instrument: 'tick', bus: 'hits', gainDb: -16 },
  tom: { instrument: 'tom', bus: 'hits', gainDb: -8 },
  snap: { instrument: 'snap', bus: 'hits', gainDb: -12 },
  crack: { instrument: 'crack', bus: 'hits', gainDb: -8 },
  glass: { instrument: 'glassShatter', bus: 'hits', gainDb: -10 },
  shriek: { instrument: 'shriek', bus: 'hits', gainDb: -17 },
  heart: { instrument: 'heartbeat', bus: 'beds', gainDb: -6 },
  sub: { instrument: 'subPulse', bus: 'beds', gainDb: -8 },
  rumble: { instrument: 'rumble', bus: 'beds', gainDb: -14 },
} as const satisfies Record<string, Omit<Track, 'id' | 'events'>>;

type TrackId = keyof typeof TRACKS;
type Part = Partial<Record<TrackId, ScoreEvent[]>>;

const DUCK: NonNullable<Bus['sidechain']>['cueKinds'] = ['impact'];

const BUSES: Bus[] = [
  { id: 'drums', role: 'music', effects: [], sidechain: { cueKinds: DUCK, depthDb: 3, releaseFrames: 12 } },
  { id: 'bass', role: 'music', effects: [], sidechain: { cueKinds: DUCK, depthDb: 6, releaseFrames: 18 } },
  {
    id: 'keys',
    role: 'music',
    effects: [
      { kind: 'delay', beats: 0.75, feedback: 0.3, mix: 0.15 },
      { kind: 'reverb', rt60: 2.2, damping: 6500, mix: 0.22 },
    ],
    sidechain: { cueKinds: DUCK, depthDb: 5, releaseFrames: 20 },
  },
  { id: 'fx', role: 'music', effects: [{ kind: 'reverb', rt60: 1.8, damping: 7000, mix: 0.2 }] },
  { id: 'hits', role: 'sfx', effects: [{ kind: 'reverb', rt60: 1.1, damping: 6000, mix: 0.1 }] },
  { id: 'beds', role: 'sfx', effects: [] },
];

const at = (cue: string): ScoreEvent['at'] => ({ cue });
const onBeat = (beat: number): ScoreEvent['at'] => ({ beat });

/** A step pattern over bars `[from, to)` of the film. */
function bars(from: number, to: number, steps: string, params?: unknown): ScoreEvent[] {
  return pattern({ grid: GRID, bars: [from, to], steps, params });
}

/** The Devil's keynote, bars 0–3: a bouncing four-on-the-floor, a bell on every event. */
const keynote: Part = {
  kick: bars(0, 4, 'x...x...x...x...', { decay: 0.6, drive: 1.6, startHz: 200 }),
  clap: bars(1, 4, '....x.......x...'),
  hat: bars(2, 4, '..x...x...x...x.'),
  bass: [
    { at: onBeat(0), params: { note: D2, beats: 1.5, decay: 1.2 } },
    { at: onBeat(2), params: { note: D2, beats: 1, decay: 0.8 } },
    { at: onBeat(4), params: { note: B_FLAT_1, beats: 1.5, decay: 1.2 } },
    { at: onBeat(6), params: { note: B_FLAT_1, beats: 1, decay: 0.8 } },
    { at: onBeat(8), params: { note: C2, beats: 1.5, decay: 1.2 } },
    { at: onBeat(10), params: { note: C2, beats: 1, decay: 0.8 } },
    { at: onBeat(12), params: { note: A1, beats: 3, decay: 2 } },
  ],
  bell: [
    { at: at('launch'), params: { note: D5, decay: 1.2 } },
    { at: at('apex'), params: { note: A5, decay: 0.8 } },
    { at: at('land'), params: { note: F5, decay: 1 } },
    { at: at('horns'), params: { note: C6, decay: 1 } },
    { at: at('eyes'), params: { note: A5, decay: 1.4 } },
    { at: at('grin'), params: { note: D5, decay: 1 } },
    { at: at('type'), params: { note: F5, decay: 0.6 } },
    { at: at('wink'), params: { note: A5, decay: 0.5 } },
    { at: at('preen'), params: { note: F5, decay: 0.7 } },
    { at: at('iris'), params: { note: A5, decay: 1.6 } },
    { at: at('look-1'), params: { note: F5, decay: 0.4 } },
    { at: at('look-2'), params: { note: C6, decay: 0.4 } },
    { at: at('stack-1'), params: { note: A4, decay: 0.5 } },
    { at: at('stack-2'), params: { note: D5, decay: 0.5 } },
    { at: at('stack-3'), params: { note: F5, decay: 0.5 } },
  ],
  pop: [
    { at: at('launch'), params: { fromHz: 180, octaves: 2 } },
    { at: at('land'), params: { fromHz: 320, octaves: 1.5 } },
    { at: at('grin'), params: { fromHz: 260, octaves: 2 } },
    { at: at('type'), params: { fromHz: 400 } },
    { at: at('stack-1'), params: { fromHz: 460 } },
    { at: at('stack-2'), params: { fromHz: 520 } },
    { at: at('stack-3'), params: { fromHz: 580 } },
    { at: at('wink'), params: { fromHz: 520, octaves: 1 } },
  ],
  whoosh: [
    { at: at('horns'), params: { seconds: 0.4, semitones: 7 } },
    { at: at('swarm'), params: { seconds: 0.7, semitones: 5, direction: 'rightToLeft' } },
  ],
  impact: [
    { at: at('pullout'), params: { decay: 1.2, drive: 1.5, metal: 0.3 } },
    { at: at('blink'), params: { decay: 0.8, drive: 1.5, metal: 0.2 } },
  ],
  tick: [{ at: at('type') }, { at: at('apex'), params: { toneHz: 4200 } }, { at: at('eyes'), params: { toneHz: 2400 } }],
  crack: [{ at: at('crack-1') }, { at: at('crack-2') }, { at: at('crack-3') }],
  riser: [{ at: at('gap-drop'), anchor: 'end', params: { beats: 2, octaves: 2 } }],
  sub: [{ at: at('blink'), params: { toneHz: 40, decay: 1 } }],
};

const DROP_BASS = [
  { steps: 'x..x..x...x..x..', params: [D2, D2, F2, D2, E_FLAT_2].map((note) => ({ note, beats: 0.5, drive: 3.5, decay: 0.6 })) },
  { steps: 'x..x..x...x.x...', params: [D2, D2, F2, D2, C2].map((note) => ({ note, beats: 0.5, drive: 3.5, decay: 0.6 })) },
];
const STAB = (notes: number[]): { notes: number[]; beats: number; detune: number } => ({ notes, beats: 0.25, detune: 0.4 });

/** The leak, bars 4–6: the drop, a driven groove, a shriek on every swoop; the laugh on bar 6. */
const leak: Part = {
  impact: [
    { at: at('drop'), params: { decay: 3, drive: 3.5, metal: 0.7 } },
    { at: at('face'), params: { decay: 2.5, drive: 3, metal: 0.5 } },
  ],
  glass: [{ at: at('drop'), params: { decay: 1.6, shards: 120 } }],
  braam: [{ at: at('face'), params: { note: D1 + 12, beats: 3 } }],
  kick: bars(4, 7, 'x...x...x...x...', { drive: 3.5, decay: 0.7 }),
  clap: bars(4, 7, '....x.......x...'),
  hat: bars(4, 7, 'x.xxx.x.x.xxx.xx'),
  bass: pattern({ grid: GRID, bars: [4, 6], steps: DROP_BASS }),
  saw: bars(4, 6, '..x...x...x..x..', STAB([D3, F3, A3])),
  shriek: [
    { at: at('swoop-1'), params: { toneHz: 1400, seconds: 0.7 } },
    { at: at('swoop-2'), params: { toneHz: 1800, seconds: 0.6 } },
    { at: at('swoop-3'), params: { toneHz: 1150, seconds: 0.7 } },
  ],
  whoosh: [
    { at: at('swoop-1'), params: { seconds: 0.5, semitones: 6 } },
    { at: at('swoop-2'), params: { seconds: 0.5, semitones: 6, direction: 'rightToLeft' } },
    { at: at('swoop-3'), params: { seconds: 0.5, semitones: 6 } },
    { at: at('converge'), anchor: 'end', params: { seconds: 0.75, semitones: 9 } },
    { at: at('dive'), params: { seconds: 0.5, semitones: 4, direction: 'rightToLeft' } },
  ],
  tom: [
    { at: at('ha-1'), params: { toneHz: 220, decay: 0.35 } },
    { at: at('ha-2'), params: { toneHz: 196, decay: 0.35 } },
    { at: at('ha-3'), params: { toneHz: 175, decay: 0.35 } },
    { at: at('ha-4'), params: { toneHz: 147, decay: 0.5 } },
  ],
  pop: [
    { at: at('ha-1'), params: { fromHz: 600 } },
    { at: at('ha-2'), params: { fromHz: 540 } },
    { at: at('ha-3'), params: { fromHz: 480 } },
    { at: at('ha-4'), params: { fromHz: 420 } },
  ],
  down: [{ at: at('dive'), params: { beats: 0.5, octaves: 2 } }],
};

/** "All… but one", and the Devil's fear, bars 7–11: a silence, the slam, then a trembling half-time. */
const fear: Part = {
  heart: [
    { at: onBeat(28), params: { toneHz: 50 } },
    { at: onBeat(29), params: { toneHz: 50 } },
    ...[44, 45, 45.5, 46, 46.5].map((beat) => ({ at: onBeat(beat), params: { toneHz: 58, gap: 0.15 } })),
  ],
  impact: [
    { at: at('one'), params: { decay: 4, drive: 4, subHz: 28, metal: 0.9 } },
    { at: at('blast'), params: { decay: 2.5, drive: 3, metal: 0.6 } },
    { at: at('shatter'), params: { decay: 2, drive: 3, metal: 0.8 } },
    { at: at('code'), params: { decay: 1.5, drive: 2, metal: 0.4 } },
  ],
  braam: [
    { at: at('one'), params: { note: D1, beats: 2 } },
    { at: at('blast'), params: { note: D1 + 3, beats: 4 } },
    { at: at('tags'), params: { note: D1 + 1, beats: 4 } },
    { at: at('code'), params: { note: D1 + 5, beats: 4 } },
  ],
  kick: bars(8, 11, 'x.........x.....', { drive: 2.5, decay: 0.9 }),
  snare: bars(8, 11, '........x.......'),
  hat: bars(8, 11, 'x.x.x.x.x.x.x.x.'),
  bass: [
    { at: at('one'), params: { note: D2, beats: 2, decay: 3, drive: 3 } },
    ...[32, 36, 40].map((beat, index) => ({
      at: onBeat(beat),
      params: { note: [D2, E_FLAT_2, F2][index], beats: 3.5, decay: 3, drive: 2 },
    })),
  ],
  pad: [
    { at: at('blast'), params: { notes: [D3, F3, A3], beats: 4, attack: 0.1, release: 0.2, tremolo: 0.4, tremoloRate: 5 } },
    { at: at('tags'), params: { notes: [E_FLAT_2 + 12, G3, B_FLAT_3], beats: 4, attack: 0.1, release: 0.2, tremolo: 0.6, tremoloRate: 7 } },
    { at: at('code'), params: { notes: [D3, F3, A3, C4], beats: 4, attack: 0.1, release: 0.2, tremolo: 0.8, tremoloRate: 9 } },
    { at: at('plea'), params: { notes: [D3, F3, A3], beats: 3.5, attack: 0.3, release: 0.3, tremolo: 1, tremoloRate: 11 } },
  ],
  snap: [{ at: at('splat-1'), params: { toneHz: 1800 } }, { at: at('splat-2'), params: { toneHz: 2300 } }],
  pop: [
    { at: at('splat-1'), params: { fromHz: 300, octaves: 3 } },
    { at: at('splat-2'), params: { fromHz: 360, octaves: 3 } },
    { at: at('tags'), params: { fromHz: 500 } },
    { at: at('tag-2'), params: { fromHz: 560 } },
    { at: at('tag-3'), params: { fromHz: 620 } },
    { at: at('dot'), params: { fromHz: 700, octaves: 1 } },
  ],
  glass: [{ at: at('shatter'), params: { decay: 1.4, shards: 90 } }],
  tick: [
    { at: at('shackle'), params: { toneHz: 1500, decay: 0.05 } },
    { at: at('pry-1'), params: { toneHz: 2000 } },
    { at: at('pry-2'), params: { toneHz: 2200 } },
    { at: at('scroll-1'), params: { toneHz: 3200 } },
    { at: at('scroll-2'), params: { toneHz: 3400 } },
    { at: at('scroll-3'), params: { toneHz: 3600 } },
    { at: at('tremble'), params: { toneHz: 1800 } },
  ],
  sub: [{ at: at('shackle'), params: { toneHz: 50, decay: 0.5 } }, { at: at('plea'), params: { toneHz: 38, decay: 1.5 } }],
  whoosh: [{ at: at('flee'), params: { seconds: 0.45, semitones: 8, direction: 'rightToLeft' } }],
  swell: [{ at: at('reveal'), anchor: 'end', params: { beats: 1 } }],
  rumble: [{ at: at('plea'), params: { beats: 4, toneHz: 32 } }],
};

/** The reveal, bars 12–14: D major under the mark, a bell as each arc lands, a tick on each tagline word. */
const reveal: Part = {
  impact: [{ at: at('reveal'), params: { decay: 3, drive: 2, metal: 0.4 } }],
  pad: [{ at: at('reveal'), params: { notes: [D3, F_SHARP_3, A3, D4], beats: 12, attack: 0.05, release: 1.5 } }],
  saw: [{ at: at('word'), params: { notes: [D4, F_SHARP_4, A4], beats: 2, detune: 0.3 } }],
  bass: [{ at: at('reveal'), params: { note: D2, beats: 6, decay: 5, drive: 1.2 } }],
  bell: [
    ...[48, 48.25, 48.5, 48.75, 49].map((beat, index) => ({
      at: onBeat(beat),
      params: { note: [A4, D5, F_SHARP_5, A5, D5][index], decay: 1.4 },
    })),
    { at: at('tag-a'), params: { note: D5, decay: 1 } },
    { at: at('tag-b'), params: { note: F_SHARP_5, decay: 1 } },
    { at: at('tag-c'), params: { note: A5, decay: 2 } },
    { at: at('url'), params: { note: D5, decay: 2.5 } },
  ],
  kick: bars(12, 15, 'x.......x.......', { decay: 0.5, drive: 1.2 }),
  hat: bars(13, 15, '..x...x...x...x.'),
  tick: [{ at: at('arcs'), params: { toneHz: 2600 } }, { at: at('tag-a') }, { at: at('tag-b') }, { at: at('tag-c') }, { at: at('url') }],
  whoosh: [{ at: at('word'), params: { seconds: 0.4, semitones: 3 } }],
};

function scoreOf(parts: readonly Part[]): ScoreInput {
  const played = new Map<string, ScoreEvent[]>();
  for (const part of parts) {
    for (const [id, events] of Object.entries(part)) {
      played.set(id, [...(played.get(id) ?? []), ...events]);
    }
  }
  return {
    tracks: Object.entries(TRACKS).flatMap(([id, track]) => {
      const events = played.get(id) ?? [];
      return events.length === 0 ? [] : [{ id, ...track, events }];
    }),
    buses: BUSES,
  };
}

/**
 * The take's spec and score. The CLI loads this module by path.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'one-take-launch',
    title: 'All But One: one-take launch',
    seed: 'one-take-launch',
    grid: GRID,
    beats: BEATS,
    text: ROWS.map(({ id, words, role, inBeat, outBeat, basis }) => ({
      id,
      words,
      role,
      inBeat,
      outBeat,
      ...(basis === undefined ? {} : { basis }),
    })),
    cues: [...CUES],
  }),
  score: scoreOf([keynote, leak, fear, reveal]),
};
