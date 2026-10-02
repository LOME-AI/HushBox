import { definition as engineRender } from '../engine-render/film.js';
import { defineFilm } from '../../film/spec.js';

import type { ScoreInput } from '../../audio/score/index.js';
import type { CueKind, FilmSpec, FilmSpecInput } from '../../film/spec.js';

const { spec: base, score } = engineRender;

if (score === undefined) {
  throw new Error('engine-qa-controls: engine-render declares no score for the controls to share');
}

/** engine-render's click track, which every control that is verified whole scores with. */
export const CONTROL_SCORE: ScoreInput = score;

interface ControlOptions {
  /** A new kind for each named cue; the cue keeps its beat and anchor. */
  retype?: Readonly<Record<string, CueKind>>;
  text?: FilmSpecInput['text'];
}

/**
 * engine-render's grid, shots and cues under a control's own id, and with its
 * seed, so a control renders engine-render's picture and sound but for the one
 * defect it adds.
 */
export function controlSpec(id: string, { retype = {}, text = [] }: ControlOptions = {}): FilmSpec {
  return defineFilm({
    id,
    title: `QA control ${id}`,
    seed: base.seed,
    grid: base.grid,
    beats: base.beats,
    shots: base.shots.map(({ id: shotId, fromBeat, toBeat }) => ({
      id: shotId,
      fromBeat,
      toBeat,
      reads: [],
    })),
    text,
    cues: base.cues.map(({ id: cueId, beat, kind, anchor }) => ({
      id: cueId,
      beat,
      kind: retype[cueId] ?? kind,
      anchor,
    })),
  });
}
