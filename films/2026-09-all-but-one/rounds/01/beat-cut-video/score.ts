import { pattern } from '../../../../engine/audio/score/index.js';
import { defineFilm } from '../../../../engine/film/spec.js';

import type { PatternOptions, ScoreEvent, ScoreInput } from '../../../../engine/audio/score/index.js';
import type { FilmDefinition, FilmSpecInput } from '../../../../engine/film/spec.js';
import type { Grid } from '../../../../engine/time/grid.js';

/** 150 BPM: 24 frames a beat, a 16th every 6 frames, 75 beats in 30 s. */
export const GRID: Grid = { framesPerBeat: 24, beatsPerBar: 4 };
const BEATS = 75;

// E Phrygian: the flat second (F) is the Devil's; the close resolves to E major. MIDI notes.
const E1 = 28;
const F1 = 29;
const E2 = 40;
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
  source: 'films/2026-09-all-but-one/brief.md: the Devil, AI companies, and the one he cannot use',
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

const SHOTS: FilmSpecInput['shots'] = [
  {
    id: 'ignite',
    fromBeat: 0,
    toBeat: 3,
    reads: [
      { fromBeat: 0, toBeat: 1, what: 'THE DEVIL' },
      { fromBeat: 1, toBeat: 3, what: 'loves AI; his flame splits into horns' },
    ],
    framing: 'wide, black and gold, a flame low centre under a HUD',
    camera: 'log-space push in, 1.0 to 1.18',
    event: 'the flame tears into two tongues that harden into horns',
    seam: 'radial gold speed-line cut on beat 3',
  },
  {
    id: 'grin',
    fromBeat: 3,
    toBeat: 6,
    reads: [
      { fromBeat: 3, toBeat: 4, what: 'the Devil draws himself around the horns' },
      { fromBeat: 4, toBeat: 6, what: 'HERE IS WHY' },
    ],
    framing: 'medium close, the head centred low, the interview REC HUD',
    camera: 'push and a slow roll, shake on the grin',
    event: 'the head outline, eyes and grin draw on stroke by stroke from the horns',
    seam: 'hard cut to parchment',
  },
  {
    id: 'keep',
    fromBeat: 6,
    toBeat: 9,
    reads: [
      { fromBeat: 6, toBeat: 7, what: 'THEY KEEP' },
      { fromBeat: 7, toBeat: 8, what: 'EVERYTHING' },
      { fromBeat: 8, toBeat: 9, what: 'the archive filling drawer by drawer, close' },
    ],
    framing: 'parchment, an ink archive of drawers in perspective below the type',
    camera: 'tilt down the archive as it fills; a punch-in cut to 1.45x on beat 8',
    event: 'drawers slide out and swallow glowing pages on every 16th; the counter climbs',
    seam: 'the type collapses out; hard cut to black on beat 9',
  },
  {
    id: 'cackle',
    fromBeat: 9,
    toBeat: 12,
    reads: [{ fromBeat: 9, toBeat: 12, what: 'the grin, extreme close, laughing, HA HA marquee' }],
    framing: 'extreme close on the grin, teeth filling the frame',
    camera: 'fast push, shake on each beat',
    event: 'the jaw snaps open and shut on every 8th, outline HA letters scroll behind',
    seam: 'hard cut to the closed eye',
  },
  {
    id: 'watch',
    fromBeat: 12,
    toBeat: 16,
    reads: [
      { fromBeat: 12, toBeat: 13, what: 'THEY WATCH: the eye opens' },
      { fromBeat: 13, toBeat: 13.5, what: 'WHAT YOU THINK' },
      { fromBeat: 13.5, toBeat: 14, what: 'thoughts fly in around the eye' },
      { fromBeat: 14, toBeat: 16, what: 'the sweep stamps each thought FLAGGED' },
    ],
    framing: 'navy, a giant radar eye low centre',
    camera: 'slow orbit roll, push on each stamp',
    event: 'the eye opens on beat 12; thoughts fly in on 13.5; the sweep stamps one FLAGGED on each half beat from 14',
    seam: 'hard cut to parchment',
  },
  {
    id: 'leak',
    fromBeat: 16,
    toBeat: 20,
    reads: [
      { fromBeat: 16, toBeat: 18, what: 'AND THEY LEAK: the vault door cracks' },
      { fromBeat: 18, toBeat: 20, what: 'IT ALL: the door bursts, papers fly at the viewer' },
    ],
    framing: 'parchment, an ink vault door low centre',
    camera: 'locked, then a punch out on the burst',
    event: 'the wheel spins, a crack runs across on beat 17, the halves split on beat 18 and pages fly',
    seam: 'hard cut into the montage',
  },
  {
    id: 'build',
    fromBeat: 20,
    toBeat: 24,
    reads: [{ fromBeat: 20, toBeat: 24, what: 'KEEP, WATCH, LEAK, faster, then darkness' }],
    framing: 'the three motifs recut, huge outline words, then black with one ember',
    camera: 'a push that accelerates into the ember',
    event: 'cuts tighten from every beat to every half beat, a stutter, then the frame inhales to one point',
    seam: 'silence, then the drop bursts from the ember',
  },
  {
    id: 'escape',
    fromBeat: 24,
    toBeat: 28,
    reads: [
      { fromBeat: 24, toBeat: 26, what: 'YOUR SECRETS: the ember bursts into demons' },
      { fromBeat: 26, toBeat: 28, what: 'GET OUT' },
    ],
    framing: 'hell palette, a burst from centre, demons scattering upward',
    camera: 'shake on the drop, fast pull back',
    event: 'the ember detonates into a ring and speed lines; demons of fire claw out of it',
    seam: 'whip up into the night',
  },
  {
    id: 'world',
    fromBeat: 28,
    toBeat: 32,
    reads: [
      { fromBeat: 28, toBeat: 29, what: 'FOR THE WHOLE' },
      { fromBeat: 29, toBeat: 32, what: 'WORLD TO SEE: demons swoop the city, windows light' },
    ],
    framing: 'a line-drawn street in one-point perspective, night sky',
    camera: 'a fly-down the street, zooming in log space',
    event: 'the street builds itself as the camera flies; each demon that passes lights the windows it touches',
    seam: 'a demon flies into the lens',
  },
  {
    id: 'exposed',
    fromBeat: 32,
    toBeat: 36,
    reads: [
      { fromBeat: 32, toBeat: 33, what: 'SEEN' },
      { fromBeat: 33, toBeat: 34, what: 'SOLD' },
      { fromBeat: 34, toBeat: 36, what: 'SHARED: a demon made of a secret screams' },
    ],
    framing: 'one demon close, its body made of the secret it carries',
    camera: 'push on every word, roll with the demon',
    event: 'the body of the demon assembles from the words of a secret and screams at camera',
    seam: 'hard cut to the Devil',
  },
  {
    id: 'laugh',
    fromBeat: 36,
    toBeat: 40,
    reads: [
      { fromBeat: 36, toBeat: 37, what: 'THEY ALL' },
      { fromBeat: 37, toBeat: 40, what: 'WORK FOR ME: the Devil laughs in a halo of demons' },
    ],
    framing: 'the Devil full face, demons circling him as a halo',
    camera: 'push in, the halo turning',
    event: 'the horns flare with fire, the jaw laughs on the beat, the halo tightens',
    seam: 'tape stop into silence',
  },
  {
    id: 'one',
    fromBeat: 40,
    toBeat: 44,
    reads: [
      { fromBeat: 40, toBeat: 42, what: 'ALL BUT: a field of gold tokens, every AI company' },
      { fromBeat: 42, toBeat: 44, what: 'ONE: one token turns Signal Red' },
    ],
    framing: 'black, a grid of gold tokens',
    camera: 'still, then a push into the red token',
    event: 'the tokens dim in silence; on beat 42 one turns red and swells',
    seam: 'the red token becomes the ring of the next shot',
  },
  {
    id: 'encrypted',
    fromBeat: 44,
    toBeat: 48,
    reads: [{ fromBeat: 44, toBeat: 48, what: 'ENCRYPTED BEFORE IT IS STORED: the red ring closes and the message scrambles' }],
    framing: 'warm charcoal, a chat bubble centre',
    camera: 'slow push 1.0 to 1.12',
    event: 'on the hit the red ring closes on the message, its letters scramble to cipher and a padlock snaps shut (45)',
    seam: 'copy collapses out; hard cut',
  },
  {
    id: 'flinch',
    fromBeat: 48,
    toBeat: 51,
    reads: [{ fromBeat: 48, toBeat: 51, what: 'the Devil flinches, the red ring in his eyes' }],
    framing: 'extreme close on the Devil\'s eyes',
    camera: 'slow push; he jerks back on the hit',
    event: 'his eyes snap wide and his head jerks back; the red ring shines in both pupils',
    seam: 'hard cut',
  },
  {
    id: 'unreadable',
    fromBeat: 51,
    toBeat: 56,
    reads: [{ fromBeat: 51, toBeat: 56, what: 'THEY CAN NOT READ YOUR STORED CHATS: a wall of locked cipher' }],
    framing: 'daylight paper, the archive of act one, every drawer cipher',
    camera: 'a slow track right along the wall',
    event: 'on the hit a red lock snaps onto every drawer in a wave',
    seam: 'copy collapses out; hard cut',
  },
  {
    id: 'lens',
    fromBeat: 56,
    toBeat: 59,
    reads: [{ fromBeat: 56, toBeat: 59, what: 'the Devil\'s lens finds only noise: NO KEY' }],
    framing: 'medium: the Devil behind his gold lens, cipher in the glass',
    camera: 'drift right with the lens',
    event: 'the lens swings up in front of him (56); NO KEY springs up under it (57); he recoils',
    seam: 'hard cut',
  },
  {
    id: 'not-for-sale',
    fromBeat: 59,
    toBeat: 63,
    reads: [{ fromBeat: 59, toBeat: 63, what: 'YOUR CHATS AREN\'T FOR SALE: the SOLD stamp shatters on the page' }],
    framing: 'a page in a red frame; the Devil\'s gold SOLD stamp above it',
    camera: 'shake on each blow, then a slow push',
    event: 'the stamp slams with the words (59), is thrown back, slams again and shatters (60)',
    seam: 'copy collapses out; hard cut',
  },
  {
    id: 'sweat',
    fromBeat: 63,
    toBeat: 66,
    reads: [{ fromBeat: 63, toBeat: 66, what: 'the Devil sweats as the shards rain past; he looks up' }],
    framing: 'medium wide, the Devil low in frame, stamp shards falling',
    camera: 'slow pull back',
    event: 'sweat runs, his jaw trembles; on 65 he looks up at what is coming',
    seam: 'hard cut',
  },
  {
    id: 'not-hushbox',
    fromBeat: 66,
    toBeat: 69,
    reads: [{ fromBeat: 66, toBeat: 69, what: 'NOT HUSHBOX: the Devil screams and breaks into a red spiral' }],
    framing: 'the Devil full face in terror',
    camera: 'push into the mouth',
    event: 'the head pulls back, the scream opens, then every stroke tears loose into a red vortex',
    seam: 'hard cut to the mark',
  },
  {
    id: 'mark',
    fromBeat: 69,
    toBeat: 72,
    reads: [{ fromBeat: 69, toBeat: 72, what: 'the mark lands and the wordmark slams under it' }],
    framing: 'the Signal Red mark centred, large',
    camera: 'a log-space pull back, 1.12 to 1.0',
    event: 'the mark lands, squashes and settles as its arms uncurl; HushBox slams in under it on 70',
    seam: 'hard cut',
  },
  {
    id: 'tagline',
    fromBeat: 72,
    toBeat: 75,
    reads: [{ fromBeat: 72, toBeat: 75, what: 'One interface. Every feature. Private.' }],
    framing: 'the lockup at the top, the tagline stacking beneath it',
    camera: 'slow push with a drift',
    event: 'the tagline builds on the beat; the Devil\'s last ember drifts into the mark\'s dot on 74',
    seam: 'end',
  },
];

