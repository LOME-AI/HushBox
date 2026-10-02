import { rand } from '../../rand/rand.js';
import { createStereo, decodeWav24, encodeWav24, mixInto, sampleAt } from '../dsp/index.js';
import { INSTRUMENTS } from '../instruments/index.js';
import { masterChain } from '../master/index.js';

import { anchorPoint } from './anchors.js';
import { applyDuck } from './duck.js';
import { applyEffect } from './effects.js';
import { ScoreError } from './score-error.js';
import { silenced } from './silence.js';

import type { StereoBuffer } from '../dsp/index.js';
import type { Score, ScoreBus, ScoreFilm, ScoreTrack } from './define-score.js';
import type { ScoreRule } from './score-error.js';
import type { Anchor } from './schema.js';

/** Where one event's sound was placed: the sample its anchor landed on, and which anchor. */
export interface ScorePlacement {
  track: string;
  cueId: string | null;
  sample: number;
  anchor: Anchor;
}

export interface RenderedScore {
  /** The master as delivered: the samples the WAV holds, dither included. */
  master: StereoBuffer;
  /** The master as a 48 kHz stereo 24-bit PCM WAV with seeded TPDF dither. */
  wav: Uint8Array;
  /** Each track alone, placed with its gain and pan, before its bus. */
  stems: Record<string, StereoBuffer>;
  /** Each bus's output: its tracks through its effects, sidechain and silences. */
  buses: Record<string, StereoBuffer>;
  /** Every placement, track by track in the score's order, each track's in time order. */
  placements: ScorePlacement[];
}

type Refuse = (rule: ScoreRule, subject: string, cause: unknown) => ScoreError;

function sumOf(buffers: readonly StereoBuffer[], samples: number): StereoBuffer {
  const sum = createStereo(samples);
  for (const buffer of buffers) {
    for (let index = 0; index < samples; index++) {
      sum.left[index] = sampleAt(sum.left, index) + sampleAt(buffer.left, index);
      sum.right[index] = sampleAt(sum.right, index) + sampleAt(buffer.right, index);
    }
  }
  return sum;
}

/**
 * A track's stem: each event's sound rendered with its own seed and placed so
 * its anchor lands on the event's sample. The seed is keyed by the track and
 * the sample, so adding an event never changes the sound of another.
 */
function renderTrack(
  track: ScoreTrack,
  film: ScoreFilm,
  refuse: Refuse
): { stem: StereoBuffer; placements: ScorePlacement[] } {
  const stem = createStereo(film.samples);
  const instrument = INSTRUMENTS[track.instrument];
  const onSample = new Map<number, number>();
  const placements = track.events.map((event, index) => {
    const occurrence = onSample.get(event.sample) ?? 0;
    onSample.set(event.sample, occurrence + 1);
    const key = `${film.seed}/${track.id}/${String(event.sample)}/${String(occurrence)}`;
    let rendered: ReturnType<typeof instrument.render>;
    try {
      rendered = instrument.render(event.params, {
        rand: rand(key),
        framesPerBeat: film.framesPerBeat,
      });
    } catch (error) {
      throw refuse('render', `track ${JSON.stringify(track.id)} event ${String(index)}`, error);
    }
    const { anchor, offset } = anchorPoint(event.anchor, rendered);
    mixInto(stem, rendered.buffer, {
      atSample: event.sample - offset,
      gain: track.gain,
      pan: track.pan,
    });
    return { track: track.id, cueId: event.cueId, sample: event.sample, anchor };
  });
  return { stem, placements: placements.toSorted((a, b) => a.sample - b.sample) };
}

/** A bus: its tracks summed, through its effects in order, its sidechain, and, for music, its silences. */
function renderBus(bus: ScoreBus, stems: readonly StereoBuffer[], film: ScoreFilm): StereoBuffer {
  let signal = sumOf(stems, film.samples);
  for (const effect of bus.effects) {
    signal = applyEffect(signal, effect);
  }
  if (bus.duck !== null) {
    signal = applyDuck(signal, bus.duck);
  }
  return bus.role === 'music' ? silenced(signal, film.silences) : signal;
}

/**
 * Renders a score: every event placed on its exact sample, tracks summed into
 * buses, bus effects, sidechains and silences applied, then the master chain
 * and seeded TPDF dither. A sound that fails to render, or a master that cannot
 * reach its target, throws a `ScoreError` naming the film and what failed.
 */
export function renderScore(score: Score): RenderedScore {
  const { film } = score;
  const refuse: Refuse = (rule, subject, cause) =>
    new ScoreError({ filmId: film.id, rule, subject, detail: String(cause) }, { cause });
  const tracks = score.tracks.map((track) => ({ track, ...renderTrack(track, film, refuse) }));
  const buses = score.buses.map((bus) => {
    const stems = tracks.filter(({ track }) => track.bus === bus.id).map(({ stem }) => stem);
    return [bus.id, renderBus(bus, stems, film)] as const;
  });
  let mastered: StereoBuffer;
  try {
    mastered = masterChain(
      sumOf(
        buses.map(([, signal]) => signal),
        film.samples
      ),
      score.master
    );
  } catch (error) {
    throw refuse('master', 'the master', error);
  }
  const wav = encodeWav24(mastered, rand(`${film.seed}/dither`));
  return {
    master: decodeWav24(wav),
    wav,
    stems: Object.fromEntries(tracks.map(({ track, stem }) => [track.id, stem])),
    buses: Object.fromEntries(buses),
    placements: tracks.flatMap(({ placements }) => placements),
  };
}
