import { eq } from 'drizzle-orm';
import { sharedLinks, sharedMessages } from '@hushbox/db';
import type { Database } from '@hushbox/db';

/**
 * Dev/E2E fixture writes to this slice's sharing tables, published on the
 * barrel so the dev tooling reaches `shared_links` / `shared_messages`
 * through their owning slice.
 */

interface RevokedSharedLinkFixture {
  /** Caller-chosen so a fixed seed converges; fresh-id callers never conflict. */
  readonly id: string;
  readonly conversationId: string;
  /** Must be unique per row (`link_public_key` unique constraint). */
  readonly linkPublicKey: Uint8Array;
  /** The hash of the token the same link secret derives, so the pair is one a real mint makes. */
  readonly linkAuthHash: Uint8Array;
  readonly displayName: string;
}

/**
 * A revoked shared link. Clean upsert: a stale row from an earlier seed (or
 * a reset dev DB state) re-points at the current conversation instead of
 * dangling; fresh-id callers never hit the conflict.
 */
export async function insertRevokedSharedLink(
  db: Database,
  fixture: RevokedSharedLinkFixture
): Promise<void> {
  await db
    .insert(sharedLinks)
    .values({
      id: fixture.id,
      conversationId: fixture.conversationId,
      linkPublicKey: fixture.linkPublicKey,
      linkAuthHash: fixture.linkAuthHash,
      displayName: fixture.displayName,
      revokedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: sharedLinks.id,
      set: { conversationId: fixture.conversationId, revokedAt: new Date() },
    });
}

/**
 * Hard-deletes a message share, and answers how many rows went. Dev-only by
 * design: a message share carries no revoke column, so in the product a share
 * ends only with its message or its creator's account — this is an E2E lever,
 * never an unshare capability to wire into a product route.
 */
export async function deleteSharedMessageById(db: Database, shareId: string): Promise<number> {
  // RETURNING hands back the deleted rows, so the count is an array length.
  // The driver's own `rowCount` is typed nullable, which would force a
  // fallback that a DELETE can never reach.
  const deleted = await db
    .delete(sharedMessages)
    .where(eq(sharedMessages.id, shareId))
    .returning({ id: sharedMessages.id });
  return deleted.length;
}