const TEXT: TextRow[] = [
  line('devil', 'ignite', 'THE DEVIL', [0, 3], STORY),
  line('loves', 'ignite', 'LOVES AI.', [1, 3], OPINION),
  line('why', 'grin', 'HERE’S WHY.', [4, 6], OPINION),
  line('keep-a', 'keep', 'THEY KEEP', [6, 9], OPINION),
  line('keep-b', 'keep', 'EVERYTHING.', [7, 9], OPINION),
  line('watch-a', 'watch', 'THEY WATCH', [12, 16], OPINION),
  line('watch-b', 'watch', 'WHAT YOU THINK.', [13, 16], OPINION),
  line('leak-a', 'leak', 'AND THEY LEAK', [16, 20], OPINION),
  line('leak-b', 'leak', 'IT ALL.', [18, 20], OPINION),
  line('secrets', 'escape', 'YOUR SECRETS', [24, 28], OPINION),
  line('out', 'escape', 'GET OUT.', [26, 28], OPINION),
  line('world-a', 'world', 'FOR THE WHOLE', [28, 32], OPINION),
  line('world-b', 'world', 'WORLD TO SEE.', [29, 32], OPINION),
  line('seen', 'exposed', 'SEEN.', [32, 36], OPINION),
  line('sold', 'exposed', 'SOLD.', [33, 36], OPINION),
  line('shared', 'exposed', 'SHARED.', [34, 36], OPINION),
  line('all-a', 'laugh', 'THEY ALL', [36, 40], OPINION),
  line('all-b', 'laugh', 'WORK FOR ME.', [37, 40], OPINION),
  line('but', 'one', 'ALL BUT', [40, 44], STORY),
  line('one', 'one', 'ONE.', [42, 44], STORY),
  line('enc-a', 'encrypted', 'ENCRYPTED', [44, 48], ENCRYPTED),
  line('enc-b', 'encrypted', 'BEFORE IT’S STORED.', [44, 48], ENCRYPTED),
  line('read-a', 'unreadable', 'THEY CAN’T READ', [51, 56], UNREADABLE),
  line('read-b', 'unreadable', 'YOUR STORED CHATS.', [51, 56], UNREADABLE),
  line('sale-a', 'not-for-sale', 'YOUR CHATS', [59, 63], NOT_SOLD),
  line('sale-b', 'not-for-sale', 'AREN’T FOR SALE.', [59, 63], NOT_SOLD),
  line('not', 'not-hushbox', 'NOT HUSHBOX.', [66, 69], STORY),
  line('wordmark', 'mark', 'HushBox', [70, 72], TAGLINE),
  line('lockup', 'tagline', 'HushBox', [72, 75], TAGLINE),
  line('tag-1', 'tagline', 'One interface.', [72, 75], TAGLINE),
  line('tag-2', 'tagline', 'Every feature.', [72.5, 75], TAGLINE),
  line('tag-3', 'tagline', 'Private.', [73, 75], TAGLINE),
];

