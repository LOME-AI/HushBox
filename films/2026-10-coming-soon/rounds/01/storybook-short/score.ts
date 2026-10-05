import { defineFilm } from '../../../../engine/film/spec.js';

import type { ScoreEvent, ScoreInput } from '../../../../engine/audio/score/index.js';
import type { FilmDefinition, FilmSpecInput } from '../../../../engine/film/spec.js';
import type { Grid } from '../../../../engine/time/grid.js';

/** 100 BPM: 36 frames a beat, a half beat every 18 frames, 52 beats in 31.2 s. */
export const GRID: Grid = { framesPerBeat: 36, beatsPerBar: 4 };
export const FPB = 36;
const BEATS = 52;

/** Beat to frame, for the beats this take uses (every one lands on a whole frame). */
export function bf(beat: number): number {
  return Math.round(beat * FPB);
}


// ---------------------------------------------------------------- the story's timing, shared with the look

/** The question she types, deletes, types again and finally sends. */
export const QUESTION = 'Is it crazy to quit my job to open a cinema?';
/** The brief's own line: the head of the question, still whole on screen while its tail is deleted. */
export const DOUBT = 'Is it crazy to quit my job';

/** Frames from a deleted letter's pop to its landing on the pile. */
export const FALL_FRAMES = 24;

/**
 * The frame each character of the question is deleted, by its index. The held
 * backspace is already at work before the film: the tail (" to open a
 * cinema?") goes a letter every eight frames, so a letter lands on the pile on
 * frame 0 and the brief's line stays whole to frame 117; then the held key
 * races through the rest, a letter a frame.
 */
export const DELETE_AT: readonly number[] = [...QUESTION].map((_, k) => {
  const j = QUESTION.length - 1 - k;
  const tail = QUESTION.length - DOUBT.length;
  return j < tail ? -24 + j * 8 : 118 + (j - tail);
});

/** The letters that fall, in the order they were deleted (a space leaves none). */
export const FALLEN = [...QUESTION]
  .map((char, index) => ({ char, index }))
  .filter(({ char }) => char !== ' ')
  .reverse();

/** Each fallen letter's landing on the pile. */
export const LAND_AT: readonly number[] = FALLEN.map(({ index }) => (DELETE_AT[index] ?? 0) + FALL_FRAMES);

/** Letters already on the pile at frame 0, from the times she deleted it before. */
export const EARLIER = 'ISITCRAZYTOQUITMYJOBISITCRAZYQ';

/** The send shot opens on her finishing the question again: the last six characters, two frames apart. */
export const TYPE_AT: readonly number[] = [...QUESTION].map((_, k) => (k < 38 ? bf(8) - 1 : bf(8) + (k - 37) * 2));
export const SEND = bf(11.5);

/** Beats the chart's bars rise, each leaving its place on the screen, and the rows landing, one at a time. */
export const BAR_BEATS = [12.5, 13, 13.5, 14] as const;
export const ROW_BEATS = [14.5, 14.75, 15, 15.25] as const;
/** The search answer lands, its sources fan, and they lift off the screen. */
export const SEARCH = bf(16);
export const FAN = bf(18);
export const LIFT = bf(19.25);
/** Beats each source lands as a paving slab, a quarter beat apart. */
export const SLAB_BEATS = [20.25, 20.5, 20.75, 21, 21.25, 21.5] as const;
export const LAMP = bf(22);
/** The image answer rises from her phone in the street and is held across the cut; it morphs into the marquee, which lands. */
export const IMAGE = bf(22.5);
export const MORPH = bf(25);
export const SIGN = bf(25.5);
/** A beat after the sign, the four names rise one by one. */
export const NAME_BEATS = [26.5, 26.75, 27, 27.25] as const;
export const NAMES = bf(26.5);
export const PICK = bf(28);
export const LANTERN = bf(28.5);
/** Beats each page of the conversation pastes onto the glass. */
export const PAGE_BEATS = [29.5, 30, 30.5, 31, 31.5, 32] as const;
export const SMOOTH = bf(32.5);
export const WRITE_FROM = bf(33.25);
export const WRITTEN = bf(34);
export const SPIRAL = bf(34.5);
export const NOTE = bf(35.5);
export const GRAB = bf(39);
export const PEEL = bf(39.5);
/** She picks four letters one at a time with her near hand; the far hand holds them. */
export const PICK_BEATS = [40.75, 41, 41.25, 41.5] as const;
/** Beats each letter of OPEN is pressed onto the board. */
export const OPEN_BEATS = [42.5, 43, 43.5, 44] as const;
export const DOOR = bf(44.5);
/** The page turns over the open shot's last half beat; the mark lands on the cut, then HushBox, then the tagline, three quarters of a beat apart, so the tagline holds 2.7 s to the end. */
export const PAGE_TURN = bf(45.5);
export const MARK = bf(46);
export const WORDMARK_AT = bf(46.75);
export const TAGLINE_AT = bf(47.5);
export const END = bf(BEATS);
/** Type that leaves before its cut: the search line, then COMING SOON and the note. */
export const SEARCH_OUT = bf(19.5);
export const NIGHT_OUT = bf(37.5);

