import { pattern } from '../../../../engine/audio/score/index.js';
import { defineFilm } from '../../../../engine/film/spec.js';

import {
  ANSWERS,
  ANSWER_BEATS,
  ASK_FROM,
  BAR_BEATS,
  BEATS,
  CHASE_BEATS,
  CHEER,
  CODE_LINE_BEATS,
  DELETE_FALL,
  DELETE_WORDS,
  DIVE,
  DOUBT,
  DOUBT_LEAD,
  DROP_FALL,
  FINAL,
  FPB,
  JOY,
  LAMP_BEATS,
  LAMP_LAG,
  LAPSE_DROPS,
  LIGHTS,
  LOL_DELETE,
  LOL_FALL,
  NAME_ASK,
  NAME_FLY,
  NOTE,
  OPENING_TEXT,
  OPEN_BEATS,
  OTHERS_FALL,
  OUTSIDE,
  PEEL_BEATS,
  PRESS,
  RUN,
  SCREEN_ON,
  SEARCH_ROW,
  SEATS_LAND,
  SEND,
  SHEET_BEATS,
  SIGN_NAME,
  SIGN_THE,
  SIT,
  SOON_OUT,
  STRANGER_LOOK,
  SLAB_BEATS,
  SOURCE_BEATS,
  STEP_BACK,
  TAG_BEATS,
  TAP,
  TIP,
  TRACE_BEATS,
  TYPE_FRAMES,
  WISH,
  WISH_DROP,
  WISH_FAST_FROM,
  WORDMARK,
  bf,
} from './beats.js';

import type { PatternOptions, ScoreEvent, ScoreInput } from '../../../../engine/audio/score/index.js';
import type { FilmDefinition, FilmSpecInput } from '../../../../engine/film/spec.js';
import type { Grid } from '../../../../engine/time/grid.js';

/** 128.57 BPM, four-four, 64 beats: sixteen bars. */
export const GRID: Grid = { framesPerBeat: FPB, beatsPerBar: 4 };

// D minor, resolving to F major at the close. MIDI notes.
const BB0 = 22;
const C1 = 24;
const D1 = 26;
const F1 = 29;
const G1 = 31;
const F2 = 41;
const A2 = 45;
const C3 = 48;
const D3 = 50;
const E3 = 52;
const F3 = 53;
const G3 = 55;
const A3 = 57;
const BB3 = 58;
const C4 = 60;
const G4 = 67;
const A4 = 69;
const C5 = 72;
const D5 = 74;
const E5 = 76;
const F5 = 77;
const G5 = 79;
const A5 = 81;
const C6 = 84;

const DM = [D3, F3, A3];
const BB = [D3, F3, BB3];
const F = [C3, F3, A3];
const C = [C3, E3, G3];
const GM = [D3, G3, BB3];

type Basis = NonNullable<FilmSpecInput['text'][number]['basis']>;
const STORY: Basis = {
  kind: 'brand',
  source: 'films/2026-10-coming-soon/brief.md, The idea: the question she deletes, the one she sends, COMING SOON, OPEN',
};
const SEARCH_ROW_FACT: Basis = {
  kind: 'fact',
  source:
    'apps/web/src/components/chat/segments/web-search-labels.ts:63-75 (parts "Searched the web", "N sources"), joined by " · " at apps/web/src/components/chat/segments/web-search-row.tsx:241',
};
const UNREADABLE: Basis = {
  kind: 'fact',
  source:
    'Stored conversations are encrypted and only her key opens them: packages/db/src/schema/content-items.ts:31, packages/crypto/src/account.ts:18-55 (films/2026-10-coming-soon/brief.md, Facts a take may show)',
};
const MODELS: Basis = {
  kind: 'fact',
  source:
    'Model names from the live admission filter on 2026-10-02 (films/2026-10-coming-soon/brief.md); one model full name per reply, apps/web/src/components/chat/message/model-nameplate.tsx:64-69; at most five stacked, packages/shared/src/constants.ts:101',
};
const TAGLINE_BASIS: Basis = { kind: 'brand', source: 'README.md:7, apps/marketing/src/pages/welcome.astro:80-84' };

type TextRow = FilmSpecInput['text'][number];
type ShotRow = NonNullable<FilmSpecInput['shots']>[number];