/** Beats of the demons that swoop past the camera in the city, each with a shriek. */
export const SWOOP_BEATS = [28.5, 29.5, 30.5, 31.25] as const;

/** Beats the radar sweep stamps a thought FLAGGED, each with a stamp sound. */
export const STAMP_BEATS = [14, 14.5, 15, 15.5] as const;

const CUES: FilmSpecInput['cues'] = [
  { id: 'open', beat: 0, kind: 'impact', anchor: 'start' },
  { id: 'loves', beat: 1, kind: 'hit', anchor: 'start' },
  { id: 'grin', beat: 3, kind: 'whoosh', anchor: 'peak' },
  { id: 'keep', beat: 6, kind: 'hit', anchor: 'start' },
  { id: 'cackle', beat: 9, kind: 'hit', anchor: 'start' },
  { id: 'watch', beat: 12, kind: 'hit', anchor: 'start' },
  { id: 'leak', beat: 16, kind: 'hit', anchor: 'start' },
  { id: 'crack', beat: 17, kind: 'impact', anchor: 'start' },
  { id: 'burst', beat: 18, kind: 'impact', anchor: 'start' },
  { id: 'build', beat: 20, kind: 'hit', anchor: 'start' },
  { id: 'stutter', beat: 23, kind: 'stutter', anchor: 'start' },
  { id: 'inhale', beat: 23.5, kind: 'silence', anchor: 'start' },
  { id: 'drop', beat: 24, kind: 'impact', anchor: 'start' },
  { id: 'out', beat: 26, kind: 'hit', anchor: 'start' },
  { id: 'world', beat: 28, kind: 'whoosh', anchor: 'peak' },
  { id: 'seen', beat: 32, kind: 'hit', anchor: 'start' },
  { id: 'sold', beat: 33, kind: 'hit', anchor: 'start' },
  { id: 'shared', beat: 34, kind: 'hit', anchor: 'start' },
  { id: 'laugh', beat: 36, kind: 'impact', anchor: 'start' },
  { id: 'tape', beat: 39.5, kind: 'tick', anchor: 'start' },
  { id: 'hush', beat: 40, kind: 'silence', anchor: 'start' },
  { id: 'one', beat: 42, kind: 'impact', anchor: 'start' },
  { id: 'value-1', beat: 44, kind: 'impact', anchor: 'start' },
  { id: 'padlock', beat: 45, kind: 'tick', anchor: 'start' },
  { id: 'react-1', beat: 48, kind: 'hit', anchor: 'start' },
  { id: 'value-2', beat: 51, kind: 'impact', anchor: 'start' },
  { id: 'react-2', beat: 56, kind: 'hit', anchor: 'start' },
  { id: 'no-key', beat: 57, kind: 'tick', anchor: 'start' },
  { id: 'value-3', beat: 59, kind: 'impact', anchor: 'start' },
  { id: 'shatter', beat: 60, kind: 'impact', anchor: 'start' },
  { id: 'react-3', beat: 63, kind: 'hit', anchor: 'start' },
  { id: 'scream', beat: 66, kind: 'hit', anchor: 'start' },
  { id: 'final', beat: 69, kind: 'impact', anchor: 'start' },
  { id: 'wordmark', beat: 70, kind: 'tick', anchor: 'start' },
  { id: 'tag-1', beat: 72, kind: 'tick', anchor: 'start' },
  { id: 'tag-2', beat: 72.5, kind: 'tick', anchor: 'start' },
  { id: 'tag-3', beat: 73, kind: 'tick', anchor: 'start' },
  { id: 'last-ember', beat: 74, kind: 'tick', anchor: 'start' },
];

