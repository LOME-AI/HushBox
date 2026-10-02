import { z } from 'zod';

import { dbToAmplitude } from '../../analyze/index.js';
import { frameToSample } from '../../time/grid.js';
import { INSTRUMENTS } from '../instruments/index.js';

import { ScoreError } from './score-error.js';
import { scoreInputSchema } from './schema.js';

import type { FilmSpec } from '../../film/spec.js';
import type { FilterMode } from '../dsp/index.js';
import type { InstrumentName } from '../instruments/index.js';
import type { ScoreRule } from './score-error.js';
import type { Anchor, ParsedScore, ScoreInput } from './schema.js';

/** A half-open sample range `[from, to)` a silence cue opens. */
export interface SampleSpan {
  cueId: string;
  from: number;
  to: number;
}

/** What a score needs of its film, in samples. */
export interface ScoreFilm {
  id: string;
  seed: string;
  framesPerBeat: number;
  /** The master's length: `durationInFrames × SAMPLES_PER_FRAME`. */
  samples: number;
  silences: readonly SampleSpan[];
}

/** An event resolved to the sample its anchor lands on. */
export interface TimedEvent {
  sample: number;
  /** The anchor that lands on `sample`; null lands the instrument's own anchor there. */
  anchor: Anchor | null;
  cueId: string | null;
  /** The instrument's parameters, validated and with its defaults filled. */
  params: unknown;
}

export interface ScoreTrack {
  id: string;
  instrument: InstrumentName;
  bus: string;
  /** Linear gain, from the track's `gainDb`. */
  gain: number;
  pan: number;
  events: TimedEvent[];
}

/** A bus effect with every length, and every cue it names, resolved to samples. */
export type ResolvedEffect =
  | { kind: 'reverb'; rt60: number; damping: number; mix: number }
  | { kind: 'delay'; samples: number; feedback: number; mix: number }
  | { kind: 'saturation'; drive: number }
  | { kind: 'filter'; mode: FilterMode; cutoff: number; resonance: number }
  | { kind: 'stutter'; from: number; sliceSamples: number; repeats: number }
  | { kind: 'tapeStop'; from: number; samples: number };

/** A sidechain resolved to the samples it ducks on. */
export interface Duck {
  cueSamples: number[];
  /** The linear gain the duck dips to on each cue. */
  floor: number;
  releaseSamples: number;
}

export interface ScoreBus {
  id: string;
  role: 'music' | 'sfx';
  effects: ResolvedEffect[];
  duck: Duck | null;
}

/** A score validated against its film, every time in it resolved to an exact sample. */
export interface Score {
  film: ScoreFilm;
  tracks: ScoreTrack[];
  buses: ScoreBus[];
  master: { targetLufs: number; ceilingDbtp: number };
}

type Refuse = (rule: ScoreRule, subject: string, detail: string) => ScoreError;

interface Context {
  film: FilmSpec;
  refuse: Refuse;
  samplesPerBeat: number;
  samples: number;
}

type Cue = FilmSpec['cues'][number];
type ParsedEvent = ParsedScore['tracks'][number]['events'][number];
type ParsedEffect = ParsedScore['buses'][number]['effects'][number];

function label(kind: string, id: string | undefined): string {
  return `${kind} ${JSON.stringify(id)}`;
}

/** The track or bus a schema issue sits inside, the master settings, or the score itself. */
function issueOwner(input: ScoreInput, [collection, index]: readonly PropertyKey[]): string {
  if (collection === 'master') {
    return 'the master settings';
  }
  if (typeof index !== 'number') {
    return 'the score';
  }
  if (collection === 'tracks') {
    return label('track', input.tracks[index]?.id);
  }
  return label('bus', input.buses[index]?.id);
}

function parseInput(input: ScoreInput, refuse: Refuse): ParsedScore {
  const parsed = scoreInputSchema.safeParse(input);
  if (!parsed.success) {
    const owners = new Set(parsed.error.issues.map((issue) => issueOwner(input, issue.path)));
    throw refuse('shape', [...owners].join(', '), z.prettifyError(parsed.error));
  }
  return parsed.data;
}

function checkUniqueIds(score: ParsedScore, refuse: Refuse): void {
  for (const [collection, kind] of [
    ['tracks', 'track'],
    ['buses', 'bus'],
  ] as const) {
    const seen = new Set<string>();
    for (const { id } of score[collection]) {
      if (seen.has(id)) {
        throw refuse('unique-ids', label(kind, id), `declared twice in ${collection}`);
      }
      seen.add(id);
    }
  }
}

function cueNamed(context: Context, cueId: string, subject: string): Cue {
  const cue = context.film.cues.find(({ id }) => id === cueId);
  if (cue === undefined) {
    const detail = `names cue ${JSON.stringify(cueId)}, which the film does not declare`;
    throw context.refuse('unknown-cue', subject, detail);
  }
  return cue;
}

/** A length in beats as a whole number of samples at the film's tempo. */
function lengthInSamples(context: Context, beats: number, subject: string): number {
  const samples = beats * context.samplesPerBeat;
  if (!Number.isSafeInteger(samples)) {
    const detail = `${String(beats)} beats is ${String(samples)} samples at framesPerBeat ${String(context.film.grid.framesPerBeat)}: a length needs a whole number of samples`;
    throw context.refuse('sample-grid', subject, detail);
  }
  return samples;
}

/** The sample an event's time resolves to, and the cue it names, if any. */
function placeOf(
  at: ParsedEvent['at'],
  context: Context,
  subject: string
): { sample: number; cue: Cue | null } {
  if ('cue' in at) {
    const cue = cueNamed(context, at.cue, subject);
    return { sample: frameToSample(cue.from), cue };
  }
  if ('frame' in at) {
    return { sample: frameToSample(at.frame), cue: null };
  }
  const sample = at.beat * context.samplesPerBeat;
  if (!Number.isSafeInteger(sample)) {
    const detail = `beat ${String(at.beat)} lands between samples at framesPerBeat ${String(context.film.grid.framesPerBeat)}`;
    throw context.refuse('sample-grid', subject, detail);
  }
  return { sample, cue: null };
}

