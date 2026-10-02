import { pattern } from '../engine/audio/score/index.js';

import type { PatternOptions, ScoreEvent, ScoreInput } from '../engine/audio/score/index.js';
import type { FilmSpecInput } from '../engine/film/spec.js';
import type { Grid } from '../engine/time/grid.js';

/** 112.5 BPM: 32 frames a beat, a 16th every 8 frames, 75 beats in 40 s. */
export const GRID: Grid = { framesPerBeat: 32, beatsPerBar: 4 };
export const BEATS = 75;

/** Frames per typed character of the interviewer's questions. */
export const TYPE_FRAMES = 2;
/** The first question starts typing this many frames before the film, so frame 0 already reads. */
export const Q1_LEAD = 8;

// E Phrygian: the flat second (F) is the Devil's, pressed against E as a detuned cluster; the close
// resolves to E major. MIDI notes.
const E1 = 28;
const F1 = 29;
const E2 = 40;
const F2 = 41;
const B2 = 47;
const E3 = 52;
const F3 = 53;
const G3 = 55;
const G_SHARP_3 = 56;
const A3 = 57;
const B3 = 59;
const C4 = 60;
const E4 = 64;
const G_SHARP_4 = 68;
const B4 = 71;
const E5 = 76;

/** The leaked messages: personal, in the sender's own words. Imagery, not claims. */
export const LEAKS = [
  'I’m in love with my best friend.',
  'I lied about the money.',
  'Please don’t tell mom.',
  'I’m not okay.',
  'I practise my Oscar speech in the shower.',
  'The test came back positive.',
  'I still have the other phone.',
  'Nobody knows I got fired.',
] as const;

/** Beats each hero demon of the flock lunges at the lens with its secret, each with a shriek. */
export const SWOOP_BEATS = [25, 27.5, 29.75] as const;
/** Beats the search's flares land, each lighting a mark with his brand: two in the first region, four in the second, eight in the third. */
export const FLARE_BEATS = [
  36, 36.5, 37, 37.25, 37.5, 37.75, 38, 38.125, 38.25, 38.375, 38.5, 38.625, 38.75, 38.875,
] as const;
/** Beats the radar sweep stamps a message FLAGGED. */
export const STAMP_BEATS = [16, 16.5, 17, 17.5] as const;