// ---------------------------------------------------------------- music

type Bars = Exclude<PatternOptions['steps'], string>;

/** A step pattern over `count` bars from `fromBeat`. */
function bars(fromBeat: number, count: number, steps: PatternOptions['steps'], params?: unknown): ScoreEvent[] {
  return pattern({ grid: GRID, bars: [0, count], steps, params, startBeat: fromBeat });
}

/** One event per beat listed. */
function at(beats: readonly number[], params?: unknown): ScoreEvent[] {
  return beats.map((beat) => ({ at: { beat }, params }));
}

/** A 16th-note roll from `from` to `to` beats, its parameter ramped by `rampOf(0..1)`. */
function roll(from: number, to: number, rampOf: (u: number) => unknown): ScoreEvent[] {
  const count = Math.round((to - from) * 4);
  return Array.from({ length: count }, (_, index) => ({
    at: { beat: from + index / 4 },
    params: rampOf(count === 1 ? 1 : index / (count - 1)),
  }));
}

const RIFF = { drawbars: '888600000', rotorHz: 6.7 };
const PRAISE_ORGAN: Bars = [
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
      { note: E1, beats: 1.5, glideFrom: E2, glide: 0.06, drive: 4.5 },
      { note: E1, beats: 1, drive: 4.5 },
      { note: E1, beats: 1, drive: 4.5 },
      { note: F1, beats: 0.5, drive: 4.5 },
    ],
  },
];
const STAB = { beats: 0.5, detune: 0.5 };
const DROP_STABS: Bars = [
  {
    steps: 'x..x..x...x.....',
    params: [
      { ...STAB, notes: [E3, G3, B3] },
      { ...STAB, notes: [E3, G3, B3] },
      { ...STAB, notes: [F3, A3, C4] },
      { ...STAB, notes: [E3, G3, B3] },
    ],
  },
];
const HATS_A: Bars = [{ steps: 'x.x.x.x.x.x.x.x.' }, { steps: 'x.x.x.x.x.x.xxxx' }];
const HATS_DROP: Bars = [{ steps: 'x.xxx.x.x.xxx.x.' }, { steps: 'x.xxx.x.x.x.xxxx' }];