function line(
  id: string,
  shotId: string,
  words: string,
  [inBeat, outBeat]: readonly [number, number],
  role: TextRow['role'],
  basis: Basis
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
  shot('doubt', [0, 4], [[0, 1, 'close: is it crazy to quit my job lol; she deletes lol'], [1, 4, 'lol lands on the floor; the question is left: is it crazy to quit my job']],
    'close on the composer, her head below it; then the composer, her and the floor', 'a push on the composer, a whip down with the falling word on the half beat, then a slow push', 'she types the question and lol after it, smirking; she deletes lol and it falls, growing, and lands on the floor large on 1 with a thud and a burst; she flinches, looks up at the question and hesitates', 'hard cut'),
  shot('delete', [4, 8], [[4, 6, 'the words drop off the line one by one'], [6, 8, 'they pile up on lol at her feet']],
    'wider: the room, the window high on the wall, the composer and her, the floor below', 'held, then a push down to the heap on 6', 'backspace eats the line word by word on the eighths; each word falls and lands on a growing heap', 'hard cut'),
  shot('nights', [8, 10], [[8, 10, 'night after night the line is typed and dropped; the heap grows']],
    'wide: the room, the window with the moon, the heap beside her', 'a drift right', 'the heap jumps at the cut; the line drops whole twice, the moon jumps between', 'hard cut'),
  shot('wish', [10, 12], [[10, 11, 'she types how do I open a cinema?'], [11, 12, 'and drops that too, onto the heap above her head']],
    'the heap taller than her, the composer above', 'a push in', 'the wish types fast and falls whole; its letters land warm on the heap', 'hard cut'),
  shot('ask', [12, 16], [[12, 15.5, 'she types it again: how do I open a cinema?'], [15.5, 16, 'her thumb presses send']],
    'close on the composer, the send button at the right', 'a slow push, a kick on the press', 'the wish types; her hand rises in and presses the send arrow', 'silence, then the drop'),
  shot('sent', [16, 20], [[16, 16.5, 'the message flies up, readable'], [16.5, 20, 'Searched the web · 12 sources, and the sources pop out']],
    'a sky of letters; the sent message at the top, the answer under it', 'a whip up after the message, then a settle', 'the message leaves in plain text; Gemini 3.1 Pro searches; twelve source chips pop out on the sixteenths', 'the chips fall'),
  shot('street', [20, 24], [[20, 22, 'the sources slam down as the paving of a street'], [22, 24, 'lamps rise; she walks towards an empty shopfront']],
    'a street in perspective, low', 'a low glide forward', 'the chips land flat in rows, the lane dashes draw, f-shaped lamps spring up, one side then the other a sixteenth later and shorter; she walks in', 'hard cut'),
  shot('code', [24, 27], [[24, 25, 'code types in the document panel'], [25, 27, 'it runs: a chart of seats per row rises']],
    'the document panel: code above, its chart below', 'a push', 'two lines of code type; on run the chart’s bars of n’s grow one a sixteenth', 'the chart tips'),
  shot('seats', [27, 30], [[27, 28, 'the chart tips back into the floor'], [28, 30, 'its bars are rows of seats; the screen lights; she sits']],
    'the chart, then the hall from behind the back row', 'a tilt and pull back as the chart lies down', 'the code flies up and the caption falls flat as the chart rotates into the floor plane; its bars become the rows A to H and the hall slams down on 28; the screen switches on; she drops into a seat', 'hard cut'),
  shot('names', [30, 34], [[30, 30.5, 'she asks: what do I call it?'], [30.5, 34, 'four models answer, one name a beat, one under another']],
    'the chat on paper: her question, the answers stacked', 'a slow tilt down the stack', 'her bubble lands; a reply lands on each beat, each a model name over a name, each held a beat before the next', 'hard cut'),
  shot('pick', [34, 36], [[34, 35, 'she taps The Lantern'], [35, 36, 'the others drop away and it flies up']],
    'the stack, close, her below with her phone', 'a push in on the tap, a whip up', 'she taps; The Lantern lights amber; the others jolt and fall; the name flies up', 'match cut on the name'),
  shot('sign', [36, 39], [[36, 37.5, 'Seedream 5.0 draws a sign in bulbs'], [37.5, 39, 'THE LANTERN slams in']],
    'the sign on the dark facade', 'a slow push', 'bulbs trace the marquee frame on the sixteenths; THE, then LANTERN, slam in and settle', 'pull back'),
  shot('facade', [39, 42], [[39, 42, 'the cinema stands on the street; the bulbs light and chase; she cheers']],
    'wide: the facade on the street, her small in front, looking up', 'a pull back, then a drift', 'the bulbs light on 39 and chase on the eighths; on 40 she throws one arm up, then the other', 'hard cut'),
  shot('papering', [42, 45], [[42, 43.5, 'inside at night, she flings the start of the conversation onto the left door'], [43.5, 44.5, 'then the name onto the right door'], [44.5, 45, 'she steps back']],
    'inside, facing the doors; the heap beside her', 'a slow push and drift', 'two tall sheets, one per door, each printed with the chat in big type, fly in and slap onto the glass, writing facing her', 'cut outside'),
  shot('outside', [45, 50], [[45, 46.5, 'from the street: blank paper, a small red spiral, COMING SOON'], [46.5, 48, 'a note taped on: Not even we can read it.'], [48, 50, 'close: the note and the spiral; a stranger passes, looks, sees blank paper']],
    'the papered doors from the street at night, the sign above', 'a push in and down onto COMING SOON; on 48 a cut in to the note and the spiral, pushing on and panning with the stranger', 'from outside the sheets are blank; COMING SOON lands painted across them; the note slaps on at 46.5 with an overshoot; a stranger walks past, stops dead on 48.5 with his head snapped up to the doors and a question mark over him, frowns at the blank paper and walks on', 'hard cut to dawn'),
  shot('dawn', [50, 52], [[50, 52, 'at dawn she peels the paper down, a door a beat']],
    'the doors from outside at dawn, her inside', 'a drift up', 'the two sheets peel down one a beat, COMING SOON and the note tearing away with them, the lit hall behind the glass', 'up to the board'),
  shot('open', [52, 56], [[52, 54, 'she throws o, p, e, n up from her arms; they land as O P E N'], [54, 55.75, 'OPEN; she cheers'], [55.75, 56, 'the camera dives into the O']],
    'the board under the lit sign, her below at the doors with four amber letters in her arms', 'a slow push; on 55.75 a dive into the O', 'each letter leaves her hand in view, arcs up turning and lands on the board as a capital with an overshoot; on 54.5 she throws one arm up, then the other; the camera dives into the O', 'through the O'),
  shot('end', [56, 64], [[56, 56.5, 'the spiral, from a dot'], [56.5, 58, 'HushBox, alone'], [58, 59, 'One interface.'], [59, 60, 'Every feature.'], [60, 64, 'Private.; the card holds']],
    'warm charcoal: the mark, the wordmark, the tagline', 'a settle, then near still', 'a red dot bursts into the mark’s arcs, which settle on the logo; the wordmark lands and is read alone; each tagline line lands on its own beat; the card holds', 'end'),
];

