import { afterAll, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  epochs,
  messages,
  sharedLinks,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { toBase64 } from '@hushbox/shared';
import { HOUR_MS, MINUTE_MS } from '@hushbox/shared/test-time';
import { createConversationsStores } from './stores.js';
import { isActiveConversationMember } from './presign-reads.js';
import { seedConversationWithEpoch } from '../../../test-support/conversation-seed.js';
import { mintLinkCredential } from '../../../test-support/link-credential.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for conversations store tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createConversationsStores(db);

const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

async function seedUserAndConversation(): Promise<{ userId: string; conversationId: string }> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userRows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@fork-stores.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey: crypto.getRandomValues(new Uint8Array(32)),
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = userRows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  const { conversationId } = await seedConversationWithEpoch(db, { userId, title: BYTES });
  createdConversationIds.push(conversationId);
  return { userId, conversationId };
}

async function seedConversation(): Promise<string> {
  const seeded = await seedUserAndConversation();
  return seeded.conversationId;
}

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

/**
 * The real Postgres error chains behind the fork-name catch mapping. The
 * domain pre-checks make these unreachable through the routes (the byKey
 * transaction would abort), so the raw-client store contract is proven here.
 */
describe('fork store unique-violation mapping (real error chains)', () => {
  it('maps the fork-name unique violation to name-taken on insert', async () => {
    const conversationId = await seedConversation();
    const first = await stores.forks.insert({
      id: null,
      conversationId,
      name: 'Dup',
      tipMessageId: null,
    });
    expect(first._unsafeUnwrap()).not.toBe('name-taken');
    const second = await stores.forks.insert({
      id: null,
      conversationId,
      name: 'Dup',
      tipMessageId: null,
    });
    expect(second._unsafeUnwrap()).toBe('name-taken');
  });

  it('maps the fork-name unique violation to name-taken on rename', async () => {
    const conversationId = await seedConversation();
    const seeded = await stores.forks.insert({
      id: null,
      conversationId,
      name: 'One',
      tipMessageId: null,
    });
    expect(seeded._unsafeUnwrap()).not.toBe('name-taken');
    const other = await stores.forks.insert({
      id: null,
      conversationId,
      name: 'Two',
      tipMessageId: null,
    });
    const otherRecord = other._unsafeUnwrap();
    if (typeof otherRecord === 'string') throw new Error('seed fork collided');
    const renamed = await stores.forks.rename({
      conversationId,
      forkId: otherRecord.id,
      name: 'One',
    });
    expect(renamed._unsafeUnwrap()).toBe('name-taken');
  });

  it('answers unavailable for a non-unique constraint failure', async () => {
    const result = await stores.forks.insert({
      id: null,
      conversationId: crypto.randomUUID(),
      name: 'Orphan',
      tipMessageId: null,
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('fork list over a tip the database nulled', () => {
  it('lists a fork whose tip message was deleted', async () => {
    const conversationId = await seedConversation();
    const messageRows = await db
      .insert(messages)
      .values({
        conversationId,
        senderType: 'user',
        wrappedContentKey: BYTES,
        epochNumber: 1,
        sequenceNumber: 1,
      })
      .returning({ id: messages.id });
    const messageId = messageRows[0]?.id;
    if (messageId === undefined) throw new Error('message seed failed');
    const inserted = await stores.forks.insert({
      id: null,
      conversationId,
      name: 'Tipped',
      tipMessageId: messageId,
    });
    const record = inserted._unsafeUnwrap();
    if (typeof record === 'string') throw new Error('fork seed collided');

    // `tip_message_id` is ON DELETE SET NULL, so deleting the message leaves a
    // live fork with no tip. The list must floor such a fork, never drop it.
    await db.delete(messages).where(eq(messages.id, messageId));

    const listed = await stores.forks.list(conversationId);
    const rows = listed._unsafeUnwrap();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: record.id,
      name: 'Tipped',
      tipMessageId: null,
      tipEpochNumber: null,
    });
  });
});

describe('single-statement contract arms unreachable through the domain', () => {
  it('converges a member insert lost to the active-unique index to null', async () => {
    const { userId, conversationId } = await seedUserAndConversation();
    const insert = {
      conversationId,
      userId,
      privilege: 'write' as const,
      visibleFromEpoch: 1,
      acceptedAt: null,
      invitedByUserId: null,
    };
    const first = await stores.members.insert(insert);
    expect(first._unsafeUnwrap()).not.toBeNull();
    const second = await stores.members.insert(insert);
    expect(second._unsafeUnwrap()).toBeNull();
  });

  it('answers null when marking an unknown member left', async () => {
    const conversationId = await seedConversation();
    const result = await stores.members.markLeft({
      conversationId,
      memberId: crypto.randomUUID(),
    });
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('answers null for a missing epoch number', async () => {
    const conversationId = await seedConversation();
    const missing = await stores.epochs.byNumber(conversationId, 99);
    expect(missing._unsafeUnwrap()).toBeNull();
  });

  it('answers null for the latest message of an empty conversation', async () => {
    const conversationId = await seedConversation();
    const latest = await stores.messages.latestId(conversationId);
    expect(latest._unsafeUnwrap()).toBeNull();
  });
});

describe('message history over a conversation with no messages', () => {
  it('reads an empty page', async () => {
    const conversationId = await seedConversation();
    const page = await stores.messages.history({
      conversationId,
      minEpoch: 1,
      afterSequence: null,
      limit: 10,
    });
    expect(page._unsafeUnwrap()).toEqual([]);
  });
});

/** Inserts an epoch row for the conversation and returns its number. */
async function seedEpoch(conversationId: string, epochNumber: number): Promise<number> {
  const inserted = await stores.epochs.insert({
    conversationId,
    epochNumber,
    previousEpochId: null,
    epochPublicKey: crypto.getRandomValues(new Uint8Array(32)),
    confirmationHash: crypto.getRandomValues(new Uint8Array(32)),
    chainLink: null,
  });
  inserted._unsafeUnwrap();
  return epochNumber;
}

async function storedTitle(
  conversationId: string
): Promise<{ title: Uint8Array; titleEpochNumber: number }> {
  const rows = await db
    .select({ title: conversations.title, titleEpochNumber: conversations.titleEpochNumber })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  const row = rows[0];
  if (row === undefined) throw new Error('conversation row missing');
  return row;
}

describe('title write epoch correlation', () => {
  it('writes the title when the epoch number names an epoch of the conversation', async () => {
    const { userId, conversationId } = await seedUserAndConversation();
    const written = await stores.conversations.updateTitle({
      conversationId,
      ownerUserId: userId,
      title: new Uint8Array([4, 5, 6]),
      titleEpochNumber: 1,
    });
    expect(written._unsafeUnwrap()).not.toBeNull();
    expect(await storedTitle(conversationId)).toEqual({
      title: new Uint8Array([4, 5, 6]),
      titleEpochNumber: 1,
    });
  });

  it('leaves the row untouched when the epoch number names no epoch of the conversation', async () => {
    const { userId, conversationId } = await seedUserAndConversation();
    const before = await storedTitle(conversationId);
    const written = await stores.conversations.updateTitle({
      conversationId,
      ownerUserId: userId,
      title: new Uint8Array([4, 5, 6]),
      titleEpochNumber: 9999,
    });
    expect(written._unsafeUnwrap()).toBeNull();
    expect(await storedTitle(conversationId)).toEqual(before);
  });

  it('leaves the row untouched when the epoch number belongs to another conversation', async () => {
    const { userId, conversationId } = await seedUserAndConversation();
    const other = await seedUserAndConversation();
    await seedEpoch(other.conversationId, 7);
    const before = await storedTitle(conversationId);
    const written = await stores.conversations.updateTitle({
      conversationId,
      ownerUserId: userId,
      title: new Uint8Array([4, 5, 6]),
      titleEpochNumber: 7,
    });
    expect(written._unsafeUnwrap()).toBeNull();
    expect(await storedTitle(conversationId)).toEqual(before);
  });
});

async function seedLink(conversationId: string): Promise<string> {
  const { linkPublicKey, linkAuthHash } = mintLinkCredential();
  const rows = await db
    .insert(sharedLinks)
    .values({ conversationId, linkPublicKey, linkAuthHash })
    .returning({ id: sharedLinks.id });
  const linkId = rows[0]?.id;
  if (linkId === undefined) throw new Error('shared link seed failed');
  return linkId;
}

describe('link-guest member helpers', () => {
  it('seats a link guest (userId null, accepted) and converges a duplicate active insert', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const first = await stores.members.insertLinkMember({
      conversationId,
      linkId,
      privilege: 'read',
      visibleFromEpoch: 1,
    });
    expect(first._unsafeUnwrap()).not.toBeNull();
    const row = await db
      .select()
      .from(conversationMembers)
      .where(and(eq(conversationMembers.linkId, linkId), isNull(conversationMembers.leftAt)));
    expect(row[0]?.userId).toBeNull();
    expect(row[0]?.privilege).toBe('read');
    expect(row[0]?.acceptedAt).not.toBeNull();
    // A second active insert converges to null on the link-active unique index.
    const second = await stores.members.insertLinkMember({
      conversationId,
      linkId,
      privilege: 'read',
      visibleFromEpoch: 1,
    });
    expect(second._unsafeUnwrap()).toBeNull();
  });

  it('marks the link guest left and denies the presign member gate thereafter', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const seated = await stores.members.insertLinkMember({
      conversationId,
      linkId,
      privilege: 'write',
      visibleFromEpoch: 1,
    });
    expect(seated._unsafeUnwrap()).not.toBeNull();
    const before = await isActiveConversationMember(db, conversationId, {
      kind: 'linkGuest',
      linkId,
    });
    expect(before._unsafeUnwrap()).toBe(true);

    const left = await stores.members.markLeftByLink({ conversationId, linkId });
    expect(left._unsafeUnwrap()).not.toBeNull();
    const row = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.linkId, linkId));
    expect(row[0]?.leftAt).not.toBeNull();
    // Security invariant: the presign member path (leftAt-only) now denies the guest.
    const after = await isActiveConversationMember(db, conversationId, {
      kind: 'linkGuest',
      linkId,
    });
    expect(after._unsafeUnwrap()).toBe(false);
  });

  it('answers null when marking an already-left link guest', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const result = await stores.members.markLeftByLink({ conversationId, linkId });
    expect(result._unsafeUnwrap()).toBeNull();
  });
});

describe('link privilege and display-name writes', () => {
  it('updates the active guest member privilege and returns its id', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const seated = await stores.members.insertLinkMember({
      conversationId,
      linkId,
      privilege: 'read',
      visibleFromEpoch: 1,
    });
    const memberId = seated._unsafeUnwrap()?.id;
    const updated = await stores.members.updatePrivilegeByLink({
      conversationId,
      linkId,
      privilege: 'write',
    });
    expect(updated._unsafeUnwrap()).toEqual({ id: memberId });
    const row = await db
      .select({ privilege: conversationMembers.privilege })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.linkId, linkId), isNull(conversationMembers.leftAt)));
    expect(row[0]?.privilege).toBe('write');
  });

  it('returns null updating a link with no active guest member', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const updated = await stores.members.updatePrivilegeByLink({
      conversationId,
      linkId,
      privilege: 'write',
    });
    expect(updated._unsafeUnwrap()).toBeNull();
  });

  it('renames a live link and reports true', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const result = await stores.sharedLinks.updateDisplayName({
      conversationId,
      linkId,
      displayName: 'renamed',
    });
    expect(result._unsafeUnwrap()).toBe(true);
    const row = await db
      .select({ displayName: sharedLinks.displayName })
      .from(sharedLinks)
      .where(eq(sharedLinks.id, linkId));
    expect(row[0]?.displayName).toBe('renamed');
  });

  it('reports false renaming a revoked link', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    await db.update(sharedLinks).set({ revokedAt: new Date() }).where(eq(sharedLinks.id, linkId));
    const result = await stores.sharedLinks.updateDisplayName({
      conversationId,
      linkId,
      displayName: 'nope',
    });
    expect(result._unsafeUnwrap()).toBe(false);
  });
});