/** Four bars of fear, each trembling more: the value section's pad. */
const FEAR_TREMOLO = [0.35, 0.6, 0.8, 0.95] as const;

const TRACKS = {
  kick: { instrument: 'kick', bus: 'drums', gainDb: -2 },
  // Act one's groove sits under the drop, so the drop lands louder than anything before it.
  kickLow: { instrument: 'kick', bus: 'drums', gainDb: -8 },
  bassLow: { instrument: 'sub808', bus: 'bass', gainDb: -12 },
  clapLow: { instrument: 'clap', bus: 'drums', gainDb: -14 },
  clap: { instrument: 'clap', bus: 'drums', gainDb: -8 },
  snare: { instrument: 'snare', bus: 'drums', gainDb: -6 },
  hat: { instrument: 'hat', bus: 'drums', gainDb: -18 },
  bass: { instrument: 'sub808', bus: 'bass', gainDb: -5 },
  organ: { instrument: 'organ', bus: 'keys', gainDb: -13 },
  stabs: { instrument: 'supersaw', bus: 'keys', gainDb: -12 },
  braam: { instrument: 'braam', bus: 'keys', gainDb: -7 },
  pad: { instrument: 'pad', bus: 'keys', gainDb: -12 },
  riser: { instrument: 'riser', bus: 'keys', gainDb: -12 },
  bell: { instrument: 'fmBell', bus: 'bell', gainDb: -10 },
  chord: { instrument: 'pad', bus: 'keys', gainDb: -6 },
  impact: { instrument: 'impact', bus: 'hits', gainDb: -1 },
  shatter: { instrument: 'glassShatter', bus: 'hits', gainDb: -10 },
  crack: { instrument: 'crack', bus: 'hits', gainDb: -8 },
  whoosh: { instrument: 'whoosh', bus: 'hits', gainDb: -9 },
  swell: { instrument: 'reverseSwell', bus: 'hits', gainDb: -10 },
  shriek: { instrument: 'shriek', bus: 'hits', gainDb: -15 },
  snap: { instrument: 'snap', bus: 'foley', gainDb: -12 },
  tick: { instrument: 'tick', bus: 'foley', gainDb: -16 },
  pop: { instrument: 'pop', bus: 'foley', gainDb: -14 },
  heartbeat: { instrument: 'heartbeat', bus: 'beds', gainDb: -5 },
  sub: { instrument: 'subPulse', bus: 'beds', gainDb: -6 },
  tom: { instrument: 'tom', bus: 'hits', gainDb: -6 },
} as const;

