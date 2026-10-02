import { and, asc, eq, gte, inArray, notExists, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  conversationMembers,
  conversations,
  epochMembers,
  epochs,
  sharedLinks,
  users,
} from '@hushbox/db';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { liveSeat } from './seat-predicates.js';
import { storeFailure } from './store-failure.js';
import type { SQL } from 'drizzle-orm';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { EpochChainRecord, EpochsStore } from '../ports/stores.js';

/** The epoch a record's chain link opens to, joined through `previous_epoch_id`. */
const predecessor = alias(epochs, 'predecessor');

/** A wrap in any epoch of the conversation: the scope of the deletes that span its history. */
function wrapInConversation(db: DbWriter, conversationId: string): SQL {
  return inArray(
    epochMembers.epochId,
    db.select({ id: epochs.id }).from(epochs).where(eq(epochs.conversationId, conversationId))
  );
}

export function createEpochsStore(db: DbWriter): EpochsStore {
  return {
    byNumber: (conversationId, epochNumber) =>
      fromPromise(
        db
          .select({ id: epochs.id })
          .from(epochs)
          .where(
            and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber))
          ),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    insert: ({
      conversationId,
      epochNumber,
      previousEpochId,
      epochPublicKey,
      confirmationHash,
      chainLink,
    }) =>
      fromPromise(
        db
          .insert(epochs)
          .values({
            conversationId,
            epochNumber,
            previousEpochId,
            epochPublicKey,
            confirmationHash,
            chainLink,
          })
          .returning({ id: epochs.id }),
        storeFailure
      ).andThen((rows) => {
        const row = rows[0];
        return row === undefined
          ? errAsync(storeFailure(new Error('epoch insert returned no row')))
          : okAsync(row);
      }),

    insertWraps: (rows) =>
      rows.length === 0
        ? okAsync()
        : fromPromise(
            db
              .insert(epochMembers)
              .values([...rows])
              .onConflictDoNothing({
                target: [epochMembers.epochId, epochMembers.memberPublicKey],
              }),
            storeFailure
          ).map((): void => undefined),

    deleteWrapsExceptKeys: (conversationId, keys) =>
      fromPromise(
        db
          .delete(epochMembers)
          .where(
            and(
              wrapInConversation(db, conversationId),
              notInArray(epochMembers.memberPublicKey, [...keys])
            )
          ),
        storeFailure
      ).map((): void => undefined),

    deleteWrapsForKeys: (conversationId, keys) =>
      keys.length === 0
        ? okAsync()
        : fromPromise(
            db
              .delete(epochMembers)
              .where(
                and(
                  wrapInConversation(db, conversationId),
                  inArray(epochMembers.memberPublicKey, [...keys])
                )
              ),
            storeFailure
          ).map((): void => undefined),

    // A current-epoch wrap is departed when no live seat of the conversation
    // holds its key: a user seat through its account key, a link seat through
    // the link key. `liveSeat` is the one live-seat predicate, so this answer,
    // the rotation wrap set and the room's membership cannot drift apart.
    conversationsWithDepartedHolders: (conversationIds) =>
      conversationIds.length === 0
        ? okAsync(new Set<string>())
        : fromPromise(
            db
              .selectDistinct({ conversationId: epochs.conversationId })
              .from(epochMembers)
              .innerJoin(epochs, eq(epochMembers.epochId, epochs.id))
              .innerJoin(
                conversations,
                and(
                  eq(conversations.id, epochs.conversationId),
                  eq(conversations.currentEpoch, epochs.epochNumber)
                )
              )
              .where(
                and(
                  inArray(epochs.conversationId, [...conversationIds]),
                  notExists(
                    db
                      .select({ one: sql`1` })
                      .from(conversationMembers)
                      .leftJoin(users, eq(conversationMembers.userId, users.id))
                      .leftJoin(sharedLinks, eq(conversationMembers.linkId, sharedLinks.id))
                      .where(
                        and(
                          liveSeat(conversationIds),
                          eq(conversationMembers.conversationId, epochs.conversationId),
                          or(
                            eq(users.publicKey, epochMembers.memberPublicKey),
                            eq(sharedLinks.linkPublicKey, epochMembers.memberPublicKey)
                          )
                        )
                      )
                  )
                )
              ),
            storeFailure
          ).map((rows): ReadonlySet<string> => new Set(rows.map((row) => row.conversationId))),

    memberInEpoch: ({ conversationId, epochNumber, memberPublicKey }) =>
      fromPromise(
        db
          .select({ id: epochMembers.id })
          .from(epochMembers)
          .innerJoin(epochs, eq(epochMembers.epochId, epochs.id))
          .where(
            and(
              eq(epochs.conversationId, conversationId),
              eq(epochs.epochNumber, epochNumber),
              eq(epochMembers.memberPublicKey, memberPublicKey)
            )
          )
          .limit(1),
        storeFailure
      ).map((rows) => rows.length > 0),

    wrapsForKey: (conversationIds, memberPublicKey) =>
      conversationIds.length === 0
        ? okAsync([])
        : fromPromise(
            db
              .select({
                conversationId: epochs.conversationId,
                epochNumber: epochs.epochNumber,
                wrap: epochMembers.wrap,
                visibleFromEpoch: epochMembers.visibleFromEpoch,
              })
              .from(epochMembers)
              .innerJoin(epochs, eq(epochMembers.epochId, epochs.id))
              .where(
                and(
                  inArray(epochs.conversationId, [...conversationIds]),
                  eq(epochMembers.memberPublicKey, memberPublicKey)
                )
              )
              .orderBy(asc(epochs.epochNumber)),
            storeFailure
          ),

    epochChains: (scopes) =>
      scopes.length === 0
        ? okAsync(new Map())
        : fromPromise(
            db
              .select({
                conversationId: epochs.conversationId,
                epochNumber: epochs.epochNumber,
                epochPublicKey: epochs.epochPublicKey,
                confirmationHash: epochs.confirmationHash,
                previousEpochNumber: predecessor.epochNumber,
                chainLink: epochs.chainLink,
              })
              .from(epochs)
              .leftJoin(predecessor, eq(epochs.previousEpochId, predecessor.id))
              // One OR term per scope rather than one statement per scope:
              // the floors differ by conversation, so the predicate is what
              // carries them, and the read stays a single round trip.
              .where(
                or(
                  ...scopes.map((scope) =>
                    and(
                      eq(epochs.conversationId, scope.conversationId),
                      gte(epochs.epochNumber, scope.fromEpoch)
                    )
                  )
                )
              )
              .orderBy(asc(epochs.epochNumber)),
            storeFailure
          ).map((rows) => {
            const chains = new Map<string, EpochChainRecord[]>();
            for (const { conversationId, ...record } of rows) {
              const records = chains.get(conversationId);
              if (records === undefined) chains.set(conversationId, [record]);
              else records.push(record);
            }
            return chains;
          }),
  };
}
