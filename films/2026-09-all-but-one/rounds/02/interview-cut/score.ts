import { pattern } from '../../../../engine/audio/score/index.js';
import { defineFilm } from '../../../../engine/film/spec.js';

import type { PatternOptions, ScoreEvent, ScoreInput } from '../../../../engine/audio/score/index.js';
import type { FilmDefinition, FilmSpecInput } from '../../../../engine/film/spec.js';
import type { Grid } from '../../../../engine/time/grid.js';

/** 112.5 BPM: 32 frames a beat, a 16th every 8 frames, 75 beats in 40 s. */
export const GRID: Grid = { framesPerBeat: 32, beatsPerBar: 4 };
const BEATS = 75;

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
const G2 = 43;
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

type Basis = NonNullable<FilmSpecInput['text'][number]['basis']>;
const OPINION: Basis = { kind: 'opinion' };
const STORY: Basis = {
  kind: 'brand',
  source: 'films/2026-09-all-but-one/brief.md: the interview, the Devil, and the one company he cannot use',
};
const ENCRYPTED: Basis = {
  kind: 'fact',
  source:
    'README.template.md (README.md:56): "Your messages are encrypted in your browser before they\'re stored."',
};
const UNREADABLE: Basis = {
  kind: 'fact',
  source:
    'README.template.md (README.md:58): "Our servers can\'t read your stored conversations because they never hold the decryption key."',
};
const NOT_SOLD: Basis = {
  kind: 'fact',
  source:
    'README.template.md (README.md:148-152), No Data Monetization: "What you write in HushBox is yours ... We won\'t sell it"; docs/PRODUCT.md: "no data monetization"',
};
const TAGLINE: Basis = { kind: 'brand', source: 'README.md:7, apps/marketing/src/pages/welcome.astro:80-84' };

type TextRow = FilmSpecInput['text'][number];
type ShotRow = NonNullable<FilmSpecInput['shots']>[number];

function line(
  id: string,
  shotId: string,
  words: string,
  [inBeat, outBeat]: readonly [number, number],
  basis: Basis,
  role: TextRow['role'] = 'headline'
): TextRow {
  return { id, shotId, words, role, inBeat, outBeat, basis };
}

function shot(
  id: string,
  [fromBeat, toBeat]: readonly [number, number],
  reads: readonly (readonly [number, number, string])[],
  framing: string,
  camera: string,
  event: string,
  seam: string
): ShotRow {
  return {
    id,
    fromBeat,
    toBeat,
    reads: reads.map(([a, b, what]) => ({ fromBeat: a, toBeat: b, what })),
    framing,
    camera,
    event,
    seam,
  };
}

