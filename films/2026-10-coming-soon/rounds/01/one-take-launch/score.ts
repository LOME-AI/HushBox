import { pattern } from '../../../../engine/audio/score/index.js';
import { defineFilm } from '../../../../engine/film/spec.js';

import type { PatternOptions, ScoreEvent, ScoreInput } from '../../../../engine/audio/score/index.js';
import type { FilmDefinition, FilmSpecInput } from '../../../../engine/film/spec.js';
import type { Grid } from '../../../../engine/time/grid.js';

/** 120 BPM: 30 frames a beat, a half beat every 15 frames, 60 beats in 30 s. */
export const GRID: Grid = { framesPerBeat: 30, beatsPerBar: 4 };
const BEATS = 60;

/** The question she keeps deleting, and the one she sends. */
export const Q1 = 'is it crazy to quit my job';
export const Q2 = 'How do I open a cinema?';
/**
 * The attempt she deleted just before the film starts: its letters are still
 * falling into the pile on frame 0, too scattered to read. The O, P, E and N
 * she spells at dawn are its letters.
 */
export const RAIN = 'should i open a cinema';
/** Frames per typed character. */
/** COMING SOON's letters each fly this many frames from the moment they are thrown to their landing on the paper. */
export const PRINT_FLIGHT = 7;

/** The frame each printed letter lands: COMING a letter every two frames, SOON starting three letters in. */
export function printLand(index: number, sheet: number): number {
  return BEAT.coming * GRID.framesPerBeat + PRINT_FLIGHT + index * 2 + (sheet === 1 ? 6 : 0);
}

export const TYPE_FRAMES = 2;

/** Every beat the look stages on: the reads of the one continuous take, in order. */
export const BEAT = {
  /** The earlier attempt's letters land on the pile, a handful on each half beat from frame 0. */
  rain: [0, 0.5, 1, 1.5] as const,
  type: 1,
  hover: 3.5,
  withdraw: 4.5,
  /** Words leave the composer on the half beats, last first (the fourth and fifth pops take two words), and land a beat later. */
  pops: [5.5, 6, 6.5, 7, 7.5] as const,
  ask: 8,
  send: 11,
  reply: 12,
  run: 13.5,
  bars: [14, 14.5, 15, 15.5] as const,
  react: 15,
  seatsMorph: 16,
  /** Each bar lands as its row, deepest first. */
  rows: [16.5, 17, 17.5, 18] as const,
  stand: 18.5,
  /** The search card arrives and its chips lay the street, three handfuls; the road rolls out after the last. */
  search: 20,
  chips: [21, 21.5, 22] as const,
  road: 22.5,
  image: 23.5,
  denoise: [24, 24.5] as const,
  lift: 26,
  sign: 26.5,
  bulbs: 27,
  names: [28.5, 29.5, 30.5] as const,
  pick: 31.5,
  nameFly: 32,
  lit: 33,
  pages: [34, 34.5, 35, 35.5] as const,
  coming: 36,
  spiral: 37,
  note: 37.5,
  car: 40,
  dawn: 42,
  peels: [43, 43.5, 44, 44.5] as const,
  doors: 45,
  letters: [45.5, 46, 46.5, 47] as const,
  inhale: 47.5,
  open: 48,
  cheer: 50,
  fly: 51,
  screen: 53,
  wordmark: 54,
  tagline: 54.5,
} as const;

/** The names three models offer, one under another, a read each; she picks the third. */
export const NAMES = [
  { model: 'Claude Sonnet 5.5', name: 'The Lantern' },
  { model: 'GPT-5.5', name: 'Picture House' },
  { model: 'Gemini 3.1 Pro', name: 'The Small Hours' },
] as const;
export const PICKED = 2;

// D major. MIDI notes.
const D1 = 26;
const G1 = 31;
const A1 = 33;
const B1 = 35;
const D2 = 38;
const E2 = 40;
const F_SHARP_2 = 42;
const G2 = 43;
const A2 = 45;
const B2 = 47;
const C_SHARP_3 = 49;
const D3 = 50;
const E3 = 52;
const F_SHARP_3 = 54;
const G3 = 55;
const A3 = 57;
const B3 = 59;
const C_SHARP_4 = 61;
const D4 = 62;
const E4 = 64;
const F_SHARP_4 = 66;
const A4 = 69;
const B4 = 71;
const D5 = 74;
const E5 = 76;
const F_SHARP_5 = 78;
const A5 = 81;
const B5 = 83;

