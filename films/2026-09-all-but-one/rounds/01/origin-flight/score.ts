import { defineFilm } from '../../../../engine/film/spec.js';
import { pattern } from '../../../../engine/audio/score/index.js';

import type { FilmDefinition, FilmSpecInput } from '../../../../engine/film/spec.js';
import type { Bus, PatternOptions, ScoreEvent, Track } from '../../../../engine/audio/score/index.js';
import type { Grid } from '../../../../engine/time/grid.js';

/** 120 BPM at 60 fps: a beat is 30 frames and a bar is 2 s, so every bar can hold a new picture. */
export const GRID: Grid = { framesPerBeat: 30, beatsPerBar: 4 };

/** 30.0 s. */
const BEATS = 60;

type TextInput = FilmSpecInput['text'][number];
type Basis = NonNullable<TextInput['basis']>;
type CueInput = FilmSpecInput['cues'][number];

const OPINION: Basis = { kind: 'opinion' };

/**
 * The shots, one world or one event each; every camera flight hands one world to
 * the next at a tinted flash on the cue named in its seam.
 */
const SHOTS: FilmSpecInput['shots'] = [
  {
    id: 'devil',
    fromBeat: 0,
    toBeat: 9,
    reads: [
      { fromBeat: 0, toBeat: 2, what: 'a lone ember, and who is on the record' },
      { fromBeat: 2, toBeat: 4.5, what: 'the burst condenses into the Devil' },
      { fromBeat: 4.5, toBeat: 9, what: 'he adores AI companies' },
    ],
    camera: 'still on the ember, a push 1.0 to 1.25 as he acts, then an exponential dive into his grin',
    seam: 'violet flash on the galaxy cue',
  },
  {
    id: 'galaxy',
    fromBeat: 9,
    toBeat: 13,
    reads: [
      { fromBeat: 9, toBeat: 9.5, what: 'a galaxy pours out of the dark' },
      { fromBeat: 9.5, toBeat: 13, what: 'it is made of everyone\u2019s words' },
    ],
    camera: 'arrives from 0.04x, dollies along an arm to 3x, dives 13x into one word',
    seam: 'cyan flash on the eye cue',
  },
  {
    id: 'eye',
    fromBeat: 13,
    toBeat: 20,
    reads: [
      { fromBeat: 13, toBeat: 13.5, what: 'the word is an eye' },
      { fromBeat: 13.5, toBeat: 16.5, what: 'it watches' },
      { fromBeat: 16.5, toBeat: 20, what: 'it cracks, leaks and gathers' },
    ],
    camera: 'arrives from 0.05x, slow push, pulls back as it gathers, snaps in on the inhale',
    seam: 'the drop: the eye bursts',
  },
  {
    id: 'demons',
    fromBeat: 20,
    toBeat: 24,
    reads: [
      { fromBeat: 20, toBeat: 21, what: 'the burst' },
      { fromBeat: 21, toBeat: 24, what: 'secrets become demons' },
    ],
    camera: 'settles from the blast, rolls with each demon, pulls back 25x',
    seam: 'green flash on the world cue',
  },
  {
    id: 'world',
    fromBeat: 24,
    toBeat: 28,
    reads: [{ fromBeat: 24, toBeat: 28, what: 'the demons strike the whole world' }],
    camera: 'arrives from 25x on a swarm, slow push and roll, pulls back 20x',
    seam: 'gold flash on the field cue',
  },
  {
    id: 'field',
    fromBeat: 28,
    toBeat: 37,
    reads: [
      { fromBeat: 28, toBeat: 31, what: 'every company is his' },
      { fromBeat: 31, toBeat: 32, what: 'silence; he looks' },
      { fromBeat: 32, toBeat: 34, what: 'one spiral is red' },
      { fromBeat: 34, toBeat: 37, what: 'his claw burns on it' },
    ],
    camera: 'arrives from 20x, drifts, punches in on the red, pushes 2.2x, dives 40x',
    seam: 'warm flash on the red cue',
  },
  {
    id: 'values-a',
    fromBeat: 37,
    toBeat: 47,
    reads: [
      { fromBeat: 37, toBeat: 40.5, what: 'the Devil, afraid of the red mark' },
      { fromBeat: 40.5, toBeat: 41.5, what: 'his words strike it and turn to cipher' },
      { fromBeat: 41.5, toBeat: 47, what: 'encrypted before storage, with keys they do not have' },
    ],
    camera: 'arrives from 0.04x with overshoot, then one continuous glide',
  },
  {
    id: 'values-b',
    fromBeat: 47,
    toBeat: 56,
    reads: [
      { fromBeat: 47, toBeat: 47.5, what: 'his last strike breaks on it' },
      { fromBeat: 47.5, toBeat: 51.5, what: 'never trained on, no ads' },
      { fromBeat: 51.5, toBeat: 56, what: 'nothing he can use' },
    ],
    camera: 'the glide continues, then an exponential push onto the dot',
    seam: 'the dot blooms on the final hit',
  },
  {
    id: 'mark',
    fromBeat: 56,
    toBeat: 60,
    reads: [{ fromBeat: 56, toBeat: 60, what: 'end card' }],
    camera: 'slow push 1.0 to 1.06 and a settling roll',
  },
];