const SHOTS: ShotRow[] = [
  shot('file', [0, 4], [[0, 2.5, 'the question types: DO YOU LIKE AI COMPANIES?'], [2.5, 4, 'two eyes open in the dark and fix on you']],
    'black; the interview file HUD; the question in the safe box', 'a slow push into the dark', 'the question types itself; on 2.5 two eyes snap open and track the viewer', 'the lamp comes up'),
  shot('of-course', [4, 8], [[4, 6, 'OF COURSE I DO.'], [6, 8, 'his smirk splits into a grin, one brow arching']],
    'close on his face under the lamp, eyes on the viewer', 'slow push, the eyes tracking against it', 'the lamp comes up on him; the head tilts while the eyes stay on you; on 6 the closed smirk splits into the full grin and his left brow arches', 'hard cut'),
  shot('not-to-like', [8, 12], [[8, 10.5, 'WHAT\u2019S NOT TO LIKE? the jaw opens on rows of teeth'], [10.5, 12, 'the jaw snaps shut at the lens']],
    'extreme close on the mouth', 'creep in; a punch on the chomp', 'the jaw opens slowly on row after row of teeth and snaps shut on 10.5, the eyes narrowing', 'hard cut'),
  shot('save', [12, 15], [[12, 15, 'THEY SAVE ALL YOUR DATA: messages file into an archive']],
    'wide: an archive wall, messages dropping into drawers', 'tilt down the wall', 'personal messages fall into the drawers on the 16ths; the counter climbs', 'hard cut'),
  shot('watch', [15, 18], [[15, 18, 'THEY WATCH FOR WRONG OPINIONS: the eye stamps thoughts FLAGGED']],
    'navy radar: a giant eye, scribbled thought bubbles orbiting', 'slow orbit roll', 'the eye opens; the sweep stamps a thought FLAGGED on each half beat from 16', 'hard cut'),
  shot('leak', [18, 21], [[18, 19, 'AND THEY LEAK IT: the eye stares, close'], [19, 21, 'the lids snap shut into a seam of light, which kinks into a crack']],
    'extreme close: the watching eye', 'creep in; a punch on each crack', 'the iris darts; on 19 the lids snap shut into a white-hot seam across the frame; on 20 the seam kinks into a zig-zag crack that opens and throws off branch cracks', 'hard cut'),
  shot('world-to-see', [21, 24], [[21, 23.5, 'FOR THE WORLD TO SEE. over the crack, which opens wider on each hit'], [23.5, 24, 'the crack draws in, dark, in silence']],
    'black: the crack across the frame, the copy high', 'push on each crack; inhale on the silence', 'the crack opens wider on 22 and 23, its branches running further; on 23.5 it draws in to a dark line in silence; on 24 it bursts', 'the crack bursts and the flock escapes'),
  shot('flock', [24, 32], [[24, 24.25, 'a seam of light bursts where his eyes were'], [24.25, 26.25, 'a demon carries a secret: I’m in love with my best friend.'], [26.5, 28.5, 'a demon carries a secret: I practise my Oscar speech in the shower.'], [28.75, 30.75, 'a demon carries a secret: I still have the other phone.'], [30.75, 32, 'the flock lines up as the Devil’s face']],
    'hellfire dark: a flock of demons, each built differently, three heroes close', 'snaps back on the drop, dives into the flock rolled, pulls wide, pushes on the second secret, settles for the face', 'the leaked secrets burst out as small chat bubbles that grow horns, wings, ember eyes and teeth; each hero demon carries its secret written across its body; one demon crosses the lens huge; the flock spirals in and lines up as the outline, horns and grin of his face', 'the flock merges into his face'),
  shot('laugh', [32, 35], [[32, 33.75, 'the Devil laughs in a halo of the demons he has gathered'], [33.75, 34, 'he freezes'], [34, 35, 'his collection spreads into a field of gold marks and his face looms behind it']],
    'the Devil full face, the halo', 'push in; a snap still on 33.75; then an eased move out as his face grows vast behind the field', 'the flock merges into his laughing face and the demons he has gathered ring him; on 33.75 everything stops dead; from 34 each demon of the halo flies out and becomes a small gold mark, hundreds more light around them, and his face grows vast and dims behind them: his collection, every AI company', 'into the field'),
  shot('all-of-them', [35, 41], [[35, 36, 'the question types: ALL OF THEM? over his field of gold marks'], [36, 39, 'his searchlights land mark after mark, each taking his brand, faster and faster'], [39, 40.5, 'the whole field ablaze in gold, but one dark slot'], [40.5, 41, 'silence, dark']],
    'his collection: a field of gold marks, every one different, far larger than the frame; his vast face dim behind, his eyes throwing two searchlights', 'pulls out to show the field\u2019s size, then flies through it: a dive (36), a whip (37), a second whip (38), a pull back (39) and a rush at the dark slot (39.5)', 'each mark his light lands on flares white and takes his brand, two in the first region, four in the second, eight in the third; on 39 the whole field ignites gold in a wave; the slot stays dark and his light judders off it; on 40.5 everything drops dark in silence', 'the drop'),
  shot('all-but-one', [41, 44], [[41, 41.5, 'the slot lights Signal Red and a shockwave blows his field apart'], [41.5, 42.5, 'ALL BUT ONE.'], [42.5, 44, 'his claw reaches for it and burns white-hot; he recoils']],
    'close on the red HushBox mark as his field burns away, his face dim behind', 'a slow push', 'on 41 the HushBox mark lights, exact, and a white-hot shockwave throws the gold marks outward and burns them to embers; on 42.5 his claw reaches in; on 43 it touches the mark and burns white-hot, ash falling; his face turns to fear', 'hard cut'),
  shot('encrypted', [44, 48], [[44, 44.5, 'THEY ENCRYPT IT BEFORE IT’S STORED.'], [44.5, 46, 'the flock’s first secret slams in, readable'], [46, 48, 'the red ring closes, the message scrambles, the padlock snaps']],
    'charcoal, a message bubble high, the claim under it', 'slow push; a punch-in cut on the padlock at 47', 'the claim lands alone; the message slams in (44.5); the ring closes and the letters scramble (46); the padlock snaps (46.5)', 'hard cut'),
  shot('flinch', [48, 50], [[48, 49, 'he flinches: his eyes snap wide'], [49, 50, 'he winces: lids squeeze, brows knot']],
    'daylight paper: extreme close on his eyes', 'push; he jerks back on the hit; a punch-in cut on 49', 'the eyes snap wide; on 49 the lids squeeze and the brows knot', 'hard cut'),
  shot('unreadable', [50, 54], [[50, 54, 'THEY CAN’T READ YOUR STORED CHATS: a wall of locked cipher']],
    'charcoal, the archive, every drawer cipher', 'track right; a punch-in cut at 52', 'a red lock snaps onto every drawer in a wave', 'hard cut'),
  shot('lens', [54, 56], [[54, 56, 'his lens finds only noise: NO KEY']],
    'the Devil behind his gold lens', 'drift with the lens', 'the lens swings up (54), NO KEY springs up (55), he recoils', 'hard cut'),
  shot('not-for-sale', [56, 60], [[56, 56.5, 'AND YOUR CHATS AREN’T FOR SALE.'], [56.5, 57.75, 'the SOLD stamp slams, slams again and cracks'], [57.75, 60, 'it flies apart']],
    'a page in a red frame, the gold SOLD stamp above', 'shake on the blows, a punch-in cut at 58.5', 'the claim lands alone (56); the stamp drops and slams (56.5), slams again and cracks (57.25), holds cracked, and flies apart (57.75)', 'hard cut'),
  shot('which-one', [60, 63], [[60, 61, 'the question types: WHICH ONE?'], [61, 62.5, 'he screams and tears apart into a red spiral'], [62.5, 63, 'the spiral collapses to one red dot']],
    'charcoal: the Devil full face in terror', 'push into the mouth', 'the question lands and is backspaced; he screams; from 62 his strokes spiral in; on 62.5 everything collapses to a dot in silence', 'the dot bursts into the mark'),
  shot('mark', [63, 75], [[63, 64, 'the dot bursts into the mark’s parts, which settle on the logo'], [64, 65, 'HushBox, then the tagline'], [65, 75, 'the end card holds still: One interface. Every feature. Private.']],
    'the Signal Red mark, the wordmark under it, the tagline under that', 'a pull back that lands by 64.5, then no camera move', 'the dot bursts on 63; each part of the mark flies out on its own arc and settles on the exact logo by 64.5; HushBox lands on 64 and the tagline on 64.5; from there the card holds still to the end, embers drifting and the rays turning slowly behind it', 'end'),
];

