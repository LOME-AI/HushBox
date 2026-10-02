import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { conversationMembers, sharedLinks, users } from '@hushbox/db';
import { toBase64 } from '@hushbox/shared';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { activeInConversation, liveLink, liveSeat } from './seat-predicates.js';
import { storeFailure } from './store-failure.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { MembersStore, MemberKeyRecord } from '../ports/stores.js';

const memberColumns = {
  id: conversationMembers.id,
  userId: conversationMembers.userId,
  linkId: conversationMembers.linkId,
  privilege: conversationMembers.privilege,
  visibleFromEpoch: conversationMembers.visibleFromEpoch,
  joinedAt: conversationMembers.joinedAt,
  acceptedAt: conversationMembers.acceptedAt,
  muted: conversationMembers.muted,
  pinned: conversationMembers.pinned,
  lastReadSeq: conversationMembers.lastReadSeq,
} as const;

/**
 * The one active-membership predicate, over a single conversation or a set of
 * them. The batch read and the single-conversation reads must admit exactly the
 * same members: the batch answers key material, so a clause added to one
 * derivation and not the other hands keys to a member the single read refuses.
 */
function activeMember(
  conversationScope: string | readonly string[],
  userId: string
): ReturnType<typeof and> {
  return and(activeInConversation(conversationScope), eq(conversationMembers.userId, userId));
}