describe('shared-link revoke claim', () => {
  it('answers null revoking an already-revoked link (0 rows claimed)', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    await db.update(sharedLinks).set({ revokedAt: new Date() }).where(eq(sharedLinks.id, linkId));
    const result = await stores.sharedLinks.revoke({ conversationId, linkId });
    expect(result._unsafeUnwrap()).toBeNull();
  });
});

describe('shared-link unrevoke claim', () => {
  it('clears revokedAt on a revoked link and returns the live record', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    await db.update(sharedLinks).set({ revokedAt: new Date() }).where(eq(sharedLinks.id, linkId));
    const result = await stores.sharedLinks.unrevoke({ conversationId, linkId });
    expect(result._unsafeUnwrap()?.revokedAt).toBeNull();
    const row = await db
      .select({ revokedAt: sharedLinks.revokedAt })
      .from(sharedLinks)
      .where(eq(sharedLinks.id, linkId));
    expect(row[0]?.revokedAt).toBeNull();
  });

  it('answers null unrevoking a live link (0 rows claimed)', async () => {
    const conversationId = await seedConversation();
    const linkId = await seedLink(conversationId);
    const result = await stores.sharedLinks.unrevoke({ conversationId, linkId });
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('answers null for a link of another conversation', async () => {
    const conversationId = await seedConversation();
    const other = await seedConversation();
    const linkId = await seedLink(conversationId);
    await db.update(sharedLinks).set({ revokedAt: new Date() }).where(eq(sharedLinks.id, linkId));
    const result = await stores.sharedLinks.unrevoke({ conversationId: other, linkId });
    expect(result._unsafeUnwrap()).toBeNull();
  });
});

describe('listForConversation privilege projection', () => {
  async function seatLink(conversationId: string, privilege: 'read' | 'write'): Promise<string> {
    const linkId = await seedLink(conversationId);
    const seated = await stores.members.insertLinkMember({
      conversationId,
      linkId,
      privilege,
      visibleFromEpoch: 1,
    });
    seated._unsafeUnwrap();
    return linkId;
  }

  it('projects a freshly seated link guest privilege (write)', async () => {
    const conversationId = await seedConversation();
    const linkId = await seatLink(conversationId, 'write');
    const listed = await stores.sharedLinks.listForConversation(conversationId);
    const links = listed._unsafeUnwrap();
    expect(links.find((l) => l.id === linkId)?.privilege).toBe('write');
  });

  it('projects a read link guest privilege', async () => {
    const conversationId = await seedConversation();
    const linkId = await seatLink(conversationId, 'read');
    const listed = await stores.sharedLinks.listForConversation(conversationId);
    const links = listed._unsafeUnwrap();
    expect(links.find((l) => l.id === linkId)?.privilege).toBe('read');
  });

  it('falls back to the write default for a link with no active guest member', async () => {
    const conversationId = await seedConversation();
    const linkId = await seatLink(conversationId, 'read');
    // Revoking marks the guest left; the link then has no active member row.
    const left = await stores.members.markLeftByLink({ conversationId, linkId });
    left._unsafeUnwrap();
    const listed = await stores.sharedLinks.listForConversation(conversationId);
    const links = listed._unsafeUnwrap();
    expect(links.find((l) => l.id === linkId)?.privilege).toBe('write');
  });

  it('excludes a revoked link from the list', async () => {
    const conversationId = await seedConversation();
    const liveId = await seedLink(conversationId);
    const revokedId = await seedLink(conversationId);
    await db
      .update(sharedLinks)
      .set({ revokedAt: new Date() })
      .where(eq(sharedLinks.id, revokedId));
    const listed = await stores.sharedLinks.listForConversation(conversationId);
    const links = listed._unsafeUnwrap();
    expect(links.find((l) => l.id === revokedId)).toBeUndefined();
    expect(links.find((l) => l.id === liveId)).toBeDefined();
  });
});

describe('link lifetime and the active-member reads', () => {
  async function seatLink(
    conversationId: string,
    lifetime: { readonly expiresAt?: Date | null; readonly revokedAt?: Date | null }
  ): Promise<{ linkId: string; publicKey: Uint8Array }> {
    const { linkPublicKey: publicKey, linkAuthHash } = mintLinkCredential();
    const rows = await db
      .insert(sharedLinks)
      .values({
        conversationId,
        linkPublicKey: publicKey,
        linkAuthHash,
        expiresAt: lifetime.expiresAt ?? null,
        revokedAt: lifetime.revokedAt ?? null,
      })
      .returning({ id: sharedLinks.id });
    const linkId = rows[0]?.id;
    if (linkId === undefined) throw new Error('shared link seed failed');
    const seated = await stores.members.insertLinkMember({
      conversationId,
      linkId,
      privilege: 'write',
      visibleFromEpoch: 1,
    });
    seated._unsafeUnwrap();
    return { linkId, publicKey };
  }

  it('does not count an expired link guest against the member cap', async () => {
    const conversationId = await seedConversation();
    await seatLink(conversationId, { expiresAt: new Date(Date.now() - MINUTE_MS) });
    const count = await stores.members.countActive(conversationId);
    expect(count._unsafeUnwrap()).toBe(0);
  });

  it('counts a link guest whose expiry has not arrived', async () => {
    const conversationId = await seedConversation();
    await seatLink(conversationId, { expiresAt: new Date(Date.now() + HOUR_MS) });
    const count = await stores.members.countActive(conversationId);
    expect(count._unsafeUnwrap()).toBe(1);
  });

  it('omits an expired link key from the rotation wrap set', async () => {
    const conversationId = await seedConversation();
    const expired = await seatLink(conversationId, {
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });
    const visibility = await stores.members.activeVisibilityByKey(conversationId);
    expect(visibility._unsafeUnwrap().has(toBase64(expired.publicKey))).toBe(false);
  });

  it('omits a revoked link key from the rotation wrap set', async () => {
    const conversationId = await seedConversation();
    const revoked = await seatLink(conversationId, { revokedAt: new Date() });
    const visibility = await stores.members.activeVisibilityByKey(conversationId);
    expect(visibility._unsafeUnwrap().has(toBase64(revoked.publicKey))).toBe(false);
  });

  it('omits an expired link key from the ordered member keys', async () => {
    const conversationId = await seedConversation();
    const expired = await seatLink(conversationId, {
      expiresAt: new Date(Date.now() - MINUTE_MS),
    });
    const keys = await stores.members.activeKeysOrdered(conversationId);
    expect(keys._unsafeUnwrap().map((key) => key.linkId)).not.toContain(expired.linkId);
  });

  it('keeps a link with no expiry in the ordered member keys', async () => {
    const conversationId = await seedConversation();
    const live = await seatLink(conversationId, { expiresAt: null });
    const keys = await stores.members.activeKeysOrdered(conversationId);
    expect(keys._unsafeUnwrap().map((key) => key.linkId)).toContain(live.linkId);
  });
});

describe('read-cursor write', () => {
  async function seedMember(): Promise<{ userId: string; conversationId: string }> {
    const seeded = await seedUserAndConversation();
    await db.insert(conversationMembers).values({
      conversationId: seeded.conversationId,
      userId: seeded.userId,
      privilege: 'owner',
      visibleFromEpoch: 1,
    });
    return seeded;
  }

  it('advances the cursor to a higher sequence', async () => {
    const { userId, conversationId } = await seedMember();
    const advanced = await stores.members.advanceLastReadSeq({
      conversationId,
      userId,
      lastReadSeq: 7n,
    });
    expect(advanced._unsafeUnwrap()).toEqual({ lastReadSeq: 7n });
  });

  it('keeps the higher cursor when the same write replays', async () => {
    const { userId, conversationId } = await seedMember();
    const firstWrite = await stores.members.advanceLastReadSeq({
      conversationId,
      userId,
      lastReadSeq: 12n,
    });
    firstWrite._unsafeUnwrap();
    const replay = await stores.members.advanceLastReadSeq({
      conversationId,
      userId,
      lastReadSeq: 12n,
    });
    expect(replay._unsafeUnwrap()).toEqual({ lastReadSeq: 12n });
  });

  it('never regresses the cursor on an out-of-order lower write', async () => {
    const { userId, conversationId } = await seedMember();
    const firstWrite = await stores.members.advanceLastReadSeq({
      conversationId,
      userId,
      lastReadSeq: 30n,
    });
    firstWrite._unsafeUnwrap();
    const stale = await stores.members.advanceLastReadSeq({
      conversationId,
      userId,
      lastReadSeq: 4n,
    });
    expect(stale._unsafeUnwrap()).toEqual({ lastReadSeq: 30n });
  });

  it('answers null for a caller with no active membership', async () => {
    const { conversationId } = await seedMember();
    const other = await seedUserAndConversation();
    const missing = await stores.members.advanceLastReadSeq({
      conversationId,
      userId: other.userId,
      lastReadSeq: 3n,
    });
    expect(missing._unsafeUnwrap()).toBeNull();
  });

  it('never advances another member of the same conversation', async () => {
    const { userId, conversationId } = await seedMember();
    const bystander = await seedUserAndConversation();
    await db.insert(conversationMembers).values({
      conversationId,
      userId: bystander.userId,
      privilege: 'write',
      visibleFromEpoch: 1,
    });
    const ownWrite = await stores.members.advanceLastReadSeq({
      conversationId,
      userId,
      lastReadSeq: 9n,
    });
    ownWrite._unsafeUnwrap();
    const untouched = await stores.members.activeByUser(conversationId, bystander.userId);
    expect(untouched._unsafeUnwrap()?.lastReadSeq).toBe(0n);
  });
});

describe('rotation claim title write', () => {
  /**
   * The claim advances `current_epoch`, which is a foreign key into `epochs`, so
   * the epoch it lands on has to be written before the transaction commits —
   * exactly the order the rotation domain uses.
   */
  async function claimRotationToEpochTwo(
    conversationId: string,
    encryptedTitle: Uint8Array | null
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const claimed = await createConversationsStores(tx).conversations.claimRotation({
        conversationId,
        expectedEpoch: 1,
        encryptedTitle,
      });
      await tx.insert(epochs).values({
        conversationId,
        epochNumber: 2,
        epochPublicKey: BYTES,
        confirmationHash: BYTES,
      });
      return claimed._unsafeUnwrap();
    });
  }

  it('rewrites the title and its epoch when the claim carries one', async () => {
    const conversationId = await seedConversation();
    const newTitle = new Uint8Array([9, 9, 9]);

    const claimed = await claimRotationToEpochTwo(conversationId, newTitle);

    expect(claimed).toBe(true);
    const read = await stores.conversations.get(conversationId);
    const row = read._unsafeUnwrap();
    expect(row?.title).toEqual(newTitle);
    expect(row?.titleEpochNumber).toBe(2);
  });

  it('keeps the title and its epoch when the claim carries none', async () => {
    const conversationId = await seedConversation();

    const claimed = await claimRotationToEpochTwo(conversationId, null);

    expect(claimed).toBe(true);
    const read = await stores.conversations.get(conversationId);
    const row = read._unsafeUnwrap();
    expect(row?.title).toEqual(BYTES);
    expect(row?.titleEpochNumber).toBe(1);
    expect(row?.currentEpoch).toBe(2);
  });
});