const TEXT: TextRow[] = [
  line('q1', 'file', 'DO YOU LIKE AI COMPANIES?', [0, 4], STORY, 'support'),
  line('a1', 'of-course', 'OF COURSE I DO.', [4, 8], OPINION),
  line('a2', 'not-to-like', 'WHAT’S NOT TO LIKE?', [8, 12], OPINION),
  line('a3', 'save', 'THEY SAVE ALL YOUR DATA.', [12, 15], OPINION),
  line('a4a', 'watch', 'THEY WATCH FOR', [15, 18], OPINION),
  line('a4b', 'watch', 'WRONG OPINIONS.', [15, 18], OPINION),
  line('a5', 'leak', 'AND THEY LEAK IT', [18, 21], OPINION),
  line('a6', 'world-to-see', 'FOR THE WORLD TO SEE.', [21, 24], OPINION),
  line('q2', 'all-of-them', 'ALL OF THEM?', [35, 38], STORY, 'support'),
  line('a7', 'all-but-one', 'ALL BUT ONE.', [41.5, 44], STORY),
  line('v1a', 'encrypted', 'THEY ENCRYPT IT', [44, 48], ENCRYPTED),
  line('v1b', 'encrypted', 'BEFORE IT’S STORED.', [44, 48], ENCRYPTED),
  line('v2a', 'unreadable', 'THEY CAN’T READ', [50, 54], UNREADABLE),
  line('v2b', 'unreadable', 'YOUR STORED CHATS.', [50, 54], UNREADABLE),
  line('v3a', 'not-for-sale', 'AND YOUR CHATS', [56, 60], NOT_SOLD),
  line('v3b', 'not-for-sale', 'AREN’T FOR SALE.', [56, 60], NOT_SOLD),
  line('q3', 'which-one', 'WHICH ONE?', [60, 63], STORY, 'support'),
  line('wordmark', 'mark', 'HushBox', [64, 75], TAGLINE),
  line('tag-1', 'mark', 'One interface.', [64.5, 75], TAGLINE),
  line('tag-2', 'mark', 'Every feature.', [64.5, 75], TAGLINE),
  line('tag-3', 'mark', 'Private.', [64.5, 75], TAGLINE),
];

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
export const FLARE_BEATS = [36, 36.5, 37, 37.25, 37.5, 37.75, 38, 38.125, 38.25, 38.375, 38.5, 38.625, 38.75, 38.875] as const;
/** Beats the radar sweep stamps a message FLAGGED. */
export const STAMP_BEATS = [16, 16.5, 17, 17.5] as const;