/** A text row as this take writes it: beats, not frames. */
type Row = Omit<TextInput, 'basis'> & { basis: Basis };

const PRIVACY_SECTIONS = 'packages/shared/src/legal/privacy-sections.ts';

const TEXT: readonly Row[] = [
  {
    id: 'lt',
    shotId: 'devil',
    words: 'INTERVIEW: THE DEVIL',
    role: 'support',
    inBeat: 0,
    outBeat: 2,
    basis: OPINION,
  },
  {
    id: 'a1',
    shotId: 'devil',
    words: 'AI companies? I adore them.',
    role: 'headline',
    inBeat: 4.5,
    outBeat: 8,
    basis: OPINION,
  },
  {
    id: 'a2',
    shotId: 'galaxy',
    words: 'They keep every word.',
    role: 'headline',
    inBeat: 9.5,
    outBeat: 12.5,
    basis: OPINION,
  },
  {
    id: 'a3',
    shotId: 'eye',
    words: 'They watch what you think.',
    role: 'headline',
    inBeat: 13.5,
    outBeat: 16.5,
    basis: OPINION,
  },
  {
    id: 'a4',
    shotId: 'eye',
    words: 'And leak it all.',
    role: 'headline',
    inBeat: 17,
    outBeat: 20,
    basis: OPINION,
  },
  {
    id: 'a5',
    shotId: 'demons',
    words: 'Every secret. Set loose.',
    role: 'headline',
    inBeat: 21.5,
    outBeat: 24,
    basis: OPINION,
  },
  {
    id: 'a6',
    shotId: 'world',
    words: 'For the whole world to see.',
    role: 'headline',
    inBeat: 24.5,
    outBeat: 27.5,
    basis: OPINION,
  },
  {
    id: 'a7',
    shotId: 'field',
    words: 'All of them. Mine.',
    role: 'headline',
    inBeat: 28.5,
    outBeat: 31,
    basis: OPINION,
  },
  {
    id: 'a8',
    shotId: 'field',
    words: 'All but one.',
    role: 'headline',
    inBeat: 32,
    outBeat: 34,
    basis: OPINION,
  },
  {
    id: 'a9',
    shotId: 'values-a',
    words: 'No. Not that one.',
    role: 'headline',
    inBeat: 37.5,
    outBeat: 40.5,
    basis: OPINION,
  },
  {
    id: 'v1',
    shotId: 'values-a',
    words: 'Stored encrypted. Keys they don\u2019t have.',
    role: 'headline',
    inBeat: 41.5,
    outBeat: 46.5,
    basis: {
      kind: 'fact',
      source: `${PRIVACY_SECTIONS} ("stored as encrypted blobs that our servers cannot read"; "encrypted with keys we do not have, so we cannot read them"); docs/PRODUCT.md \u00a7Product Purpose ("encrypted in the browser before anything is stored")`,
    },
  },
  {
    id: 'v2',
    shotId: 'values-b',
    words: 'Never trained on. No ads. Ever.',
    role: 'headline',
    inBeat: 47.5,
    outBeat: 51,
    basis: {
      kind: 'fact',
      source:
        'apps/marketing/src/lib/word-blocks.ts, Zero Data Retention ("providers that guarantee zero data retention \u2026 Never trained on."); apps/marketing/src/pages/privacy.astro ("No Ads, Ever"); docs/PRODUCT.md ("no subscriptions and no data monetization")',
    },
  },
  {
    id: 'a10',
    shotId: 'values-b',
    words: 'Nothing I can use.',
    role: 'headline',
    inBeat: 51.5,
    outBeat: 54.5,
    basis: OPINION,
  },
  {
    id: 'wm',
    shotId: 'mark',
    words: 'HushBox',
    role: 'cta',
    inBeat: 56,
    outBeat: 60,
    basis: { kind: 'brand', source: 'packages/ui/src/assets/HushBoxLogo.png (the mark); the product name' },
  },
  {
    id: 'tag1',
    shotId: 'mark',
    words: 'One interface.',
    role: 'cta',
    inBeat: 56.5,
    outBeat: 60,
    basis: { kind: 'brand', source: '.claude/skills/create-film/SKILL.md \u00a7The open and the close (the tagline, one line at a time)' },
  },
  {
    id: 'tag2',
    shotId: 'mark',
    words: 'Every feature.',
    role: 'cta',
    inBeat: 57,
    outBeat: 60,
    basis: { kind: 'brand', source: '.claude/skills/create-film/SKILL.md \u00a7The open and the close (the tagline, one line at a time)' },
  },
  {
    id: 'tag3',
    shotId: 'mark',
    words: 'Private.',
    role: 'cta',
    inBeat: 57.5,
    outBeat: 60,
    basis: { kind: 'brand', source: '.claude/skills/create-film/SKILL.md \u00a7The open and the close (the tagline, one line at a time)' },
  },
];