const TEXT: TextRow[] = [
  line('doubt', 'doubt', DOUBT, [1, 4], 'headline', STORY),
  line('ask', 'ask', WISH, [12, 16], 'headline', STORY),
  line('sent-bubble', 'sent', WISH, [16, 20], 'imagery', STORY),
  line('search-model', 'sent', 'Gemini 3.1 Pro', [16.5, 20], 'imagery', MODELS),
  line('search', 'sent', 'Searched the web · 12 sources', [16.5, 20], 'support', SEARCH_ROW_FACT),
  line('code-model', 'code', 'Claude Sonnet 5.5', [24, 27], 'imagery', MODELS),
  line('name-q', 'names', 'what do I call it?', [30, 34], 'support', STORY),
  ...ANSWERS.map((answer, k) => line(`plate-${String(k)}`, 'names', answer.model, [ANSWER_BEATS[k] ?? 30.5, 34], 'imagery', MODELS)),
  line('sign-model', 'sign', 'Seedream 5.0', [36, 39], 'imagery', MODELS),
  line('soon', 'outside', 'COMING SOON', [OUTSIDE, SOON_OUT], 'headline', STORY),
  line('note', 'outside', 'Not even we can read it.', [NOTE, 50], 'support', UNREADABLE),
  line('open', 'open', 'OPEN', [OPEN_BEATS[3] ?? 54, DIVE], 'headline', STORY),
  line('wordmark', 'end', 'HushBox', [WORDMARK, 64], 'headline', TAGLINE_BASIS),
  ...['One interface.', 'Every feature.', 'Private.'].map((words, k) => line(`tag-${String(k + 1)}`, 'end', words, [TAG_BEATS[k] ?? 60, 64], 'headline', TAGLINE_BASIS)),
];

type CueKind = FilmSpecInput['cues'][number]['kind'];
function cue(id: string, beat: number, kind: CueKind): FilmSpecInput['cues'][number] {
  return { id, beat, kind, anchor: 'start' };
}