export function createMembersStore(db: DbWriter): MembersStore {
  return {
    activeByUser: (conversationId, userId) =>
      fromPromise(
        db
          .select(memberColumns)
          .from(conversationMembers)
          .where(activeMember(conversationId, userId)),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    activeIdsForUser: (conversationIds, userId) =>
      conversationIds.length === 0
        ? okAsync([])
        : fromPromise(
            db
              .select({ conversationId: conversationMembers.conversationId })
              .from(conversationMembers)
              .where(activeMember(conversationIds, userId)),
            storeFailure
          ).map((rows) => rows.map((row) => row.conversationId)),

    activeLinkGuest: (conversationId, linkId) =>
      fromPromise(
        db
          .select({
            ...memberColumns,
            publicKey: sharedLinks.linkPublicKey,
            displayName: sharedLinks.displayName,
          })
          .from(conversationMembers)
          .innerJoin(sharedLinks, eq(conversationMembers.linkId, sharedLinks.id))
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.linkId, linkId),
              isNull(conversationMembers.leftAt)
            )
          ),
        storeFailure
      ).map((rows) => {
        const row = rows[0];
        return row === undefined
          ? null
          : {
              member: {
                id: row.id,
                userId: row.userId,
                linkId: row.linkId,
                privilege: row.privilege,
                visibleFromEpoch: row.visibleFromEpoch,
                joinedAt: row.joinedAt,
                acceptedAt: row.acceptedAt,
                muted: row.muted,
                pinned: row.pinned,
                lastReadSeq: row.lastReadSeq,
              },
              publicKey: row.publicKey,
              displayName: row.displayName,
            };
      }),

    lockActiveByUser: (conversationId, userId) =>
      fromPromise(
        db
          .select(memberColumns)
          .from(conversationMembers)
          .where(activeMember(conversationId, userId))
          .for('share'),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    activeById: (conversationId, memberId) =>
      fromPromise(
        db
          .select(memberColumns)
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.id, memberId),
              eq(conversationMembers.conversationId, conversationId),
              isNull(conversationMembers.leftAt)
            )
          ),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    listActive: (conversationId) =>
      fromPromise(
        db
          .select({
            id: conversationMembers.id,
            userId: conversationMembers.userId,
            linkId: conversationMembers.linkId,
            username: users.username,
            privilege: conversationMembers.privilege,
            visibleFromEpoch: conversationMembers.visibleFromEpoch,
            joinedAt: conversationMembers.joinedAt,
            acceptedAt: conversationMembers.acceptedAt,
          })
          .from(conversationMembers)
          .leftJoin(users, eq(conversationMembers.userId, users.id))
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              isNull(conversationMembers.leftAt)
            )
          )
          .orderBy(asc(conversationMembers.joinedAt)),
        storeFailure
      ),

    activeKeysOrdered: (conversationId) => selectActiveMemberKeys(db, conversationId),

    countActive: (conversationId) =>
      fromPromise(
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(conversationMembers)
          .leftJoin(sharedLinks, eq(conversationMembers.linkId, sharedLinks.id))
          .where(liveSeat(conversationId)),
        storeFailure
      ).map((rows) => rows[0]?.count ?? 0),

    activePrincipalIds: (conversationId) =>
      fromPromise(
        db
          .select({
            userId: conversationMembers.userId,
            linkId: conversationMembers.linkId,
          })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              isNull(conversationMembers.leftAt)
            )
          ),
        storeFailure
      ).map((rows) =>
        rows.flatMap((row) => {
          const principalId = row.userId ?? row.linkId;
          return principalId === null ? [] : [principalId];
        })
      ),

    insert: ({
      conversationId,
      userId,
      privilege,
      visibleFromEpoch,
      acceptedAt,
      invitedByUserId,
    }) =>
      fromPromise(
        db
          .insert(conversationMembers)
          .values({
            conversationId,
            userId,
            privilege,
            visibleFromEpoch,
            acceptedAt,
            invitedByUserId,
          })
          .onConflictDoNothing({
            target: [conversationMembers.conversationId, conversationMembers.userId],
            where: isNull(conversationMembers.leftAt),
          })
          .returning({ id: conversationMembers.id, joinedAt: conversationMembers.joinedAt }),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    insertLinkMember: ({ conversationId, linkId, privilege, visibleFromEpoch }) =>
      fromPromise(
        db
          .insert(conversationMembers)
          .values({
            conversationId,
            linkId,
            userId: null,
            privilege,
            visibleFromEpoch,
            acceptedAt: new Date(),
          })
          .onConflictDoNothing({
            target: [conversationMembers.conversationId, conversationMembers.linkId],
            where: isNull(conversationMembers.leftAt),
          })
          .returning({ id: conversationMembers.id }),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    markLeft: ({ conversationId, memberId }) =>
      fromPromise(
        db
          .update(conversationMembers)
          .set({ leftAt: new Date() })
          .where(
            and(
              eq(conversationMembers.id, memberId),
              eq(conversationMembers.conversationId, conversationId),
              isNull(conversationMembers.leftAt)
            )
          )
          .returning({ userId: conversationMembers.userId }),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    markLeftByLink: ({ conversationId, linkId }) =>
      fromPromise(
        db
          .update(conversationMembers)
          .set({ leftAt: new Date() })
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.linkId, linkId),
              isNull(conversationMembers.leftAt)
            )
          )
          .returning({ id: conversationMembers.id }),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    setAccepted: ({ conversationId, userId }) =>
      fromPromise(
        db
          .update(conversationMembers)
          .set({ acceptedAt: new Date() })
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.userId, userId),
              isNull(conversationMembers.acceptedAt),
              isNull(conversationMembers.leftAt)
            )
          )
          .returning({ id: conversationMembers.id }),
        storeFailure
      ).map((rows) => rows.length > 0),

    declinePending: ({ conversationId, userId }) =>
      fromPromise(
        db
          .update(conversationMembers)
          .set({ leftAt: new Date() })
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.userId, userId),
              isNull(conversationMembers.acceptedAt),
              isNull(conversationMembers.leftAt)
            )
          )
          .returning({ id: conversationMembers.id }),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    updatePrivilege: ({ conversationId, memberId, privilege }) =>
      fromPromise(
        db
          .update(conversationMembers)
          .set({ privilege })
          .where(
            and(
              eq(conversationMembers.id, memberId),
              eq(conversationMembers.conversationId, conversationId),
              isNull(conversationMembers.leftAt)
            )
          )
          .returning({ id: conversationMembers.id }),
        storeFailure
      ).map((rows) => rows.length > 0),

    updatePrivilegeByLink: ({ conversationId, linkId, privilege }) =>
      fromPromise(
        db
          .update(conversationMembers)
          .set({ privilege })
          .where(
            and(
              eq(conversationMembers.linkId, linkId),
              eq(conversationMembers.conversationId, conversationId),
              isNull(conversationMembers.leftAt)
            )
          )
          .returning({ id: conversationMembers.id }),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    setMuted: ({ conversationId, userId, muted }) =>
      fromPromise(
        db
          .update(conversationMembers)
          .set({ muted })
          .where(activeMember(conversationId, userId))
          .returning({ id: conversationMembers.id }),
        storeFailure
      ).map((rows) => rows.length > 0),

    setPinned: ({ conversationId, userId, pinned }) =>
      fromPromise(
        db
          .update(conversationMembers)
          .set({ pinned })
          .where(activeMember(conversationId, userId))
          .returning({ id: conversationMembers.id }),
        storeFailure
      ).map((rows) => rows.length > 0),

    advanceLastReadSeq: ({ conversationId, userId, lastReadSeq }) =>
      fromPromise(
        db
          .update(conversationMembers)
          .set({
            lastReadSeq: sql`greatest(${conversationMembers.lastReadSeq}, ${lastReadSeq}::bigint)`,
          })
          .where(activeMember(conversationId, userId))
          .returning({ lastReadSeq: conversationMembers.lastReadSeq }),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    activeVisibilityByKey: (conversationId) => {
      const active = activeInConversation(conversationId);
      const userRows = fromPromise(
        db
          .select({
            publicKey: users.publicKey,
            visibleFromEpoch: conversationMembers.visibleFromEpoch,
          })
          .from(conversationMembers)
          .innerJoin(users, eq(conversationMembers.userId, users.id))
          .where(active),
        storeFailure
      );
      const linkRows = fromPromise(
        db
          .select({
            publicKey: sharedLinks.linkPublicKey,
            visibleFromEpoch: conversationMembers.visibleFromEpoch,
          })
          .from(conversationMembers)
          .innerJoin(sharedLinks, eq(conversationMembers.linkId, sharedLinks.id))
          .where(and(active, liveLink())),
        storeFailure
      );
      return userRows.andThen((fromUsers) =>
        linkRows.map((fromLinks) => {
          const map = new Map<string, number>();
          for (const row of [...fromUsers, ...fromLinks]) {
            map.set(toBase64(row.publicKey), row.visibleFromEpoch);
          }
          return map;
        })
      );
    },
  };
}

