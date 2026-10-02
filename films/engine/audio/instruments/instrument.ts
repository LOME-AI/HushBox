import type { z } from 'zod';

import type { StereoBuffer } from '../dsp/index.js';

/** What an instrument is given besides its parameters. */
interface InstrumentContext {
  /** The instrument's own seeded stream in [0, 1): its only source of randomness. */
  rand: () => number;
  /** The film's tempo; a length in beats resolves through it to exact samples. */
  framesPerBeat: number;
}

/** A rendered sound and the sample inside it that lands on its cue. */
export interface Rendered {
  buffer: StereoBuffer;
  anchorOffset: number;
}

/**
 * A sound as a pure function of its parameters and its seed. `params` validates
 * a score's raw parameters and fills their defaults; `render` takes its output.
 */
export interface Instrument<P = unknown> {
  params: z.ZodType<P>;
  /**
   * Whether the sound is heard from its anchor: true exactly when its first
   * sample above −60 dBFS falls on its anchor for every seed at every legal
   * parameter set, so a percussive track's audible onset is the sample it is
   * scheduled on.
   */
  percussive: boolean;
  // A method, not a function-typed property, so an instrument typed by its own
  // parameters stands in for `Instrument<unknown>` in the registry: the schema,
  // not the type, is what guards the parameters `render` receives.
  render(params: P, ctx: InstrumentContext): Rendered;
}

/**
 * An instrument whose `render` refuses, at its entry, a tempo that is not a
 * positive whole number of frames per beat, whether or not the instrument reads
 * it. Every numeric parameter is refused by the schema instead: Zod's numbers
 * admit neither NaN nor an infinity.
 */
export function defineInstrument<P>(definition: Instrument<P>): Instrument<P> {
  return {
    params: definition.params,
    percussive: definition.percussive,
    render(params, ctx) {
      const { framesPerBeat } = ctx;
      if (!(Number.isSafeInteger(framesPerBeat) && framesPerBeat >= 1)) {
        throw new RangeError(
          `framesPerBeat must be a whole number of frames, at least one, got ${String(framesPerBeat)}`
        );
      }
      return definition.render(params, ctx);
    },
  };
}