const CUES: FilmSpecInput['cues'] = [
  cue('open', 0, 'hit'),
  cue('lol', LOL_DELETE, 'tick'),
  cue('lol-land', LOL_DELETE + LOL_FALL / FPB, 'impact'),
  cue('backspace', 4, 'tick'),
  cue('tilt', 6, 'whoosh'),
  cue('lapse', 8, 'hit'),
  cue('lapse-drop-1', LAPSE_DROPS[0], 'tick'),
  cue('lapse-land-1', LAPSE_DROPS[0] + 0.5, 'impact'),
  cue('lapse-drop-2', LAPSE_DROPS[1], 'tick'),
  cue('wish', 10, 'impact'),
  cue('wish-drop', WISH_DROP, 'tick'),
  cue('wish-land', WISH_DROP + 0.5, 'impact'),
  cue('ask', 12, 'hit'),
  cue('press', PRESS, 'tick'),
  cue('inhale', PRESS, 'silence'),
  cue('send', SEND, 'impact'),
  cue('search', SEARCH_ROW, 'hit'),
  cue('street', 20, 'hit'),
  ...SLAB_BEATS.map((beat, k) => cue(`slab-${String(k)}`, beat, 'impact')),
  ...LAMP_BEATS.flatMap((beat, k) => [cue(`lamp-${String(k)}a`, beat, 'tick'), cue(`lamp-${String(k)}b`, beat + LAMP_LAG, 'tick')]),
  cue('code', CODE_LINE_BEATS[0], 'hit'),
  cue('run', RUN, 'tick'),
  cue('tip', TIP, 'whoosh'),
  cue('seats', SEATS_LAND, 'impact'),
  cue('screen', SCREEN_ON, 'hit'),
  cue('sit', SIT, 'tick'),
  cue('name-ask', NAME_ASK, 'hit'),
  ...ANSWER_BEATS.map((beat, k) => cue(`answer-${String(k)}`, beat, 'tick')),
  cue('tap', TAP, 'impact'),
  cue('others-fall', OTHERS_FALL, 'whoosh'),
  cue('fly', NAME_FLY, 'whoosh'),
  cue('sign', TRACE_BEATS[0] ?? 35, 'hit'),
  cue('sign-the', SIGN_THE, 'impact'),
  cue('sign-name', SIGN_NAME, 'impact'),
  cue('lights', LIGHTS, 'impact'),
  cue('cheer', CHEER, 'hit'),
  ...SHEET_BEATS.map((beat, k) => cue(`sheet-${String(k)}`, beat, 'hit')),
  cue('step-back', STEP_BACK, 'whoosh'),
  cue('outside', OUTSIDE, 'hit'),
  cue('note', NOTE, 'tick'),
  cue('cut-in', SOON_OUT, 'hit'),
  cue('stranger-looks', STRANGER_LOOK, 'tick'),
  ...PEEL_BEATS.map((beat, k) => cue(`peel-${String(k)}`, beat, 'whoosh')),
  ...OPEN_BEATS.map((beat, k) => cue(`letter-${'open'.charAt(k)}`, beat, 'hit')),
  cue('joy', JOY, 'impact'),
  cue('dive', DIVE, 'whoosh'),
  cue('hush', DIVE, 'silence'),
  cue('final', FINAL, 'impact'),
  cue('wordmark', WORDMARK, 'tick'),
  ...TAG_BEATS.map((beat, k) => cue(`tag-${String(k + 1)}`, beat, 'tick')),
];

// ---------------------------------------------------------------- music

function bars(fromBeat: number, count: number, steps: PatternOptions['steps'], params?: unknown): ScoreEvent[] {
  return pattern({ grid: GRID, bars: [0, count], steps, params, startBeat: fromBeat });
}

function at(beats: readonly number[], params?: unknown): ScoreEvent[] {
  return beats.map((beat) => (params === undefined ? { at: { beat } } : { at: { beat }, params }));
}

function frames(list: readonly number[], params?: unknown): ScoreEvent[] {
  return list.filter((frame) => frame >= 0).map((frame) => (params === undefined ? { at: { frame } } : { at: { frame }, params }));
}

/** A snare roll on the sixteenths from `from` to `to`, its pitch rising. */
function roll(from: number, to: number): ScoreEvent[] {
  const count = Math.round((to - from) * 4);
  return Array.from({ length: count }, (_, k) => ({ at: { beat: from + k / 4 }, params: { toneHz: 170 + (260 * k) / Math.max(1, count - 1), decay: 0.12 } }));
}

/** One strike per typed character, `step` frames apart from `from`. */
function typed(from: number, text: string, step: number, every = 1): number[] {
  return [...text].map((_, k) => from + k * step).filter((_, k) => k % every === 0);
}