describe('conversation budget exposure', () => {
  it('surfaces the configured per-conversation budget on the record', async () => {
    const { userId } = await seedUserAndConversation();
    const { conversationId } = await seedConversationWithEpoch(db, {
      userId,
      title: BYTES,
      conversationBudgetNanoUsd: 3_000_000_000n,
    });
    createdConversationIds.push(conversationId);

    const found = await stores.conversations.get(conversationId);
    expect(found._unsafeUnwrap()?.conversationBudgetNanoUsd).toBe(3_000_000_000n);
  });

  it('defaults an unconfigured conversation budget to zero (no owner funding)', async () => {
    const conversationId = await seedConversation();
    const found = await stores.conversations.get(conversationId);
    expect(found._unsafeUnwrap()?.conversationBudgetNanoUsd).toBe(0n);
  });
});

/**
 * The batch keychain's set-based reads. Each is one statement over a whole id
 * set, which is what keeps a 100-conversation refresh at a constant number of
 * round trips on the `max: 1` pool the Neon driver opens.
 */
describe('set-based reads behind the batch keychain', () => {
  /** `toSorted` needs an explicit collation comparator (sonarjs/no-alphabetical-sort). */
  const byId = (a: string, b: string): number => a.localeCompare(b);

  /**
   * Epoch 1 already exists — the conversation seed commits it alongside the row
   * that names it — so this adds 2..count and answers every epoch id in order.
   */
  async function seedEpochs(conversationId: string, count: number): Promise<string[]> {
    if (count > 1) {
      await db.insert(epochs).values(
        Array.from({ length: count - 1 }, (_unused, index) => ({
          conversationId,
          epochNumber: index + 2,
          epochPublicKey: BYTES,
          confirmationHash: new Uint8Array([index + 2]),
          chainLink: new Uint8Array([101 + index]),
        }))
      );
    }
    const rows = await db
      .select({ id: epochs.id })
      .from(epochs)
      .where(eq(epochs.conversationId, conversationId))
      .orderBy(asc(epochs.epochNumber));
    return rows.map((row) => row.id);
  }

  it('reads no epoch below the floor a chain scope names', async () => {
    const conversationId = await seedConversation();
    await seedEpochs(conversationId, 4);

    const chains = await stores.epochs.epochChains([{ conversationId, fromEpoch: 3 }]);

    const records = chains._unsafeUnwrap().get(conversationId);
    expect(records?.map((row) => row.epochNumber)).toEqual([3, 4]);
  });

  it("names each epoch's predecessor by the number of the row it chains to", async () => {
    const conversationId = await seedConversation();
    const [first] = await seedEpochs(conversationId, 1);
    await db.insert(epochs).values({
      conversationId,
      epochNumber: 2,
      previousEpochId: first ?? null,
      epochPublicKey: new Uint8Array([7, 2]),
      confirmationHash: BYTES,
      chainLink: new Uint8Array([102]),
    });
    await db.insert(epochs).values({
      conversationId,
      epochNumber: 3,
      previousEpochId: first ?? null,
      epochPublicKey: BYTES,
      confirmationHash: BYTES,
      chainLink: new Uint8Array([103]),
    });

    const chains = await stores.epochs.epochChains([{ conversationId, fromEpoch: 1 }]);

    const records = chains._unsafeUnwrap().get(conversationId);
    expect(records?.map((row) => [row.epochNumber, row.previousEpochNumber])).toEqual([
      [1, null],
      [2, 1],
      [3, 1],
    ]);
    expect(records?.[1]?.epochPublicKey).toEqual(new Uint8Array([7, 2]));
    expect(records?.[1]?.chainLink).toEqual(new Uint8Array([102]));
  });

  it('answers each conversation at its own floor in one read', async () => {
    const first = await seedConversation();
    const second = await seedConversation();
    await seedEpochs(first, 3);
    await seedEpochs(second, 3);

    const chains = await stores.epochs.epochChains([
      { conversationId: first, fromEpoch: 1 },
      { conversationId: second, fromEpoch: 3 },
    ]);

    const material = chains._unsafeUnwrap();
    expect(material.get(first)?.map((row) => row.epochNumber)).toEqual([1, 2, 3]);
    expect(material.get(second)?.map((row) => row.epochNumber)).toEqual([3]);
  });

  it('answers an empty map for no scopes', async () => {
    const chains = await stores.epochs.epochChains([]);
    expect(chains._unsafeUnwrap().size).toBe(0);
  });

  it('tags each wrap with the conversation it belongs to', async () => {
    const first = await seedConversation();
    const second = await seedConversation();
    const [firstEpochId] = await seedEpochs(first, 1);
    const [secondEpochId] = await seedEpochs(second, 1);
    const memberPublicKey = crypto.getRandomValues(new Uint8Array(32));
    const seeded = await stores.epochs.insertWraps([
      { epochId: firstEpochId ?? '', memberPublicKey, wrap: BYTES, visibleFromEpoch: 1 },
      { epochId: secondEpochId ?? '', memberPublicKey, wrap: BYTES, visibleFromEpoch: 1 },
    ]);
    expect(seeded.isOk()).toBe(true);

    const wraps = await stores.epochs.wrapsForKey([first, second], memberPublicKey);

    expect(
      wraps
        ._unsafeUnwrap()
        .map((row) => row.conversationId)
        .toSorted(byId)
    ).toEqual([first, second].toSorted(byId));
  });

  it('answers no wraps for an empty conversation set', async () => {
    const wraps = await stores.epochs.wrapsForKey([], crypto.getRandomValues(new Uint8Array(32)));
    expect(wraps._unsafeUnwrap()).toEqual([]);
  });

  it('reads many conversation rows at once, omitting ids that do not exist', async () => {
    const conversationId = await seedConversation();

    const found = await stores.conversations.byIds([conversationId, crypto.randomUUID()]);

    expect(found._unsafeUnwrap().map((row) => row.id)).toEqual([conversationId]);
  });

  it('answers no conversation rows for an empty id set', async () => {
    const found = await stores.conversations.byIds([]);
    expect(found._unsafeUnwrap()).toEqual([]);
  });

  it('names only the conversations the caller is still an active member of', async () => {
    const { userId, conversationId } = await seedUserAndConversation();
    const left = await seedConversation();
    const seated = await stores.members.insert({
      conversationId,
      userId,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: null,
      invitedByUserId: null,
    });
    expect(seated.isOk()).toBe(true);
    const departed = await stores.members.insert({
      conversationId: left,
      userId,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: null,
      invitedByUserId: null,
    });
    const departure = await stores.members.markLeft({
      conversationId: left,
      memberId: departed._unsafeUnwrap()?.id ?? '',
    });
    expect(departure.isOk()).toBe(true);

    const active = await stores.members.activeIdsForUser([conversationId, left], userId);

    expect(active._unsafeUnwrap()).toEqual([conversationId]);
  });

  it('answers no active conversations for an empty id set', async () => {
    const { userId } = await seedUserAndConversation();
    const active = await stores.members.activeIdsForUser([], userId);
    expect(active._unsafeUnwrap()).toEqual([]);
  });
});

