import { z } from 'zod';

import { FPS, beatToFrame, bpmOf } from '../time/grid.js';

import type { ScoreInput } from '../audio/score/index.js';
import type { Grid } from '../time/grid.js';

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The shortest hold of any copy text block. */
const TEXT_MIN_HOLD_SECONDS = 0.8;

/** The fastest copy may ask a viewer to read: Netflix's 20 characters per second ceiling. */
const TEXT_MAX_CHARS_PER_SECOND = 20;

const idSchema = z.string().min(1);
const beatSchema = z.number().nonnegative();
/** A shot's direction in words: its framing, camera, event, or seam (how it meets the next shot). */
const directionSchema = z.string().min(1);

const cueKindSchema = z.enum([
  'hit',
  'impact',
  'whoosh',
  'tick',
  'silence',
  'stutter',
  'flash',
  'riser-end',
]);

const gridSchema = z.object({
  framesPerBeat: z.int().positive(),
  beatsPerBar: z.int().positive(),
}) satisfies z.ZodType<Grid>;

const basisSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fact'), source: z.string().min(1) }),
  z.object({ kind: z.literal('opinion') }),
  z.object({ kind: z.literal('brand'), source: z.string().min(1) }),
]);

export const filmSpecInputSchema = z.object({
  id: z.string().regex(KEBAB_CASE, 'must be kebab-case'),
  title: z.string(),
  seed: z.string(),
  grid: gridSchema,
  beats: z.int().positive(),
  /** Optional until a film's look is ported; a spec without shots runs no shot check. */
  shots: z
    .array(
      z.object({
        id: idSchema,
        fromBeat: beatSchema,
        toBeat: beatSchema,
        reads: z.array(z.object({ fromBeat: beatSchema, toBeat: beatSchema, what: z.string() })),
        framing: directionSchema.optional(),
        camera: directionSchema.optional(),
        event: directionSchema.optional(),
        seam: directionSchema.optional(),
      })
    )
    .default([]),
  text: z.array(
    z.object({
      id: idSchema,
      shotId: idSchema.optional(),
      words: z.string(),
      role: z.enum(['headline', 'support', 'cta', 'imagery']),
      inBeat: beatSchema,
      outBeat: beatSchema,
      basis: basisSchema.optional(),
    })
  ),
  cues: z.array(
    z.object({
      id: idSchema,
      beat: beatSchema,
      kind: cueKindSchema,
      anchor: z.enum(['start', 'peak', 'end']),
    })
  ),
});

export type FilmSpecInput = z.input<typeof filmSpecInputSchema>;

export type CueKind = z.infer<typeof cueKindSchema>;

type ParsedSpec = z.output<typeof filmSpecInputSchema>;

/** A half-open frame range `[from, to)`. */
interface FrameSpan {
  from: number;
  to: number;
}

/** The range a `silence` cue opens: to the next cue on a later frame, or to the end. */
interface Silence extends FrameSpan {
  cueId: string;
}

type Shot = Omit<ParsedSpec['shots'][number], 'reads'> &
  FrameSpan & { reads: (ParsedSpec['shots'][number]['reads'][number] & FrameSpan)[] };

/** A cue is an instant: its `from` and `to` are the same frame. */
type Cue = ParsedSpec['cues'][number] & FrameSpan;

/** A validated film: the input plus every beat-based time resolved to integer frames. */
export type FilmSpec = Omit<ParsedSpec, 'shots' | 'text' | 'cues'> & {
  durationInFrames: number;
  bpm: number;
  shots: Shot[];
  text: (ParsedSpec['text'][number] & FrameSpan)[];
  cues: Cue[];
  silences: Silence[];
};

/** What a film's `film.ts` exports as `definition`. */
export interface FilmDefinition {
  spec: FilmSpec;
  score?: ScoreInput;
}

/** The load-time rules `defineFilm` enforces; every refusal names the one broken. */
type FilmSpecRule =
  | 'shape'
  | 'unique-ids'
  | 'cut-on-beat'
  | 'frame-grid'
  | 'empty-span'
  | 'past-end'
  | 'shots-tile'
  | 'reads-overlap'
  | 'text-in-shot'
  | 'text-basis'
  | 'text-hold';

/** What broke: the film, the rule, the shot, read, text block or cue at fault, and how. */
interface FilmSpecBreak {
  filmId: string;
  rule: FilmSpecRule;
  subject: string;
  detail: string;
}

/** A film spec that breaks a load-time rule, naming the film, the rule and what broke it. */
export class FilmSpecError extends Error {
  readonly filmId: string;
  readonly rule: FilmSpecRule;
  readonly subject: string;

  constructor({ filmId, rule, subject, detail }: FilmSpecBreak, options?: ErrorOptions) {
    super(`film ${JSON.stringify(filmId)}, rule "${rule}", ${subject}: ${detail}`, options);
    this.name = 'FilmSpecError';
    this.filmId = filmId;
    this.rule = rule;
    this.subject = subject;
  }
}