const TRACKS = {
  kick: { instrument: 'kick', bus: 'drums', gainDb: -4 },
  kickSoft: { instrument: 'kick', bus: 'drums', gainDb: -12 },
  clap: { instrument: 'clap', bus: 'drums', gainDb: -8 },
  snare: { instrument: 'snare', bus: 'drums', gainDb: -9 },
  hat: { instrument: 'hat', bus: 'drums', gainDb: -19 },
  hatOpen: { instrument: 'hat', bus: 'drums', gainDb: -21 },
  bass: { instrument: 'sub808', bus: 'bass', gainDb: -10 },
  stab: { instrument: 'supersaw', bus: 'keys', gainDb: -11 },
  pad: { instrument: 'pad', bus: 'keys', gainDb: -11 },
  riser: { instrument: 'riser', bus: 'keys', gainDb: -14 },
  hook: { instrument: 'fmBell', bus: 'bell', gainDb: -12 },
  bell: { instrument: 'fmBell', bus: 'bell', gainDb: -8 },
  pluck: { instrument: 'fmBell', bus: 'bell', gainDb: -9 },
  carriage: { instrument: 'carriageBell', bus: 'bell', gainDb: -14 },
  keys: { instrument: 'typewriter', bus: 'foley', gainDb: -14 },
  tick: { instrument: 'tick', bus: 'foley', gainDb: -16 },
  pop: { instrument: 'pop', bus: 'foley', gainDb: -12 },
  snap: { instrument: 'snap', bus: 'foley', gainDb: -12 },
  tom: { instrument: 'tom', bus: 'hits', gainDb: -8 },
  impact: { instrument: 'impact', bus: 'hits', gainDb: -4 },
  whoosh: { instrument: 'whoosh', bus: 'hits', gainDb: -11 },
  down: { instrument: 'downlifter', bus: 'hits', gainDb: -14 },
  swell: { instrument: 'reverseSwell', bus: 'hits', gainDb: -10 },
  sub: { instrument: 'subPulse', bus: 'beds', gainDb: -10 },
} as const;

type TrackId = keyof typeof TRACKS;
type Part = Partial<Record<TrackId, ScoreEvent[]>>;

/** A pluck of the D minor pentatonic for each landing, falling as the words fall. */
const LANDING_NOTES = [A5, G5, F5, D5, C5, A4, G4];

/** Beats 0–16: the doubt typed and deleted, the heap's nights, the wish typed and sent. */
const DOUBT_PART: Part = {
  pad: [
    { at: { cue: 'open' }, params: { notes: [A2, ...DM], beats: 8, attack: 0.04, release: 0.6 } },
    { at: { beat: 8 }, params: { notes: BB, beats: 4, attack: 0.02, release: 0.3 } },
    { at: { beat: 12 }, params: { notes: C, beats: 3.5, attack: 0.3, release: 0.1 } },
  ],
  bass: [
    { at: { cue: 'open' }, params: { note: D1, beats: 4, decay: 4, drive: 2 } },
    { at: { beat: 4 }, params: { note: D1, beats: 4, decay: 4, drive: 2 } },
    { at: { beat: 8 }, params: { note: BB0 + 12, beats: 2, drive: 2.5 } },
    { at: { beat: 10 }, params: { note: BB0 + 12, beats: 2, drive: 2.5 } },
    { at: { beat: 12 }, params: { note: C1 + 12, beats: 3.5, decay: 4, drive: 2.5 } },
  ],
  kickSoft: [...at([0, 2, 4, 6]), ...bars(12, 1, 'x...x...x...x...')],
  kick: bars(8, 1, 'x...x...x...x...'),
  hat: [...bars(4, 1, '..x...x...x...x.'), ...bars(8, 1, 'xxxxxxxxxxxxxxxx'), ...bars(12, 1, '..x...x...x...x.')],
  clap: bars(8, 1, '....x.......x...'),
  snare: roll(14, PRESS),
  riser: [{ at: { cue: 'inhale' }, anchor: 'end', params: { beats: 3.5, octaves: 2 } }],
  swell: [{ at: { cue: 'send' }, anchor: 'end', params: { beats: 0.5 } }],
  keys: frames([
    ...typed(-DOUBT_LEAD, OPENING_TEXT, TYPE_FRAMES),
    // The time-lapse retypes the doubt in a burst on 9.
    ...typed(bf(9), DOUBT.slice(0, 13), 1, 2),
    ...typed(WISH_FAST_FROM, WISH, 0.5, 2),
    ...typed(ASK_FROM, WISH, TYPE_FRAMES),
  ]),
  tick: [
    { at: { cue: 'lol' }, params: { toneHz: 2400, decay: 0.02 } },
    ...DELETE_WORDS.map(([, beat]) => ({ at: { beat }, params: { toneHz: 2400, decay: 0.02 } })),
    { at: { cue: 'press' }, params: { toneHz: 3200, decay: 0.03 } },
  ],
  pluck: [
    { at: { cue: 'lol-land' }, params: { note: A5, decay: 1.2 } },
    ...DELETE_WORDS.map(([, beat], k) => ({ at: { frame: bf(beat) + DELETE_FALL }, params: { note: LANDING_NOTES[k] ?? D5, decay: 0.9 } })),
    ...[...LAPSE_DROPS, WISH_DROP].flatMap((beat, k) =>
      [D5, F5, A5].map((note) => ({ at: { frame: bf(beat) + DROP_FALL }, params: { note: note - 12 * (k % 2), decay: 0.8 } }))
    ),
  ],
  tom: [
    { at: { cue: 'lol-land' }, params: { toneHz: 85, decay: 0.7 } },
    ...[...LAPSE_DROPS, WISH_DROP].map((beat, k) => ({ at: { frame: bf(beat) + DROP_FALL }, params: { toneHz: 80 - k * 8, decay: 0.5 } })),
  ],
  sub: [{ at: { cue: 'lol-land' }, params: { toneHz: 40, decay: 0.9 } }],
  impact: [{ at: { cue: 'lol-land' }, params: { decay: 1.4, drive: 2.5, subHz: 32, metal: 0.25 } }],
  snap: at([...LAPSE_DROPS, WISH_DROP]),
  pop: [{ at: { cue: 'press' }, params: { fromHz: 500, octaves: 1, decay: 0.05 } }],
  whoosh: [{ at: { cue: 'tilt' }, params: { seconds: 0.5, semitones: 3, direction: 'rightToLeft' } }],
};