/**
 * An event on its sample. An `end` anchor may land one past the film's last
 * sample, where its sound finishes with the film; any other lands on a sample
 * of the film.
 */
function timedEvent(
  event: ParsedEvent,
  instrument: InstrumentName,
  context: Context,
  subject: string
): TimedEvent {
  const { sample, cue } = placeOf(event.at, context, subject);
  const anchor = event.anchor ?? cue?.anchor ?? null;
  const last = anchor === 'end' ? context.samples : context.samples - 1;
  if (sample > last) {
    const detail = `lands on sample ${String(sample)}, past sample ${String(last)}, the last it may land on`;
    throw context.refuse('past-end', subject, detail);
  }
  const params = INSTRUMENTS[instrument].params.safeParse(event.params ?? {});
  if (!params.success) {
    const detail = `${instrument} refuses its parameters: ${z.prettifyError(params.error)}`;
    throw context.refuse('params', subject, detail);
  }
  return { sample, anchor, cueId: cue?.id ?? null, params: params.data };
}

function timedTrack(
  track: ParsedScore['tracks'][number],
  context: Context,
  busIds: ReadonlySet<string>
): ScoreTrack {
  const subject = label('track', track.id);
  if (!busIds.has(track.bus)) {
    const detail = `plays on bus ${JSON.stringify(track.bus)}, which the score does not declare`;
    throw context.refuse('unknown-bus', subject, detail);
  }
  return {
    id: track.id,
    instrument: track.instrument,
    bus: track.bus,
    gain: dbToAmplitude(track.gainDb),
    pan: track.pan,
    events: track.events.map((event, index) =>
      timedEvent(event, track.instrument, context, `${subject} event ${String(index)}`)
    ),
  };
}

/** Refuses a range that runs past the film's last sample. */
function requireWithinFilm(context: Context, end: number, subject: string): void {
  if (end > context.samples) {
    const detail = `runs to sample ${String(end)}, past the film's end at sample ${String(context.samples)}`;
    throw context.refuse('past-end', subject, detail);
  }
}

function resolveEffect(effect: ParsedEffect, context: Context, subject: string): ResolvedEffect {
  switch (effect.kind) {
    case 'delay': {
      const samples = lengthInSamples(context, effect.beats, subject);
      if (samples > context.samples) {
        const detail = `delays ${String(samples)} samples, longer than the film's ${String(context.samples)}`;
        throw context.refuse('past-end', subject, detail);
      }
      return { kind: 'delay', samples, feedback: effect.feedback, mix: effect.mix };
    }
    case 'stutter': {
      const from = frameToSample(cueNamed(context, effect.cue, subject).from);
      const sliceSamples = lengthInSamples(context, effect.sliceBeats, subject);
      requireWithinFilm(context, from + sliceSamples * effect.repeats, subject);
      return { kind: 'stutter', from, sliceSamples, repeats: effect.repeats };
    }
    case 'tapeStop': {
      const from = frameToSample(cueNamed(context, effect.cue, subject).from);
      const samples = lengthInSamples(context, effect.beats, subject);
      requireWithinFilm(context, from + samples, subject);
      return { kind: 'tapeStop', from, samples };
    }
    default: {
      return effect;
    }
  }
}

function duckOf(sidechain: ParsedScore['buses'][number]['sidechain'], film: FilmSpec): Duck | null {
  if (sidechain === undefined) {
    return null;
  }
  const kinds = new Set(sidechain.cueKinds);
  return {
    cueSamples: film.cues
      .filter(({ kind }) => kinds.has(kind))
      .map(({ from }) => frameToSample(from))
      .toSorted((a, b) => a - b),
    floor: dbToAmplitude(-sidechain.depthDb),
    releaseSamples: frameToSample(sidechain.releaseFrames),
  };
}

function resolvedBus(bus: ParsedScore['buses'][number], context: Context): ScoreBus {
  const subject = label('bus', bus.id);
  return {
    id: bus.id,
    role: bus.role,
    effects: bus.effects.map((effect, index) =>
      resolveEffect(effect, context, `${subject} effect ${String(index)}`)
    ),
    duck: duckOf(bus.sidechain, context.film),
  };
}

/**
 * Validates a score against its film and resolves every event, effect and
 * sidechain to exact samples, throwing a `ScoreError` naming the film, the rule
 * and the track, event, bus or effect at fault.
 */
export function defineScore(input: ScoreInput, film: FilmSpec): Score {
  const refuse: Refuse = (rule, subject, detail) =>
    new ScoreError({ filmId: film.id, rule, subject, detail });
  const parsed = parseInput(input, refuse);
  checkUniqueIds(parsed, refuse);
  const context: Context = {
    film,
    refuse,
    samplesPerBeat: frameToSample(film.grid.framesPerBeat),
    samples: frameToSample(film.durationInFrames),
  };
  const busIds = new Set(parsed.buses.map(({ id }) => id));
  return {
    film: {
      id: film.id,
      seed: film.seed,
      framesPerBeat: film.grid.framesPerBeat,
      samples: context.samples,
      silences: film.silences.map(({ cueId, from, to }) => ({
        cueId,
        from: frameToSample(from),
        to: frameToSample(to),
      })),
    },
    tracks: parsed.tracks.map((track) => timedTrack(track, context, busIds)),
    buses: parsed.buses.map((bus) => resolvedBus(bus, context)),
    master: parsed.master,
  };
}