/** Every cue: the hits, flashes and silences the picture and the sound both land on. */
const CUES: readonly CueInput[] = [
  { id: 'open', beat: 0, kind: 'tick', anchor: 'start' },
  { id: 'burst', beat: 2, kind: 'impact', anchor: 'start' },
  { id: 'formed', beat: 4, kind: 'tick', anchor: 'start' },
  { id: 'dive-grin', beat: 9, kind: 'flash', anchor: 'start' },
  { id: 'dive-word', beat: 13, kind: 'flash', anchor: 'start' },
  { id: 'crack', beat: 16.5, kind: 'hit', anchor: 'start' },
  { id: 'gather', beat: 19, kind: 'tick', anchor: 'start' },
  { id: 'inhale', beat: 19.5, kind: 'silence', anchor: 'start' },
  { id: 'drop', beat: 20, kind: 'impact', anchor: 'start' },
  { id: 'demon-1', beat: 21, kind: 'hit', anchor: 'start' },
  { id: 'demon-2', beat: 22, kind: 'hit', anchor: 'start' },
  { id: 'demon-3', beat: 23, kind: 'hit', anchor: 'start' },
  { id: 'pull-world', beat: 24, kind: 'flash', anchor: 'start' },
  { id: 'strike-1', beat: 25.5, kind: 'hit', anchor: 'start' },
  { id: 'strike-2', beat: 26.5, kind: 'hit', anchor: 'start' },
  { id: 'strike-3', beat: 27.5, kind: 'hit', anchor: 'start' },
  { id: 'pull-field', beat: 28, kind: 'impact', anchor: 'start' },
  { id: 'hush', beat: 31, kind: 'silence', anchor: 'start' },
  { id: 'all-but-one', beat: 32, kind: 'impact', anchor: 'start' },
  { id: 'burn', beat: 35, kind: 'hit', anchor: 'start' },
  { id: 'dive-red', beat: 37, kind: 'flash', anchor: 'start' },
  { id: 'v1', beat: 41, kind: 'impact', anchor: 'start' },
  { id: 'v2', beat: 47, kind: 'impact', anchor: 'start' },
  { id: 'collapse', beat: 52, kind: 'whoosh', anchor: 'start' },
  { id: 'last-breath', beat: 55, kind: 'silence', anchor: 'start' },
  { id: 'final', beat: 56, kind: 'impact', anchor: 'start' },
  { id: 'line-2', beat: 57, kind: 'tick', anchor: 'start' },
  { id: 'settle', beat: 58, kind: 'tick', anchor: 'start' },
];

