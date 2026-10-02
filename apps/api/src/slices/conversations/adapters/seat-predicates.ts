import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { conversationMembers, sharedLinks } from '@hushbox/db';
import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * The one "has not left" test, over the member table or an alias of it (a
 * correlated subquery needs the alias to tell its rows from the outer query's).
 */
export function notLeft(members: { readonly leftAt: PgColumn }): SQL {
  return isNull(members.leftAt);
}

/** Every seat not left in a conversation, or in a set of them, whoever holds it. */
export function activeInConversation(
  conversationScope: string | readonly string[]
): ReturnType<typeof and> {
  return and(
    typeof conversationScope === 'string'
      ? eq(conversationMembers.conversationId, conversationScope)
      : inArray(conversationMembers.conversationId, [...conversationScope]),
    notLeft(conversationMembers)
  );
}

/**
 * The one link-liveness predicate. A lapsed link is never stamped `leftAt` —
 * expiry is enforced lazily at read — so every read that treats a link as a live
 * seat must carry this, the room's broadcast-time membership included. The
 * rotation wrap set and the member-key list the client builds that wrap set from
 * must admit exactly the same keys or `planEpochWraps` refuses every rotation for
 * the conversation. Expiry is inclusive of the instant itself, matching the link
 * credential resolution that guards the guest's own reads.
 */
export function liveLink(): ReturnType<typeof and> {
  return and(
    isNull(sharedLinks.revokedAt),
    or(isNull(sharedLinks.expiresAt), gt(sharedLinks.expiresAt, sql`now()`))
  );
}

/**
 * The one live-seat predicate over user and link seats together: a seat not left,
 * and on a live link when a link holds it. The member cap and the room's
 * membership must agree on it. The query must left-join `shared_links` on the
 * seat's `link_id`, because the link half reads the joined link's columns.
 */
export function liveSeat(conversationScope: string | readonly string[]): ReturnType<typeof and> {
  return and(
    activeInConversation(conversationScope),
    or(isNull(conversationMembers.linkId), liveLink())
  );
}