type Basis = NonNullable<FilmSpecInput['text'][number]['basis']>;
const STORY: Basis = {
  kind: 'brand',
  source: 'films/2026-10-coming-soon/brief.md, The idea: the question she keeps deleting becomes the cinema she opens',
};
const SEALED: Basis = {
  kind: 'fact',
  source:
    'packages/db/src/schema/content-items.ts:31 (stored content is ciphertext) and packages/crypto/src/account.ts:18-55 (only her key opens it): HushBox cannot read a stored conversation',
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
  shot('question', [0, 6], [[0, 1, 'letters rain from the composer into a pile beside her'], [1, 3.5, 'she types: is it crazy to quit my job'], [3.5, 5.5, 'she reaches for Send, and pulls back'], [5.5, 6, 'the last word lifts off the line']],
    'close and low on the pile, then her face lit by the phone and the composer above her',
    'rises from the pile to her face; in close on her face as she reaches for Send, out wide as she pulls back', 'the earlier attempt\u2019s last letters land on the pile; the composer empties and the question types itself; on 3.5 a touch point reaches for Send and she leans in; on 4.5 both pull back and her head drops', 'the last word lifts off the line'),
  shot('delete', [6, 8], [[6, 8, 'she deletes it word by word; the letters fall and pile up']],
    'the pile, close, the composer high', 'dives to the pile as the composer floats up with the room, then rises back', 'each word lifts off the line on its half beat, breaks into letters that stretch as they fall and squash as they land on the pile a beat later', 'she sits up and types again'),
  shot('ask', [8, 12], [[8, 10, 'she types: How do I open a cinema?'], [10, 11, 'she leans in'], [11, 12, 'she sends it']],
    'the composer over her', 'a small pull back, then a push in on Send', 'she straightens and types the new line; on 11 Send squashes and the line lifts into a bubble that rises', 'an answer arrives as a document'),
  shot('chart', [12, 16], [[12, 13.5, 'a document answers: code'], [13.5, 15, 'Run draws a chart, a bar a half beat'], [15, 16, 'she leans in, delighted']],
    'the reply card high; behind her the dark room deepens into a hall', 'pulls back from her to show the hall, then in close on her delight', 'the card springs in with an overshoot; the code holds; Run is pressed on 13.5; the code folds away and four bars grow; on 15 she leans in and smiles', 'the card flies to the back wall'),
  shot('seats', [16, 20], [[16, 16.5, 'the card becomes the screen'], [16.5, 18.5, 'each bar drops into the hall as a row of seats'], [18.5, 20, 'she stands to look at them']],
    'the hall behind her', 'out from her face as the rows land, up with her as she stands, then back through the glass', 'on 16 the card flies to the back wall and lands as the screen; the bars, left hanging, drop one per half beat, deepest first, each landing as a row that squashes and parts into seats; on 18.5 the question scrolls away and she dips and rises, her hair and hem following, a hand on her hip, and turns to look at the rows; from 19.25 the camera pulls back through the doors', 'the search card arrives'),
  shot('street', [20, 23], [[20, 23, 'a web search lays the street in front of her building']],
    'the doors and the dark facade, the search card high', 'settles back from the doors to the street', 'the search card grows in (20): Gemini 3.1 Pro, Searched the web \u00b7 12 sources, twelve chips; the chips fall four to a half beat (21, 21.5, 22) and slam down as paving slabs while she points down at them; the road rolls out after them (22.5)', 'an image card arrives'),
  shot('sign', [23, 28], [[23.5, 26, 'an image model draws a sign'], [26, 28, 'the sign goes up on the facade']],
    'the facade, the image card over the doors', 'tilts up to the top of the facade', 'the image card grows in (23.5), Seedream 5.0, and resolves from coarse blocks (23.5, 24, 24.5), clean from 24.75 and held; on 26 it lifts and slams onto the facade as the marquee on 26.5, squashing onto its fixings, its bulbs flaring; on 27 the bulbs start their chase; she shades her eyes and looks up', 'the name cards arrive'),
  shot('name', [28, 34], [[28.5, 31.5, 'three models offer names, one at a time'], [31.5, 32, 'she taps her pick'], [32, 34, 'the name flies to the sign and lights']],
    'the reply cards high, her behind the glass below them; then her face, close', 'a slow push on the doors, in close on her face for the tap, then up to the sign', 'three cards slide in a beat apart, each landing past its place and springing back as she scrolls with her free hand: Claude Sonnet 5.5 The Lantern (28.5), GPT-5.5 Picture House (29.5), Gemini 3.1 Pro The Small Hours (30.5); from 31 the camera is close on her face; on 31.5 she taps, the third card is checked and the others slide away; its letters jump off the card and fly onto the sign (32) and light on 33; she hugs the phone to her chest', 'her phone sends the conversation to the doors'),
  shot('papered', [34, 36], [[34, 36, 'night: the conversation papers the glass doors from inside, a page a half beat, each turning to face her']],
    'the whole cinema at night, the doors lit from inside', 'a push in on the doors', 'four pages fly from her phone, each showing a reply, and turn round as they land on the glass so the writing faces her; from the street they are blank paper; her free hand rests on her hip', 'the paper is printed'),
  shot('coming-soon', [36, 42], [[36, 37, 'COMING SOON on the blank paper'], [37, 37.5, 'a small Signal Red spiral'], [37.5, 42, 'a note taped above it: Not even we can read it.']],
    'the papered doors, close', 'a push in on the note from 38.5 until it fills the frame', 'COMING and SOON are thrown at the paper letter by letter: each comes in big from above, slams flat on its frame and springs back to shape; the spiral swirls together from its arcs; the note is slapped on, flattens and springs back, and its tape snaps; the paper\u2019s light breathes on each beat; on 40 a passing car throws the door frames\u2019 shadows across the paper', 'sunlight strikes the paper'),
  shot('dawn', [42, 48], [[42, 43, 'dawn strikes the paper'], [43, 45, 'she peels the paper down'], [45, 46.5, 'she sends O, P and E from the pile onto the letter board'], [46.5, 48, 'the N slams onto the board, filling the frame']],
    'the doors, the letter board and the foot of the sign at dawn; then the N, filling the frame', 'pulls back from the note to the doorway and the board; dives onto the last letter; pulls back out through the silence', 'a bar of dawn sunlight snaps onto the paper on 42; the four sheets peel down on the half beats, showing her inside; on 45 the doors swing out; for each of O, P, E, N she winds her arm back low, releases high towards the board and follows through across her body, and the letter leaves the pile, flips to a capital and bounces onto the board on its half beat; the camera dives onto the N as it lands, until it fills the frame, then pulls back out through the silence', 'the board lights'),
  shot('open', [48, 51], [[48, 50, 'OPEN'], [50, 51, 'she cheers']],
    'the whole cinema in the morning light, she in the doorway; then her, close', 'out from the last letter to the whole lit cinema, then in through the doorway to her face', 'the board and the sign light together on 48; on 50 she cheers, close: a hop, one arm punching high, the other pumping a beat later', 'the camera flies past her into the hall'),
  shot('screen', [51, 54], [[51, 53, 'the camera flies past her, over the seats, to the screen'], [53, 54, 'the screen shows the Signal Red mark and fills the frame']],
    'the hall rushing past', 'a flight down the hall, zoom in log space', 'the screen irises open to charcoal from its centre as the camera passes the doors, the dot of the mark at its centre; the rows rush below; the arcs swirl in round the dot; on 53 the screen fills the frame', 'the screen is the end card'),
  shot('card', [54, 60], [[54, 54.5, 'HushBox'], [54.5, 60, 'One interface. Every feature. Private.']],
    'warm charcoal, the mark, the wordmark under it, the tagline under that', 'near still: the camera settles; the mark breathes', 'the wordmark drops in letter by letter with an overshoot on 54; the tagline\u2019s lines rise into place one after another from 54.5, each overshooting; the mark breathes slowly to the end', 'end'),
];