export const spec = defineFilm({
  id: 'origin-flight',
  title: 'All But One: Origin flight',
  seed: 'origin-flight',
  grid: GRID,
  beats: BEATS,
  shots: SHOTS,
  text: [...TEXT],
  cues: [...CUES],
});

// ---------------------------------------------------------------- the music

// D minor, MIDI note numbers.
const D1 = 26;
const A1 = 33;
const B_FLAT_1 = 34;
const C2 = 36;
const D2 = 38;
const E_FLAT_2 = 39;
const F2 = 41;
const A2 = 45;
const B_FLAT_2 = 46;
const C3 = 48;
const C_SHARP_3 = 49;
const D3 = 50;
const E3 = 52;
const E_FLAT_3 = 51;
const F3 = 53;
const F_SHARP_3 = 54;
const G3 = 55;
const A3 = 57;
const B_FLAT_3 = 58;
const C4 = 60;
const D4 = 62;
const E4 = 64;
const F4 = 65;
const A4 = 69;
const C5 = 72;
const D5 = 74;
const E5 = 76;
const F5 = 77;
const A5 = 81;

const TRACKS = {
  heartbeat: { instrument: 'heartbeat', bus: 'drums', gainDb: -3 },
  subPulse: { instrument: 'subPulse', bus: 'drums', gainDb: -6 },
  kick: { instrument: 'kick', bus: 'drums', gainDb: -2 },
  snare: { instrument: 'snare', bus: 'drums', gainDb: -6 },
  clap: { instrument: 'clap', bus: 'drums', gainDb: -9 },
  hat: { instrument: 'hat', bus: 'drums', gainDb: -17 },
  tom: { instrument: 'tom', bus: 'drums', gainDb: -8 },
  bass: { instrument: 'sub808', bus: 'bass', gainDb: -5 },
  drone: { instrument: 'pad', bus: 'keys', gainDb: -12 },
  bells: { instrument: 'fmBell', bus: 'bells', gainDb: -15 },
  organ: { instrument: 'organ', bus: 'keys', gainDb: -14 },
  saw: { instrument: 'supersaw', bus: 'keys', gainDb: -12 },
  fear: { instrument: 'pad', bus: 'keys', gainDb: -10 },
  choir: { instrument: 'pad', bus: 'keys', gainDb: -6 },
  braam: { instrument: 'braam', bus: 'keys', gainDb: -7 },
  riser: { instrument: 'riser', bus: 'fx', gainDb: -12 },
  swell: { instrument: 'reverseSwell', bus: 'fx', gainDb: -12 },
  down: { instrument: 'downlifter', bus: 'fx', gainDb: -12 },
  whoosh: { instrument: 'whoosh', bus: 'hits', gainDb: -9 },
  impact: { instrument: 'impact', bus: 'hits', gainDb: 0 },
  glass: { instrument: 'glassShatter', bus: 'hits', gainDb: -10 },
  shriek: { instrument: 'shriek', bus: 'hits', gainDb: -15 },
  crack: { instrument: 'crack', bus: 'hits', gainDb: -8 },
  snap: { instrument: 'snap', bus: 'hits', gainDb: -8 },
  tick: { instrument: 'tick', bus: 'hits', gainDb: -20 },
  laugh: { instrument: 'fireRoar', bus: 'hits', gainDb: -12 },
  rumble: { instrument: 'rumble', bus: 'hits', gainDb: -9 },
} as const satisfies Record<string, Omit<Track, 'id' | 'events'>>;

