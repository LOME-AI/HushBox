import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { conversationMembers, sharedLinks } from '@hushbox/db';
import { fromPromise } from '../../../lib/result/index.js';
import { storeFailure } from './store-failure.js';
import type { MemberPrivilege } from '@hushbox/shared';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { SharedLinksStore } from '../ports/stores.js';

const sharedLinkColumns = {
  id: sharedLinks.id,
  conversationId: sharedLinks.conversationId,
  displayName: sharedLinks.displayName,
  revokedAt: sharedLinks.revokedAt,
  expiresAt: sharedLinks.expiresAt,
  createdAt: sharedLinks.createdAt,
} as const;

export function createSharedLinksStore(db: DbWriter): SharedLinksStore {
  return {
    insert: (values) =>
      fromPromise(
        // No conflict target: a clash on either unique column, the public key or
        // the auth hash, is a refusal the caller answers, never a thrown 500.
        db.insert(sharedLinks).values(values).onConflictDoNothing().returning(sharedLinkColumns),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    byPublicKey: (linkPublicKey) =>
      fromPromise(
        db
          .select({ ...sharedLinkColumns, linkAuthHash: sharedLinks.linkAuthHash })
          .from(sharedLinks)
          .where(eq(sharedLinks.linkPublicKey, linkPublicKey)),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    byAuthHash: (linkAuthHash) =>
      fromPromise(
        db
          .select(sharedLinkColumns)
          .from(sharedLinks)
          .where(eq(sharedLinks.linkAuthHash, linkAuthHash)),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    listForConversation: (conversationId) =>
      fromPromise(
        db
          .select({
            ...sharedLinkColumns,
            // Privilege lives on the link's guest member row, not on `shared_links`.
            // The link-active partial unique bounds the join to one active guest.
            // Revoked links are filtered out below, so a memberless link (no active
            // guest) reports the column default.
            privilege: sql<MemberPrivilege>`coalesce(${conversationMembers.privilege}, 'write')`,
          })
          .from(sharedLinks)
          .leftJoin(
            conversationMembers,
            and(eq(conversationMembers.linkId, sharedLinks.id), isNull(conversationMembers.leftAt))
          )
          .where(and(eq(sharedLinks.conversationId, conversationId), isNull(sharedLinks.revokedAt)))
          .orderBy(asc(sharedLinks.createdAt), asc(sharedLinks.id)),
        storeFailure
      ),

    byId: (linkId) =>
      fromPromise(
        db.select(sharedLinkColumns).from(sharedLinks).where(eq(sharedLinks.id, linkId)),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    revoke: ({ conversationId, linkId }) =>
      fromPromise(
        db
          .update(sharedLinks)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(sharedLinks.id, linkId),
              eq(sharedLinks.conversationId, conversationId),
              isNull(sharedLinks.revokedAt)
            )
          )
          .returning(sharedLinkColumns),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    unrevoke: ({ conversationId, linkId }) =>
      fromPromise(
        db
          .update(sharedLinks)
          .set({ revokedAt: null })
          .where(
            and(
              eq(sharedLinks.id, linkId),
              eq(sharedLinks.conversationId, conversationId),
              isNotNull(sharedLinks.revokedAt)
            )
          )
          .returning(sharedLinkColumns),
        storeFailure
      ).map((rows) => rows[0] ?? null),

    updateDisplayName: ({ conversationId, linkId, displayName }) =>
      fromPromise(
        db
          .update(sharedLinks)
          .set({ displayName })
          .where(
            and(
              eq(sharedLinks.id, linkId),
              eq(sharedLinks.conversationId, conversationId),
              isNull(sharedLinks.revokedAt)
            )
          )
          .returning({ id: sharedLinks.id }),
        storeFailure
      ).map((rows) => rows.length > 0),
  };
}