// ---------------------------------------------------------------- the spec

type Basis = NonNullable<FilmSpecInput['text'][number]['basis']>;
type TextRow = FilmSpecInput['text'][number];
type ShotRow = NonNullable<FilmSpecInput['shots']>[number];

const STORY: Basis = {
  kind: 'brand',
  source: 'films/2026-10-coming-soon/brief.md: the question she keeps deleting, the cinema it becomes, its papered doors and OPEN',
};
const NOT_EVEN_WE: Basis = {
  kind: 'fact',
  source:
    'Stored conversations are encrypted and HushBox cannot read them; only her key opens them: packages/db/src/schema/content-items.ts:31 (encrypted_blob), packages/crypto/src/account.ts:18-55. Scoped to the stored record the papered doors show; the brief (2026-10-02) records the boundary.',
};
const SEARCH_ROW: Basis = {
  kind: 'fact',
  source: 'The app writes a web search as "Searched the web · N sources" (apps/web/src/components/chat/message/ai-message-block.test.tsx:117); Gemini 3.1 Pro is tool-capable and in the live admission list the brief records (2026-10-02)',
};
const TAGLINE: Basis = { kind: 'brand', source: 'packages/shared/src/brand/tagline.ts:1' };
const WORDMARK: Basis = { kind: 'brand', source: 'packages/ui/src/components/composites/logo.tsx (Hush<span class="text-brand-red">Box</span>)' };

function line(
  id: string,
  shotId: string,
  words: string,
  [inBeat, outBeat]: readonly [number, number],
  basis: Basis,
  role: TextRow['role']
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
  return { id, fromBeat, toBeat, reads: reads.map(([a, b, what]) => ({ fromBeat: a, toBeat: b, what })), framing, camera, event, seam };
}