type Refuse = (
  rule: FilmSpecRule,
  subject: string,
  detail: string,
  options?: ErrorOptions
) => FilmSpecError;

function refuser(filmId: string): Refuse {
  return (rule, subject, detail, options) =>
    new FilmSpecError({ filmId, rule, subject, detail }, options);
}

type ResolvedSpec = Omit<FilmSpec, 'silences'>;

const OWNER_LABELS = { shots: 'shot', text: 'text', cues: 'cue' } as const;

function label(kind: string, id: string): string {
  return `${kind} ${JSON.stringify(id)}`;
}

function readLabel(shot: { id: string }, read: { what: string }): string {
  return `${label('shot', shot.id)} read ${JSON.stringify(read.what)}`;
}

function frameRange(span: FrameSpan): string {
  return `[${String(span.from)}, ${String(span.to)})`;
}

/** The shot, text block or cue a schema issue sits inside, or the spec itself. */
function issueOwner(input: FilmSpecInput, [collection, index]: readonly PropertyKey[]): string {
  if (
    typeof index === 'number' &&
    (collection === 'shots' || collection === 'text' || collection === 'cues')
  ) {
    return `${OWNER_LABELS[collection]} ${JSON.stringify(input[collection]?.[index]?.id)}`;
  }
  return 'the spec';
}

function parseInput(input: FilmSpecInput): ParsedSpec {
  const parsed = filmSpecInputSchema.safeParse(input);
  if (!parsed.success) {
    const owners = new Set(parsed.error.issues.map((issue) => issueOwner(input, issue.path)));
    throw refuser(input.id)('shape', [...owners].join(', '), z.prettifyError(parsed.error));
  }
  return parsed.data;
}

function checkUniqueIds(spec: ParsedSpec, refuse: Refuse): void {
  for (const collection of ['shots', 'text', 'cues'] as const) {
    const seen = new Set<string>();
    for (const { id } of spec[collection]) {
      if (seen.has(id)) {
        const subject = label(OWNER_LABELS[collection], id);
        throw refuse('unique-ids', subject, `declared twice in ${collection}`);
      }
      seen.add(id);
    }
  }
}

/**
 * Resolves every beat to its frame, refusing a cut between beats, a beat
 * between frames, a span that does not move forward, and anything past the end.
 */
function resolveFrames(spec: ParsedSpec, refuse: Refuse): ResolvedSpec {
  const durationInFrames = beatToFrame(spec.grid, spec.beats);
  const toFrame = (beat: number, subject: string): number => {
    try {
      return beatToFrame(spec.grid, beat);
    } catch (error) {
      const detail = `beat ${String(beat)} lands between frames at framesPerBeat ${String(spec.grid.framesPerBeat)}`;
      throw refuse('frame-grid', subject, detail, { cause: error });
    }
  };
  const pastEnd = (frame: number, limit: number, subject: string): void => {
    if (frame > limit) {
      const detail = `reaches frame ${String(frame)}, past frame ${String(limit)}, the furthest it may reach in ${String(durationInFrames)} frames`;
      throw refuse('past-end', subject, detail);
    }
  };
  const span = (fromBeat: number, toBeat: number, subject: string): FrameSpan => {
    const resolved = { from: toFrame(fromBeat, subject), to: toFrame(toBeat, subject) };
    if (resolved.to <= resolved.from) {
      throw refuse('empty-span', subject, `spans frames ${frameRange(resolved)}, which hold none`);
    }
    pastEnd(resolved.to, durationInFrames, subject);
    return resolved;
  };
  return {
    ...spec,
    durationInFrames,
    bpm: bpmOf(spec.grid),
    shots: spec.shots.map((shot) => {
      const subject = label('shot', shot.id);
      const offBeat = [shot.fromBeat, shot.toBeat].find((beat) => !Number.isInteger(beat));
      if (offBeat !== undefined) {
        throw refuse('cut-on-beat', subject, `cuts at beat ${String(offBeat)}, not a whole beat`);
      }
      return {
        ...shot,
        ...span(shot.fromBeat, shot.toBeat, subject),
        reads: shot.reads.map((read) => ({
          ...read,
          ...span(read.fromBeat, read.toBeat, readLabel(shot, read)),
        })),
      };
    }),
    text: spec.text.map((block) => ({
      ...block,
      ...span(block.inBeat, block.outBeat, label('text', block.id)),
    })),
    cues: spec.cues.map((cue) => {
      const subject = label('cue', cue.id);
      const frame = toFrame(cue.beat, subject);
      // A cue is an instant at its own frame, so it must be a frame of the film,
      // except an `end`-anchored cue: its sound's last sample precedes the cue,
      // so on the end boundary it finishes on the film's last sample.
      pastEnd(frame, cue.anchor === 'end' ? durationInFrames : durationInFrames - 1, subject);
      return { ...cue, from: frame, to: frame };
    }),
  };
}