export const CUES: FilmSpecInput['cues'] = [
  { id: 'open', beat: 0, kind: 'hit', anchor: 'start' },
  { id: 'eyes', beat: 2.5, kind: 'hit', anchor: 'start' },
  { id: 'answer', beat: 4, kind: 'hit', anchor: 'start' },
  { id: 'smirk', beat: 6, kind: 'tick', anchor: 'start' },
  { id: 'like', beat: 8, kind: 'hit', anchor: 'start' },
  { id: 'chomp', beat: 10.5, kind: 'impact', anchor: 'start' },
  { id: 'save', beat: 12, kind: 'hit', anchor: 'start' },
  { id: 'watch', beat: 15, kind: 'hit', anchor: 'start' },
  { id: 'leak', beat: 18, kind: 'hit', anchor: 'start' },
  { id: 'blink', beat: 19, kind: 'hit', anchor: 'start' },
  { id: 'crack', beat: 20, kind: 'impact', anchor: 'start' },
  { id: 'world', beat: 21, kind: 'hit', anchor: 'start' },
  { id: 'crack-2', beat: 22, kind: 'hit', anchor: 'start' },
  { id: 'crack-3', beat: 23, kind: 'impact', anchor: 'start' },
  { id: 'inhale', beat: 23.5, kind: 'silence', anchor: 'start' },
  { id: 'drop', beat: 24, kind: 'impact', anchor: 'start' },
  { id: 'swoop-1', beat: 25, kind: 'hit', anchor: 'start' },
  { id: 'swoop-2', beat: 27.5, kind: 'hit', anchor: 'start' },
  { id: 'swoop-3', beat: 29.75, kind: 'hit', anchor: 'start' },
  { id: 'converge', beat: 30.75, kind: 'whoosh', anchor: 'start' },
  { id: 'laugh', beat: 32, kind: 'impact', anchor: 'start' },
  { id: 'freeze', beat: 33.75, kind: 'tick', anchor: 'start' },
  { id: 'spread', beat: 34, kind: 'whoosh', anchor: 'start' },
  { id: 'ask', beat: 35, kind: 'tick', anchor: 'start' },
  { id: 'dive', beat: 36, kind: 'hit', anchor: 'start' },
  { id: 'whip-1', beat: 37, kind: 'hit', anchor: 'start' },
  { id: 'whip-2', beat: 38, kind: 'hit', anchor: 'start' },
  { id: 'ablaze', beat: 39, kind: 'impact', anchor: 'start' },
  { id: 'rush', beat: 39.5, kind: 'whoosh', anchor: 'start' },
  { id: 'hush', beat: 40.5, kind: 'silence', anchor: 'start' },
  { id: 'lit', beat: 41, kind: 'impact', anchor: 'start' },
  { id: 'all-but-one', beat: 41.5, kind: 'hit', anchor: 'start' },
  { id: 'reach', beat: 42.5, kind: 'whoosh', anchor: 'peak' },
  { id: 'burn', beat: 43, kind: 'impact', anchor: 'start' },
  { id: 'value-1', beat: 44, kind: 'impact', anchor: 'start' },
  { id: 'padlock', beat: 46.5, kind: 'tick', anchor: 'start' },
  { id: 'react-1', beat: 48, kind: 'hit', anchor: 'start' },
  { id: 'wince', beat: 49, kind: 'tick', anchor: 'start' },
  { id: 'value-2', beat: 50, kind: 'impact', anchor: 'start' },
  { id: 'react-2', beat: 54, kind: 'hit', anchor: 'start' },
  { id: 'no-key', beat: 55, kind: 'tick', anchor: 'start' },
  { id: 'value-3', beat: 56, kind: 'impact', anchor: 'start' },
  { id: 'stamp', beat: 56.5, kind: 'impact', anchor: 'start' },
  { id: 'stamp-crack', beat: 57.25, kind: 'impact', anchor: 'start' },
  { id: 'shatter', beat: 57.75, kind: 'impact', anchor: 'start' },
  { id: 'which', beat: 60, kind: 'tick', anchor: 'start' },
  { id: 'scream', beat: 61, kind: 'hit', anchor: 'start' },
  { id: 'last-hush', beat: 62.5, kind: 'silence', anchor: 'start' },
  { id: 'final', beat: 63, kind: 'impact', anchor: 'start' },
  { id: 'wordmark', beat: 64, kind: 'tick', anchor: 'start' },
  { id: 'tagline', beat: 64.5, kind: 'tick', anchor: 'start' },
];

// ---------------------------------------------------------------- music

type Bars = Exclude<PatternOptions['steps'], string>;

function bars(
  fromBeat: number,
  count: number,
  steps: PatternOptions['steps'],
  params?: unknown
): ScoreEvent[] {
  return pattern({ grid: GRID, bars: [0, count], steps, params, startBeat: fromBeat });
}

function at(beats: readonly number[], params?: unknown): ScoreEvent[] {
  return beats.map((beat) => ({ at: { beat }, params }));
}

function roll(from: number, to: number, rampOf: (u: number) => unknown): ScoreEvent[] {
  const count = Math.round((to - from) * 4);
  return Array.from({ length: count }, (_, index) => ({
    at: { beat: from + index / 4 },
    params: rampOf(count === 1 ? 1 : index / (count - 1)),
  }));
}