describe('users row lock a settlement takes before any other', () => {
  // Two more pools, because `createDb` caps each at one connection: the deleting
  // transaction and the locking read each hold theirs open, and only a third
  // connection can see that one of them is waiting.
  const deleter = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  const observer = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

  afterAll(async () => {
    await deleter.$client.end();
    await observer.$client.end();
  });

  /** Resolves once a backend in this test's database is waiting to acquire a lock. */
  async function lockWaitObserved(): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const result = await observer.execute(
        sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
      );
      if (Number(result.rows[0]?.['waiting']) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('no backend waited on a lock');
  }

  it('reads a users row that exists', async () => {
    const { userId } = await seedUserAndConversation();
    const read = await db.transaction(
      async (tx) => await createConversationsStores(tx).users.lockForKeyShare(userId)
    );
    expect(read._unsafeUnwrap()).toEqual({ id: userId });
  });

  it('waits out an account deletion that holds the row, then reads it as gone', async () => {
    const { userId } = await seedUserAndConversation();
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseDeletion!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    // The account deletion's opening lock, then its delete once released.
    const deleting = deleter.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      signalLocked();
      await released;
      await tx.delete(users).where(eq(users.id, userId));
    });
    await locked;

    const reading = db.transaction(
      async (tx) => await createConversationsStores(tx).users.lockForKeyShare(userId)
    );
    try {
      await lockWaitObserved();
    } finally {
      releaseDeletion();
      await deleting;
    }

    const read = await reading;
    expect(read._unsafeUnwrap()).toBeNull();
  });
});