function checkShotsTile(film: ResolvedSpec, refuse: Refuse): void {
  let cursor = 0;
  let previous = 'the start';
  for (const shot of film.shots.toSorted((a, b) => a.from - b.from)) {
    const subject = label('shot', shot.id);
    if (shot.from !== cursor) {
      const detail =
        shot.from > cursor
          ? `frames ${frameRange({ from: cursor, to: shot.from })} between ${previous} and it belong to no shot`
          : `starts at frame ${String(shot.from)}, before ${previous} ends at frame ${String(cursor)}`;
      throw refuse('shots-tile', subject, detail);
    }
    cursor = shot.to;
    previous = subject;
  }
  if (cursor !== film.durationInFrames) {
    const gap = frameRange({ from: cursor, to: film.durationInFrames });
    throw refuse('shots-tile', previous, `frames ${gap} after it belong to no shot`);
  }
}

function checkReadsOverlap(film: ResolvedSpec, refuse: Refuse): void {
  for (const shot of film.shots) {
    let previous: (typeof shot.reads)[number] | undefined;
    for (const read of shot.reads.toSorted((a, b) => a.from - b.from)) {
      if (previous !== undefined && read.from < previous.to) {
        const detail = `starts at frame ${String(read.from)}, before read ${JSON.stringify(previous.what)} ends at frame ${String(previous.to)}`;
        throw refuse('reads-overlap', readLabel(shot, read), detail);
      }
      previous = read;
    }
  }
}

/**
 * Characters are counted as code points: deterministic on every engine, and
 * never fewer than the graphemes a reader sees, so the floor never under-holds.
 */
function codePointCount(text: string): number {
  return [...text.matchAll(/./gsu)].length;
}

/**
 * A copy line (any role but `imagery`) declares a basis and holds at least
 * `ceil(max(TEXT_MIN_HOLD_SECONDS, characters / TEXT_MAX_CHARS_PER_SECOND) × FPS)` frames.
 */
function checkCopy(block: ResolvedSpec['text'][number], subject: string, refuse: Refuse): void {
  if (block.basis === undefined) {
    throw refuse('text-basis', subject, `a ${block.role} line declares no basis`);
  }
  const characters = codePointCount(block.words);
  const floor = Math.max(
    Math.ceil(TEXT_MIN_HOLD_SECONDS * FPS),
    Math.ceil((characters * FPS) / TEXT_MAX_CHARS_PER_SECOND)
  );
  const held = block.to - block.from;
  if (held < floor) {
    const detail = `holds ${String(held)} frames; ${String(characters)} characters need ${String(floor)} (at least ${String(TEXT_MIN_HOLD_SECONDS)} s, at most ${String(TEXT_MAX_CHARS_PER_SECOND)} characters per second)`;
    throw refuse('text-hold', subject, detail);
  }
}

function checkTextInShot(
  film: ResolvedSpec,
  block: ResolvedSpec['text'][number],
  refuse: Refuse
): void {
  const subject = label('text', block.id);
  if (block.shotId === undefined) {
    throw refuse('text-in-shot', subject, 'names no shot, and the spec declares shots');
  }
  const shot = film.shots.find(({ id }) => id === block.shotId);
  if (shot === undefined) {
    const detail = `names shot ${JSON.stringify(block.shotId)}, which the spec does not declare`;
    throw refuse('text-in-shot', subject, detail);
  }
  if (block.from < shot.from || block.to > shot.to) {
    const detail = `spans frames ${frameRange(block)}, outside ${label('shot', shot.id)} at ${frameRange(shot)}`;
    throw refuse('text-in-shot', subject, detail);
  }
}

function checkText(film: ResolvedSpec, refuse: Refuse): void {
  for (const block of film.text) {
    const subject = label('text', block.id);
    if (film.shots.length > 0) {
      checkTextInShot(film, block, refuse);
    }
    if (block.role !== 'imagery') {
      checkCopy(block, subject, refuse);
    }
  }
}

function deriveSilences(cues: readonly Cue[], durationInFrames: number): Silence[] {
  const frames = cues.map((cue) => cue.from);
  return cues
    .filter((cue) => cue.kind === 'silence')
    .toSorted((a, b) => a.from - b.from)
    .map((cue) => ({
      cueId: cue.id,
      from: cue.from,
      to: Math.min(durationInFrames, ...frames.filter((frame) => frame > cue.from)),
    }));
}

/** Validates a film spec and resolves every beat-based time to integer frames. */
export function defineFilm(input: FilmSpecInput): FilmSpec {
  const parsed = parseInput(input);
  const refuse = refuser(parsed.id);
  checkUniqueIds(parsed, refuse);
  const film = resolveFrames(parsed, refuse);
  if (film.shots.length > 0) {
    checkShotsTile(film, refuse);
  }
  checkReadsOverlap(film, refuse);
  checkText(film, refuse);
  return { ...film, silences: deriveSilences(film.cues, film.durationInFrames) };
}