/** One typewriter strike per character of a question, from `fromFrame`, skipping strikes before frame 0. */
function typing(fromFrame: number, text: string): ScoreEvent[] {
  return Array.from(text.matchAll(/./gsu), (_, index) => fromFrame + index * TYPE_FRAMES)
    .filter((frame) => frame >= 0)
    .map((frame) => ({ at: { frame } }));
}

const RIFF = { drawbars: '888600000', rotorHz: 6.7 };
const ORGAN: Bars = [
  {
    steps: 'x.....x.x...x...',
    params: [
      { ...RIFF, notes: [E3, B3], beats: 1.5 },
      { ...RIFF, notes: [F3], beats: 0.5 },
      { ...RIFF, notes: [F3, C4], beats: 1 },
      { ...RIFF, notes: [E3, B3], beats: 1 },
    ],
  },
  {
    steps: 'x.....x.x...x...',
    params: [
      { ...RIFF, notes: [E3, B3], beats: 1.5 },
      { ...RIFF, notes: [G3], beats: 0.5 },
      { ...RIFF, notes: [F3, A3], beats: 1 },
      { ...RIFF, notes: [F3, C4], beats: 1 },
    ],
  },
];
const PRAISE_BASS: Bars = [
  {
    steps: 'x.....x...x.....',
    params: [
      { note: E1, beats: 1.5, glideFrom: E2, glide: 0.08, drive: 2.5 },
      { note: E1, beats: 1, drive: 2.5 },
      { note: F1, beats: 1.5, drive: 2.5 },
    ],
  },
];
const DROP_BASS: Bars = [
  {
    steps: 'x.....x...x...x.',
    params: [
      { note: E1, beats: 1.5, glideFrom: E2, glide: 0.06, drive: 5 },
      { note: E1, beats: 1, drive: 5 },
      { note: E1, beats: 1, drive: 5 },
      { note: F1, beats: 0.5, drive: 5 },
    ],
  },
];
/** Detuned stabs: E against F, a semitone apart, the wide detune making them sour. */
const STAB = { beats: 0.5, detune: 0.95 };
const DROP_STABS: Bars = [
  {
    steps: 'x..x..x...x.....',
    params: [
      { ...STAB, notes: [E3, F3, B3] },
      { ...STAB, notes: [E3, F3, B3] },
      { ...STAB, notes: [F3, G3, C4] },
      { ...STAB, notes: [E3, F3, B3] },
    ],
  },
];
const HATS_A: Bars = [{ steps: 'x.x.x.x.x.x.x.x.' }, { steps: 'x.x.x.x.x.x.xxxx' }];
const HATS_DROP: Bars = [{ steps: 'x.xxx.x.x.xxx.x.' }, { steps: 'x.xxx.x.x.x.xxxx' }];
const FEAR_TREMOLO = [0.35, 0.6, 0.8, 0.95] as const;

