import { z } from 'zod';

import { filmSpecInputSchema } from '../../film/spec.js';
import { SAMPLE_RATE } from '../../time/grid.js';
import { INSTRUMENTS } from '../instruments/index.js';
import { DEFAULT_CEILING_DBTP, DEFAULT_TARGET_LUFS } from '../master/index.js';

import type { FilterMode } from '../dsp/index.js';
import type { InstrumentName } from '../instruments/index.js';

const NYQUIST = SAMPLE_RATE / 2;

const idSchema = z.string().min(1);

/** Which point of a sound lands on its event's sample: its first, its loudest, or one past its last. */
const anchorSchema = z.enum(['start', 'peak', 'end']);

/** The film spec's own cue-kind enum, read through its schema so the two cannot drift. */
const cueKindSchema = filmSpecInputSchema.shape.cues.element.shape.kind;

function isInstrumentName(value: unknown): value is InstrumentName {
  return typeof value === 'string' && Object.hasOwn(INSTRUMENTS, value);
}

const eventSchema = z.object({
  /** A cue of the film, a beat (sub-frame beats allowed), or a whole frame. */
  at: z.union([
    z.strictObject({ cue: idSchema }),
    z.strictObject({ beat: z.number().min(0) }),
    z.strictObject({ frame: z.int().min(0) }),
  ]),
  /** The instrument's raw parameters; its own schema validates them and fills defaults. */
  params: z.unknown().optional(),
  /** Overrides the cue's anchor; with neither, the instrument's own anchor lands on the sample. */
  anchor: anchorSchema.optional(),
});

const trackSchema = z.object({
  id: idSchema,
  instrument: z.custom<InstrumentName>(isInstrumentName, 'must name a registered instrument'),
  bus: idSchema,
  gainDb: z.number(),
  /** −1 hard left, 0 centre, 1 hard right. */
  pan: z.number().min(-1).max(1).default(0),
  events: z.array(eventSchema),
});

/** A proportion of the wet signal added to the dry. */
const mixSchema = z.number().min(0).max(1);
/** A length in beats; it must also come to a whole number of samples, which only the film's tempo can check. */
const beatsSchema = z.number().positive();
const frequencySchema = z.number().min(0).lt(NYQUIST);

const effectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reverb'),
    /** Seconds for the tail to fall 60 dB. */
    rt60: z.number().positive(),
    /** Hz: the corner of the low-pass in the reverb's loops. */
    damping: frequencySchema,
    mix: mixSchema,
  }),
  z.object({
    kind: z.literal('delay'),
    beats: beatsSchema,
    feedback: z.number().gt(-1).lt(1),
    mix: mixSchema,
  }),
  z.object({ kind: z.literal('saturation'), drive: z.number().min(0.5).max(8) }),
  z.object({
    kind: z.literal('filter'),
    mode: z.enum(['lowpass', 'highpass', 'bandpass', 'notch']) satisfies z.ZodType<FilterMode>,
    cutoff: frequencySchema,
    resonance: z.number().min(0).lt(1),
  }),
  z.object({
    kind: z.literal('stutter'),
    /** The cue the stutter starts on: its slice starts there and repeats. */
    cue: idSchema,
    sliceBeats: beatsSchema,
    repeats: z.int().min(2),
  }),
  z.object({ kind: z.literal('tapeStop'), cue: idSchema, beats: beatsSchema }),
]);

const busSchema = z.object({
  id: idSchema,
  /** Across a silence span a `music` bus outputs digital zero; an `sfx` bus plays on. */
  role: z.enum(['music', 'sfx']),
  effects: z.array(effectSchema),
  sidechain: z
    .object({
      cueKinds: z.array(cueKindSchema).min(1),
      depthDb: z.number().min(0),
      releaseFrames: z.int().min(1),
    })
    .optional(),
});

const masterSchema = z.object({
  /** At least 10 LU above the loudness meter's −70 LKFS absolute gate, so the master is measurable. */
  targetLufs: z.number().min(-60).default(DEFAULT_TARGET_LUFS),
  /** At most full scale: a 24-bit WAV holds nothing louder. */
  ceilingDbtp: z.number().max(0).default(DEFAULT_CEILING_DBTP),
});

export const scoreInputSchema = z.object({
  tracks: z.array(trackSchema),
  buses: z.array(busSchema),
  master: masterSchema.default({
    targetLufs: DEFAULT_TARGET_LUFS,
    ceilingDbtp: DEFAULT_CEILING_DBTP,
  }),
});

export type ScoreInput = z.input<typeof scoreInputSchema>;
export type Track = z.input<typeof trackSchema>;
export type ScoreEvent = z.input<typeof eventSchema>;
export type Bus = z.input<typeof busSchema>;
export type BusEffect = z.input<typeof effectSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type ParsedScore = z.output<typeof scoreInputSchema>;