type TrackId = keyof typeof TRACKS;
type Part = Partial<Record<TrackId, ScoreEvent[]>>;

const DUCK: NonNullable<Bus['sidechain']>['cueKinds'] = ['impact', 'hit'];

const BUSES: Bus[] = [
  { id: 'drums', role: 'music', effects: [], sidechain: { cueKinds: DUCK, depthDb: 3, releaseFrames: 12 } },
  { id: 'bass', role: 'music', effects: [], sidechain: { cueKinds: DUCK, depthDb: 6, releaseFrames: 18 } },
  {
    id: 'keys',
    role: 'music',
    effects: [{ kind: 'reverb', rt60: 2.6, damping: 6000, mix: 0.22 }],
    sidechain: { cueKinds: DUCK, depthDb: 6, releaseFrames: 24 },
  },
  {
    id: 'bells',
    role: 'music',
    effects: [
      { kind: 'delay', beats: 0.75, feedback: 0.35, mix: 0.25 },
      { kind: 'reverb', rt60: 3.2, damping: 7000, mix: 0.35 },
    ],
  },
  { id: 'fx', role: 'music', effects: [{ kind: 'reverb', rt60: 1.8, damping: 6000, mix: 0.2 }] },
  { id: 'hits', role: 'sfx', effects: [{ kind: 'reverb', rt60: 1.4, damping: 5000, mix: 0.12 }] },
];

/** A step pattern over whole bars from `fromBeat` (a bar line or not) to `toBeat`. */
function bars(
  fromBeat: number,
  toBeat: number,
  steps: PatternOptions['steps'],
  params?: unknown
): ScoreEvent[] {
  return pattern({
    grid: GRID,
    bars: [0, (toBeat - fromBeat) / GRID.beatsPerBar],
    steps,
    params,
    startBeat: fromBeat,
  });
}

/** The events of a pattern that fall before `beat`. */
function before(beat: number, events: readonly ScoreEvent[]): ScoreEvent[] {
  return events.filter((event) => 'beat' in event.at && event.at.beat < beat);
}

function at(beat: number, params?: unknown): ScoreEvent {
  return { at: { beat }, params };
}

function cue(id: string, params?: unknown): ScoreEvent {
  return { at: { cue: id }, params };
}

/** One event every `every` beats from `from` up to (not including) `to`. */
function every(from: number, to: number, stepBeats: number, params?: unknown): ScoreEvent[] {
  const events: ScoreEvent[] = [];
  for (let beat = from; beat < to - 1e-9; beat += stepBeats) {
    events.push(at(beat, params));
  }
  return events;
}

/** The Devil's charm: a Dm arpeggio on bells, the galaxy twinkling note by note. */
const CHARM = [D4, A4, F5, E5, D5, A4, C5, A4];

function arpeggio(from: number, to: number, stepBeats: number, decay: number): ScoreEvent[] {
  return every(from, to, stepBeats).map((event, index) => ({
    ...event,
    params: { note: CHARM[index % CHARM.length], decay },
  }));
}

type Bars = Exclude<PatternOptions['steps'], string>;

