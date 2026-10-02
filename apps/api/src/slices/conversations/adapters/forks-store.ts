import { and, asc, eq, sql } from 'drizzle-orm';
import { conversationForks, messages } from '@hushbox/db';
import { isUniqueViolationOn } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import { storeFailure } from './store-failure.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ForksStore, ForkRecord } from '../ports/stores.js';

const FORK_NAME_UNIQUE = 'conversation_forks_conversation_name_unique';

const forkColumns = {
  id: conversationForks.id,
  name: conversationForks.name,
  tipMessageId: conversationForks.tipMessageId,
  createdAt: conversationForks.createdAt,
} as const;

export function createForksStore(db: DbWriter): ForksStore {
  return {
    // Left join, not inner: `tipMessageId` is nullable, and an inner join
    // would drop a tipless fork from the list rather than floor it.
    list: (conversationId) =>
      fromPromise(
        db
          .select({ ...forkColumns, tipEpochNumber: messages.epochNumber })
          .from(conversationForks)
          .leftJoin(messages, eq(messages.id, conversationForks.tipMessageId))
          .where(eq(conversationForks.conversationId, conversationId))
          .orderBy(asc(conversationForks.createdAt), asc(conversationForks.id)),
        storeFailure
      ),

    byId: (conversationId, forkId) =>
      fromPromise(
        db
          .select(forkColumns)
          .from(conversationForks)
          .where(
            and(
              eq(conversationForks.id, forkId),
              eq(conversationForks.conversationId, conversationId)
            )
          ),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    lockById: (conversationId, forkId) =>
      fromPromise(
        db
          .select(forkColumns)
          .from(conversationForks)
          .where(
            and(
              eq(conversationForks.id, forkId),
              eq(conversationForks.conversationId, conversationId)
            )
          )
          .for('update'),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    insert: ({ id, conversationId, name, tipMessageId, createdAt }) =>
      insertFork(db, { id, conversationId, name, tipMessageId, createdAt }),

    rename: (params) => fromPromise(renameForkRow(db, params), storeFailure),

    updateTip: ({ conversationId, forkId, expectedTipMessageId, tipMessageId }) =>
      fromPromise(
        db
          .update(conversationForks)
          .set({ tipMessageId })
          .where(
            and(
              eq(conversationForks.id, forkId),
              eq(conversationForks.conversationId, conversationId),
              sql`${conversationForks.tipMessageId} IS NOT DISTINCT FROM ${expectedTipMessageId}`
            )
          )
          .returning(forkColumns),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    remove: ({ conversationId, forkId }) =>
      fromPromise(
        db
          .delete(conversationForks)
          .where(
            and(
              eq(conversationForks.id, forkId),
              eq(conversationForks.conversationId, conversationId)
            )
          )
          .returning({ id: conversationForks.id }),
        storeFailure
      ).map((rows) => rows.length > 0),

    removeAll: (conversationId) =>
      fromPromise(
        db.delete(conversationForks).where(eq(conversationForks.conversationId, conversationId)),
        storeFailure
      ).map((): void => undefined),
  };
}

function insertFork(
  db: DbWriter,
  params: {
    readonly id: string | null;
    readonly conversationId: string;
    readonly name: string;
    readonly tipMessageId: string | null;
    readonly createdAt?: Date | undefined;
  }
): ResultAsync<ForkRecord | 'name-taken' | 'id-taken', DomainError> {
  return fromPromise(insertForkRow(db, params), storeFailure);
}

async function insertForkRow(
  db: DbWriter,
  params: {
    readonly id: string | null;
    readonly conversationId: string;
    readonly name: string;
    readonly tipMessageId: string | null;
    readonly createdAt?: Date | undefined;
  }
): Promise<ForkRecord | 'name-taken' | 'id-taken'> {
  const values = {
    conversationId: params.conversationId,
    name: params.name,
    tipMessageId: params.tipMessageId,
    ...(params.id === null ? {} : { id: params.id }),
    ...(params.createdAt === undefined ? {} : { createdAt: params.createdAt }),
  };
  try {
    // The client mints `id`, and the primary key is GLOBAL, so a caller can
    // reuse one it already spent on another conversation. That collision is
    // arbitrated by `ON CONFLICT (id) DO NOTHING` rather than by catching the
    // 23505: a raised unique violation leaves the transaction aborted (25P02 on
    // every later statement), which would take the enclosing `byKey` key-row
    // flip down with it and answer a store failure instead of the refusal.
    // Arbitrating on the id alone leaves the name constraint raising as before.
    const rows = await db
      .insert(conversationForks)
      .values(values)
      .onConflictDoNothing({ target: conversationForks.id })
      .returning(forkColumns);
    return rows[0] ?? 'id-taken';
  } catch (error) {
    if (isUniqueViolationOn(error, FORK_NAME_UNIQUE)) return 'name-taken';
    throw error;
  }
}

async function renameForkRow(
  db: DbWriter,
  params: { readonly conversationId: string; readonly forkId: string; readonly name: string }
): Promise<ForkRecord | 'name-taken' | null> {
  try {
    const rows = await db
      .update(conversationForks)
      .set({ name: params.name })
      .where(
        and(
          eq(conversationForks.id, params.forkId),
          eq(conversationForks.conversationId, params.conversationId)
        )
      )
      .returning(forkColumns);
    return rows[0] ?? null;
  } catch (error) {
    if (isUniqueViolationOn(error, FORK_NAME_UNIQUE)) return 'name-taken';
    throw error;
  }
}
