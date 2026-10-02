import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  sharedLinks,
  users,
} from '@hushbox/db';
import { sharedLinkFactory, userFactory } from '@hushbox/db/factories';
import { ERROR_CODES, keyChainResponseSchema, toBase64 } from '@hushbox/shared';
import { applyPipeline } from '../../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../../middleware/pipeline-session.js';
import { okAsync } from '../../../lib/result/index.js';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { createLinkResolutionAdapter } from '../../../composition/bindings/link-resolution.js';
import { createBillingStores } from '../../billing/index.js';
import { deleteForkMessagesWithinTx } from '../../chat/index.js';
import {
  adminRevokeSharedLink,
  assertNoPendingDeparture,
  createConversationsManifest,
  createConversationsStores,
  createMembershipRevoker,
} from '../index.js';
import { leaveAllMembershipsWithinTx } from '../public/account-deletion.js';
import type { SQL } from 'drizzle-orm';
import type { AppEnv, Bindings } from '../../../lib/context/index.js';
import type { TelemetryEnv } from '../../../lib/telemetry/index.js';
import type { RealtimeBroadcast } from '../ports/realtime.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for key-chain route tests');
}

const SECRET = 'secret-at-least-32-characters-long!!';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createConversationsStores(db);

const BYTES = new Uint8Array([9, 9, 9]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

interface TestUser {
  readonly userId: string;
  readonly cookie: string;
  readonly publicKey: Uint8Array;
}

function randomB64(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

async function newUser(): Promise<TestUser> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const publicKey = crypto.getRandomValues(new Uint8Array(32));
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@key-routes.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  const sealed = await sealData(
    {
      userId,
      sessionId: `session-${userId}`,
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return { userId, cookie: `${SESSION_COOKIE_NAME}=${sealed}`, publicKey };
}

const silentRealtime: RealtimeBroadcast = {
  broadcast: () => okAsync({ delivered: 0, paused: 0, evicted: 0 }),
  evict: () => okAsync(0),
  presence: () => okAsync([]),
  startRun: () => okAsync({ started: false, code: ERROR_CODES.CONFLICT }),
  stopRun: () => okAsync(false),
  upgrade: () => okAsync(new Response(null, { status: 200 })),
};

function createApp(): Hono<AppEnv> {
  const manifest = createConversationsManifest({
    stores: createConversationsStores,
    billing: createBillingStores(),
    revoker: createMembershipRevoker,
    realtime: () => silentRealtime,
    deleteForkMessages: (writer) => (conversationId, ids) =>
      deleteForkMessagesWithinTx(writer, conversationId, ids),
    linkResolution: (writer) => createLinkResolutionAdapter(writer),
  });
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

const app = createApp();

async function request(
  method: string,
  path: string,
  cookie: string,
  body?: unknown
): Promise<Response> {
  return await app.request(
    path,
    {
      method,
      headers: {
        cookie,
        'content-type': 'application/json',
        ...(method === 'GET' ? {} : { 'Idempotency-Key': crypto.randomUUID() }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    testEnv
  );
}

/** A conversation created through the API: epoch 1, the owner seated and wrapped. */
async function createConversation(owner: TestUser): Promise<string> {
  const id = crypto.randomUUID();
  createdConversationIds.push(id);
  const res = await request('POST', '/conversations', owner.cookie, {
    id,
    title: randomB64(),
    epochPublicKey: randomB64(),
    confirmationHash: randomB64(),
    memberWrap: randomB64(),
  });
  if (res.status !== 200) throw new Error(`conversation create failed: ${String(res.status)}`);
  return id;
}

async function currentEpochId(conversationId: string): Promise<string> {
  const rows = await db
    .select({ id: epochs.id })
    .from(epochs)
    .innerJoin(
      conversations,
      and(
        eq(conversations.id, epochs.conversationId),
        eq(conversations.currentEpoch, epochs.epochNumber)
      )
    )
    .where(eq(epochs.conversationId, conversationId));
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('current epoch missing');
  return id;
}

async function wrapIntoCurrentEpoch(conversationId: string, key: Uint8Array): Promise<void> {
  await db.insert(epochMembers).values({
    epochId: await currentEpochId(conversationId),
    memberPublicKey: key,
    wrap: BYTES,
    visibleFromEpoch: 1,
  });
}

/** A second user seated and wrapped into the current epoch; `accepted` false leaves the invite pending. */
async function seatUser(
  conversationId: string,
  member: TestUser,
  accepted: boolean
): Promise<void> {
  await db.insert(conversationMembers).values({
    conversationId,
    userId: member.userId,
    privilege: 'write',
    visibleFromEpoch: 1,
    acceptedAt: accepted ? new Date() : null,
  });
  await wrapIntoCurrentEpoch(conversationId, member.publicKey);
}

/** A link guest seated and wrapped into the current epoch. */
async function seatLink(conversationId: string, expiresAt: SQL | null): Promise<string> {
  const linkPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const rows = await db
    .insert(sharedLinks)
    .values({ ...sharedLinkFactory.build({ conversationId, linkPublicKey }), expiresAt })
    .returning({ id: sharedLinks.id });
  const linkId = rows[0]?.id;
  if (linkId === undefined) throw new Error('link seed failed');
  await db
    .insert(conversationMembers)
    .values({ conversationId, linkId, privilege: 'read', visibleFromEpoch: 1 });
  await wrapIntoCurrentEpoch(conversationId, linkPublicKey);
  return linkId;
}

interface PendingReading {
  readonly keychain: boolean;
  readonly gate: 'ok' | 'rotation-pending' | 'other';
}

/** What the keychain route and the published gate each say about the conversation. */
async function readPending(conversationId: string, reader: TestUser): Promise<PendingReading> {
  const res = await request('GET', `/conversations/${conversationId}/keychain`, reader.cookie);
  if (res.status !== 200) throw new Error(`keychain read failed: ${String(res.status)}`);
  const body = keyChainResponseSchema.parse(await res.json());
  const gate = await assertNoPendingDeparture(stores, conversationId);
  return {
    keychain: body.rotationPending,
    gate: gate.match(
      () => 'ok' as const,
      (error) =>
        error.code === 'conflict' && error.wireCode === ERROR_CODES.ROTATION_PENDING
          ? ('rotation-pending' as const)
          : ('other' as const)
    ),
  };
}

const LIVE: PendingReading = { keychain: false, gate: 'ok' };
const PENDING: PendingReading = { keychain: true, gate: 'rotation-pending' };

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('rotation pending, per departure path', () => {
  it('pends once a member is stamped left', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await seatUser(id, member, true);
    expect(await readPending(id, owner)).toEqual(LIVE);

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          eq(conversationMembers.userId, member.userId)
        )
      );

    expect(await readPending(id, owner)).toEqual(PENDING);
  });

  it('pends once an invitee declines', async () => {
    const owner = await newUser();
    const invitee = await newUser();
    const id = await createConversation(owner);
    await seatUser(id, invitee, false);
    expect(await readPending(id, owner)).toEqual(LIVE);

    const declined = await request(
      'POST',
      `/conversations/${id}/membership/decline`,
      invitee.cookie
    );
    expect(declined.status).toBe(200);

    expect(await readPending(id, owner)).toEqual(PENDING);
  });

  it("pends once a member's account is deleted", async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await seatUser(id, member, true);
    expect(await readPending(id, owner)).toEqual(LIVE);

    await runSettlement(db, async (tx) => {
      await leaveAllMembershipsWithinTx(tx, member.userId, new Date());
      await tx.delete(users).where(eq(users.id, member.userId));
    });

    expect(await readPending(id, owner)).toEqual(PENDING);
  });

  it('pends once an admin revokes a shared link', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const linkId = await seatLink(id, null);
    expect(await readPending(id, owner)).toEqual(LIVE);

    const revoked = await adminRevokeSharedLink(stores, { conversationId: id, linkId });
    expect(revoked._unsafeUnwrap()).toMatchObject({ revoked: true });

    expect(await readPending(id, owner)).toEqual(PENDING);
  });

  it('pends once a shared link lapses, with no writer at the moment it does', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const linkId = await seatLink(id, sql`now() + interval '1 hour'`);
    expect(await readPending(id, owner)).toEqual(LIVE);

    // Lapsed in Postgres's own clock, which is what link liveness reads.
    await db
      .update(sharedLinks)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(sharedLinks.id, linkId));

    expect(await readPending(id, owner)).toEqual(PENDING);
  });
});

