import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  sharedLinks,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { runSettlement } from '../../../lib/idempotency/index.js';
import {
  deleteOwnedConversationsWithinTx,
  leaveAllMembershipsWithinTx,
  ownedConversationIdsWithinTx,
  revokeLinksCreatedByWithinTx,
} from './account-deletion.js';
import { seedConversationWithEpoch } from '../../../test-support/conversation-seed.js';
import { mintLinkCredential } from '../../../test-support/link-credential.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for conversations account-deletion tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/**
 * Unique per module load: a worker slot's database outlives the file that runs
 * on it, so the next file to land on that slot sees whatever rows this one
 * leaves behind.
 */
const PREFIX = `zc${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
let counter = 0;

const BYTES = new Uint8Array([1, 2, 3]);

async function seedUser(): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${PREFIX}u${String(counter)}@conv-deletion.test`,
        username: `${PREFIX}u${String(counter)}`,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  if (!row) throw new Error('user seed failed');
  createdUserIds.push(row.id);
  return row.id;
}

async function seedConversation(ownerUserId: string): Promise<string> {
  const { conversationId } = await seedConversationWithEpoch(db, {
    userId: ownerUserId,
    title: BYTES,
  });
  return conversationId;
}

async function seedMembership(
  conversationId: string,
  userId: string,
  leftAt: Date | null = null
): Promise<string> {
  const [row] = await db
    .insert(conversationMembers)
    .values({ conversationId, userId, visibleFromEpoch: 1, leftAt })
    .returning({ id: conversationMembers.id });
  if (!row) throw new Error('membership seed failed');
  return row.id;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // Conversations first: their cascade removes membership rows, whose
    // userId-SET-NULL would otherwise trip the identity-or-left check — the
    // exact ordering constraint the deletion executor handles via leftAt.
    await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('ownedConversationIdsWithinTx', () => {
  it('returns only the conversations the user owns, not the ones they merely joined', async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const owned = await seedConversation(owner);
    const foreign = await seedConversation(other);
    await seedMembership(foreign, owner);

    const ids = await runSettlement(db, (tx) => ownedConversationIdsWithinTx(tx, owner));

    expect([...ids]).toEqual([owned]);
  });

  it('returns an empty list for a user owning no conversations', async () => {
    const loner = await seedUser();

    const ids = await runSettlement(db, (tx) => ownedConversationIdsWithinTx(tx, loner));

    expect(ids).toEqual([]);
  });
});

describe('deleteOwnedConversationsWithinTx', () => {
  it("removes the user's owned conversations and leaves foreign ones standing", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const owned = await seedConversation(owner);
    const foreign = await seedConversation(other);

    await runSettlement(db, (tx) => deleteOwnedConversationsWithinTx(tx, owner));

    const remaining = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.id, [owned, foreign]));
    expect(remaining).toEqual([{ id: foreign }]);
  });
});

describe('leaveAllMembershipsWithinTx', () => {
  it('stamps leftAt on every ACTIVE membership of the user and no one else', async () => {
    const leaver = await seedUser();
    const bystander = await seedUser();
    const host = await seedUser();
    const conversationA = await seedConversation(host);
    const conversationB = await seedConversation(host);
    const activeA = await seedMembership(conversationA, leaver);
    const activeB = await seedMembership(conversationB, leaver);
    const bystanderRow = await seedMembership(conversationA, bystander);
    const now = new Date();

    await runSettlement(db, (tx) => leaveAllMembershipsWithinTx(tx, leaver, now));

    const rows = await db
      .select({ id: conversationMembers.id, leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(inArray(conversationMembers.id, [activeA, activeB, bystanderRow]));
    const byId = new Map(rows.map((row) => [row.id, row.leftAt]));
    expect(byId.get(activeA)?.getTime()).toBe(now.getTime());
    expect(byId.get(activeB)?.getTime()).toBe(now.getTime());
    expect(byId.get(bystanderRow)).toBeNull();
  });

  it('never rewrites a membership the user already left', async () => {
    const leaver = await seedUser();
    const host = await seedUser();
    const conversation = await seedConversation(host);
    const departedAt = new Date(TEST_DAY_START);
    const departedRow = await seedMembership(conversation, leaver, departedAt);

    await runSettlement(db, (tx) => leaveAllMembershipsWithinTx(tx, leaver, new Date()));

    const [row] = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.id, departedRow));
    expect(row?.leftAt?.getTime()).toBe(departedAt.getTime());
  });
});