const TEXT: TextRow[] = [
  line('q1', 'question', Q1, [1, 5.5], STORY, 'support'),
  line('q2', 'ask', Q2, [8, 12], STORY, 'support'),
  line('coming', 'coming-soon', 'COMING', [36, 38.5], STORY, 'support'),
  line('soon', 'coming-soon', 'SOON', [36, 38.5], STORY, 'support'),
  line('note', 'coming-soon', 'Not even we can read it.', [37.5, 42], SEALED, 'support'),
  line('open', 'open', 'OPEN', [48, 50], STORY),
  line('wordmark', 'card', 'HushBox', [54, 60], TAGLINE),
  line('tag-1', 'card', 'One interface.', [54.5, 60], TAGLINE),
  line('tag-2', 'card', 'Every feature.', [54.5, 60], TAGLINE),
  line('tag-3', 'card', 'Private.', [54.5, 60], TAGLINE),
];

type Cue = FilmSpecInput['cues'][number];
const cue = (id: string, beat: number, kind: Cue['kind'], anchor: Cue['anchor'] = 'start'): Cue => ({ id, beat, kind, anchor });

const indexed = (prefix: string, beats: readonly number[], kind: Cue['kind']): Cue[] =>
  beats.map((beat, index) => cue(`${prefix}-${String(index + 1)}`, beat, kind));