const TRACKS = {
  kick: { instrument: 'kick', bus: 'drums', gainDb: -2 },
  kickLow: { instrument: 'kick', bus: 'drums', gainDb: -8 },
  clap: { instrument: 'clap', bus: 'drums', gainDb: -8 },
  clapLow: { instrument: 'clap', bus: 'drums', gainDb: -14 },
  snare: { instrument: 'snare', bus: 'drums', gainDb: -6 },
  hat: { instrument: 'hat', bus: 'drums', gainDb: -18 },
  bass: { instrument: 'sub808', bus: 'bass', gainDb: -5 },
  bassLow: { instrument: 'sub808', bus: 'bass', gainDb: -12 },
  organ: { instrument: 'organ', bus: 'keys', gainDb: -14 },
  stabs: { instrument: 'supersaw', bus: 'keys', gainDb: -11 },
  braam: { instrument: 'braam', bus: 'keys', gainDb: -6 },
  pad: { instrument: 'pad', bus: 'keys', gainDb: -12 },
  drone: { instrument: 'pad', bus: 'keys', gainDb: -9 },
  riser: { instrument: 'riser', bus: 'keys', gainDb: -12 },
  chord: { instrument: 'pad', bus: 'keys', gainDb: -6 },
  bell: { instrument: 'fmBell', bus: 'bell', gainDb: -10 },
  rumble: { instrument: 'rumble', bus: 'beds', gainDb: -8 },
  impact: { instrument: 'impact', bus: 'hits', gainDb: -1 },
  shatter: { instrument: 'glassShatter', bus: 'hits', gainDb: -10 },
  crack: { instrument: 'crack', bus: 'hits', gainDb: -8 },
  whoosh: { instrument: 'whoosh', bus: 'hits', gainDb: -9 },
  swell: { instrument: 'reverseSwell', bus: 'hits', gainDb: -8 },
  shriek: { instrument: 'shriek', bus: 'hits', gainDb: -14 },
  fire: { instrument: 'fireRoar', bus: 'hits', gainDb: -10 },
  tom: { instrument: 'tom', bus: 'hits', gainDb: -6 },
  snap: { instrument: 'snap', bus: 'foley', gainDb: -12 },
  tick: { instrument: 'tick', bus: 'foley', gainDb: -16 },
  pop: { instrument: 'pop', bus: 'foley', gainDb: -12 },
  keys: { instrument: 'typewriter', bus: 'foley', gainDb: -18 },
  heartbeat: { instrument: 'heartbeat', bus: 'beds', gainDb: -5 },
  sub: { instrument: 'subPulse', bus: 'beds', gainDb: -5 },
} as const;

type TrackId = keyof typeof TRACKS;
type Part = Partial<Record<TrackId, ScoreEvent[]>>;

/** Beats 0-4: the hook. A sub drone and heartbeat under the typing; the eyes open. */
const HOOK: Part = {
  rumble: [{ at: { cue: 'open' }, params: { beats: 4, toneHz: 30, breathRate: 0.5 } }],
  drone: [
    {
      at: { cue: 'open' },
      params: {
        notes: [E2, F2],
        beats: 4,
        attack: 0,
        release: 0.2,
        tremolo: 0.3,
        tremoloRate: 0.5,
      },
    },
  ],
  heartbeat: at([0, 2]),
  keys: typing(-Q1_LEAD, 'DO YOU LIKE AI COMPANIES?'),
  sub: [{ at: { cue: 'eyes' }, params: { toneHz: 36, decay: 1.5 } }],
};

/** Beats 4-21: the praise, the Devil's groove under his answers, into the eye and its crack. */
const PRAISE: Part = {
  kickLow: [
    ...bars(4, 3, 'x.....x...x.....', { drive: 2.5, endHz: 41 }),
    ...at([16, 17, 18, 19], { drive: 3, endHz: 41 }),
  ],
  clapLow: [...bars(4, 3, '....x.......x...'), ...at([17])],
  hat: [...bars(10, 2, HATS_A), ...roll(18, 21, () => ({}))],
  bassLow: [
    ...bars(4, 3, PRAISE_BASS),
    { at: { beat: 16 }, params: { note: E1, beats: 2, drive: 2.5 } },
    { at: { beat: 18 }, params: { note: E1, beats: 3, drive: 3 } },
  ],
  organ: [
    ...bars(4, 3, ORGAN),
    { at: { beat: 16 }, params: { ...RIFF, notes: [E3, B3], beats: 2 } },
  ],
  snap: at([4, 8, 10.5, 12, 15, 18]),
  tick: at([6, 49], { toneHz: 2600, decay: 0.02 }),
  pop: at([...STAMP_BEATS], { fromHz: 400, octaves: 1.5, decay: 0.05 }),
  impact: [
    { at: { cue: 'chomp' }, params: { decay: 0.7, drive: 3, subHz: 30, metal: 0.3 } },
    { at: { cue: 'blink' }, params: { decay: 0.6, drive: 2, subHz: 30, metal: 0.2 } },
    { at: { cue: 'crack' }, params: { decay: 0.8, drive: 2, metal: 0.9 } },
  ],
  crack: [{ at: { cue: 'crack' }, params: { toneHz: 1400, decay: 0.3 } }],
  // The shards breaking off the crack on each of its hits.
  shatter: [
    { at: { cue: 'crack' }, params: { decay: 0.6, shards: 40 } },
    { at: { cue: 'crack-2' }, params: { decay: 0.7, shards: 60 } },
    { at: { cue: 'crack-3' }, params: { decay: 0.9, shards: 80 } },
  ],
};

