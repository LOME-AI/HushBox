import type { FilmSpecInput } from '../../../../engine/film/spec.js';
import type { Grid } from '../../../../engine/time/grid.js';

/** 120 BPM at 60 fps: a beat is 30 frames, a half beat 15. */
export const GRID: Grid = { framesPerBeat: 30, beatsPerBar: 4 };

/** Sixty beats: 30.0 s. */
export const BEATS = 60;

export const FPB = GRID.framesPerBeat;

/** The frame a beat lands on. */
export function F(beat: number): number {
  return beat * FPB;
}

type TextInput = FilmSpecInput['text'][number];
type Basis = NonNullable<TextInput['basis']>;
type CueInput = FilmSpecInput['cues'][number];

const OPINION: Basis = { kind: 'opinion' };

/** How a row is set: the keynote's own copy in the brand sans, the Devil's voice in the brand serif italic. */
export type Voice = 'keynote' | 'devil' | 'secret' | 'brand';

export interface Row {
  id: string;
  words: string;
  role: TextInput['role'];
  inBeat: number;
  outBeat: number;
  voice: Voice;
  basis?: Basis;
}

/** Every line the take draws, in order. */
export const ROWS: readonly Row[] = [
  { id: 't1', words: 'The Devil loves AI.', role: 'headline', inBeat: 3.5, outBeat: 7, voice: 'keynote', basis: OPINION },
  { id: 't2', words: 'It keeps every word.', role: 'headline', inBeat: 7, outBeat: 11, voice: 'keynote', basis: OPINION },
  { id: 't3', words: 'It watches your thoughts.', role: 'headline', inBeat: 11, outBeat: 13.5, voice: 'keynote', basis: OPINION },
  { id: 't4', words: 'And one day, it leaks.', role: 'headline', inBeat: 13.5, outBeat: 16, voice: 'keynote', basis: OPINION },
  { id: 's1', words: "I'm in love with my best friend.", role: 'imagery', inBeat: 16, outBeat: 17.5, voice: 'secret' },
  { id: 't5', words: 'Every secret, set loose.', role: 'headline', inBeat: 17.5, outBeat: 20, voice: 'keynote', basis: OPINION },
  { id: 's2', words: 'I lied about the money.', role: 'imagery', inBeat: 20, outBeat: 23, voice: 'secret' },
  { id: 't6', words: 'I love them all.', role: 'headline', inBeat: 24.5, outBeat: 27.5, voice: 'devil', basis: OPINION },
  { id: 't7', words: 'All…', role: 'headline', inBeat: 28, outBeat: 30, voice: 'devil', basis: OPINION },
  { id: 't8', words: '…but one.', role: 'headline', inBeat: 30, outBeat: 32, voice: 'devil', basis: OPINION },
  {
    id: 'v1',
    words: 'Saved chats: locked, even from HushBox.',
    role: 'headline',
    inBeat: 32,
    outBeat: 36,
    voice: 'devil',
    basis: { kind: 'fact', source: 'README.md:58' },
  },
  {
    id: 'v2',
    words: 'No ads. Your data, never sold.',
    role: 'headline',
    inBeat: 36,
    outBeat: 40,
    voice: 'devil',
    basis: { kind: 'fact', source: 'packages/shared/src/legal/privacy-sections.ts:43' },
  },
  {
    id: 'v3',
    words: 'Every line of code, published.',
    role: 'headline',
    inBeat: 40,
    outBeat: 44,
    voice: 'devil',
    basis: { kind: 'fact', source: 'apps/marketing/src/lib/word-blocks.ts:33' },
  },
  { id: 'p', words: 'Please… use anything else.', role: 'headline', inBeat: 44.5, outBeat: 47.5, voice: 'devil', basis: OPINION },
  { id: 'wm', words: 'HushBox', role: 'cta', inBeat: 50, outBeat: 60, voice: 'brand', basis: { kind: 'brand', source: 'README.md' } },
  {
    id: 'tag',
    words: 'One interface. Every feature. Private.',
    role: 'cta',
    inBeat: 52,
    outBeat: 60,
    voice: 'brand',
    basis: { kind: 'brand', source: 'packages/shared/src/brand/tagline.ts' },
  },
  { id: 'url', words: 'hushbox.ai', role: 'cta', inBeat: 55, outBeat: 60, voice: 'brand', basis: { kind: 'brand', source: 'README.md' } },
];