type TrackId = keyof typeof TRACKS;
type Part = Partial<Record<TrackId, ScoreEvent[]>>;

/** Act one: the Devil's groove under the praise, beats 0 to 20, with a slam on every line. */
const PRAISE: Part = {
  kickLow: bars(0, 5, 'x.....x...x.....', { drive: 2.5, endHz: 41 }),
  clapLow: bars(0, 5, '....x.......x...'),
  hat: bars(4, 4, HATS_A),
  bassLow: bars(0, 5, PRAISE_BASS),
  organ: bars(0, 5, PRAISE_ORGAN),
  impact: [
    { at: { cue: 'open' }, params: { decay: 2, drive: 3, metal: 0.6 } },
    { at: { cue: 'crack' }, params: { decay: 0.8, drive: 2, metal: 0.9 } },
    { at: { cue: 'burst' }, params: { decay: 1.6, drive: 3, metal: 0.4 } },
  ],
  snap: at([0, 1, 4, 6, 7, 12, 13, 16, 18]),
  whoosh: [{ at: { cue: 'grin' }, params: { seconds: 0.5, semitones: 6 } }],
  crack: [{ at: { cue: 'crack' }, params: { toneHz: 1400, decay: 0.3 } }],
  shatter: [{ at: { cue: 'burst' }, params: { decay: 1.2, shards: 90 } }],
  // One pop per FLAGGED stamp, on the frame it lands.
  pop: at(STAMP_BEATS, { fromHz: 400, octaves: 1.5, decay: 0.05 }),
  tick: at([9, 9.5, 10, 10.5, 11, 11.5]),
};

/** The build: kicks on every beat, a rising snare roll and riser, a stutter, then half a beat of silence. */
const BUILD: Part = {
  kickLow: bars(20, 1, 'x...x...x...x...', { drive: 3, endHz: 41 }),
  hat: bars(20, 1, 'xxxxxxxxxxxxxxxx'),
  snare: roll(21, 23.5, (u) => ({ toneHz: 170 + 260 * (u as number), decay: 0.12 })),
  bassLow: [{ at: { beat: 20 }, params: { note: E1, beats: 3.5, drive: 3 } }],
  riser: [{ at: { cue: 'inhale' }, anchor: 'end', params: { beats: 3.5, octaves: 3 } }],
  organ: [{ at: { beat: 20 }, params: { ...RIFF, notes: [E3, F3, B3], beats: 3.5 } }],
  swell: [{ at: { cue: 'drop' }, anchor: 'end', params: { beats: 0.5 } }],
  snap: at([20, 21, 22, 22.5, 23]),
};

