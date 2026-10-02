import { z } from 'zod';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { NoteStore } from '../ports/index.js';

/** Example request schema. Routes validate against it; nothing parses by hand. */
export const putNoteBodySchema = z.object({ text: z.string().min(1).max(280) });

export interface NoteState {
  readonly text: string;
}

/**
 * Example mutation. Domain code returns a `Result` rather than throwing, which
 * is what lets the route map a failure onto a wire code; a dropped `Result`
 * fails lint.
 */
export function saveNote(
  store: NoteStore,
  userId: string,
  text: string
): ResultAsync<NoteState, DomainError> {
  return store.upsertNote(userId, text).map(() => ({ text }));
}