const SHOTS: ShotRow[] = [
  shot('hook', [0, 4], [[0, 3, 'she is deleting the question: its letters fall off the composer onto a pile'], [3, 4, 'the held key races through the rest']],
    'close: the phone in her hands, the composer and keyboard; below, the floor and the pile of letters', 'a slow push and a tilt down after the letters onto the pile',
    'the backspace eats the question from its end; each letter pops off the composer, turns into a white letter-board capital and falls onto a pile already there; the brief’s line stays whole to 3, then goes in a rush', 'cut to her'),
  shot('want', [4, 8], [[4, 5.5, 'she sits by the heap, her shoulders dropping'], [5.5, 6.5, 'she looks up at the blank letter board'], [6.5, 8, 'she reaches toward it, and smiles']],
    'medium, large in frame: her on the floor of the dark lobby, the heap beside her, the blank board on the wall ahead', 'a slow push toward her face and the board',
    'she sags over the phone, worried; on 5.5 her head comes up to the board, brow lifting; her far hand reaches toward it; a small smile; she lifts the phone again', 'cut to the phone'),
  shot('send', [8, 12], [[8, 10, 'the question, typed again in full'], [10, 11.5, 'her thumb hovers at Send'], [11.5, 12, 'Send: it goes up the chat']],
    'close: the phone in her hands', 'a push; a tilt up after the sent bubble',
    'she finishes typing it; her thumb drifts toward Send, trembles, pulls back (11, a half beat of silence) and strikes on 11.5, flattening against the glass; the line lifts into a sent bubble', 'cut into the hall'),
  shot('seats', [12, 16], [[12, 14.25, 'a GPT-5.5 answer: its code draws a chart'], [14.25, 15.25, 'the bars fly into the hall and become rows'], [15.25, 16, 'she turns and grips a row, delighted']],
    'over her shoulder in the dark hall: the phone close, then her from behind, the blank screen, the floor', 'one continuous log pull back from the phone to the hall',
    'the answer arrives; four bars rise one by one; each leaves the screen on its own arc and timing, tips over and lands as a row of seats (14.5, 14.75, 15, 15.25), its seats standing up one after another and settling from gold to teal one after another; she turns, grips the nearest row and smiles', 'cut to the phone'),
  shot('search', [16, 20], [[16, 19.25, 'Gemini 3.1 Pro: Searched the web · 6 sources'], [19.25, 20, 'the six sources lift off the screen; the answer scrolls away after them']],
    'close: the search answer on her phone', 'a slow push and tilt on the row',
    'the answer slides up with its nameplate and its row as one read and holds; the six sources fan out under it (18), sway, and lift off the screen one after another (19.25); the answer scrolls up after them (19.5)', 'cut to the street'),
  shot('street', [20, 24], [[20, 22, 'the sources fall and lay the street'], [22, 22.5, 'a lamppost springs up and lights'], [22.5, 24, 'an image answer rises from her phone: Seedream 5.0']],
    'the cinema’s front from the street at night', 'a tilt up and log pull back from the pavement to the front, then a push toward the doors',
    'each source falls on its own path and spin, stretching, and slaps down as a paving slab with a squash, a quarter beat apart (20.25-21.5); a lamppost springs up from the kerb and lights (22); a Seedream 5.0 card rises out of her phone through the glass and starts to sketch (22.5)', 'cut in on the card'),
  shot('sign', [24, 29], [[24, 25, 'the Seedream 5.0 card sketches a marquee'], [25, 26.5, 'it morphs into the marquee, which lands over the doors'], [26.5, 28, 'four models suggest names, one by one'], [28, 29, 'she picks one and LANTERN lights']],
    'the front at night, the card over the bare wall above the doors', 'a push in on the card, then a tilt up with it to the sign',
    'the card bobs while its sketch finishes; it stretches as it flies up and morphs into the dark marquee (25), which lands with a squash and bounce, its bulbs chasing (25.5); a beat later four answers to one message rise one by one, each settling with its nameplate (26.5-27.25); she taps (28): Lantern glows and flies into the sign; LANTERN lights (28.5)', 'cut inside'),
  shot('paper', [29, 33], [[29, 30.5, 'her conversation leaves the phone as pages'], [30.5, 32.5, 'the pages paper the glass, writing facing her'], [32.5, 33, 'she smooths the last page']],
    'inside, close on her and the glass doors', 'a slow push toward the doors',
    'six pages flutter to the glass one after another and slap flat, writing facing her; the street disappears behind them; she smooths the last one with her palm', 'cut to the street'),
  shot('coming-soon', [33, 38], [[33, 34, 'from the street the papered doors are blank; COMING SOON letters itself'], [34, 35.5, 'a small Signal Red spiral on the paper'], [35.5, 38, 'a note: Not even we can read it.']],
    'the front from the street at night, the sign dark, the doors papered', 'a slow push into the doors',
    'COMING SOON letters itself across a paper banner (33.25-34); the spiral springs up on the left door (34.5); a beat later a note flutters down, stretching, and slaps onto the right door, squashing and swinging to rest (35.5); a moth circles the lamp; on 37.5 a gust takes the note and the banner’s letters drop off it', 'cut inside, to dawn'),
  shot('peel', [38, 42], [[38, 39.5, 'dawn behind the paper; she reaches up'], [39.5, 40.5, 'she peels it all down and light floods in'], [40.5, 42, 'she picks four letters from the pile, one at a time']],
    'inside at the doors, the paper glowing with dawn', 'a push; a pull back and down on the flood of light',
    'she crouches (38.25), rises on her toes with her far arm full up (38.75), grabs (39, a half beat of silence) and pulls it down in one sweep, the far arm leading and the near arm following (39.5, the one flash); the pages peel in a wave; she throws one arm up in the light; she kneels at the pile and her near hand picks four letters one at a time into the far hand at her chest (40.75-41.5)', 'cut to the street'),
  shot('open', [42, 46], [[42, 44, 'she spells OPEN on the letter board'], [44, 45.5, 'she opens the door, the bell rings, the sign lights'], [45.5, 46, 'the page turns']],
    'the front at dawn, the board inside the door, her beside it', 'a pull back and crane up, ending on her in the doorway',
    'O, P, E, N press onto the board on the half beats (42.5-44), her near hand placing each while the far hand holds the rest at her chest; she pushes the door open (44.5), steps into the doorway, looks up at the lit sign, then to us, beaming, rocking on her heels; the page turns from its corner (45.5)', 'the page turns'),
  shot('end', [46, 52], [[46, 46.75, 'the mark'], [46.75, 47.5, 'HushBox'], [47.5, 52, 'One interface. Every feature. Private.']],
    'warm charcoal: the Signal Red mark, the wordmark, the tagline', 'a near-still push',
    'the red dot lands on the cut and the mark’s arcs fly out to the logo, overshooting into place (46); HushBox springs up with an overshoot and a stretch (46.75); the tagline’s three lines spring up, each a little later than the last (47.5), and hold 2.7 s; the mark breathes slowly to the end', 'end'),
];

const TEXT: TextRow[] = [
  line('doubt', 'hook', DOUBT, [0, 3], STORY, 'support'),
  line('question', 'send', QUESTION, [8, 12], STORY, 'support'),
  line('search-model', 'search', 'Gemini 3.1 Pro', [16, 19.5], SEARCH_ROW, 'support'),
  line('search-row', 'search', 'Searched the web · 6 sources', [16, 19.5], SEARCH_ROW, 'support'),
  line('coming-soon', 'coming-soon', 'COMING SOON', [34, 37.5], STORY, 'support'),
  line('note', 'coming-soon', 'Not even we can read it.', [35.5, 37.5], NOT_EVEN_WE, 'support'),
  line('open', 'open', 'OPEN', [44, 45.5], STORY, 'support'),
  line('wordmark', 'end', 'HushBox', [46.75, 52], WORDMARK, 'headline'),
  line('tag-1', 'end', 'One interface.', [47.5, 52], TAGLINE, 'headline'),
  line('tag-2', 'end', 'Every feature.', [47.5, 52], TAGLINE, 'headline'),
  line('tag-3', 'end', 'Private.', [47.5, 52], TAGLINE, 'headline'),
];