/** The drop: beats 24 to 40, full groove, stabs, a shriek per swooping demon. */
const DROP: Part = {
  kick: bars(24, 4, 'x.....x...x...x.', { drive: 4.5, endHz: 41 }),
  snare: bars(24, 4, '........x.......', { toneHz: 175, decay: 0.4 }),
  clap: bars(24, 4, '........x.......'),
  hat: bars(24, 4, HATS_DROP),
  bass: bars(24, 4, DROP_BASS),
  stabs: bars(24, 4, DROP_STABS),
  braam: [
    { at: { cue: 'drop' }, params: { note: E1, beats: 4 } },
    { at: { cue: 'laugh' }, params: { note: E1, beats: 3.5 } },
  ],
  impact: [
    { at: { cue: 'drop' }, params: { decay: 3, drive: 4, metal: 0.8 } },
    { at: { cue: 'laugh' }, params: { decay: 2, drive: 3, metal: 0.6 } },
  ],
  shatter: [{ at: { cue: 'drop' }, params: { decay: 1.6, shards: 120 } }],
  shriek: SWOOP_BEATS.map((beat, index) => ({
    at: { beat },
    params: { toneHz: [1300, 1750, 1100, 2100][index], seconds: 0.7 },
  })),
  whoosh: [{ at: { cue: 'world' }, params: { seconds: 0.6, semitones: 7, direction: 'rightToLeft' } }],
  snap: at([26, 28, 29, 32, 33, 34, 37]),
  organ: [{ at: { cue: 'laugh' }, params: { drawbars: '888888000', rotorHz: 6.7, notes: [E3, G3, B3, E4], beats: 3.5 } }],
};

/** Silence, then the one: two heartbeats in the hush, and a red bell on beat 42. */
const ONE: Part = {
  heartbeat: at([40, 41]),
  sub: [{ at: { cue: 'hush' }, params: { toneHz: 38, decay: 1.2 } }],
  impact: [{ at: { cue: 'one' }, params: { decay: 2.5, drive: 2, subHz: 28, metal: 0.3 } }],
  bell: [{ at: { cue: 'one' }, params: { note: E5, decay: 3 } }],
  pad: [{ at: { cue: 'one' }, params: { notes: [E2, B2], beats: 2, attack: 0.05, release: 0.4, tremolo: 0.4, tremoloRate: 4 } }],
  snap: at([40]),
};

const VALUE_CUES = ['value-1', 'value-2', 'value-3'] as const;
const REACT_CUES = ['react-1', 'react-2', 'react-3'] as const;

/** Beats 44 to 64: three value hits, each answered by the Devil's flinch; the heartbeats speed up. */
const FEAR: Part = {
  kick: bars(44, 5, 'x.......x.x.....', { drive: 3.5, endHz: 41 }),
  snare: bars(44, 5, '........x.......', { toneHz: 165, decay: 0.45 }),
  hat: bars(44, 5, '..x...x...x...x.'),
  bass: bars(44, 5, [
    { steps: 'x.......x.x.....', params: [{ note: E1, beats: 2, drive: 3 }, { note: E1, beats: 0.5, drive: 3 }, { note: F1, beats: 1.5, drive: 3 }] },
  ]),
  impact: [
    ...VALUE_CUES.map((cue, index) => ({ at: { cue }, params: { decay: 2 + index * 0.5, drive: 3 + index, metal: 0.5 + index * 0.15 } })),
    { at: { cue: 'shatter' }, params: { decay: 1.2, drive: 3, metal: 0.9 } },
  ],
  braam: VALUE_CUES.map((cue) => ({ at: { cue }, params: { note: E1, beats: 3 } })),
  bell: VALUE_CUES.map((cue) => ({ at: { cue }, params: { note: B4, decay: 2 } })),
  // The Devil's flinches: a low tom thud and a sub on each reaction cut.
  tom: REACT_CUES.map((cue, index) => ({ at: { cue }, params: { toneHz: 70 - index * 8, decay: 0.8 } })),
  sub: REACT_CUES.map((cue) => ({ at: { cue }, params: { toneHz: 40, decay: 0.8 } })),
  pad: FEAR_TREMOLO.map((tremolo, index) => ({
    at: { beat: 44 + index * 5.5 },
    params: { notes: [E2, G2, B2], beats: 5.5, attack: 0.3, release: 0.1, tremolo, tremoloRate: 4 },
  })),
  heartbeat: [...at([48, 49.5, 51, 52.5, 54]), ...at([56, 57, 58, 59, 60, 61, 62]), ...at([63, 63.5, 64, 64.5, 65, 65.5])],
  pop: at([45], { fromHz: 520, octaves: 1, decay: 0.06 }),
  whoosh: [{ at: { cue: 'react-2' }, params: { seconds: 0.4, semitones: 5, direction: 'leftToRight' } }],
  tick: at([57], { toneHz: 2200, decay: 0.03 }),
  crack: at([59, 60], { toneHz: 900, decay: 0.25 }),
  shatter: [{ at: { cue: 'shatter' }, params: { decay: 1.2, shards: 90 } }],
  snap: at([44, 51, 59]),
};