/**
 * The active-member public-key set, ordered by `joinedAt`. The union of user
 * members and link members cannot be a single ORDER BY, so the merge sorts in
 * memory (legacy parity). Extracted to module scope so its query nesting stays
 * shallow.
 */
function selectActiveMemberKeys(
  db: DbWriter,
  conversationId: string
): ResultAsync<MemberKeyRecord[], DomainError> {
  const active = activeInConversation(conversationId);
  const userRows = fromPromise(
    db
      .select({
        memberId: conversationMembers.id,
        userId: conversationMembers.userId,
        publicKey: users.publicKey,
        privilege: conversationMembers.privilege,
        visibleFromEpoch: conversationMembers.visibleFromEpoch,
        joinedAt: conversationMembers.joinedAt,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(conversationMembers.userId, users.id))
      .where(active),
    storeFailure
  );
  // The link read is issued from the continuation, after the user read returns:
  // the request's database is serial and refuses a read issued while another is
  // in flight.
  return userRows.andThen((fromUsers) =>
    fromPromise(
      db
        .select({
          memberId: conversationMembers.id,
          linkId: conversationMembers.linkId,
          publicKey: sharedLinks.linkPublicKey,
          privilege: conversationMembers.privilege,
          visibleFromEpoch: conversationMembers.visibleFromEpoch,
          joinedAt: conversationMembers.joinedAt,
        })
        .from(conversationMembers)
        .innerJoin(sharedLinks, eq(conversationMembers.linkId, sharedLinks.id))
        .where(and(active, liveLink())),
      storeFailure
    ).map((fromLinks) => mergeMemberKeys(fromUsers, fromLinks))
  );
}

type SortableKey = MemberKeyRecord & { readonly joinedAt: Date };

function mergeMemberKeys(
  fromUsers: readonly Omit<SortableKey, 'linkId'>[],
  fromLinks: readonly Omit<SortableKey, 'userId'>[]
): MemberKeyRecord[] {
  const all: SortableKey[] = [
    ...fromUsers.map((row) => ({ ...row, linkId: null })),
    ...fromLinks.map((row) => ({ ...row, userId: null })),
  ];
  all.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  return all.map((row) => ({
    memberId: row.memberId,
    userId: row.userId,
    linkId: row.linkId,
    publicKey: row.publicKey,
    privilege: row.privilege,
    visibleFromEpoch: row.visibleFromEpoch,
  }));
}