const CUES: FilmSpecInput['cues'] = [
  { id: 'deleting', beat: 0, kind: 'tick', anchor: 'start' },
  { id: 'look-up', beat: 5.5, kind: 'hit', anchor: 'start' },
  { id: 'type', beat: 8, kind: 'tick', anchor: 'start' },
  { id: 'inhale', beat: 11, kind: 'silence', anchor: 'start' },
  { id: 'send', beat: 11.5, kind: 'hit', anchor: 'start' },
  { id: 'answer', beat: 12, kind: 'tick', anchor: 'start' },
  { id: 'bar-1', beat: 12.5, kind: 'tick', anchor: 'start' },
  { id: 'bar-4', beat: 14, kind: 'tick', anchor: 'start' },
  { id: 'rows', beat: 14.5, kind: 'impact', anchor: 'start' },
  { id: 'rows-4', beat: 15.25, kind: 'hit', anchor: 'start' },
  { id: 'search', beat: 16, kind: 'hit', anchor: 'start' },
  { id: 'fan', beat: 18, kind: 'tick', anchor: 'start' },
  { id: 'sources', beat: 19.25, kind: 'whoosh', anchor: 'start' },
  { id: 'scroll-away', beat: 19.5, kind: 'tick', anchor: 'start' },
  { id: 'paving', beat: 20.25, kind: 'hit', anchor: 'start' },
  { id: 'paving-6', beat: 21.5, kind: 'hit', anchor: 'start' },
  { id: 'lamp', beat: 22, kind: 'hit', anchor: 'start' },
  { id: 'image', beat: 22.5, kind: 'whoosh', anchor: 'start' },
  { id: 'morph', beat: 25, kind: 'whoosh', anchor: 'start' },
  { id: 'sign', beat: 25.5, kind: 'impact', anchor: 'start' },
  { id: 'names', beat: 26.5, kind: 'hit', anchor: 'start' },
  { id: 'pick', beat: 28, kind: 'tick', anchor: 'start' },
  { id: 'lantern', beat: 28.5, kind: 'hit', anchor: 'start' },
  { id: 'night', beat: 29, kind: 'whoosh', anchor: 'start' },
  { id: 'page-1', beat: 29.5, kind: 'tick', anchor: 'start' },
  { id: 'smooth', beat: 32.5, kind: 'tick', anchor: 'start' },
  { id: 'outside', beat: 33, kind: 'hit', anchor: 'start' },
  { id: 'spiral', beat: 34.5, kind: 'hit', anchor: 'start' },
  { id: 'note', beat: 35.5, kind: 'tick', anchor: 'start' },
  { id: 'gust', beat: 37.5, kind: 'whoosh', anchor: 'start' },
  { id: 'dawn', beat: 38, kind: 'whoosh', anchor: 'start' },
  { id: 'grab', beat: 39, kind: 'silence', anchor: 'start' },
  { id: 'peel', beat: 39.5, kind: 'impact', anchor: 'start' },
  { id: 'gather', beat: 40.75, kind: 'tick', anchor: 'start' },
  { id: 'letter-o', beat: 42.5, kind: 'tick', anchor: 'start' },
  { id: 'letter-n', beat: 44, kind: 'tick', anchor: 'start' },
  { id: 'door', beat: 44.5, kind: 'hit', anchor: 'start' },
  { id: 'page-turn', beat: 45.5, kind: 'whoosh', anchor: 'start' },
  { id: 'mark', beat: 46, kind: 'impact', anchor: 'start' },
  { id: 'wordmark', beat: 46.75, kind: 'tick', anchor: 'start' },
  { id: 'tagline', beat: 47.5, kind: 'tick', anchor: 'start' },
];

// ---------------------------------------------------------------- music: F major, a chanson for a small cinema

const G1 = 31;
const A1 = 33;
const BB1 = 34;
const C2 = 36;
const D2 = 38;
const E2 = 40;
const F2 = 41;
const G2 = 43;
const A2 = 45;
const BB2 = 46;
const C3 = 48;
const CS3 = 49;
const D3 = 50;
const E3 = 52;
const F3 = 53;
const G3 = 55;
const A3 = 57;
const BB3 = 58;
const C4 = 60;
const D4 = 62;
const E4 = 64;
const F4 = 65;
const G4 = 67;
const A4 = 69;
const BB4 = 70;
const C5 = 72;
const D5 = 74;
const E5 = 76;
const F5 = 77;
const G5 = 79;
const A5 = 81;
const BB5 = 82;
const C6 = 84;