const CUES: FilmSpecInput['cues'] = [
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

function bars(fromBeat: number, count: number, steps: PatternOptions['steps'], params?: unknown): ScoreEvent[] {
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
  return [...text]
    .map((_, index) => fromFrame + index * TYPE_FRAMES)
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
  drone: [{ at: { cue: 'open' }, params: { notes: [E2, F2], beats: 4, attack: 0, release: 0.2, tremolo: 0.3, tremoloRate: 0.5 } }],
  heartbeat: at([0, 2]),
  keys: typing(-Q1_LEAD, 'DO YOU LIKE AI COMPANIES?'),
  sub: [{ at: { cue: 'eyes' }, params: { toneHz: 36, decay: 1.5 } }],
};

/** Beats 4-21: the praise, the Devil's groove under his answers, into the eye and its crack. */
const PRAISE: Part = {
  kickLow: [...bars(4, 3, 'x.....x...x.....', { drive: 2.5, endHz: 41 }), ...at([16, 17, 18, 19], { drive: 3, endHz: 41 })],
  clapLow: [...bars(4, 3, '....x.......x...'), ...at([17])],
  hat: [...bars(10, 2, HATS_A), ...roll(18, 21, () => ({}))],
  bassLow: [...bars(4, 3, PRAISE_BASS), { at: { beat: 16 }, params: { note: E1, beats: 2, drive: 2.5 } }, { at: { beat: 18 }, params: { note: E1, beats: 3, drive: 3 } }],
  organ: [...bars(4, 3, ORGAN), { at: { beat: 16 }, params: { ...RIFF, notes: [E3, B3], beats: 2 } }],
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
  snare: roll(21, 23.5, (u) => ({ toneHz: 170 + 260 * (u as number), decay: 0.12 })),
  riser: [{ at: { cue: 'inhale' }, anchor: 'end', params: { beats: 2.5, octaves: 3 } }],
  // A scream swelling into the drop out of the silence.
  shriek: [{ at: { cue: 'drop' }, anchor: 'end', params: { toneHz: 700, seconds: 0.5 } }],
  swell: [{ at: { cue: 'drop' }, anchor: 'end', params: { beats: 0.5 } }],
};

/** Beats 24-33.75: the drop under the flock, a shriek for each hero's lunge, the laugh; the kit stops on the freeze and the laugh's braam rings on. */
const DROP: Part = {
  // The laugh's bar stops on the freeze: its kit plays 32 to 33.75 and no further, so nothing restarts after it.
  kick: bars(24, 2, 'x.....x...x...x.', { drive: 4.5, endHz: 41 }).concat(bars(32, 1, 'x.....x.........', { drive: 4.5, endHz: 41 })),
  snare: bars(24, 2, '........x.......', { toneHz: 175, decay: 0.4 }).concat(bars(32, 1, '....x...........', { toneHz: 175, decay: 0.4 })),
  clap: bars(24, 2, '........x.......').concat(bars(32, 1, '....x...........')),
  hat: bars(24, 2, HATS_DROP).concat(bars(32, 1, 'x.xxx.x.........')),
  bass: bars(24, 2, DROP_BASS).concat(
    bars(32, 1, [{ steps: 'x.....x.........', params: [{ note: E1, beats: 1.5, glideFrom: E2, glide: 0.06, drive: 5 }, { note: E1, beats: 0.25, drive: 5 }] }])
  ),
  stabs: bars(24, 2, DROP_STABS).concat(
    bars(32, 1, [{ steps: 'x..x..x.........', params: [{ ...STAB, notes: [E3, F3, B3] }, { ...STAB, notes: [E3, F3, B3] }, { ...STAB, notes: [F3, G3, C4] }] }])
  ),
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
  shriek: SWOOP_BEATS.map((beat, index) => ({ at: { beat }, params: { toneHz: [1300, 1750, 1100][index], seconds: 0.7 } })),
  whoosh: [
    { at: { cue: 'converge' }, params: { seconds: 0.6, semitones: 7, direction: 'rightToLeft' } },
    { at: { cue: 'spread' }, params: { seconds: 0.5, semitones: 3, direction: 'leftToRight' } },
  ],
  organ: [{ at: { cue: 'laugh' }, params: { drawbars: '888888000', rotorHz: 6.7, notes: [E3, F3, B3, E4], beats: 1.75 } }],
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
    { at: { cue: 'freeze' }, params: { notes: [E2, F2, B2], beats: 6.75, attack: 0.25, release: 0.1, tremolo: 0.5, tremoloRate: 3 } },
    { at: { cue: 'all-but-one' }, params: { notes: [E2, F2], beats: 2.5, attack: 0, release: 0.2, tremolo: 0.8, tremoloRate: 6 } },
  ],
  heartbeat: at([35, 35.5]),
  keys: typing(35 * GRID.framesPerBeat, 'ALL OF THEM?'),
  kick: [...at([36, 36.5], { drive: 4, endHz: 41 }), ...roll(37, 38, () => ({ drive: 4, endHz: 41 })).filter((_, i) => i % 2 === 0), ...roll(38, 39, () => ({ drive: 4.5, endHz: 41 })), ...roll(39, 40.5, () => ({ drive: 5, endHz: 41 }))],
  bass: [
    { at: { cue: 'dive' }, params: { note: E1, beats: 1, glideFrom: E2, glide: 0.1, drive: 4 } },
    { at: { cue: 'whip-1' }, params: { note: F1, beats: 1, drive: 4.5 } },
    { at: { cue: 'whip-2' }, params: { note: E1, beats: 1, drive: 5 } },
    { at: { cue: 'ablaze' }, params: { note: E1, beats: 1.5, glideFrom: E2, glide: 0.8, drive: 5 } },
  ],
  hat: roll(38, 40.5, () => ({})),
  tick: FLARE_BEATS.map((beat, index) => ({ at: { beat }, params: { toneHz: 1800 + index * 140, decay: 0.03 } })),
  pop: FLARE_BEATS.map((beat, index) => ({ at: { beat }, params: { fromHz: 300 + index * 30, octaves: 1.5, decay: 0.05 } })),
  whoosh: [
    { at: { cue: 'dive' }, params: { seconds: 0.4, semitones: 7, direction: 'leftToRight' } },
    { at: { cue: 'whip-1' }, params: { seconds: 0.3, semitones: 9, direction: 'rightToLeft' } },
    { at: { cue: 'whip-2' }, params: { seconds: 0.25, semitones: 11, direction: 'leftToRight' } },
    { at: { cue: 'reach' }, params: { seconds: 0.3, semitones: 9, direction: 'rightToLeft' } },
  ],
  fire: [{ at: { cue: 'ablaze' }, params: { beats: 1.5, attack: 0.1, release: 0.2, crackle: 50 } }],
  snare: roll(39.5, 40.5, (u) => ({ toneHz: 190 + 300 * (u as number), decay: 0.1 })),
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
    { steps: 'x.......x.x.....', params: [{ note: E1, beats: 2, drive: 3 }, { note: E1, beats: 0.5, drive: 3 }, { note: F1, beats: 1.5, drive: 3 }] },
  ]),
  impact: [
    ...VALUE_CUES.map((cue, index) => ({ at: { cue }, params: { decay: 2 + index * 0.5, drive: 3 + index, metal: 0.5 + index * 0.15 } })),
    { at: { cue: 'shatter' }, params: { decay: 1.2, drive: 3, metal: 0.9 } },
  ],
  braam: VALUE_CUES.map((cue) => ({ at: { cue }, params: { note: E1, beats: 3 } })),
  bell: VALUE_CUES.map((cue) => ({ at: { cue }, params: { note: B4, decay: 2 } })),
  tom: REACT_CUES.map((cue, index) => ({ at: { cue }, params: { toneHz: 70 - index * 8, decay: 0.8 } })),
  sub: REACT_CUES.map((cue) => ({ at: { cue }, params: { toneHz: 38, decay: 0.8 } })),
  pad: FEAR_TREMOLO.map((tremolo, index) => ({
    at: { beat: 44 + index * 4 },
    params: { notes: [E2, F2, B2], beats: 4, attack: 0.3, release: 0.1, tremolo, tremoloRate: 4 },
  })),
  heartbeat: [...at([48, 49, 50, 51.5, 53]), ...at([54, 55, 56, 57, 58, 59]), ...at([59.5])],
  pop: [{ at: { cue: 'padlock' }, params: { fromHz: 520, octaves: 1, decay: 0.06 } }],
  whoosh: [{ at: { cue: 'react-2' }, params: { seconds: 0.4, semitones: 5, direction: 'leftToRight' } }],
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
  snare: roll(61, 62.5, (u) => ({ toneHz: 180 + 280 * (u as number), decay: 0.1 })),
  shriek: [{ at: { cue: 'scream' }, params: { toneHz: 900, seconds: 1.2 } }],
  riser: [{ at: { cue: 'last-hush' }, anchor: 'end', params: { beats: 2, octaves: 2 } }],
  swell: [{ at: { cue: 'final' }, anchor: 'end', params: { beats: 0.5 } }],
  bass: [{ at: { beat: 60 }, params: { note: E1, beats: 2.5, glideFrom: E2, glide: 1.2, drive: 4 } }],
};

