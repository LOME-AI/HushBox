import type { Context } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { conversationMembers } from '@hushbox/db';
import { fromBase64 } from '@hushbox/shared';
import type { AppEnv } from '../types.js';
import { findActiveSharedLink } from '../lib/db-helpers.js';
import { LINK_PUBLIC_KEY_HEADER } from './constants.js';

export interface ResolvedLinkGuest {
  linkId: string;
  publicKey: Uint8Array;
  displayName: string | null;
  member: { id: string; privilege: string; visibleFromEpoch: number };
}

/**
 * Resolves a link guest from the request context.
 *
 * Reads `x-link-public-key` header and `conversationId` route param,
 * looks up the shared link and associated member row.
 *
 * Returns null if any lookup step fails (missing header, no shared link, no member).
 */
export async function resolveLinkGuest(c: Context<AppEnv>): Promise<ResolvedLinkGuest | null> {
  const linkPublicKeyBase64 = c.req.header(LINK_PUBLIC_KEY_HEADER) ?? c.req.query('linkPublicKey');
  const conversationId = c.req.param('conversationId');
  if (!linkPublicKeyBase64 || !conversationId) {
    return null;
  }

  const db = c.get('db');
  const linkPublicKeyBytes = fromBase64(linkPublicKeyBase64);
  const sharedLink = await findActiveSharedLink(db, conversationId, linkPublicKeyBytes);
  if (!sharedLink) {
    return null;
  }

  const member = await db
    .select({
      id: conversationMembers.id,
      privilege: conversationMembers.privilege,
      visibleFromEpoch: conversationMembers.visibleFromEpoch,
    })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.linkId, sharedLink.id), isNull(conversationMembers.leftAt)))
    .limit(1)
    .then((rows) => rows[0]);

  if (!member) {
    return null;
  }

  return {
    linkId: sharedLink.id,
    publicKey: linkPublicKeyBytes,
    displayName: sharedLink.displayName,
    member,
  };
}