const TRACKS = {
  room: { instrument: 'roomTone', bus: 'beds', gainDb: -20 },
  pad: { instrument: 'pad', bus: 'keys', gainDb: -13 },
  chord: { instrument: 'pad', bus: 'keys', gainDb: -9 },
  box: { instrument: 'fmBell', bus: 'box', gainDb: -12, pan: 0.15 },
  run: { instrument: 'fmBell', bus: 'box', gainDb: -17, pan: -0.2 },
  bell: { instrument: 'fmBell', bus: 'bell', gainDb: -10 },
  bass: { instrument: 'sub808', bus: 'bass', gainDb: -9 },
  squeeze: { instrument: 'organ', bus: 'keys', gainDb: -19, pan: 0.25 },
  kick: { instrument: 'kick', bus: 'drums', gainDb: -14 },
  hat: { instrument: 'hat', bus: 'drums', gainDb: -26, pan: -0.2 },
  tom: { instrument: 'tom', bus: 'hits', gainDb: -10 },
  impact: { instrument: 'impact', bus: 'hits', gainDb: -9 },
  sub: { instrument: 'subPulse', bus: 'hits', gainDb: -10 },
  key: { instrument: 'tick', bus: 'foley', gainDb: -24 },
  tick: { instrument: 'tick', bus: 'foley', gainDb: -18 },
  pop: { instrument: 'pop', bus: 'foley', gainDb: -15 },
  knock: { instrument: 'typewriter', bus: 'foley', gainDb: -22 },
  snap: { instrument: 'snap', bus: 'foley', gainDb: -20 },
  whoosh: { instrument: 'whoosh', bus: 'hits', gainDb: -17 },
  fall: { instrument: 'downlifter', bus: 'hits', gainDb: -20 },
  riser: { instrument: 'riser', bus: 'keys', gainDb: -20 },
  swell: { instrument: 'reverseSwell', bus: 'hits', gainDb: -16 },
  match: { instrument: 'matchStrike', bus: 'foley', gainDb: -16 },
  snuff: { instrument: 'snuff', bus: 'foley', gainDb: -18 },
  shopBell: { instrument: 'carriageBell', bus: 'bell', gainDb: -13 },
} as const;

type TrackId = keyof typeof TRACKS;
type Part = Partial<Record<TrackId, ScoreEvent[]>>;

function at(beats: readonly number[], params?: unknown): ScoreEvent[] {
  return beats.map((beat) => ({ at: { beat }, params }));
}

function atFrames(frames: readonly number[], paramsOf: (i: number) => unknown): ScoreEvent[] {
  const seen = new Set<number>();
  const events: ScoreEvent[] = [];
  frames.forEach((frame, i) => {
    if (frame >= 0 && !seen.has(frame)) {
      seen.add(frame);
      events.push({ at: { frame }, params: paramsOf(i) });
    }
  });
  return events;
}

/** A melody as [beat, note, decay seconds]. */
function tune(notes: readonly (readonly [number, number, number?])[]): ScoreEvent[] {
  return notes.map(([beat, note, decay]) => ({ at: { beat }, params: { note, decay: decay ?? 1.6 } }));
}

/** A spread of tones a struck plastic letter rings at, from its index. */
function knockHz(i: number): number {
  return 1300 + ((i * 7919) % 11) * 90;
}

/** Beats 0-11.5: the doubt. D minor under the deleting, a music-box note for every few letters that pop, a knock for every letter that lands; a lift to F as she looks up; the inhale. */
const DOUBT_PART: Part = {
  room: [{ at: { beat: 0 }, params: { beats: 33, cutoff: 260 } }],
  pad: [
    { at: { beat: 0 }, params: { notes: [D3, F3, A3], beats: 4, attack: 0.02, release: 1 } },
    { at: { beat: 4 }, params: { notes: [BB2, D3, F3], beats: 1.5, attack: 0.3, release: 0.6 } },
    { at: { cue: 'look-up' }, params: { notes: [F3, A3, C4, G4], beats: 2.5, attack: 0.15, release: 0.8 } },
    { at: { beat: 8 }, params: { notes: [G2, BB2, D3, F3], beats: 2, attack: 0.2, release: 0.5 } },
    { at: { beat: 10 }, params: { notes: [A2, CS3, E3, G3], beats: 1, attack: 0.1, release: 0.3 } },
  ],
  run: FALLEN.filter((_, i) => i % 3 === 0)
    .map(({ index }, i) => ({ frame: DELETE_AT[index] ?? 0, note: [C6, A5, G5, F5, E5, D5, C5, A4, G4, F4, E4, D4][i % 12] ?? D4 }))
    .filter(({ frame }) => frame >= 0)
    .map(({ frame, note }) => ({ at: { frame }, params: { note, decay: 0.7 } })),
  box: tune([[1, A4, 1.8], [2, F4], [2.5, E4], [3, D4, 2], [4, A4, 1.6], [4.5, F4, 2], [5.5, C5, 2], [6, F5, 2.4], [6.5, E5], [7, C5, 2], [8, D5, 1.6], [9, C5, 1.6], [10, BB4, 1.4], [10.5, A4, 1.4]]),
  key: atFrames(TYPE_AT.filter((f) => f >= bf(8)), (i) => ({ toneHz: 3200 + (i % 3) * 300, decay: 0.012 })),
  knock: atFrames(LAND_AT, (i) => ({ toneHz: knockHz(i), decay: 0.05 })),
  bass: [
    { at: { beat: 4 }, params: { note: D2, beats: 1, decay: 0.6, drive: 1 } },
    { at: { beat: 5 }, params: { note: A1, beats: 0.5, decay: 0.5, drive: 1 } },
    { at: { cue: 'look-up' }, params: { note: F2, beats: 1, decay: 0.8, drive: 1 } },
    { at: { beat: 6.5 }, params: { note: C2, beats: 1, decay: 0.6, drive: 1 } },
    { at: { beat: 8 }, params: { note: G1, beats: 1, decay: 0.6, drive: 1 } },
    { at: { beat: 9 }, params: { note: BB1, beats: 1, decay: 0.6, drive: 1 } },
    { at: { beat: 10 }, params: { note: A1, beats: 1, decay: 0.6, drive: 1 } },
  ],
  sub: [{ at: { cue: 'look-up' }, params: { toneHz: 44, decay: 0.8 } }],
  riser: [{ at: { cue: 'inhale' }, anchor: 'end', params: { beats: 1.5, octaves: 1 } }],
};