const CUES: FilmSpecInput['cues'] = [
  ...indexed('rain', BEAT.rain, 'hit'),
  cue('type', BEAT.type, 'tick'),
  cue('hover', BEAT.hover, 'tick'),
  cue('withdraw', BEAT.withdraw, 'tick'),
  ...indexed('pop', BEAT.pops, 'tick'),
  ...indexed('land', BEAT.pops.map((beat) => beat + 1), 'hit'),
  cue('ask', BEAT.ask, 'tick'),
  cue('send', BEAT.send, 'impact'),
  cue('reply', BEAT.reply, 'hit'),
  cue('run', BEAT.run, 'tick'),
  ...indexed('bar', BEAT.bars, 'tick'),
  cue('seats-morph', BEAT.seatsMorph, 'whoosh'),
  ...indexed('row', BEAT.rows, 'hit'),
  cue('search', BEAT.search, 'hit'),
  ...indexed('chips', BEAT.chips, 'hit'),
  cue('road', BEAT.road, 'tick'),
  cue('image', BEAT.image, 'hit'),
  ...indexed('denoise', BEAT.denoise, 'tick'),
  cue('lift', BEAT.lift, 'whoosh'),
  cue('sign', BEAT.sign, 'impact'),
  cue('bulbs', BEAT.bulbs, 'hit'),
  ...indexed('name', BEAT.names, 'hit'),
  cue('pick', BEAT.pick, 'hit'),
  cue('name-fly', BEAT.nameFly, 'whoosh'),
  cue('lit', BEAT.lit, 'impact'),
  ...indexed('page', BEAT.pages, 'hit'),
  cue('coming', BEAT.coming, 'impact'),
  cue('spiral', BEAT.spiral, 'hit'),
  cue('note', BEAT.note, 'hit'),
  cue('car', BEAT.car, 'whoosh', 'peak'),
  cue('dawn', BEAT.dawn, 'hit'),
  ...indexed('peel', BEAT.peels, 'whoosh'),
  cue('doors', BEAT.doors, 'whoosh'),
  ...indexed('letter', BEAT.letters, 'hit'),
  cue('inhale', BEAT.inhale, 'silence'),
  cue('open', BEAT.open, 'impact'),
  cue('cheer', BEAT.cheer, 'hit'),
  cue('fly', BEAT.fly, 'whoosh'),
  cue('screen', BEAT.screen, 'impact'),
  cue('wordmark', BEAT.wordmark, 'tick'),
  cue('tagline', BEAT.tagline, 'tick'),
];

// ---------------------------------------------------------------- music

type Bars = Exclude<PatternOptions['steps'], string>;

function bars(fromBeat: number, count: number, steps: PatternOptions['steps'], params?: unknown): ScoreEvent[] {
  return pattern({ grid: GRID, bars: [0, count], steps, params, startBeat: fromBeat });
}

function at(beats: readonly number[], params?: unknown): ScoreEvent[] {
  return beats.map((beat) => ({ at: { beat }, params }));
}

/** One key strike per typed character, from `fromFrame`, skipping strikes before frame 0. */
function typing(fromFrame: number, count: number, lead = 0): ScoreEvent[] {
  return Array.from({ length: count - lead }, (_, index) => ({
    at: { frame: fromFrame + index * TYPE_FRAMES },
    params: { toneHz: 2800 + ((index * 7) % 5) * 180, decay: 0.012 },
  }));
}

const TRACKS = {
  kick: { instrument: 'kick', bus: 'drums', gainDb: -7 },
  kickSoft: { instrument: 'kick', bus: 'drums', gainDb: -14 },
  clap: { instrument: 'clap', bus: 'drums', gainDb: -10 },
  snap: { instrument: 'snap', bus: 'drums', gainDb: -12 },
  hat: { instrument: 'hat', bus: 'drums', gainDb: -20 },
  bass: { instrument: 'sub808', bus: 'bass', gainDb: -12 },
  pad: { instrument: 'pad', bus: 'keys', gainDb: -11 },
  chord: { instrument: 'pad', bus: 'keys', gainDb: -9 },
  stab: { instrument: 'supersaw', bus: 'keys', gainDb: -16 },
  bell: { instrument: 'fmBell', bus: 'bell', gainDb: -10 },
  chime: { instrument: 'fmBell', bus: 'bell', gainDb: -6 },
  keys: { instrument: 'tick', bus: 'foley', gainDb: -22 },
  tick: { instrument: 'tick', bus: 'foley', gainDb: -17 },
  pop: { instrument: 'pop', bus: 'foley', gainDb: -13 },
  clack: { instrument: 'snap', bus: 'foley', gainDb: -11 },
  thud: { instrument: 'tom', bus: 'foley', gainDb: -14 },
  room: { instrument: 'roomTone', bus: 'beds', gainDb: -30 },
  riser: { instrument: 'riser', bus: 'hits', gainDb: -16 },
  swell: { instrument: 'reverseSwell', bus: 'hits', gainDb: -14 },
  whoosh: { instrument: 'whoosh', bus: 'hits', gainDb: -15 },
  impact: { instrument: 'impact', bus: 'hits', gainDb: -8 },
  sub: { instrument: 'subPulse', bus: 'hits', gainDb: -10 },
  snuff: { instrument: 'snuff', bus: 'foley', gainDb: -16 },
} as const;