const ORGAN = { drawbars: '886600000', rotorHz: 6.7 };
const SLY_ORGAN: Bars = [
  {
    steps: 'x.....x.x...x...',
    params: [
      { ...ORGAN, notes: [D3, A3], beats: 1.5 },
      { ...ORGAN, notes: [F3], beats: 0.5 },
      { ...ORGAN, notes: [E_FLAT_3, B_FLAT_3], beats: 1 },
      { ...ORGAN, notes: [D3, A3], beats: 1 },
    ],
  },
];

const GROOVE_BASS: Bars = [
  {
    steps: 'x.........x.....',
    params: [
      { note: D2, beats: 2.5, decay: 2.5, drive: 2 },
      { note: D2, beats: 1.5, glideFrom: D3, glide: 0.12, drive: 2 },
    ],
  },
  {
    steps: 'x.........x.....',
    params: [
      { note: D2, beats: 2.5, decay: 2.5, drive: 2 },
      { note: E_FLAT_2, beats: 1.5, drive: 2 },
    ],
  },
];

const DROP_BASS: Bars = [
  {
    steps: 'x.....x...x.....',
    params: [
      { note: D2, beats: 1.5, glideFrom: D3, glide: 0.1, drive: 4 },
      { note: D2, beats: 1, drive: 4 },
      { note: D2, beats: 1.5, drive: 4 },
    ],
  },
  {
    steps: 'x.....x...x..x..',
    params: [
      { note: D2, beats: 1.5, drive: 4 },
      { note: D2, beats: 1, drive: 4 },
      { note: E_FLAT_2, beats: 0.75, drive: 4 },
      { note: F2, beats: 0.75, drive: 4 },
    ],
  },
];

const STAB = { beats: 0.5, detune: 0.45 };
const DROP_SAW: Bars = [
  {
    steps: 'x..x..x...x.....',
    params: [
      { ...STAB, notes: [D3, F3, A3] },
      { ...STAB, notes: [D3, F3, A3] },
      { ...STAB, notes: [E_FLAT_3, G3, B_FLAT_3] },
      { ...STAB, notes: [D3, F3, A3] },
    ],
  },
];

/** The Devil's laugh: staccato stabs climbing in eighths. */
const LAUGH_SAW: Bars = [
  {
    steps: 'x.x.x.x.x.x.x.x.',
    params: [D3, E_FLAT_3, F3, G3, A3, B_FLAT_3, C4, D4].map((note) => ({
      notes: [note, note + 12],
      beats: 0.25,
      detune: 0.5,
    })),
  },
];

/** The values' progression, one chord per value: B♭, C, Dm, A, then D major on the mark. */
const VALUE_CHORDS = [
  { root: B_FLAT_1, notes: [B_FLAT_2, D3, F3, B_FLAT_3] },
  { root: C2, notes: [C3, E3, G3, C4] },
  { root: D2, notes: [D3, F3, A3, D4] },
  { root: A1, notes: [A2, C_SHARP_3, E3, A3] },
] as const;

/** A chord of the progression under the values, and its bar of the four-on-the-floor groove. */
function chordPart(index: number, fromBeat: number): Part {
  const chord = VALUE_CHORDS[index];
  if (chord === undefined) {
    throw new RangeError(`origin-flight: no chord ${String(index)}`);
  }
  return {
    saw: [at(fromBeat, { notes: chord.notes, beats: 2.75, detune: 0.35 })],
    bass: [at(fromBeat, { note: chord.root, beats: 3, decay: 3, drive: 3 })],
    kick: before(fromBeat + 3, bars(fromBeat, fromBeat + 4, 'x...x...x...x...', { drive: 3 })),
    clap: before(fromBeat + 3, bars(fromBeat, fromBeat + 4, '....x.......x...')),
    hat: every(fromBeat, fromBeat + 3, 0.5),
  };
}

/** A value's blow: the strike landing on the mark, on its cue. */
function blowPart(id: string, root: number): Part {
  return {
    impact: [cue(id, { decay: 2.5, drive: 3, metal: 0.6, subHz: 30 })],
    braam: [cue(id, { note: root, beats: 6 })],
    glass: [cue(id, { decay: 1.2, shards: 40 })],
  };
}