describe('key-chain response over a rotation', () => {
  it('validates against the shared key-chain schema', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await request('GET', `/conversations/${id}/keychain`, owner.cookie);
    expect(keyChainResponseSchema.safeParse(await res.json()).success).toBe(true);
  });

  it('withholds the link into epoch 1 from a member seated at epoch 2', async () => {
    const owner = await newUser();
    const joiner = await newUser();
    const id = await createConversation(owner);
    const added = await request('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: joiner.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: {
        expectedEpoch: 1,
        epochPublicKey: randomB64(),
        confirmationHash: randomB64(),
        chainLink: randomB64(),
        memberWraps: [owner.publicKey, joiner.publicKey].map((key) => ({
          memberPublicKey: toBase64(key),
          wrap: randomB64(),
        })),
        encryptedTitle: randomB64(),
      },
    });
    expect(added.status).toBe(200);

    const res = await request('GET', `/conversations/${id}/keychain`, joiner.cookie);
    const body = keyChainResponseSchema.parse(await res.json());

    expect(body.epochs).toEqual([
      expect.objectContaining({ epochNumber: 2, previousEpochNumber: 1, chainLink: null }),
    ]);
  });

  it('carries the link into epoch 1 to the founding member', async () => {
    const owner = await newUser();
    const joiner = await newUser();
    const id = await createConversation(owner);
    await request('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: joiner.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: {
        expectedEpoch: 1,
        epochPublicKey: randomB64(),
        confirmationHash: randomB64(),
        chainLink: randomB64(),
        memberWraps: [owner.publicKey, joiner.publicKey].map((key) => ({
          memberPublicKey: toBase64(key),
          wrap: randomB64(),
        })),
        encryptedTitle: randomB64(),
      },
    });

    const res = await request('GET', `/conversations/${id}/keychain`, owner.cookie);
    const body = keyChainResponseSchema.parse(await res.json());

    expect(body.epochs.map((epoch) => [epoch.epochNumber, epoch.chainLink === null])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(body.wraps.map((wrap) => wrap.epochNumber)).toEqual([1, 2]);
  });
});