/** The groove's chords, two beats each: [beat, bass root, bass fifth, squeeze-box voicing]. */
const CHANGES: readonly (readonly [number, number, number, readonly number[]])[] = [
  [12, F2, C2, [A3, C4, F4]],
  [14, D2, A1, [A3, D4, F4]],
  [16, BB1, F2, [BB3, D4, F4]],
  [18, C2, G1, [G3, C4, E4]],
  [20, F2, C2, [A3, C4, F4]],
  [22, A1, E2, [A3, C4, E4]],
  [24, BB1, F2, [BB3, D4, F4]],
  [26, C2, G1, [G3, C4, E4]],
  [28, F2, C2, [A3, C4, F4]],
];

const SQUEEZE = { drawbars: '006860400', rotorHz: 5.8 };

/** Oom-pah: bass on every beat (root then fifth), the squeeze-box on every off-beat, a soft kick on the chord. */
function oomPah(changes: readonly (readonly [number, number, number, readonly number[]])[], to: number): Part {
  const bass: ScoreEvent[] = [];
  const squeeze: ScoreEvent[] = [];
  const kick: ScoreEvent[] = [];
  changes.forEach(([beat, root, fifth, voicing], index) => {
    const end = changes[index + 1]?.[0] ?? to;
    for (let b = beat; b < end; b += 1) {
      bass.push({ at: { beat: b }, params: { note: (b - beat) % 2 === 0 ? root : fifth, beats: 0.5, decay: 0.45, drive: 1.2 } });
      squeeze.push({ at: { beat: b + 0.5 }, params: { ...SQUEEZE, notes: voicing, beats: 0.35 } });
      if ((b - beat) % 2 === 0) {
        kick.push({ at: { beat: b }, params: { startHz: 95, endHz: 46, decay: 0.3, drive: 0.8 } });
      }
    }
  });
  return { bass, squeeze, kick };
}