/** Beats 21-24: the crack opening on each hit over a rising roll, then half a beat of hard silence as it draws in. */
const BUILD: Part = {
  kickLow: at([21, 22, 23], { drive: 3, endHz: 41 }),
  impact: [
    { at: { cue: 'crack-2' }, params: { decay: 0.9, drive: 3, metal: 0.7 } },
    { at: { cue: 'crack-3' }, params: { decay: 1.2, drive: 3.5, metal: 0.8 } },
  ],
  crack: [
    { at: { cue: 'crack-2' }, params: { toneHz: 1200, decay: 0.3 } },
    { at: { cue: 'crack-3' }, params: { toneHz: 1000, decay: 0.4 } },
  ],
  snare: roll(21, 23.5, (u) => ({ toneHz: 170 + 260 * u, decay: 0.12 })),
  riser: [{ at: { cue: 'inhale' }, anchor: 'end', params: { beats: 2.5, octaves: 3 } }],
  // A scream swelling into the drop out of the silence.
  shriek: [{ at: { cue: 'drop' }, anchor: 'end', params: { toneHz: 700, seconds: 0.5 } }],
  swell: [{ at: { cue: 'drop' }, anchor: 'end', params: { beats: 0.5 } }],
};

/** Beats 24-33.75: the drop under the flock, a shriek for each hero's lunge, the laugh; the kit stops on the freeze and the laugh's braam rings on. */
const DROP: Part = {
  // The laugh's bar stops on the freeze: its kit plays 32 to 33.75 and no further, so nothing restarts after it.
  kick: [
    ...bars(24, 2, 'x.....x...x...x.', { drive: 4.5, endHz: 41 }),
    ...bars(32, 1, 'x.....x.........', { drive: 4.5, endHz: 41 }),
  ],
  snare: [
    ...bars(24, 2, '........x.......', { toneHz: 175, decay: 0.4 }),
    ...bars(32, 1, '....x...........', { toneHz: 175, decay: 0.4 }),
  ],
  clap: [...bars(24, 2, '........x.......'), ...bars(32, 1, '....x...........')],
  hat: [...bars(24, 2, HATS_DROP), ...bars(32, 1, 'x.xxx.x.........')],
  bass: [
    ...bars(24, 2, DROP_BASS),
    ...bars(32, 1, [
      {
        steps: 'x.....x.........',
        params: [
          { note: E1, beats: 1.5, glideFrom: E2, glide: 0.06, drive: 5 },
          { note: E1, beats: 0.25, drive: 5 },
        ],
      },
    ]),
  ],
  stabs: [
    ...bars(24, 2, DROP_STABS),
    ...bars(32, 1, [
      {
        steps: 'x..x..x.........',
        params: [
          { ...STAB, notes: [E3, F3, B3] },
          { ...STAB, notes: [E3, F3, B3] },
          { ...STAB, notes: [F3, G3, C4] },
        ],
      },
    ]),
  ],
  braam: [
    { at: { cue: 'drop' }, params: { note: E1, beats: 4 } },
    // The laugh's braam rings on through the freeze and the spread, into the question.
    { at: { cue: 'laugh' }, params: { note: E1, beats: 3.5 } },
  ],
  impact: [
    { at: { cue: 'drop' }, params: { decay: 3, drive: 4.5, metal: 0.8 } },
    { at: { cue: 'laugh' }, params: { decay: 2, drive: 3, metal: 0.6 } },
  ],
  shatter: [{ at: { cue: 'drop' }, params: { decay: 1.6, shards: 120 } }],
  shriek: SWOOP_BEATS.map((beat, index) => ({
    at: { beat },
    params: { toneHz: [1300, 1750, 1100][index], seconds: 0.7 },
  })),
  whoosh: [
    { at: { cue: 'converge' }, params: { seconds: 0.6, semitones: 7, direction: 'rightToLeft' } },
    { at: { cue: 'spread' }, params: { seconds: 0.5, semitones: 3, direction: 'leftToRight' } },
  ],
  organ: [
    {
      at: { cue: 'laugh' },
      params: { drawbars: '888888000', rotorHz: 6.7, notes: [E3, F3, B3, E4], beats: 1.75 },
    },
  ],
  snap: at([24, 32]),
};