/** Beats 16–41: the drop and the groove under the build: Dm, Bb, F, C, Dm, Bb, then F. */
const GROOVE_CHORDS = [DM, BB, F, C, DM, BB] as const;
const GROOVE_ROOTS = [D1, BB0, F1, C1, D1, BB0] as const;
const BASS_STEPS = 'x..x..x...x..x..';

/** The hook: a bell figure over each two bars of the groove. */
const HOOK_FIGURE: readonly (readonly [number, number])[] = [
  [0, D5], [0.5, F5], [1, A5], [1.75, G5], [2, F5], [3, D5],
  [4, C5], [4.5, D5], [5.5, F5], [6, D5], [7, A4],
];

/** Half a bar more of the groove, on F, to the papering on 42. */
function toNight(events: ScoreEvent[]): ScoreEvent[] {
  return events.filter((e) => !('beat' in e.at) || e.at.beat < 42);
}

const GROOVE: Part = {
  kick: bars(16, 6, 'x...x...x...x...').concat(toNight(bars(40, 1, 'x...x...x...x...'))),
  clap: [...bars(16, 6, '....x.......x...'), ...toNight(bars(40, 1, '....x.......x...')), ...at([SIGN_THE])],
  hat: bars(16, 6, 'x.xxx.xxx.xxx.xx').concat(toNight(bars(40, 1, 'x.xxx.xxx.xxx.xx'))),
  hatOpen: bars(16, 6, '..x...x...x...x.', { variant: 'open' }).concat(toNight(bars(40, 1, '..x...x...x...x.', { variant: 'open' }))),
  bass: [...GROOVE_ROOTS, F1].flatMap((root, bar) =>
    toNight(pattern({ grid: GRID, bars: [0, 1], steps: BASS_STEPS, startBeat: 16 + bar * 4, params: { note: root + 12, beats: 0.5, decay: 0.6, drive: 3 } }))
  ),
  stab: [...GROOVE_CHORDS, F].flatMap((chord, bar) =>
    toNight(pattern({ grid: GRID, bars: [0, 1], steps: '..x...x...x...x.', startBeat: 16 + bar * 4, params: { notes: chord.map((n) => n + 12), beats: 0.25, detune: 0.4 } }))
  ),
  pad: [...GROOVE_CHORDS.map((chord, bar) => ({ at: { beat: 16 + bar * 4 }, params: { notes: chord, beats: 4, attack: 0.05, release: 0.4 } })), { at: { beat: 40 }, params: { notes: F, beats: 2, attack: 0.05, release: 0.3 } }],
  hook: [16, 24, 32].flatMap((start) => HOOK_FIGURE.map(([beat, note]) => ({ at: { beat: start + beat }, params: { note, decay: 0.6 } }))),
  impact: [
    { at: { cue: 'send' }, params: { decay: 2.5, drive: 3, subHz: 30, metal: 0.4 } },
    { at: { cue: 'seats' }, params: { decay: 1.2, drive: 2, metal: 0.2 } },
    { at: { cue: 'tap' }, params: { decay: 0.8, drive: 1.5, metal: 0.2 } },
    { at: { cue: 'sign-name' }, params: { decay: 1.5, drive: 2, metal: 0.5 } },
    { at: { cue: 'lights' }, params: { decay: 2, drive: 2.5, metal: 0.6 } },
  ],
  sub: [
    { at: { cue: 'send' }, params: { toneHz: 37, decay: 1.5 } },
    { at: { cue: 'lights' }, params: { toneHz: 44, decay: 1.2 } },
  ],
  carriage: [{ at: { cue: 'send' }, params: { toneHz: 2700, decay: 1.6 } }],
  whoosh: [
    { at: { cue: 'send' }, params: { seconds: 0.5, semitones: 7, direction: 'leftToRight' } },
    { at: { cue: 'tip' }, params: { seconds: 0.5, semitones: 5, direction: 'rightToLeft' } },
    { at: { cue: 'fly' }, params: { seconds: 0.45, semitones: 9, direction: 'leftToRight' } },
  ],
  snap: [...at([SEARCH_ROW, TAP]), ...at([...CODE_LINE_BEATS])],
  tick: [
    ...SOURCE_BEATS.map((beat, k) => ({ at: { beat }, params: { toneHz: 2000 + k * 130, decay: 0.02 } })),
    { at: { cue: 'run' }, params: { toneHz: 3600, decay: 0.03 } },
    ...TRACE_BEATS.map((beat, k) => ({ at: { beat }, params: { toneHz: 2600 + k * 200, decay: 0.02 } })),
    ...CHASE_BEATS.map((beat) => ({ at: { beat }, params: { toneHz: 4200, decay: 0.015 } })),
  ],
  tom: [
    ...SLAB_BEATS.map((beat, k) => ({ at: { beat }, params: { toneHz: 120 - k * 12, decay: 0.45 } })),
    { at: { cue: 'sit' }, params: { toneHz: 90, decay: 0.4 } },
    { at: { cue: 'sign-the' }, params: { toneHz: 110, decay: 0.5 } },
  ],
  pop: [
    { at: { cue: 'cheer' }, params: { fromHz: 600, octaves: 1.5, decay: 0.06 } },
    ...LAMP_BEATS.flatMap((beat) => [
      { at: { beat }, params: { fromHz: 420, octaves: 1.5, decay: 0.06 } },
      { at: { beat: beat + LAMP_LAG }, params: { fromHz: 520, octaves: 1.3, decay: 0.05 } },
    ]),
    ...BAR_BEATS.map((beat, k) => ({ at: { beat }, params: { fromHz: 220 + k * 45, octaves: 1.2, decay: 0.05 } })),
    { at: { cue: 'name-ask' }, params: { fromHz: 520, octaves: 1, decay: 0.05 } },
  ],
  pluck: ANSWER_BEATS.map((beat, k) => ({ at: { beat }, params: { note: [D5, F5, A5, G5, C6][k] ?? D5, decay: 0.7 } })),
  bell: [
    { at: { cue: 'tap' }, params: { note: A5, decay: 1.5 } },
    { at: { cue: 'screen' }, params: { note: F5, decay: 2 } },
    ...[F5, A5, C6].map((note) => ({ at: { cue: 'lights' }, params: { note, decay: 2.5 } })),
  ],
  keys: frames([...typed(bf(CODE_LINE_BEATS[0]), 'x'.repeat(12), 1, 2), ...typed(bf(CODE_LINE_BEATS[1]), 'x'.repeat(12), 1, 2)]),
  down: [{ at: { cue: 'others-fall' }, params: { beats: 1, octaves: 2 } }],
};

