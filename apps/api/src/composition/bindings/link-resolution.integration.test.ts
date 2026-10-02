import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createSharedLink, generateKeyPair } from '@hushbox/crypto';
import { LOCAL_NEON_DEV_CONFIG, conversations, createDb, sharedLinks, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { createLinkResolutionAdapter } from './link-resolution.js';
import { seedConversationWithEpoch } from '../../test-support/conversation-seed.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('DATABASE_URL is required for the link-resolution adapter tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

async function seedUser(): Promise<string> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@link-resolution.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey: crypto.getRandomValues(new Uint8Array(32)),
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

async function seedConversation(userId: string): Promise<string> {
  const { conversationId } = await seedConversationWithEpoch(db, { userId, title: BYTES });
  createdConversationIds.push(conversationId);
  return conversationId;
}

interface SeededLink {
  readonly linkId: string;
  readonly linkPublicKey: Uint8Array;
  readonly linkAuthHash: Uint8Array;
}

async function seedLink(params: {
  readonly conversationId: string;
  readonly revokedAt?: Date;
  readonly expiresAt?: Date;
}): Promise<SeededLink> {
  const { linkPublicKey, linkAuthHash } = createSharedLink(generateKeyPair().privateKey, {
    conversationId: params.conversationId,
    epochNumber: 1,
  });
  const rows = await db
    .insert(sharedLinks)
    .values({
      conversationId: params.conversationId,
      linkPublicKey,
      linkAuthHash,
      displayName: null,
      expiresAt: params.expiresAt ?? null,
      ...(params.revokedAt === undefined ? {} : { revokedAt: params.revokedAt }),
    })
    .returning({ id: sharedLinks.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('shared link seed failed');
  return { linkId: id, linkPublicKey, linkAuthHash };
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

describe('createLinkResolutionAdapter', () => {
  it('resolves a live link by its auth hash to its link and conversation ids', async () => {
    const conversationId = await seedConversation(await seedUser());
    const { linkId, linkAuthHash } = await seedLink({ conversationId });
    const result = await createLinkResolutionAdapter(db).resolveLinkCredential(linkAuthHash);
    expect(result.isOk() && result.value).toEqual({ linkId, conversationId });
  });

  it('resolves a live link whose expiry is still in the future', async () => {
    const conversationId = await seedConversation(await seedUser());
    const { linkId, linkAuthHash } = await seedLink({
      conversationId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const result = await createLinkResolutionAdapter(db).resolveLinkCredential(linkAuthHash);
    expect(result.isOk() && result.value).toEqual({ linkId, conversationId });
  });

  it('answers null for a live link presented by its public key', async () => {
    const conversationId = await seedConversation(await seedUser());
    const { linkPublicKey } = await seedLink({ conversationId });
    const result = await createLinkResolutionAdapter(db).resolveLinkCredential(linkPublicKey);
    expect(result.isOk() && result.value).toBe(null);
  });

  it('answers null for an unknown credential', async () => {
    const result = await createLinkResolutionAdapter(db).resolveLinkCredential(
      crypto.getRandomValues(new Uint8Array(32))
    );
    expect(result.isOk() && result.value).toBe(null);
  });

  it('answers null for a revoked link', async () => {
    const conversationId = await seedConversation(await seedUser());
    const { linkAuthHash } = await seedLink({ conversationId, revokedAt: new Date() });
    const result = await createLinkResolutionAdapter(db).resolveLinkCredential(linkAuthHash);
    expect(result.isOk() && result.value).toBe(null);
  });

  it('answers null for a link expiring at the exact resolution instant (inclusive expiry)', async () => {
    const conversationId = await seedConversation(await seedUser());
    const expiresAt = new Date();
    const { linkAuthHash } = await seedLink({ conversationId, expiresAt });
    const result = await createLinkResolutionAdapter(db, () => expiresAt).resolveLinkCredential(
      linkAuthHash
    );
    expect(result.isOk() && result.value).toBe(null);
  });

  it('answers null for an expired link', async () => {
    const conversationId = await seedConversation(await seedUser());
    const { linkAuthHash } = await seedLink({
      conversationId,
      expiresAt: new Date(Date.now() - 1000),
    });
    const result = await createLinkResolutionAdapter(db).resolveLinkCredential(linkAuthHash);
    expect(result.isOk() && result.value).toBe(null);
  });
});