type TrackId = keyof typeof TRACKS;
type Part = Partial<Record<TrackId, ScoreEvent[]>>;

const PAD = { attack: 0.05, release: 0.6 };

/** Beats 0-11: night. Letters landing on a falling line from frame 0, a key per typed character, a bell each time she hesitates, a pitched fall for each word deleted, a riser into Send. */
const NIGHT: Part = {
  room: [{ at: { frame: 0 }, params: { beats: 60, cutoff: 300 } }],
  pad: [
    { at: { frame: 0 }, params: { ...PAD, notes: [D3, F_SHARP_3, A3, E4], beats: 5.5 } },
    { at: { beat: 5.5 }, params: { ...PAD, notes: [B2, D3, F_SHARP_3, C_SHARP_4], beats: 2.5 } },
    { at: { beat: 8 }, params: { ...PAD, notes: [G2, B2, D3, F_SHARP_3], beats: 4 } },
  ],
  keys: [...typing(BEAT.type * GRID.framesPerBeat, Q1.length), ...typing(BEAT.ask * GRID.framesPerBeat, Q2.length)],
  sub: [{ at: { frame: 0 }, params: { toneHz: 44, decay: 1.2 } }],
  bell: [
    // The earlier attempt's letters land on a falling line, the first on frame 0.
    ...[A5, F_SHARP_5, E5, D5].map((note, index) => ({ at: { cue: `rain-${String(index + 1)}` }, params: { note, decay: 1.4 } })),
    { at: { cue: 'hover' }, params: { note: B4, decay: 2 } },
    { at: { cue: 'withdraw' }, params: { note: A4, decay: 2 } },
    // The deleted words land on a falling line.
    ...[F_SHARP_5, E5, D5, B4, A4].map((note, index) => ({ at: { cue: `land-${String(index + 1)}` }, params: { note, decay: 1.6 } })),
    { at: { cue: 'ask' }, params: { note: D5, decay: 2 } },
  ],
  pop: BEAT.pops.map((beat, index) => ({ at: { beat }, params: { fromHz: 300 + index * 50, octaves: 1.2, decay: 0.05 } })),
  thud: [
    ...BEAT.rain.map((_, index) => ({ at: { cue: `rain-${String(index + 1)}` }, params: { toneHz: 150, decay: 0.12 } })),
    ...BEAT.pops.map((_, index) => ({ at: { cue: `land-${String(index + 1)}` }, params: { toneHz: 140, decay: 0.15 } })),
  ],
  riser: [{ at: { cue: 'send' }, anchor: 'end', params: { beats: 2.5, octaves: 2 } }],
};

const BASS_BAR = (note: number): Bars => [
  { steps: 'x.....x...x.....', params: [{ note, beats: 1.4, drive: 2 }, { note, beats: 0.9, drive: 2 }, { note: note + 12, beats: 1.4, drive: 2 }] },
];

/** The chords of the build, a bar each from beat 12: D, Bm, G, A, D. */
const BUILD_CHORDS = [
  [D3, F_SHARP_3, A3, E4],
  [B2, D3, F_SHARP_3, A3],
  [G2, B2, D3, F_SHARP_3],
  [A2, C_SHARP_3, E3, A3],
  [D3, F_SHARP_3, A3, C_SHARP_4],
] as const;
const BUILD_ROOTS = [D2, B1, G1, A1, D2] as const;