/** Beats 41–50: night. The kit drops out; the sheets slap; COMING SOON on C under a bell chord. */
const NIGHT: Part = {
  pad: [
    { at: { beat: 42 }, params: { notes: F, beats: 3, attack: 0.1, release: 0.6 } },
    { at: { cue: 'outside' }, params: { notes: [C3, E3, G3, C4], beats: 3, attack: 0.05, release: 0.6 } },
    { at: { beat: 48 }, params: { notes: DM, beats: 2, attack: 0.1, release: 0.4 } },
  ],
  bass: [
    { at: { beat: 42 }, params: { note: F1 + 12, beats: 3, decay: 3, drive: 2 } },
    { at: { cue: 'outside' }, params: { note: C1 + 12, beats: 3, decay: 4, drive: 2 } },
    { at: { beat: 48 }, params: { note: D1 + 12, beats: 2, decay: 3, drive: 2 } },
  ],
  snap: at([...SHEET_BEATS]),
  clap: at([...SHEET_BEATS]),
  whoosh: [{ at: { cue: 'step-back' }, params: { seconds: 0.4, semitones: 2, direction: 'rightToLeft' } }],
  kickSoft: at([45, 47, 48, 49]),
  bell: [
    ...[C5, E5, G5].map((note) => ({ at: { cue: 'outside' }, params: { note, decay: 3 } })),
    { at: { cue: 'note' }, params: { note: D5, decay: 2 } },
  ],
  pop: [{ at: { cue: 'note' }, params: { fromHz: 360, octaves: 1, decay: 0.06 } }],
  tick: [
    { at: { cue: 'note' }, params: { toneHz: 2800, decay: 0.02 } },
    { at: { cue: 'stranger-looks' }, params: { toneHz: 1600, decay: 0.03 } },
  ],
};