describe('member count on the conversation list', () => {
  async function listedMemberCount(userId: string, conversationId: string): Promise<number> {
    const rows = await stores.conversations.listForUser({ userId, limit: 100, cursor: null });
    const row = rows._unsafeUnwrap().find((listed) => listed.conversation.id === conversationId);
    if (row === undefined) throw new Error('conversation missing from the caller list');
    return row.memberCount;
  }

  async function seatUser(
    conversationId: string,
    userId: string,
    privilege: 'owner' | 'write'
  ): Promise<string> {
    const seated = await stores.members.insert({
      conversationId,
      userId,
      privilege,
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
      invitedByUserId: null,
    });
    const memberId = seated._unsafeUnwrap()?.id;
    if (memberId === undefined) throw new Error('member seat failed');
    return memberId;
  }

  /** A conversation whose owner holds the seat creation gives them. */
  async function seedOwnedConversation(): Promise<{ userId: string; conversationId: string }> {
    const seeded = await seedUserAndConversation();
    await seatUser(seeded.conversationId, seeded.userId, 'owner');
    return seeded;
  }

  async function seatMember(conversationId: string): Promise<string> {
    const { userId } = await seedUserAndConversation();
    return seatUser(conversationId, userId, 'write');
  }

  async function seatLinkGuest(conversationId: string): Promise<string> {
    const linkId = await seedLink(conversationId);
    const seated = await stores.members.insertLinkMember({
      conversationId,
      linkId,
      privilege: 'read',
      visibleFromEpoch: 1,
    });
    if (seated._unsafeUnwrap() === null) throw new Error('link guest seat failed');
    return linkId;
  }

  it('counts the owner alone in a solo conversation', async () => {
    const { userId, conversationId } = await seedOwnedConversation();
    expect(await listedMemberCount(userId, conversationId)).toBe(1);
  });

  it('counts user members and link-guest seats together', async () => {
    const { userId, conversationId } = await seedOwnedConversation();
    await seatMember(conversationId);
    await seatLinkGuest(conversationId);
    expect(await listedMemberCount(userId, conversationId)).toBe(3);
  });

  it('drops a member marked left, the one mark both leaving and removal write', async () => {
    const { userId, conversationId } = await seedOwnedConversation();
    const memberId = await seatMember(conversationId);
    await seatLinkGuest(conversationId);
    const left = await stores.members.markLeft({ conversationId, memberId });
    expect(left._unsafeUnwrap()).not.toBeNull();
    expect(await listedMemberCount(userId, conversationId)).toBe(2);
  });

  it('drops a link guest whose link was revoked', async () => {
    const { userId, conversationId } = await seedOwnedConversation();
    const linkId = await seatLinkGuest(conversationId);
    const revoked = await stores.members.markLeftByLink({ conversationId, linkId });
    expect(revoked._unsafeUnwrap()).not.toBeNull();
    expect(await listedMemberCount(userId, conversationId)).toBe(1);
  });

  it('counts a lapsed link seat not yet marked left, as the member list shows it', async () => {
    const { userId, conversationId } = await seedOwnedConversation();
    const linkId = await seatLinkGuest(conversationId);
    await db
      .update(sharedLinks)
      .set({ expiresAt: new Date(Date.now() - MINUTE_MS) })
      .where(eq(sharedLinks.id, linkId));
    const listed = await stores.members.listActive(conversationId);
    expect(listed._unsafeUnwrap()).toHaveLength(2);
    expect(await listedMemberCount(userId, conversationId)).toBe(2);
  });

  it('reads the list with its counts in one statement', async () => {
    const { userId, conversationId } = await seedOwnedConversation();
    await seatMember(conversationId);
    const query = vi.spyOn(db.$client, 'query');
    try {
      await listedMemberCount(userId, conversationId);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }
  });
});