/** Beats 11-33: the build. Send is the downbeat's pickup; four on the floor from 12, claps on two and four, a sub line, and a pitched hit for every piece of the cinema. */
const BUILD: Part = {
  kick: [...BUILD_ROOTS.flatMap((_, bar) => bars(12 + bar * 4, 1, 'x...x...x...x...', { drive: 2.5, endHz: 50, decay: 0.5 })), ...at([32], { drive: 2.5, endHz: 50, decay: 0.5 })],
  clap: BUILD_ROOTS.flatMap((_, bar) => bars(12 + bar * 4, 1, '....x.......x...')),
  hat: BUILD_ROOTS.flatMap((_, bar) => bars(12 + bar * 4, 1, '..x...x...x...x.')),
  bass: BUILD_ROOTS.flatMap((root, bar) => bars(12 + bar * 4, 1, BASS_BAR(root))),
  pad: BUILD_CHORDS.map((notes, bar) => ({ at: { beat: 12 + bar * 4 }, params: { ...PAD, notes: [...notes], beats: bar === 4 ? 5 : 4 } })),
  impact: [
    { at: { cue: 'send' }, params: { decay: 1.2, drive: 1.5, subHz: 38, metal: 0.15 } },
    { at: { cue: 'sign' }, params: { decay: 1.2, drive: 2, subHz: 36, metal: 0.4 } },
    { at: { cue: 'lit' }, params: { decay: 1.6, drive: 2, subHz: 36, metal: 0.3 } },
  ],
  whoosh: [
    { at: { cue: 'send' }, params: { seconds: 0.5, semitones: 5, direction: 'leftToRight' } },
    { at: { cue: 'seats-morph' }, params: { seconds: 0.5, semitones: 4, direction: 'rightToLeft' } },
    { at: { cue: 'lift' }, params: { seconds: 0.45, semitones: 6, direction: 'leftToRight' } },
    { at: { cue: 'name-fly' }, params: { seconds: 0.45, semitones: 6, direction: 'rightToLeft' } },
  ],
  chime: [
    { at: { cue: 'send' }, params: { note: A5, decay: 2.5 } },
    { at: { cue: 'lit' }, params: { note: D5, decay: 3 } },
  ],
  pop: [
    ...at([BEAT.reply, BEAT.search, BEAT.image], { fromHz: 420, octaves: 1.5, decay: 0.06 }),
    ...BEAT.names.map((beat, index) => ({ at: { beat }, params: { fromHz: 380 + index * 90, octaves: 1.4, decay: 0.05 } })),
  ],
  tick: [
    { at: { cue: 'run' }, params: { toneHz: 3600, decay: 0.02 } },
    ...BEAT.chips.map((beat, index) => ({ at: { beat }, params: { toneHz: 2400 + index * 300, decay: 0.03 } })),
    ...BEAT.denoise.map((beat, index) => ({ at: { beat }, params: { toneHz: 4200 + index * 500, decay: 0.025 } })),
    { at: { cue: 'road' }, params: { toneHz: 1800, decay: 0.04 } },
    { at: { cue: 'pick' }, params: { toneHz: 3000, decay: 0.03 } },
  ],
  bell: [
    // One rising note per bar of the chart.
    ...[D5, E5, F_SHARP_5, A5].map((note, index) => ({ at: { cue: `bar-${String(index + 1)}` }, params: { note, decay: 1.4 } })),
    // The bulbs chase on a quick arpeggio.
    ...[D5, F_SHARP_5, A5].map((note, index) => ({ at: { frame: BEAT.bulbs * GRID.framesPerBeat + index * 5 }, params: { note, decay: 1.2 } })),
    ...[D5, E5, F_SHARP_5].map((note, index) => ({ at: { cue: `name-${String(index + 1)}` }, params: { note, decay: 1.2 } })),
    { at: { cue: 'pick' }, params: { note: A5, decay: 1.6 } },
  ],
  thud: [
    // Each row lands with its own thud, lower as the rows come nearer.
    ...BEAT.rows.map((beat, index) => ({ at: { beat }, params: { toneHz: 120 - index * 12, decay: 0.35 } })),
    ...BEAT.chips.map((beat) => ({ at: { beat }, params: { toneHz: 120, decay: 0.2 } })),
  ],
  clack: [
    ...BEAT.rows.map((beat) => ({ at: { beat }, params: { toneHz: 1700, decay: 0.05 } })),
    // The sign's fixings bite as it lands.
    { at: { cue: 'sign' }, params: { toneHz: 1200, decay: 0.09 } },
  ],
  stab: [{ at: { cue: 'lit' }, params: { notes: [D4, F_SHARP_4, A4], beats: 1, detune: 0.3 } }],
};