/** Beats 64 to 69: kicks on every beat into the scream, a rising roll and riser into the mark. */
const SCREAM: Part = {
  kick: at([64, 65, 66, 67, 68], { drive: 4, endHz: 41 }),
  hat: at([64, 64.5, 65, 65.5, 66, 66.25, 66.5, 66.75, 67, 67.25, 67.5, 67.75, 68, 68.25, 68.5, 68.75]),
  snare: roll(67, 69, (u) => ({ toneHz: 180 + 280 * (u as number), decay: 0.1 })),
  shriek: [{ at: { cue: 'scream' }, params: { toneHz: 900, seconds: 1.4 } }],
  snap: at([66]),
  riser: [{ at: { cue: 'final' }, anchor: 'end', params: { beats: 3, octaves: 2 } }],
  bass: [{ at: { beat: 64 }, params: { note: E1, beats: 5, glideFrom: E2, glide: 1.2, drive: 4 } }],
};

/** The close: the mark lands on the E major chord, a bell on each of its reads. */
const CLOSE: Part = {
  impact: [{ at: { cue: 'final' }, params: { decay: 3, drive: 2.5, metal: 0.4 } }],
  chord: [{ at: { cue: 'final' }, params: { notes: [E3, G_SHARP_3, B3, E4], beats: 6, attack: 0.01, release: 2 } }],
  stabs: [{ at: { cue: 'final' }, params: { notes: [E3, G_SHARP_3, B3], beats: 1, detune: 0.4 } }],
  bell: [
    { at: { cue: 'final' }, params: { note: E5, decay: 4 } },
    { at: { cue: 'wordmark' }, params: { note: B4, decay: 3 } },
    { at: { cue: 'tag-1' }, params: { note: G_SHARP_4, decay: 2 } },
    { at: { cue: 'tag-2' }, params: { note: B4, decay: 2 } },
    { at: { cue: 'tag-3' }, params: { note: E5, decay: 3 } },
    { at: { cue: 'last-ember' }, params: { note: B4, decay: 3 } },
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
        effects: [
          { kind: 'stutter', cue: 'stutter', sliceBeats: 0.125, repeats: 4 },
          { kind: 'tapeStop', cue: 'tape', beats: 0.5 },
        ],
        sidechain: { cueKinds: ['impact'], depthDb: 3, releaseFrames: 12 },
      },
      {
        id: 'bass',
        role: 'music',
        effects: [{ kind: 'tapeStop', cue: 'tape', beats: 0.5 }],
        sidechain: { cueKinds: ['impact'], depthDb: 6, releaseFrames: 18 },
      },
      {
        id: 'keys',
        role: 'music',
        effects: [
          { kind: 'reverb', rt60: 2.2, damping: 6000, mix: 0.2 },
          { kind: 'tapeStop', cue: 'tape', beats: 0.5 },
        ],
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
    id: 'beat-cut-video',
    title: 'All But One: beat-cut video',
    seed: 'all-but-one/beat-cut-video',
    grid: GRID,
    beats: BEATS,
    shots: SHOTS,
    text: TEXT,
    cues: CUES,
  }),
  score: scoreOf([PRAISE, BUILD, DROP, ONE, FEAR, SCREAM, CLOSE]),
};
