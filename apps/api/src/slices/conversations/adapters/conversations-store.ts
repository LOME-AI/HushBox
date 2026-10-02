import { and, count, desc, eq, exists, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { conversationMembers, conversations, epochs, users } from '@hushbox/db';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { notLeft } from './seat-predicates.js';
import { storeFailure } from './store-failure.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ConversationsStore } from '../ports/stores.js';

const conversationColumns = {
  id: conversations.id,
  ownerUserId: conversations.userId,
  title: conversations.title,
  titleEpochNumber: conversations.titleEpochNumber,
  currentEpoch: conversations.currentEpoch,
  nextSequence: conversations.nextSequence,
  conversationBudgetNanoUsd: conversations.conversationBudgetNanoUsd,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
} as const;

export function createConversationsStore(db: DbWriter): ConversationsStore {
  const inviter = alias(users, 'inviter');
  const seat = alias(conversationMembers, 'seat');

  return {
    insert: ({ id, ownerUserId, title }) =>
      fromPromise(
        db
          .insert(conversations)
          .values({ id, userId: ownerUserId, title })
          .onConflictDoNothing({ target: conversations.id })
          .returning(conversationColumns),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    get: (conversationId) =>
      fromPromise(
        db
          .select(conversationColumns)
          .from(conversations)
          .where(eq(conversations.id, conversationId)),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    byIds: (conversationIds) =>
      conversationIds.length === 0
        ? okAsync([])
        : fromPromise(
            db
              .select(conversationColumns)
              .from(conversations)
              .where(inArray(conversations.id, [...conversationIds])),
            storeFailure
          ),

    lockForUpdate: (conversationId) =>
      fromPromise(
        db
          .select(conversationColumns)
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .for('update'),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    lockForShare: (conversationId) =>
      fromPromise(
        db
          .select(conversationColumns)
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .for('share'),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    listForUser: ({ userId, limit, cursor }) => {
      // Correlated per row, so the page and its counts stay one statement. A lapsed
      // link still counts until its seat is marked left, as the member list shows it.
      const memberCount = sql<number>`(${db
        .select({ count: count() })
        .from(seat)
        .where(and(eq(seat.conversationId, conversations.id), notLeft(seat)))})`.mapWith(Number);
      // `and()` drops undefined members, so the no-cursor case needs no guard.
      const conditions = and(
        eq(conversationMembers.userId, userId),
        isNull(conversationMembers.leftAt),
        cursor === null
          ? undefined
          : or(
              lt(conversations.updatedAt, cursor.updatedAt),
              and(eq(conversations.updatedAt, cursor.updatedAt), lt(conversations.id, cursor.id))
            )
      );
      return fromPromise(
        db
          .select({
            conversation: conversationColumns,
            privilege: conversationMembers.privilege,
            muted: conversationMembers.muted,
            pinned: conversationMembers.pinned,
            lastReadSeq: conversationMembers.lastReadSeq,
            acceptedAt: conversationMembers.acceptedAt,
            invitedByUsername: inviter.username,
            memberCount,
          })
          .from(conversationMembers)
          .innerJoin(conversations, eq(conversationMembers.conversationId, conversations.id))
          .leftJoin(inviter, eq(conversationMembers.invitedByUserId, inviter.id))
          .where(conditions)
          .orderBy(desc(conversations.updatedAt), desc(conversations.id))
          .limit(limit),
        storeFailure
      );
    },

    deleteOwned: ({ conversationId, ownerUserId }) =>
      fromPromise(
        db
          .delete(conversations)
          .where(and(eq(conversations.id, conversationId), eq(conversations.userId, ownerUserId)))
          .returning({ id: conversations.id }),
        storeFailure
      ).map((rows) => rows.length > 0),

    // `title_epoch_number` carries no foreign key, so the EXISTS arm is what
    // holds it to a real epoch of this row: one statement, so a caller can
    // never observe the title written against an epoch that is not there.
    updateTitle: ({ conversationId, ownerUserId, title, titleEpochNumber }) =>
      fromPromise(
        db
          .update(conversations)
          .set({ title, titleEpochNumber, updatedAt: new Date() })
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.userId, ownerUserId),
              exists(
                db
                  .select({ epochNumber: epochs.epochNumber })
                  .from(epochs)
                  .where(
                    and(
                      eq(epochs.conversationId, conversationId),
                      eq(epochs.epochNumber, titleEpochNumber)
                    )
                  )
              )
            )
          )
          .returning(conversationColumns),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    updateBudget: ({ conversationId, ownerUserId, budgetNanoUsd }) =>
      fromPromise(
        db
          .update(conversations)
          .set({ conversationBudgetNanoUsd: budgetNanoUsd, updatedAt: new Date() })
          .where(and(eq(conversations.id, conversationId), eq(conversations.userId, ownerUserId)))
          .returning(conversationColumns),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    claimRotation: ({ conversationId, expectedEpoch, encryptedTitle }) =>
      fromPromise(
        db
          .update(conversations)
          .set({
            currentEpoch: expectedEpoch + 1,
            ...(encryptedTitle === null
              ? {}
              : { title: encryptedTitle, titleEpochNumber: expectedEpoch + 1 }),
            updatedAt: new Date(),
          })
          .where(
            and(eq(conversations.id, conversationId), eq(conversations.currentEpoch, expectedEpoch))
          )
          .returning({ id: conversations.id }),
        storeFailure
      ).map((rows) => rows.length > 0),

    reserveSequenceBlock: ({ conversationId, count }) =>
      fromPromise(
        db
          .update(conversations)
          .set({
            nextSequence: sql`${conversations.nextSequence} + ${count}`,
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, conversationId))
          // RETURNING sees the post-update value, so `nextSequence - count`
          // recovers the pre-update base — the block's lowest number.
          .returning({ base: sql<number>`${conversations.nextSequence} - ${count}` }),
        storeFailure
      ).map((rows) => {
        const base = rows[0]?.base;
        return base === undefined
          ? null
          : Array.from({ length: count }, (_, index) => base + index);
      }),
  };
}