/** Beats 33-48: night and dawn. A soft kick under the paper's breathing light, a paper slap per page, a stamp, HushBox's chime on the spiral, the car, dawn's swell, the peel, the letters, and a breath of silence. */
const PAPER: Part = {
  kickSoft: [...at([33, 34, 35, 36, 37, 38, 39, 40, 41], { drive: 1.5, endHz: 48, decay: 0.6 }), ...at([42, 43, 44, 45, 46, 47], { drive: 2, endHz: 50, decay: 0.5 })],
  hat: [...bars(36, 1, '..x...x...x...x.'), ...bars(44, 1, '..x...x...x.x.x.')],
  pad: [
    { at: { beat: 33 }, params: { ...PAD, notes: [B2, D3, F_SHARP_3, A3], beats: 2 } },
    { at: { beat: 35 }, params: { ...PAD, notes: [G2, B2, D3, F_SHARP_3], beats: 4 } },
    { at: { beat: 39 }, params: { ...PAD, notes: [F_SHARP_2, A2, D3, A3], beats: 3 } },
    { at: { beat: 42 }, params: { ...PAD, notes: [G2, B2, D3, E4], beats: 3, attack: 0.3 } },
    { at: { beat: 45 }, params: { ...PAD, notes: [A2, C_SHARP_3, E3, B3], beats: 2.5 } },
  ],
  bass: [
    { at: { beat: 33 }, params: { note: B1 + 12, beats: 1.8, drive: 1.5, decay: 4 } },
    { at: { beat: 35 }, params: { note: G1 + 12, beats: 3.8, drive: 1.5, decay: 4 } },
    { at: { beat: 39 }, params: { note: F_SHARP_2, beats: 2.8, drive: 1.5, decay: 4 } },
    { at: { beat: 42 }, params: { note: G1 + 12, beats: 2.8, drive: 1.5, decay: 4 } },
    { at: { beat: 45 }, params: { note: A1 + 12, beats: 2.4, drive: 2, decay: 4 } },
  ],
  clack: [
    ...BEAT.pages.map((beat) => ({ at: { beat }, params: { toneHz: 1500, decay: 0.08 } })),
    { at: { cue: 'note' }, params: { toneHz: 1300, decay: 0.1 } },
    { at: { beat: BEAT.note + 0.5 }, params: { toneHz: 2600, decay: 0.05 } },
    ...BEAT.letters.map((beat) => ({ at: { beat }, params: { toneHz: 2300, decay: 0.07 } })),
    // Each sheet's tape lets go as it peels.
    ...BEAT.peels.map((beat) => ({ at: { beat }, params: { toneHz: 3200, decay: 0.04 } })),
    // Each printed letter slaps the paper as it lands.
    ...[0, 1, 2, 3, 4, 5].map((index) => ({ at: { frame: printLand(index, 0) }, params: { toneHz: 1700, decay: 0.05 } })),
    ...[0, 1, 2, 3].map((index) => ({ at: { frame: printLand(index, 1) }, params: { toneHz: 1500, decay: 0.05 } })),
  ],
  thud: [
    ...BEAT.pages.map((beat) => ({ at: { beat }, params: { toneHz: 110, decay: 0.25 } })),
    { at: { cue: 'coming' }, params: { toneHz: 80, decay: 0.5 } },
  ],
  whoosh: [
    ...BEAT.pages.map((beat, index) => ({ at: { beat }, anchor: 'end' as const, params: { seconds: 0.35, semitones: 3, direction: index % 2 === 0 ? 'leftToRight' : 'rightToLeft' } })),
    { at: { cue: 'car' }, anchor: 'peak' as const, params: { seconds: 1.2, semitones: 5, direction: 'leftToRight' } },
    ...BEAT.peels.map((beat, index) => ({ at: { beat }, params: { seconds: 0.35, semitones: 2, direction: index % 2 === 0 ? 'leftToRight' : 'rightToLeft' } })),
    { at: { cue: 'doors' }, params: { seconds: 0.6, semitones: 3, direction: 'leftToRight' } },
  ],
  impact: [{ at: { cue: 'coming' }, params: { decay: 1.2, drive: 1.5, subHz: 34, metal: 0.2 } }],
  // HushBox's chime: a rising fifth, on the spiral.
  chime: [
    { at: { cue: 'spiral' }, params: { note: D5, decay: 3 } },
    { at: { frame: BEAT.spiral * GRID.framesPerBeat + 8 }, params: { note: A5, decay: 3.5 } },
    // Dawn strikes the paper.
    { at: { cue: 'dawn' }, params: { note: F_SHARP_5, decay: 3 } },
  ],
  sub: [{ at: { cue: 'spiral' }, params: { toneHz: 40, decay: 1.5 } }],
  swell: [
    { at: { cue: 'dawn' }, anchor: 'end', params: { beats: 1 } },
    { at: { cue: 'open' }, anchor: 'end', params: { beats: 1 } },
  ],
  bell: [
    // O, P, E, N on a rising line.
    ...[D5, F_SHARP_5, A5, B5].map((note, index) => ({ at: { cue: `letter-${String(index + 1)}` }, params: { note, decay: 1.6 } })),
  ],
  riser: [{ at: { cue: 'inhale' }, anchor: 'end', params: { beats: 2.5, octaves: 2 } }],
};

