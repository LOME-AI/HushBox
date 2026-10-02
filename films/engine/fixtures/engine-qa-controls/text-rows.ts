import type { FilmSpecInput } from '../../film/spec.js';

type TextRow = FilmSpecInput['text'][number];

/** A text row held across engine-render's first bar, where the text controls draw it. */
export function firstBarRow(id: string, words: string, role: TextRow['role']): TextRow {
  return { id, shotId: 'bar-0', words, role, inBeat: 0, outBeat: 4, basis: { kind: 'opinion' } };
}