/**
 * Beats 33.75-44: the carry and the search. From the freeze a detuned drone swells under the
 * braam and carries on under the question; the build starts on the dive: a kick that doubles
 * each region (quarters, eighths, sixteenths), a strike on every flare, climbing, a whoosh on
 * each whip, the field igniting on 39, a snare roll and a riser into half a beat of silence;
 * then the drop on the red mark: impact, braam, sub, glass and HushBox's bell. ALL BUT ONE on a
 * low braam; the claw's burn.
 */
const TURN: Part = {
  drone: [
    {
      at: { cue: 'freeze' },
      params: {
        notes: [E2, F2, B2],
        beats: 6.75,
        attack: 0.25,
        release: 0.1,
        tremolo: 0.5,
        tremoloRate: 3,
      },
    },
    {
      at: { cue: 'all-but-one' },
      params: {
        notes: [E2, F2],
        beats: 2.5,
        attack: 0,
        release: 0.2,
        tremolo: 0.8,
        tremoloRate: 6,
      },
    },
  ],
  heartbeat: at([35, 35.5]),
  keys: typing(35 * GRID.framesPerBeat, 'ALL OF THEM?'),
  kick: [
    ...at([36, 36.5], { drive: 4, endHz: 41 }),
    ...roll(37, 38, () => ({ drive: 4, endHz: 41 })).filter((_, index) => index % 2 === 0),
    ...roll(38, 39, () => ({ drive: 4.5, endHz: 41 })),
    ...roll(39, 40.5, () => ({ drive: 5, endHz: 41 })),
  ],
  bass: [
    { at: { cue: 'dive' }, params: { note: E1, beats: 1, glideFrom: E2, glide: 0.1, drive: 4 } },
    { at: { cue: 'whip-1' }, params: { note: F1, beats: 1, drive: 4.5 } },
    { at: { cue: 'whip-2' }, params: { note: E1, beats: 1, drive: 5 } },
    {
      at: { cue: 'ablaze' },
      params: { note: E1, beats: 1.5, glideFrom: E2, glide: 0.8, drive: 5 },
    },
  ],
  hat: roll(38, 40.5, () => ({})),
  tick: FLARE_BEATS.map((beat, index) => ({
    at: { beat },
    params: { toneHz: 1800 + index * 140, decay: 0.03 },
  })),
  pop: FLARE_BEATS.map((beat, index) => ({
    at: { beat },
    params: { fromHz: 300 + index * 30, octaves: 1.5, decay: 0.05 },
  })),
  whoosh: [
    { at: { cue: 'dive' }, params: { seconds: 0.4, semitones: 7, direction: 'leftToRight' } },
    { at: { cue: 'whip-1' }, params: { seconds: 0.3, semitones: 9, direction: 'rightToLeft' } },
    { at: { cue: 'whip-2' }, params: { seconds: 0.25, semitones: 11, direction: 'leftToRight' } },
    { at: { cue: 'reach' }, params: { seconds: 0.3, semitones: 9, direction: 'rightToLeft' } },
  ],
  fire: [{ at: { cue: 'ablaze' }, params: { beats: 1.5, attack: 0.1, release: 0.2, crackle: 50 } }],
  snare: roll(39.5, 40.5, (u) => ({ toneHz: 190 + 300 * u, decay: 0.1 })),
  riser: [{ at: { cue: 'hush' }, anchor: 'end', params: { beats: 4.5, octaves: 3 } }],
  swell: [{ at: { cue: 'lit' }, anchor: 'end', params: { beats: 0.5 } }],
  impact: [
    { at: { cue: 'dive' }, params: { decay: 0.6, drive: 2, metal: 0.4 } },
    { at: { cue: 'ablaze' }, params: { decay: 1.2, drive: 3, metal: 0.6 } },
    { at: { cue: 'lit' }, params: { decay: 3, drive: 4.5, subHz: 26, metal: 0.7 } },
    { at: { cue: 'all-but-one' }, params: { decay: 1.5, drive: 2, subHz: 26, metal: 0.3 } },
    { at: { cue: 'burn' }, params: { decay: 1.2, drive: 3, metal: 0.9 } },
  ],
  sub: [{ at: { cue: 'lit' }, params: { toneHz: 34, decay: 2 } }],
  shatter: [{ at: { cue: 'lit' }, params: { decay: 1.6, shards: 140 } }],
  bell: [{ at: { cue: 'lit' }, params: { note: E5, decay: 4 } }],
  crack: [{ at: { cue: 'burn' }, params: { toneHz: 1200, decay: 0.4 } }],
  braam: [
    { at: { cue: 'lit' }, params: { note: E1, beats: 3 } },
    { at: { cue: 'all-but-one' }, params: { note: E1, beats: 2.5 } },
  ],
};

