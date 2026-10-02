import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * Example write port. `upsertNote` is ONE `INSERT … ON CONFLICT (user_id)`
 * statement, so the unique constraint — not the caller — arbitrates duplicate
 * and racing deliveries. That contract is what makes `idempotent.byUpsert` the
 * honest classification at the route; a write that cannot make it needs a
 * different wrapper.
 */
export interface NoteStore {
  upsertNote(userId: string, text: string): ResultAsync<void, DomainError>;
}

/**
 * Stores are constructed per request from the pipeline's `c.var.db`, so a
 * handler inside a transaction can be handed that transaction instead. The
 * adapter implementing this is the new slice's drizzle repository.
 */
export type NoteStoreFactory = (db: Database) => NoteStore;