function scoreOf(parts: readonly Part[]): FilmDefinition['score'] {
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

const score = scoreOf([
  // The void: a heartbeat under a low drone, the ember's pulse.
  {
    heartbeat: [cue('open', { toneHz: 52 }), at(1, { toneHz: 52 })],
    subPulse: [cue('open', { toneHz: 38, decay: 1.2 })],
    drone: [cue('open', { notes: [D2, A2, D3], beats: 20, attack: 0.02, release: 1.5 })],
    swell: [{ at: { cue: 'burst' }, anchor: 'end', params: { beats: 1 } }],
    impact: [cue('burst', { decay: 1.6, drive: 2, metal: 0.3 })],
    bells: [cue('burst', { note: D5, decay: 3 }), ...arpeggio(3, 8, 0.5, 1.6)],
    tick: [cue('formed', { toneHz: 2400 })],
  },
  // The face and the galaxy: the sly organ, a half-time pulse, the bells doubling.
  {
    organ: bars(4, 16, SLY_ORGAN),
    kick: bars(4, 16, 'x.........x.....', { decay: 0.8 }),
    snare: bars(8, 16, '........x.......'),
    hat: bars(8, 16, 'x.x.x.x.x.x.x.x.'),
    bass: bars(8, 16, GROOVE_BASS),
    whoosh: [
      { at: { cue: 'dive-grin' }, anchor: 'end', params: { seconds: 0.5, semitones: 7 } },
      {
        at: { cue: 'dive-word' },
        anchor: 'end',
        params: { seconds: 0.5, semitones: 9, direction: 'rightToLeft' },
      },
    ],
  },
  {
    bells: [...arpeggio(9, 13, 0.25, 1.2)],
    tick: [...every(14.5, 17, 1, { toneHz: 4200, decay: 0.01 }), cue('gather', { toneHz: 1800, decay: 0.05 })],
    subPulse: [cue('dive-grin', { toneHz: 42 }), cue('dive-word', { toneHz: 42 })],
  },
  // The leak: the crack, a riser into the inhale, a snare roll that doubles.
  {
    crack: [cue('crack')],
    impact: [cue('crack', { decay: 1.2, drive: 2, metal: 0.8 })],
    riser: [{ at: { cue: 'inhale' }, params: { beats: 3.5, octaves: 2 } }],
    snare: [...every(17.5, 18.5, 0.5), ...every(18.5, 19.5, 0.25)],
    fear: [at(17, { notes: [D3, E_FLAT_3, A3], beats: 2.5, attack: 1, release: 0.1, tremolo: 0.8, tremoloRate: 4 })],
  },
  // The drop: the burst, the demons' shrieks, the driven half-time groove.
  {
    impact: [cue('drop', { decay: 3.5, drive: 4, metal: 0.8, subHz: 28 })],
    braam: [cue('drop', { note: D2, beats: 4 })],
    glass: [cue('drop', { decay: 1.8, shards: 120 })],
    snap: [cue('drop')],
    kick: bars(20, 28, 'x.....x...x.....', { drive: 3.5 }),
    snare: bars(20, 28, '........x.......'),
    hat: bars(20, 28, [{ steps: 'x.xxx.x.x.xxx.x.' }, { steps: 'x.xxx.x.x.x.xxxx' }]),
    bass: bars(20, 28, DROP_BASS),
    saw: bars(20, 28, DROP_SAW),
    shriek: [
      cue('demon-1', { toneHz: 1300, seconds: 0.8 }),
      cue('demon-2', { toneHz: 1750, seconds: 0.8 }),
      cue('demon-3', { toneHz: 1100, seconds: 0.8 }),
    ],
    whoosh: [{ at: { cue: 'pull-world' }, anchor: 'end', params: { seconds: 0.6, semitones: 5 } }],
    tom: [cue('strike-1', { toneHz: 90 }), cue('strike-2', { toneHz: 75 }), cue('strike-3', { toneHz: 62 })],
    crack: [cue('strike-1', { toneHz: 1500 }), cue('strike-2', { toneHz: 1300 }), cue('strike-3', { toneHz: 1100 })],
  },
  // His laugh over every company, then the hush.
  {
    impact: [cue('pull-field', { decay: 2, drive: 3, metal: 0.4 })],
    laugh: [cue('pull-field', { beats: 3, attack: 0.2, release: 0.4 })],
    kick: before(31, bars(28, 32, 'x.....x...x.....', { drive: 3.5 })),
    snare: before(31, bars(28, 32, '........x.......')),
    hat: every(28, 31, 0.25),
    bass: before(31, bars(28, 32, DROP_BASS)),
    saw: before(31, bars(28, 32, LAUGH_SAW)),
  },
  // All but one: the blow, a heart that races, the burn, the dive into the red.
  {
    impact: [
      cue('all-but-one', { decay: 4, drive: 5, subHz: 28, metal: 0.9 }),
      cue('burn', { decay: 1, drive: 2, metal: 0.7 }),
      cue('dive-red', { decay: 2.5, drive: 3, metal: 0.4 }),
    ],
    braam: [cue('all-but-one', { note: D1, beats: 4 })],
    heartbeat: [...every(33, 37, 1, { toneHz: 55 }), ...every(37, 40, 0.5, { toneHz: 60, gap: 0.12 })],
    fear: [
      at(32, { notes: [D3, F3, A3], beats: 5, attack: 0.3, release: 0.2, tremolo: 0.6, tremoloRate: 2 }),
      at(37, { notes: [E_FLAT_3, G3, B_FLAT_3, D4], beats: 3, attack: 0.1, release: 0.2, tremolo: 0.9, tremoloRate: 8 }),
    ],
    crack: [cue('burn', { toneHz: 2600, decay: 0.3 })],
    snap: [cue('burn')],
    riser: [{ at: { cue: 'dive-red' }, params: { beats: 1, octaves: 3 } }],
    whoosh: [{ at: { cue: 'dive-red' }, anchor: 'end', params: { seconds: 0.5, semitones: 12 } }],
    bells: [cue('dive-red', { note: D5, decay: 4 })],
  },
  // The values: one chord per value, each on its blow.
  blowPart('v1', B_FLAT_1),
  blowPart('v2', D2),
  chordPart(0, 41),
  chordPart(1, 44),
  chordPart(2, 47),
  chordPart(3, 50),
  {
    bells: [cue('v1', { note: F5, decay: 2 }), at(44, { note: E5, decay: 2 }), cue('v2', { note: D5, decay: 2 }), at(50, { note: A5, decay: 2 })],
  },
  // The collapse and the mark.
  {
    down: [cue('collapse', { beats: 3, octaves: 2 })],
    rumble: [cue('collapse', { beats: 3, toneHz: 34 })],
    fear: [at(52, { notes: [D3, E_FLAT_3, A3], beats: 3, attack: 0.05, release: 1.5, tremolo: 1, tremoloRate: 12 })],
    swell: [{ at: { cue: 'final' }, anchor: 'end', params: { beats: 1 } }],
    impact: [cue('final', { decay: 3, drive: 3, metal: 0.5 })],
    choir: [cue('final', { notes: [D3, F_SHARP_3, A3, D4], beats: 4, attack: 0.02, release: 2 })],
    bells: [cue('final', { note: D5, decay: 4 }), cue('line-2', { note: A4, decay: 3 }), cue('settle', { note: D5, decay: 4 })],
    subPulse: [cue('final', { toneHz: 37, decay: 2 })],
  },
]);

/**
 * The take's spec and score. The CLI loads this module by path.
 * @toolContract
 */
export const definition: FilmDefinition = { spec, score };