/** Beats 11.5-29: Send starts the oom-pah; the answers build the cinema, the music box carrying the theme. */
const BUILD: Part = {
  ...oomPah(CHANGES, 29),
  hat: at([12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5, 21.5, 22.5, 23.5, 24.5, 25.5, 26.5, 27.5, 28.5].flatMap((b) => [b, b + 0.25]), { variant: 'closed' }),
  box: tune([
    [12, C5], [12.5, A4], [13, F4], [13.5, A4],
    [14, D5, 1.2], [15, C5, 1.2],
    [16, BB4], [16.5, D5], [17, F5, 1.2], [17.5, D5],
    [18, E5, 1.2], [19, C5, 1.2],
    [20, F5], [20.5, E5], [21, C5, 1.2], [21.5, A4],
    [22, E5, 1.2], [22.5, C5], [23, D5], [23.5, F5],
    [24, BB5, 1.2], [25, A5], [25.5, F5, 1.4],
    // The names, one by one, climbing.
    ...NAME_BEATS.map((beat, i) => [beat, [G5, A5, BB5, C6][i] ?? C6, 1.2] as const),
    [28, A5], [28.5, C6, 2.4], [28.75, A5, 2],
  ]),
  bell: [
    { at: { cue: 'send' }, params: { note: F5, decay: 2.2 } },
    { at: { cue: 'lantern' }, params: { note: F5, decay: 2.6 } },
  ],
  pop: [
    { at: { cue: 'send' }, params: { fromHz: 480, octaves: 1.5, decay: 0.07 } },
    ...BAR_BEATS.map((beat, i) => ({ at: { beat }, params: { fromHz: 300 + i * 80, octaves: 1, decay: 0.06 } })),
    ...NAME_BEATS.map((beat, i) => ({ at: { beat }, params: { fromHz: 380 + i * 60, octaves: 1.4, decay: 0.07 } })),
    { at: { cue: 'lamp' }, params: { fromHz: 260, octaves: 2, decay: 0.08 } },
  ],
  tick: [
    { at: { cue: 'answer' }, params: { toneHz: 2400, decay: 0.03 } },
    { at: { cue: 'fan' }, params: { toneHz: 2600, decay: 0.03 } },
    { at: { cue: 'scroll-away' }, params: { toneHz: 2100, decay: 0.03 } },
    { at: { cue: 'pick' }, params: { toneHz: 2600, decay: 0.04 } },
    // The sign's bulbs light in a chase, a group every three frames.
    ...Array.from({ length: 6 }, (_, i) => ({ at: { frame: SIGN + 3 + i * 3 }, params: { toneHz: 2000 + i * 260, decay: 0.02 } })),
  ],
  whoosh: [
    { at: { cue: 'send' }, params: { seconds: 0.5, semitones: 6, direction: 'rightToLeft' } },
    { at: { beat: 14.25 }, params: { seconds: 0.5, semitones: 5, direction: 'rightToLeft' } },
    { at: { cue: 'search' }, params: { seconds: 0.35, semitones: 3, direction: 'leftToRight' } },
    { at: { cue: 'sources' }, params: { seconds: 0.5, semitones: 7, direction: 'rightToLeft' } },
    { at: { cue: 'image' }, params: { seconds: 0.7, semitones: 5, direction: 'leftToRight' } },
    { at: { cue: 'morph' }, params: { seconds: 0.4, semitones: 7, direction: 'leftToRight' } },
    { at: { beat: 28.25 }, params: { seconds: 0.35, semitones: 6, direction: 'rightToLeft' } },
  ],
  tom: [
    ...ROW_BEATS.map((beat, i) => ({ at: { beat }, params: { toneHz: 86 - i * 5, decay: 0.45 } })),
    ...SLAB_BEATS.map((beat, i) => ({ at: { beat }, params: { toneHz: 124 - i * 5, decay: 0.22 } })),
    { at: { cue: 'sign' }, params: { toneHz: 66, decay: 0.6 } },
  ],
  snap: SLAB_BEATS.map((beat, i) => ({ at: { beat }, params: { toneHz: 1000 + i * 60, decay: 0.05 } })),
  impact: [
    { at: { cue: 'rows' }, params: { decay: 1, drive: 1, subHz: 40, metal: 0 } },
    { at: { cue: 'sign' }, params: { decay: 1.2, drive: 1, subHz: 38, metal: 0.15 } },
  ],
  match: [{ at: { cue: 'lamp' }, params: { seconds: 1.2 } }],
  chord: [{ at: { cue: 'lantern' }, params: { notes: [F3, A3, C4, F4], beats: 0.5, attack: 0.02, release: 0.2 } }],
};

/** Beats 29-39: night. The groove stops; pages slap onto the glass; outside, the papered doors, the spiral's bell, the note's tape. */
const NIGHT_PART: Part = {
  pad: [
    { at: { cue: 'night' }, params: { notes: [BB2, D3, F3, A3], beats: 4, attack: 0.5, release: 1 } },
    { at: { cue: 'outside' }, params: { notes: [G2, BB2, D3, F3], beats: 3, attack: 0.6, release: 1 } },
    { at: { beat: 36 }, params: { notes: [C3, F3, G3, BB3], beats: 2, attack: 0.6, release: 0.8 } },
  ],
  box: tune([[29, F5, 2.4], [30, D5, 2.2], [31, C5, 2.2], [32, A4, 2.4], [33, C5, 2.4], [34, A4, 2.2], [36, D5, 2.2], [37, C5, 2.2]]),
  whoosh: [
    { at: { cue: 'night' }, params: { seconds: 0.4, semitones: 3, direction: 'leftToRight' } },
    ...PAGE_BEATS.map((beat, i) => ({ at: { beat }, anchor: 'end' as const, params: { seconds: 0.3, semitones: 2, direction: i % 2 === 0 ? 'leftToRight' : 'rightToLeft' } })),
    { at: { frame: WRITE_FROM }, params: { seconds: 0.5, semitones: 1, direction: 'leftToRight' } },
    { at: { cue: 'note' }, anchor: 'end', params: { seconds: 0.3, semitones: 2, direction: 'rightToLeft' } },
    { at: { cue: 'gust' }, params: { seconds: 0.45, semitones: 4, direction: 'leftToRight' } },
  ],
  tick: [
    ...PAGE_BEATS.map((beat) => ({ at: { beat }, params: { toneHz: 1500, decay: 0.03 } })),
    { at: { cue: 'note' }, params: { toneHz: 1400, decay: 0.03 } },
  ],
  snap: [
    ...PAGE_BEATS.map((beat) => ({ at: { beat }, params: { toneHz: 1200, decay: 0.04 } })),
    { at: { cue: 'smooth' }, params: { toneHz: 900, decay: 0.1 } },
    { at: { cue: 'note' }, params: { toneHz: 1300, decay: 0.05 } },
  ],
  snuff: [{ at: { beat: 32 }, params: { toneHz: 700, decay: 0.6 } }],
  bell: [{ at: { cue: 'spiral' }, params: { note: A5, decay: 3 } }],
  room: [{ at: { cue: 'outside' }, params: { beats: 5, cutoff: 520 } }],
  riser: [{ at: { cue: 'grab' }, anchor: 'end', params: { beats: 2, octaves: 2 } }],
};