const VALUE_CUES = ['value-1', 'value-2', 'value-3'] as const;
const REACT_CUES = ['react-1', 'react-2'] as const;

/** Beats 44-60: three value hits, the first two answered by the Devil's flinch; the heartbeats speed up. */
const FEAR: Part = {
  kick: bars(44, 4, 'x.......x.x.....', { drive: 3.5, endHz: 41 }),
  snare: bars(44, 4, '........x.......', { toneHz: 165, decay: 0.45 }),
  hat: bars(44, 4, '..x...x...x...x.'),
  bass: bars(44, 4, [
    {
      steps: 'x.......x.x.....',
      params: [
        { note: E1, beats: 2, drive: 3 },
        { note: E1, beats: 0.5, drive: 3 },
        { note: F1, beats: 1.5, drive: 3 },
      ],
    },
  ]),
  impact: [
    ...VALUE_CUES.map((cue, index) => ({
      at: { cue },
      params: { decay: 2 + index * 0.5, drive: 3 + index, metal: 0.5 + index * 0.15 },
    })),
    { at: { cue: 'shatter' }, params: { decay: 1.2, drive: 3, metal: 0.9 } },
  ],
  braam: VALUE_CUES.map((cue) => ({ at: { cue }, params: { note: E1, beats: 3 } })),
  bell: VALUE_CUES.map((cue) => ({ at: { cue }, params: { note: B4, decay: 2 } })),
  tom: REACT_CUES.map((cue, index) => ({
    at: { cue },
    params: { toneHz: 70 - index * 8, decay: 0.8 },
  })),
  sub: REACT_CUES.map((cue) => ({ at: { cue }, params: { toneHz: 38, decay: 0.8 } })),
  pad: FEAR_TREMOLO.map((tremolo, index) => ({
    at: { beat: 44 + index * 4 },
    params: { notes: [E2, F2, B2], beats: 4, attack: 0.3, release: 0.1, tremolo, tremoloRate: 4 },
  })),
  heartbeat: [...at([48, 49, 50, 51.5, 53]), ...at([54, 55, 56, 57, 58, 59]), ...at([59.5])],
  pop: [{ at: { cue: 'padlock' }, params: { fromHz: 520, octaves: 1, decay: 0.06 } }],
  whoosh: [
    { at: { cue: 'react-2' }, params: { seconds: 0.4, semitones: 5, direction: 'leftToRight' } },
  ],
  tick: [{ at: { cue: 'no-key' }, params: { toneHz: 2200, decay: 0.03 } }],
  crack: [
    { at: { cue: 'stamp' }, params: { toneHz: 900, decay: 0.25 } },
    { at: { cue: 'stamp-crack' }, params: { toneHz: 1300, decay: 0.4 } },
  ],
  shatter: [{ at: { cue: 'shatter' }, params: { decay: 1.2, shards: 90 } }],
  snap: at([44, 50, 56]),
};