/** Every cue: a visible action on its frame, and its sound. */
export const CUES: readonly CueInput[] = [
  { id: 'launch', beat: 0, kind: 'hit', anchor: 'start' },
  { id: 'apex', beat: 1, kind: 'tick', anchor: 'start' },
  { id: 'land', beat: 2, kind: 'hit', anchor: 'start' },
  { id: 'horns', beat: 3, kind: 'whoosh', anchor: 'start' },
  { id: 'eyes', beat: 3.5, kind: 'tick', anchor: 'start' },
  { id: 'wink', beat: 5, kind: 'tick', anchor: 'start' },
  { id: 'preen', beat: 6, kind: 'tick', anchor: 'start' },
  { id: 'grin', beat: 7, kind: 'hit', anchor: 'start' },
  { id: 'type', beat: 7.5, kind: 'tick', anchor: 'start' },
  { id: 'stack-1', beat: 8.5, kind: 'tick', anchor: 'start' },
  { id: 'stack-2', beat: 9.5, kind: 'tick', anchor: 'start' },
  { id: 'stack-3', beat: 10.5, kind: 'tick', anchor: 'start' },
  { id: 'pullout', beat: 11, kind: 'impact', anchor: 'start' },
  { id: 'swarm', beat: 11.5, kind: 'whoosh', anchor: 'start' },
  { id: 'iris', beat: 12, kind: 'hit', anchor: 'start' },
  { id: 'look-1', beat: 12.5, kind: 'tick', anchor: 'start' },
  { id: 'look-2', beat: 13, kind: 'tick', anchor: 'start' },
  { id: 'blink', beat: 13.5, kind: 'hit', anchor: 'start' },
  { id: 'crack-1', beat: 14, kind: 'hit', anchor: 'start' },
  { id: 'crack-2', beat: 14.5, kind: 'hit', anchor: 'start' },
  { id: 'crack-3', beat: 15, kind: 'hit', anchor: 'start' },
  { id: 'gap-drop', beat: 15.5, kind: 'silence', anchor: 'start' },
  { id: 'drop', beat: 16, kind: 'impact', anchor: 'start' },
  { id: 'swoop-1', beat: 17, kind: 'hit', anchor: 'start' },
  { id: 'swoop-2', beat: 19, kind: 'hit', anchor: 'start' },
  { id: 'swoop-3', beat: 21, kind: 'hit', anchor: 'start' },
  { id: 'converge', beat: 23, kind: 'whoosh', anchor: 'start' },
  { id: 'face', beat: 24, kind: 'impact', anchor: 'start' },
  { id: 'ha-1', beat: 25, kind: 'hit', anchor: 'start' },
  { id: 'ha-2', beat: 25.5, kind: 'hit', anchor: 'start' },
  { id: 'ha-3', beat: 26, kind: 'hit', anchor: 'start' },
  { id: 'ha-4', beat: 26.5, kind: 'hit', anchor: 'start' },
  { id: 'dive', beat: 27.5, kind: 'whoosh', anchor: 'start' },
  { id: 'gap-all', beat: 28, kind: 'silence', anchor: 'start' },
  { id: 'one', beat: 30, kind: 'impact', anchor: 'start' },
  { id: 'splat-1', beat: 31, kind: 'hit', anchor: 'start' },
  { id: 'splat-2', beat: 31.5, kind: 'hit', anchor: 'start' },
  { id: 'blast', beat: 32, kind: 'impact', anchor: 'start' },
  { id: 'shackle', beat: 33, kind: 'hit', anchor: 'start' },
  { id: 'pry-1', beat: 34, kind: 'tick', anchor: 'start' },
  { id: 'pry-2', beat: 35, kind: 'tick', anchor: 'start' },
  { id: 'tags', beat: 36, kind: 'hit', anchor: 'start' },
  { id: 'tag-2', beat: 36.5, kind: 'hit', anchor: 'start' },
  { id: 'tag-3', beat: 37, kind: 'hit', anchor: 'start' },
  { id: 'shatter', beat: 38, kind: 'impact', anchor: 'start' },
  { id: 'code', beat: 40, kind: 'hit', anchor: 'start' },
  { id: 'scroll-1', beat: 41, kind: 'tick', anchor: 'start' },
  { id: 'scroll-2', beat: 42, kind: 'tick', anchor: 'start' },
  { id: 'scroll-3', beat: 43, kind: 'tick', anchor: 'start' },
  { id: 'plea', beat: 44, kind: 'hit', anchor: 'start' },
  { id: 'tremble', beat: 46, kind: 'tick', anchor: 'start' },
  { id: 'dot', beat: 47, kind: 'hit', anchor: 'start' },
  { id: 'flee', beat: 47.5, kind: 'whoosh', anchor: 'start' },
  { id: 'reveal', beat: 48, kind: 'impact', anchor: 'start' },
  { id: 'arcs', beat: 49, kind: 'tick', anchor: 'start' },
  { id: 'word', beat: 50, kind: 'hit', anchor: 'start' },
  { id: 'tag-a', beat: 52, kind: 'tick', anchor: 'start' },
  { id: 'tag-b', beat: 53, kind: 'tick', anchor: 'start' },
  { id: 'tag-c', beat: 54, kind: 'tick', anchor: 'start' },
  { id: 'url', beat: 55, kind: 'tick', anchor: 'start' },
];

/** A cue's frame, by id. */
export function cueFrame(id: string): number {
  const cue = CUES.find((c) => c.id === id);
  if (cue === undefined) {
    throw new Error(`one-take-launch: no cue ${id}`);
  }
  return F(cue.beat);
}

/** Cues whose kind shakes and punches the camera, with their weight. */
export const IMPACT_WEIGHT: Readonly<Record<string, number>> = {
  launch: 0.35,
  land: 0.5,
  horns: 0.3,
  grin: 0.4,
  pullout: 0.5,
  iris: 0.45,
  blink: 0.5,
  'crack-1': 0.35,
  'crack-2': 0.5,
  'crack-3': 0.7,
  drop: 1,
  'swoop-1': 0.35,
  'swoop-2': 0.35,
  'swoop-3': 0.35,
  face: 0.9,
  'ha-1': 0.45,
  'ha-2': 0.4,
  'ha-3': 0.5,
  'ha-4': 0.55,
  one: 1,
  'splat-1': 0.35,
  'splat-2': 0.4,
  blast: 0.8,
  shackle: 0.45,
  tags: 0.3,
  'tag-2': 0.3,
  'tag-3': 0.3,
  shatter: 0.8,
  code: 0.45,
  plea: 0.3,
  dot: 0.3,
  reveal: 0.9,
  word: 0.35,
};