/** Beats 50–64: dawn. The kit returns; OPEN climbs D F A C; a dive into silence; F major at the close. */
const DAWN: Part = {
  kick: bars(50, 1, 'x...x...x...x...').concat(bars(54, 1, 'x...x...........')),
  kickSoft: at([50, 51]),
  hat: bars(52, 1, 'xxxxxxxxxxxxxxxx'),
  clap: [...at([JOY]), ...bars(52, 1, '....x...........')],
  bass: [
    { at: { beat: 50 }, params: { note: G1 + 12, beats: 2, decay: 3, drive: 2.5 } },
    { at: { beat: 52 }, params: { note: BB0 + 12, beats: 2, decay: 3, drive: 2.5 } },
    { at: { beat: 54 }, params: { note: C1 + 12, beats: 1.75, decay: 3, drive: 2.5 } },
  ],
  pad: [
    { at: { beat: 50 }, params: { notes: GM, beats: 2, attack: 0.2, release: 0.2 } },
    { at: { beat: 52 }, params: { notes: BB, beats: 2, attack: 0.02, release: 0.2 } },
    { at: { beat: 54 }, params: { notes: C, beats: 1.75, attack: 0.02, release: 0.1 } },
  ],
  down: PEEL_BEATS.map((beat) => ({ at: { beat }, params: { beats: 0.5, octaves: 1 } })),
  bell: OPEN_BEATS.map((beat, k) => ({ at: { beat }, params: { note: [D5, F5, A5, C6][k] ?? D5, decay: 1.6 } })),
  tick: OPEN_BEATS.map((beat) => ({ at: { beat }, params: { toneHz: 1800, decay: 0.03 } })),
  snare: roll(54, DIVE),
  riser: [{ at: { cue: 'hush' }, anchor: 'end', params: { beats: 3.75, octaves: 2 } }],
  whoosh: [{ at: { cue: 'dive' }, params: { seconds: 0.3, semitones: 10, direction: 'leftToRight' } }],
  swell: [{ at: { cue: 'final' }, anchor: 'end', params: { beats: 0.5 } }],
};

/** The close: F major under the card, a bell on each of its reads. */
const CLOSE: Part = {
  impact: [{ at: { cue: 'final' }, params: { decay: 3, drive: 2, subHz: 29, metal: 0.3 } }],
  kick: at([FINAL]),
  pad: [{ at: { cue: 'final' }, params: { notes: [F2, A2, C3, F3, A3, C4], beats: 8, attack: 0.02, release: 3 } }],
  stab: [{ at: { cue: 'final' }, params: { notes: [F3, A3, C4], beats: 1, detune: 0.3 } }],
  bass: [{ at: { cue: 'final' }, params: { note: F1, beats: 4, decay: 4, drive: 1.8 } }],
  sub: [{ at: { cue: 'final' }, params: { toneHz: 44, decay: 2.5 } }],
  bell: [
    { at: { cue: 'final' }, params: { note: F5, decay: 4 } },
    { at: { cue: 'wordmark' }, params: { note: A5, decay: 3.5 } },
    ...[C6, A5, F5].map((note, k) => ({ at: { cue: `tag-${String(k + 1)}` }, params: { note, decay: 3.5 } })),
  ],
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
      { id: 'drums', role: 'music', effects: [], sidechain: { cueKinds: ['impact'], depthDb: 3, releaseFrames: 12 } },
      { id: 'bass', role: 'music', effects: [], sidechain: { cueKinds: ['impact', 'hit'], depthDb: 5, releaseFrames: 14 } },
      { id: 'keys', role: 'music', effects: [{ kind: 'reverb', rt60: 2.2, damping: 5000, mix: 0.22 }], sidechain: { cueKinds: ['impact', 'hit'], depthDb: 5, releaseFrames: 16 } },
      { id: 'bell', role: 'music', effects: [{ kind: 'delay', beats: 0.75, feedback: 0.3, mix: 0.18 }, { kind: 'reverb', rt60: 2.6, damping: 7000, mix: 0.3 }] },
      { id: 'hits', role: 'sfx', effects: [] },
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
    id: 'type-music-video',
    title: 'Coming Soon: type music video',
    seed: 'coming-soon/type-music-video',
    grid: GRID,
    beats: BEATS,
    shots: SHOTS,
    text: TEXT,
    cues: CUES,
  }),
  score: scoreOf([DOUBT_PART, GROOVE, NIGHT, DAWN, CLOSE]),
};