/** Beats 60-63: the third question, the scream, a roll and riser, hard silence; then the mark. */
const SCREAM: Part = {
  keys: typing(60 * GRID.framesPerBeat, 'WHICH ONE?'),
  kick: at([61, 61.5, 62], { drive: 4, endHz: 41 }),
  snare: roll(61, 62.5, (u) => ({ toneHz: 180 + 280 * u, decay: 0.1 })),
  shriek: [{ at: { cue: 'scream' }, params: { toneHz: 900, seconds: 1.2 } }],
  riser: [{ at: { cue: 'last-hush' }, anchor: 'end', params: { beats: 2, octaves: 2 } }],
  swell: [{ at: { cue: 'final' }, anchor: 'end', params: { beats: 0.5 } }],
  bass: [
    { at: { beat: 60 }, params: { note: E1, beats: 2.5, glideFrom: E2, glide: 1.2, drive: 4 } },
  ],
};

/** The close: the mark lands on the E major chord, a bell on each of its reads, and the chord rings under the still card. */
const CLOSE: Part = {
  impact: [{ at: { cue: 'final' }, params: { decay: 3, drive: 2.5, metal: 0.4 } }],
  chord: [
    {
      at: { cue: 'final' },
      params: { notes: [E3, G_SHARP_3, B3, E4], beats: 12, attack: 0.01, release: 3 },
    },
  ],
  stabs: [{ at: { cue: 'final' }, params: { notes: [E3, G_SHARP_3, B3], beats: 1, detune: 0.3 } }],
  bell: [
    { at: { cue: 'final' }, params: { note: E5, decay: 4 } },
    { at: { cue: 'wordmark' }, params: { note: B4, decay: 3 } },
    { at: { cue: 'tagline' }, params: { note: G_SHARP_4, decay: 3 } },
  ],
  sub: [{ at: { cue: 'final' }, params: { toneHz: 41, decay: 2.5 } }],
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
    buses: [
      {
        id: 'drums',
        role: 'music',
        effects: [],
        sidechain: { cueKinds: ['impact'], depthDb: 3, releaseFrames: 12 },
      },
      {
        id: 'bass',
        role: 'music',
        effects: [],
        sidechain: { cueKinds: ['impact'], depthDb: 6, releaseFrames: 18 },
      },
      {
        id: 'keys',
        role: 'music',
        effects: [{ kind: 'reverb', rt60: 2.6, damping: 5000, mix: 0.24 }],
        sidechain: { cueKinds: ['impact'], depthDb: 6, releaseFrames: 24 },
      },
      { id: 'bell', role: 'sfx', effects: [{ kind: 'reverb', rt60: 3, damping: 8000, mix: 0.35 }] },
      { id: 'hits', role: 'sfx', effects: [] },
      {
        id: 'foley',
        role: 'sfx',
        effects: [{ kind: 'reverb', rt60: 0.8, damping: 6000, mix: 0.1 }],
      },
      { id: 'beds', role: 'sfx', effects: [] },
    ],
  };
}

/** The film's music, played against the cues. */
export const SCORE: ScoreInput = scoreOf([HOOK, PRAISE, BUILD, DROP, TURN, FEAR, SCREAM, CLOSE]);