/** The close: the mark lands on the E major chord, a bell on each of its reads, and the chord rings under the still card. */
const CLOSE: Part = {
  impact: [{ at: { cue: 'final' }, params: { decay: 3, drive: 2.5, metal: 0.4 } }],
  chord: [{ at: { cue: 'final' }, params: { notes: [E3, G_SHARP_3, B3, E4], beats: 12, attack: 0.01, release: 3 } }],
  stabs: [{ at: { cue: 'final' }, params: { notes: [E3, G_SHARP_3, B3], beats: 1, detune: 0.3 } }],
  bell: [
    { at: { cue: 'final' }, params: { note: E5, decay: 4 } },
    { at: { cue: 'wordmark' }, params: { note: B4, decay: 3 } },
    { at: { cue: 'tagline' }, params: { note: G_SHARP_4, decay: 3 } },
  ],
  sub: [{ at: { cue: 'final' }, params: { toneHz: 41, decay: 2.5 } }],
};

void G2;

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
      { id: 'drums', role: 'music', effects: [], sidechain: { cueKinds: ['impact'], depthDb: 3, releaseFrames: 12 } },
      { id: 'bass', role: 'music', effects: [], sidechain: { cueKinds: ['impact'], depthDb: 6, releaseFrames: 18 } },
      {
        id: 'keys',
        role: 'music',
        effects: [{ kind: 'reverb', rt60: 2.6, damping: 5000, mix: 0.24 }],
        sidechain: { cueKinds: ['impact'], depthDb: 6, releaseFrames: 24 },
      },
      { id: 'bell', role: 'sfx', effects: [{ kind: 'reverb', rt60: 3, damping: 8000, mix: 0.35 }] },
      { id: 'hits', role: 'sfx', effects: [] },
      { id: 'foley', role: 'sfx', effects: [{ kind: 'reverb', rt60: 0.8, damping: 6000, mix: 0.1 }] },
      { id: 'beds', role: 'sfx', effects: [] },
    ],
  };
}

/**
 * The take's spec and score. The CLI loads this module by path.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: 'interview-cut',
    title: 'All But One: interview cut',
    seed: 'all-but-one/interview-cut',
    grid: GRID,
    beats: BEATS,
    shots: SHOTS,
    text: TEXT,
    cues: CUES,
  }),
  score: scoreOf([HOOK, PRAISE, BUILD, DROP, TURN, FEAR, SCREAM, CLOSE]),
};