async function seedLink(
  conversationId: string,
  createdBy: string | null,
  revokedAt: Date | null = null
): Promise<string> {
  const { linkPublicKey, linkAuthHash } = mintLinkCredential();
  const [row] = await db
    .insert(sharedLinks)
    .values({ conversationId, createdBy, revokedAt, linkPublicKey, linkAuthHash })
    .returning({ id: sharedLinks.id });
  if (!row) throw new Error('shared link seed failed');
  return row.id;
}

async function seatGuest(conversationId: string, linkId: string): Promise<string> {
  const [row] = await db
    .insert(conversationMembers)
    .values({ conversationId, linkId, visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  if (!row) throw new Error('link guest seed failed');
  return row.id;
}

describe('revokeLinksCreatedByWithinTx', () => {
  it('revokes every live link the departing user minted', async () => {
    const minter = await seedUser();
    const host = await seedUser();
    const conversation = await seedConversation(host);
    const linkId = await seedLink(conversation, minter);
    const now = new Date();

    await runSettlement(db, (tx) => revokeLinksCreatedByWithinTx(tx, minter, now));

    const [row] = await db
      .select({ revokedAt: sharedLinks.revokedAt })
      .from(sharedLinks)
      .where(eq(sharedLinks.id, linkId));
    expect(row?.revokedAt?.getTime()).toBe(now.getTime());
  });

  it('departs the guest seat of each link it revokes', async () => {
    const minter = await seedUser();
    const host = await seedUser();
    const conversation = await seedConversation(host);
    const linkId = await seedLink(conversation, minter);
    const guest = await seatGuest(conversation, linkId);
    const now = new Date();

    await runSettlement(db, (tx) => revokeLinksCreatedByWithinTx(tx, minter, now));

    const [row] = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.id, guest));
    expect(row?.leftAt?.getTime()).toBe(now.getTime());
  });

  it('leaves a link minted by anyone else standing', async () => {
    const minter = await seedUser();
    const host = await seedUser();
    const conversation = await seedConversation(host);
    const foreignLink = await seedLink(conversation, host);
    const foreignGuest = await seatGuest(conversation, foreignLink);

    await runSettlement(db, (tx) => revokeLinksCreatedByWithinTx(tx, minter, new Date()));

    const [link] = await db
      .select({ revokedAt: sharedLinks.revokedAt })
      .from(sharedLinks)
      .where(eq(sharedLinks.id, foreignLink));
    const [seat] = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.id, foreignGuest));
    expect(link?.revokedAt).toBeNull();
    expect(seat?.leftAt).toBeNull();
  });

  it('never rewrites a link the user had already revoked', async () => {
    const minter = await seedUser();
    const host = await seedUser();
    const conversation = await seedConversation(host);
    const revokedAt = new Date(Date.now() - HOUR_MS);
    const linkId = await seedLink(conversation, minter, revokedAt);

    await runSettlement(db, (tx) => revokeLinksCreatedByWithinTx(tx, minter, new Date()));

    const [row] = await db
      .select({ revokedAt: sharedLinks.revokedAt })
      .from(sharedLinks)
      .where(eq(sharedLinks.id, linkId));
    expect(row?.revokedAt?.getTime()).toBe(revokedAt.getTime());
  });

  it('leaves the revoked link standing without a creator once the users row is gone', async () => {
    const minter = await seedUser();
    const host = await seedUser();
    const conversation = await seedConversation(host);
    await seedMembership(conversation, minter);
    const linkId = await seedLink(conversation, minter);
    await seatGuest(conversation, linkId);
    const now = new Date();

    await runSettlement(db, async (tx) => {
      await revokeLinksCreatedByWithinTx(tx, minter, now);
      await leaveAllMembershipsWithinTx(tx, minter, now);
      await tx.delete(users).where(eq(users.id, minter));
    });

    const [row] = await db
      .select({ createdBy: sharedLinks.createdBy, revokedAt: sharedLinks.revokedAt })
      .from(sharedLinks)
      .where(eq(sharedLinks.id, linkId));
    expect(row?.createdBy).toBeNull();
    expect(row?.revokedAt?.getTime()).toBe(now.getTime());
  });
});