/** Beats 48-60: OPEN on the full groove, the flight down the hall into a riser, the mark, and the chord ringing under the card. */
const OPEN: Part = {
  kick: [...bars(48, 1, 'x...x...x...x...', { drive: 3, endHz: 50, decay: 0.5 }), ...at([52, 52.5], { drive: 3, endHz: 50, decay: 0.5 })],
  clap: [...bars(48, 1, '....x.......x...'), ...at([BEAT.fly])],
  hat: bars(48, 1, '..x...x...x...x.'),
  bass: [
    { at: { cue: 'open' }, params: { note: D2, beats: 1.5, glideFrom: A2, glide: 0.08, drive: 3 } },
    { at: { beat: 49.5 }, params: { note: D2, beats: 1, drive: 3 } },
    { at: { beat: 50.5 }, params: { note: A1 + 12, beats: 0.5, drive: 3 } },
    { at: { cue: 'fly' }, params: { note: D2, beats: 2, glideFrom: D1 + 12, glide: 0.5, drive: 2 } },
    { at: { cue: 'screen' }, params: { note: D2, beats: 3, drive: 2, decay: 3 } },
  ],
  chord: [
    { at: { cue: 'open' }, params: { notes: [D3, F_SHARP_3, A3, D4, F_SHARP_4], beats: 3, attack: 0.01, release: 0.4 } },
    { at: { cue: 'screen' }, params: { notes: [D3, A3, D4, E4, F_SHARP_4], beats: 7, attack: 0.01, release: 3 } },
  ],
  stab: [
    { at: { cue: 'open' }, params: { notes: [D4, F_SHARP_4, A4, D5], beats: 1, detune: 0.35 } },
    { at: { cue: 'cheer' }, params: { notes: [D4, F_SHARP_4, A4], beats: 0.5, detune: 0.35 } },
  ],
  impact: [
    { at: { cue: 'open' }, params: { decay: 2, drive: 2, subHz: 36, metal: 0.3 } },
    { at: { cue: 'screen' }, params: { decay: 2.5, drive: 2, subHz: 32, metal: 0.25 } },
  ],
  sub: [{ at: { cue: 'screen' }, params: { toneHz: 42, decay: 2 } }],
  chime: [
    { at: { cue: 'open' }, params: { note: D5, decay: 3 } },
    { at: { cue: 'screen' }, params: { note: D5, decay: 4 } },
    { at: { frame: BEAT.screen * GRID.framesPerBeat + 8 }, params: { note: A5, decay: 4 } },
    { at: { cue: 'wordmark' }, params: { note: F_SHARP_5, decay: 3 } },
    { at: { cue: 'tagline' }, params: { note: E5, decay: 3.5 } },
  ],
  whoosh: [{ at: { cue: 'fly' }, params: { seconds: 1.2, semitones: 7, direction: 'leftToRight' } }],
  riser: [{ at: { cue: 'screen' }, anchor: 'end', params: { beats: 2, octaves: 2 } }],
  swell: [{ at: { cue: 'screen' }, anchor: 'end', params: { beats: 0.75 } }],
  bell: [{ at: { cue: 'cheer' }, params: { note: A5, decay: 1.5 } }],
};

void E2;
void G3;
void B3;

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
      { id: 'drums', role: 'music', effects: [{ kind: 'reverb', rt60: 0.6, damping: 7000, mix: 0.08 }], sidechain: { cueKinds: ['impact'], depthDb: 3, releaseFrames: 12 } },
      { id: 'bass', role: 'music', effects: [], sidechain: { cueKinds: ['impact'], depthDb: 4, releaseFrames: 18 } },
      {
        id: 'keys',
        role: 'music',
        effects: [{ kind: 'reverb', rt60: 2.4, damping: 6000, mix: 0.28 }],
        sidechain: { cueKinds: ['impact'], depthDb: 4, releaseFrames: 20 },
      },
      { id: 'bell', role: 'music', effects: [{ kind: 'reverb', rt60: 2.8, damping: 8000, mix: 0.32 }] },
      { id: 'hits', role: 'sfx', effects: [] },
      { id: 'foley', role: 'sfx', effects: [{ kind: 'reverb', rt60: 0.7, damping: 6000, mix: 0.12 }] },
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
    id: 'one-take-launch',
    title: 'Coming Soon: one-take launch',
    seed: 'coming-soon/one-take-launch',
    grid: GRID,
    beats: BEATS,
    shots: SHOTS,
    text: TEXT,
    cues: CUES,
  }),
  score: scoreOf([NIGHT, BUILD, PAPER, OPEN]),
};