/** Beats 38-46: dawn. The paper comes down into a flood of light; OPEN on four rising notes; the shop bell. */
const DAWN_PART: Part = {
  pad: [
    { at: { cue: 'dawn' }, params: { notes: [F3, A3, C4, E4], beats: 1, attack: 0.5, release: 0.3 } },
    { at: { cue: 'peel' }, params: { notes: [F2, C3, F3, A3, C4, F4], beats: 2.5, attack: 0.02, release: 1 } },
  ],
  whoosh: [
    { at: { cue: 'dawn' }, params: { seconds: 0.4, semitones: 2, direction: 'rightToLeft' } },
    { at: { cue: 'peel' }, anchor: 'peak', params: { seconds: 0.6, semitones: 5, direction: 'leftToRight' } },
  ],
  swell: [{ at: { cue: 'peel' }, anchor: 'end', params: { beats: 1 } }],
  impact: [{ at: { cue: 'peel' }, params: { decay: 2, drive: 1, subHz: 36, metal: 0.05 } }],
  bell: [{ at: { cue: 'peel' }, params: { note: C6, decay: 3 } }],
  box: tune([[39.5, F5, 2.6], [40, C5], [40.5, A4], [41, F4], [41.5, A4], ...OPEN_BEATS.map((beat, i) => [beat, [C5, D5, E5, F5][i] ?? F5, 1.6] as const), [45, A5, 2]]),
  tick: [
    ...PICK_BEATS.filter((b, i) => PICK_BEATS.indexOf(b) === i).map((beat) => ({ at: { beat }, params: { toneHz: 2300, decay: 0.02 } })),
    ...OPEN_BEATS.map((beat, i) => ({ at: { beat }, params: { toneHz: 2600 + i * 200, decay: 0.03 } })),
    ...Array.from({ length: 6 }, (_, i) => ({ at: { frame: DOOR + 3 + i * 3 }, params: { toneHz: 2000 + i * 260, decay: 0.02 } })),
  ],
  knock: OPEN_BEATS.map((beat, i) => ({ at: { beat }, params: { toneHz: knockHz(i + 60), decay: 0.06 } })),
  shopBell: [{ at: { cue: 'door' }, params: { toneHz: 2700, decay: 1.8 } }],
  ...oomPah([[42, F2, C2, [A3, C4, F4]], [44, BB1, F2, [BB3, D4, F4]], [45, C2, G1, [G3, C4, E4]]], 46),
};

/** The close: the page turns, the mark lands on F major and a bell rings on each read. */
const CLOSE: Part = {
  chord: [{ at: { cue: 'mark' }, params: { notes: [F2, C3, F3, A3, C4, F4], beats: 6, attack: 0.02, release: 2 } }],
  whoosh: [{ at: { cue: 'page-turn' }, params: { seconds: 0.5, semitones: 3, direction: 'rightToLeft' } }],
  impact: [{ at: { cue: 'mark' }, params: { decay: 2.5, drive: 1, subHz: 32, metal: 0.15 } }],
  bell: [
    { at: { cue: 'mark' }, params: { note: F5, decay: 4 } },
    { at: { cue: 'wordmark' }, params: { note: C6, decay: 3 } },
    { at: { cue: 'tagline' }, params: { note: A5, decay: 3 } },
  ],
  bass: [{ at: { cue: 'mark' }, params: { note: F2, beats: 4.5, decay: 2, drive: 1 } }],
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
      { id: 'drums', role: 'music', effects: [{ kind: 'reverb', rt60: 0.9, damping: 6000, mix: 0.12 }] },
      { id: 'bass', role: 'music', effects: [] },
      { id: 'keys', role: 'music', effects: [{ kind: 'reverb', rt60: 2.2, damping: 5000, mix: 0.22 }] },
      { id: 'box', role: 'music', effects: [{ kind: 'reverb', rt60: 2.4, damping: 7000, mix: 0.3 }] },
      { id: 'bell', role: 'sfx', effects: [{ kind: 'reverb', rt60: 3, damping: 8000, mix: 0.35 }] },
      { id: 'hits', role: 'sfx', effects: [{ kind: 'reverb', rt60: 1.2, damping: 5000, mix: 0.12 }] },
      { id: 'foley', role: 'sfx', effects: [{ kind: 'reverb', rt60: 0.7, damping: 6000, mix: 0.1 }] },
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
    id: 'storybook-short',
    title: 'Coming Soon: storybook short',
    seed: 'coming-soon/storybook-short',
    grid: GRID,
    beats: BEATS,
    shots: SHOTS,
    text: TEXT,
    cues: CUES,
  }),
  score: scoreOf([DOUBT_PART, BUILD, NIGHT_PART, DAWN_PART, CLOSE]),
};
