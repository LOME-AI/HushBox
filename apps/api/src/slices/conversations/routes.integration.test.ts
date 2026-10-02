import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationForks,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  llmCompletions,
  memberBudgets,
  messages,
  sharedLinks,
  sharedMessages,
  usageRecords,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import {
  ERROR_CODES,
  UPGRADE_TICKET_PARAM,
  fromBase64,
  keyChainResponseSchema,
  toBase64,
} from '@hushbox/shared';
import { MINUTE_MS, TEST_DAY_START, testUuidV7 } from '@hushbox/shared/test-time';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { bindRequestValue } from '../../lib/context/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { createRedisMembershipCache } from './adapters/membership.js';
import {
  adminRevokeSharedLink,
  adminUnrevokeSharedLink,
  CONVERSATIONS_ROUTE_POSTURES,
  createConversationsManifest,
  createConversationsStores,
  isActiveConversationMember,
} from './index.js';
import { LINK_CREDENTIAL_HEADER } from './domain/index.js';
import { createMembershipRevoker } from './adapters/membership.js';
import { createLinkResolutionAdapter } from '../../composition/bindings/link-resolution.js';
import { createBillingStores } from '../billing/index.js';
import { deleteForkMessagesWithinTx } from '../chat/index.js';
import { ASSISTANT_SENDER_ID } from '../chat/domain/settlement/settlement.js';
import { mintLinkCredential } from '../../test-support/link-credential.js';
import type { AppEnv, Bindings, SessionRevocationCheck } from '../../lib/context/index.js';
import type { Telemetry, TelemetryEnv } from '../../lib/telemetry/index.js';
import type { RealtimeBroadcast, UpgradePrincipal } from './ports/realtime.js';
import type { ConversationsRouteDeps } from './index.js';
import type { ConversationsStores } from './ports/index.js';
import type { DomainError } from '../../lib/errors/index.js';
import type { ResultAsync } from '../../lib/result/index.js';
import type { ResolvedReasoningEffort } from '@hushbox/shared';
import type { LinkCredential } from '../../test-support/link-credential.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for conversations route tests');
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
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];
let userCounter = 0;

const BYTES = new Uint8Array([9, 9, 9]);
const B64 = toBase64(new Uint8Array([1, 2, 3]));

interface TestUser {
  userId: string;
  cookie: string;
  publicKey: Uint8Array;
}

async function newUser(): Promise<TestUser> {
  userCounter += 1;
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}u${String(userCounter)}`;
  const publicKey = crypto.getRandomValues(new Uint8Array(32));
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@conversations.test`,
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

interface EvictedCall {
  conversationId: string;
  principalId: string;
}

interface BroadcastCall {
  conversationId: string;
  event: { type: string; [key: string]: unknown };
}

function recordingRealtime(
  evicted: EvictedCall[],
  broadcasts: BroadcastCall[] = []
): RealtimeBroadcast {
  return {
    broadcast: (conversationId, event) => {
      broadcasts.push({ conversationId, event: event as BroadcastCall['event'] });
      return okAsync({ delivered: 0, paused: 0, evicted: 0 });
    },
    evict: (conversationId, principalId) => {
      evicted.push({ conversationId, principalId });
      return okAsync(1);
    },
    presence: () => okAsync([]),
    startRun: () => okAsync({ started: true, runId: 'r', deadlineAt: 0, assistantMessageIds: [] }),
    stopRun: () => okAsync(false),
    upgrade: () => okAsync(new Response(null, { status: 200 })),
  };
}

/** `capturedCodes` receives the fingerprint code of every error the routes capture. */
function createApp(
  evicted: EvictedCall[] = [],
  broadcasts: BroadcastCall[] = [],
  capturedCodes: string[] = []
): Hono<AppEnv> {
  const manifest = createConversationsManifest({
    stores: createConversationsStores,
    billing: createBillingStores(),
    revoker: createMembershipRevoker,
    realtime: () => recordingRealtime(evicted, broadcasts),
    deleteForkMessages: (db) => (conversationId, ids) =>
      deleteForkMessagesWithinTx(db, conversationId, ids),
    linkResolution: (db) => createLinkResolutionAdapter(db),
  });
  const app = applyPipeline(new Hono<AppEnv>());
  // After the pipeline, which binds `logger`, and before the routes.
  app.use(async (c, next) => {
    const logger = c.var.logger;
    const captureError: Telemetry['captureError'] = (error, errorCode) => {
      capturedCodes.push(errorCode);
      logger.captureError(error, errorCode);
    };
    bindRequestValue(c, 'logger', { ...logger, captureError });
    await next();
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

interface SendOptions {
  app?: Hono<AppEnv>;
  idempotencyKey?: string | null;
  env?: Bindings & TelemetryEnv;
  origin?: string;
}

interface RequestSpec extends SendOptions {
  method: string;
  path: string;
  cookie: string;
  body?: unknown;
}

interface ConversationBody {
  created: boolean;
  conversation: { id: string; title: string; currentEpoch: number };
  membership: Record<string, unknown>;
  forks?: { id: string; name: string; tipMessageId: string | null }[];
}

interface ListBody {
  conversations: { id: string; pinned: boolean; memberCount: number }[];
  nextCursor: string | null;
}

interface MemberBody {
  member: { id: string; userId: string | null };
  newEpochNumber: number | null;
}

async function dispatch(spec: RequestSpec): Promise<Response> {
  const app = spec.app ?? createApp();
  const headers: Record<string, string> = {
    cookie: spec.cookie,
    'content-type': 'application/json',
  };
  if (spec.idempotencyKey !== null && spec.method !== 'GET') {
    headers['Idempotency-Key'] = spec.idempotencyKey ?? crypto.randomUUID();
  }
  if (spec.origin !== undefined) {
    headers['Origin'] = spec.origin;
  }
  return app.request(
    spec.path,
    {
      method: spec.method,
      headers,
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
    },
    spec.env ?? testEnv
  );
}

const send = (method: string, path: string, cookie: string, body?: unknown): Promise<Response> =>
  dispatch({ method, path, cookie, body });

const get = (path: string, cookie: string, options: SendOptions = {}): Promise<Response> =>
  dispatch({ method: 'GET', path, cookie, ...options });

function createBody(id: string): Record<string, unknown> {
  return {
    id,
    title: B64,
    epochPublicKey: B64,
    confirmationHash: B64,
    memberWrap: B64,
  };
}

/** Creates a conversation through the API and tracks it for cleanup. */
async function createConversation(owner: TestUser): Promise<string> {
  const id = crypto.randomUUID();
  createdConversationIds.push(id);
  const res = await send('POST', '/conversations', owner.cookie, createBody(id));
  if (res.status !== 200) throw new Error(`conversation create failed: ${String(res.status)}`);
  return id;
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

describe('conversations routes: pipeline enforcement', () => {
  const ID = testUuidV7(1);
  const routes: [string, string][] = [
    ['POST', '/conversations'],
    ['GET', '/conversations'],
    ['GET', `/conversations/${ID}`],
    ['DELETE', `/conversations/${ID}`],
    ['GET', `/conversations/${ID}/members`],
    ['POST', `/conversations/${ID}/members`],
    ['POST', `/conversations/${ID}/members/${ID}/remove`],
    ['POST', `/conversations/${ID}/leave`],
    ['PATCH', `/conversations/${ID}`],
    ['PATCH', `/conversations/${ID}/membership/mute`],
    ['PATCH', `/conversations/${ID}/membership/pin`],
    ['PATCH', `/conversations/${ID}/membership/accept`],
    ['POST', `/conversations/${ID}/membership/decline`],
    ['PATCH', `/conversations/${ID}/member/${ID}/privilege`],
    ['PATCH', `/conversations/${ID}/links/${ID}/privilege`],
    ['PATCH', `/conversations/${ID}/links/${ID}/name`],
    ['GET', `/conversations/${ID}/keychain`],
    ['GET', `/conversations/${ID}/forks`],
    ['POST', `/conversations/${ID}/forks`],
    ['PATCH', `/conversations/${ID}/forks/${ID}`],
    ['PUT', `/conversations/${ID}/forks/${ID}/tip`],
    ['DELETE', `/conversations/${ID}/forks/${ID}`],
  ];

  it.each(routes)('answers 401 to an anonymous %s %s', async (method, path) => {
    const res = await createApp().request(path, { method }, testEnv);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('demands an Idempotency-Key on the create route', async () => {
    const { cookie } = await newUser();
    const res = await dispatch({
      method: 'POST',
      path: '/conversations',
      cookie,
      body: createBody(crypto.randomUUID()),
      idempotencyKey: null,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED });
  });
});

describe('conversations routes: create', () => {
  it('creates a conversation and answers the serialized record', async () => {
    const owner = await newUser();
    const id = crypto.randomUUID();
    createdConversationIds.push(id);
    const res = await send('POST', '/conversations', owner.cookie, createBody(id));
    expect(res.status).toBe(200);
    const body: ConversationBody = await res.json();
    expect(body.created).toBe(true);
    expect(body.conversation.id).toBe(id);
    expect(body.conversation.title).toBe(B64);
    expect(body.conversation.currentEpoch).toBe(1);
  });

  it('writes exactly one epoch-1 row, the owner wrap on it, and the accepted owner membership', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const epochRows = await db.select().from(epochs).where(eq(epochs.conversationId, id));
    expect(epochRows).toHaveLength(1);
    expect(epochRows[0]?.epochNumber).toBe(1);
    expect(epochRows[0]?.previousEpochId).toBeNull();
    const epochId = epochRows[0]?.id;
    if (epochId === undefined) throw new Error('epoch missing');
    const wraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epochId));
    expect(wraps).toHaveLength(1);
    expect(toBase64(new Uint8Array(wraps[0]?.memberPublicKey ?? []))).toBe(
      toBase64(owner.publicKey)
    );
    const memberRows = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, id));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.privilege).toBe('owner');
    expect(memberRows[0]?.acceptedAt).not.toBeNull();
  });

  it('replays the stored response for a retried Idempotency-Key without duplicating rows', async () => {
    const owner = await newUser();
    const id = crypto.randomUUID();
    createdConversationIds.push(id);
    const key = crypto.randomUUID();
    const first = await dispatch({
      method: 'POST',
      path: '/conversations',
      cookie: owner.cookie,
      body: createBody(id),
      idempotencyKey: key,
    });
    const second = await dispatch({
      method: 'POST',
      path: '/conversations',
      cookie: owner.cookie,
      body: createBody(id),
      idempotencyKey: key,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    const epochRows = await db.select().from(epochs).where(eq(epochs.conversationId, id));
    expect(epochRows).toHaveLength(1);
  });

  it('converges a re-create of the same id under a fresh key', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', '/conversations', owner.cookie, createBody(id));
    expect(res.status).toBe(200);
    const body: ConversationBody = await res.json();
    expect(body.created).toBe(false);
  });

  it("rejects a create reusing another user's conversation id", async () => {
    const owner = await newUser();
    const rival = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', '/conversations', rival.cookie, createBody(id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CONFLICT });
  });

  it('rejects a malformed body with the uniform validation answer', async () => {
    const { cookie } = await newUser();
    const res = await send('POST', '/conversations', cookie, { id: 'nope' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });
});

describe('conversations routes: list', () => {
  it('lists the caller conversations with member state', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get('/conversations', owner.cookie);
    expect(res.status).toBe(200);
    const body: ListBody = await res.json();
    const row = body.conversations.find((c) => c.id === id);
    expect(row).toMatchObject({
      id,
      privilege: 'owner',
      muted: false,
      pinned: false,
      accepted: true,
      invitedByUsername: null,
    });
    expect(body.nextCursor).toBeNull();
  });

  it('serves each listed conversation its active member count', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get('/conversations', owner.cookie);
    const body: ListBody = await res.json();
    expect(body.conversations.find((c) => c.id === id)?.memberCount).toBe(1);
  });

  it('does not list conversations the caller is no longer a member of', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(eq(conversationMembers.conversationId, id));
    const res = await get('/conversations', owner.cookie);
    const body: ListBody = await res.json();
    expect(body.conversations.map((c) => c.id)).not.toContain(id);
  });

  it('pages with a cursor ordered by most recent update', async () => {
    const owner = await newUser();
    const ids = [
      await createConversation(owner),
      await createConversation(owner),
      await createConversation(owner),
    ];
    const first = await get('/conversations?limit=2', owner.cookie);
    const firstBody: ListBody = await first.json();
    expect(firstBody.conversations).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();
    const second = await get(
      `/conversations?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      owner.cookie
    );
    const secondBody: ListBody = await second.json();
    const seen = [...firstBody.conversations, ...secondBody.conversations].map((c) => c.id);
    for (const id of ids) expect(seen).toContain(id);
  });

  it('answers an empty page for an undecodable cursor', async () => {
    const owner = await newUser();
    await createConversation(owner);
    const res = await get('/conversations?cursor=%%%garbage', owner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: [], nextCursor: null });
  });

  it('answers 503 when the database is unreachable', async () => {
    const { cookie } = await newUser();
    const res = await get('/conversations', cookie, {
      env: { ...testEnv, DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:9/hushbox' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });
});

describe('conversations routes: get', () => {
  it('answers the conversation with the caller membership state', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}`, owner.cookie);
    expect(res.status).toBe(200);
    const body: ConversationBody = await res.json();
    expect(body.conversation.id).toBe(id);
    expect(body.membership).toMatchObject({
      privilege: 'owner',
      muted: false,
      pinned: false,
      accepted: true,
      visibleFromEpoch: 1,
    });
    // A fresh, unforked conversation reports an empty branch set.
    expect(body.forks).toEqual([]);
  });

  it('hides an existing conversation from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}`, outsider.cookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('answers 404 for an absent conversation', async () => {
    const { cookie } = await newUser();
    const res = await get(`/conversations/${crypto.randomUUID()}`, cookie);
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: websocket upgrade', () => {
  it('proxies the upgrade to the DO for an active member', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/websocket`, owner.cookie, {
      origin: 'capacitor://localhost',
    });
    // The port double answers a 200 stand-in for the DO's real 101 (undici
    // cannot construct a sub-200 Response); the route forwards it untouched.
    expect(res.status).toBe(200);
  });

  it('rejects an active member upgrade from a non-allowlisted Origin with 403', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/websocket`, owner.cookie, {
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CSRF_REJECTED });
  });

  it('rejects an active member upgrade from the localhost Origin in production with 403', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    // Production refuses a pipeline missing what the composition root wires, so
    // this app wires each: a session liveness check that admits the test cookie,
    // an empty cache-policy map, and the slice's own rate-limit postures.
    const liveSession: SessionRevocationCheck = () => okAsync('active');
    const manifest = createConversationsManifest({
      stores: createConversationsStores,
      billing: createBillingStores(),
      revoker: createMembershipRevoker,
      realtime: () => recordingRealtime([], []),
      deleteForkMessages: (db) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(db, conversationId, ids),
      linkResolution: (db) => createLinkResolutionAdapter(db),
    });
    const app = applyPipeline(new Hono<AppEnv>(), {
      session: { revocation: liveSession },
      cache: { policies: {} },
      rateLimit: {
        postures: CONVERSATIONS_ROUTE_POSTURES,
        linkCredentialHeader: LINK_CREDENTIAL_HEADER,
      },
    });
    app.route(manifest.basePath, manifest.routes);
    const res = await get(`/conversations/${id}/websocket`, owner.cookie, {
      app,
      origin: 'http://localhost',
      env: { ...testEnv, NODE_ENV: 'production' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CSRF_REJECTED });
  });

  it('rejects an active member upgrade with a missing Origin with 403', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/websocket`, owner.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CSRF_REJECTED });
  });

  it('upgrades an active member from a Capacitor native-app Origin', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/websocket`, owner.cookie, {
      origin: 'capacitor://localhost',
    });
    expect(res.status).toBe(200);
  });

  it('upgrades an active member from the configured app Origin', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const appOrigin = 'https://app.hushbox.ai';
    // FRONTEND_URL is not typed on Bindings (see CsrfBindings); a variable
    // widens structurally so it can ride the env without an excess-property error.
    const envWithFrontend = { ...testEnv, FRONTEND_URL: appOrigin };
    const res = await get(`/conversations/${id}/websocket`, owner.cookie, {
      origin: appOrigin,
      env: envWithFrontend,
    });
    expect(res.status).toBe(200);
  });

  it('hides an existing conversation from a non-member with 404 before proxying', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/websocket`, outsider.cookie, {
      origin: 'capacitor://localhost',
    });
    // Existence-hiding parity with the sibling GET /:conversationId: a
    // non-member's upgrade is indistinguishable from an absent conversation.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('rejects an unauthenticated upgrade with 401', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/websocket`, '');
    expect(res.status).toBe(401);
  });

  it('forwards the client cursor declaration to the room', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const declared: (string | null)[] = [];
    const manifest = createConversationsManifest({
      billing: createBillingStores(),
      stores: createConversationsStores,
      revoker: createMembershipRevoker,
      realtime: () => ({
        ...recordingRealtime([]),
        upgrade: (_conversationId, _principal, _headers, cursors) => {
          declared.push(cursors);
          return okAsync(new Response(null, { status: 200 }));
        },
      }),
      deleteForkMessages: (db) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(db, conversationId, ids),
      linkResolution: (db) => createLinkResolutionAdapter(db),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const cursors = '[{"streamId":"s1","lastEventId":2}]';
    const res = await get(
      `/conversations/${id}/websocket?cursors=${encodeURIComponent(cursors)}`,
      owner.cookie,
      { app, origin: 'capacitor://localhost' }
    );
    expect(res.status).toBe(200);
    expect(declared).toEqual([cursors]);
  });

  it('forwards no declaration when the client sends no cursors', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const declared: (string | null)[] = [];
    const manifest = createConversationsManifest({
      billing: createBillingStores(),
      stores: createConversationsStores,
      revoker: createMembershipRevoker,
      realtime: () => ({
        ...recordingRealtime([]),
        upgrade: (_conversationId, _principal, _headers, cursors) => {
          declared.push(cursors);
          return okAsync(new Response(null, { status: 200 }));
        },
      }),
      deleteForkMessages: (db) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(db, conversationId, ids),
      linkResolution: (db) => createLinkResolutionAdapter(db),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await get(`/conversations/${id}/websocket`, owner.cookie, {
      app,
      origin: 'capacitor://localhost',
    });
    expect(res.status).toBe(200);
    expect(declared).toEqual([null]);
  });

  it('answers 503 when the DO upgrade fails at the transport', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const manifest = createConversationsManifest({
      billing: createBillingStores(),
      stores: createConversationsStores,
      revoker: createMembershipRevoker,
      realtime: () => ({
        ...recordingRealtime([]),
        upgrade: () => errAsync(unavailableError('room upgrade transport failed')),
      }),
      deleteForkMessages: (db) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(db, conversationId, ids),
      linkResolution: (db) => createLinkResolutionAdapter(db),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await get(`/conversations/${id}/websocket`, owner.cookie, {
      app,
      origin: 'capacitor://localhost',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });
});

describe('conversations routes: delete', () => {
  it('hard-deletes an owned conversation with its epoch chain', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send('DELETE', `/conversations/${id}`, owner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await db.select().from(conversations).where(eq(conversations.id, id))).toHaveLength(0);
    expect(await db.select().from(epochs).where(eq(epochs.conversationId, id))).toHaveLength(0);
  });

  it('forbids a non-owner member from deleting', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await db.insert(conversationMembers).values({
      conversationId: id,
      userId: member.userId,
      privilege: 'admin',
      visibleFromEpoch: 1,
    });
    const res = await send('DELETE', `/conversations/${id}`, member.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('hides the delete surface from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await send('DELETE', `/conversations/${id}`, outsider.cookie);
    expect(res.status).toBe(404);
  });

  it('answers 404 for an already-deleted conversation under a fresh key', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    await send('DELETE', `/conversations/${id}`, owner.cookie);
    const res = await send('DELETE', `/conversations/${id}`, owner.cookie);
    expect(res.status).toBe(404);
  });

  it('evicts every member: cache entries deleted and sockets closed', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await db.insert(conversationMembers).values({
      conversationId: id,
      userId: member.userId,
      privilege: 'write',
      visibleFromEpoch: 1,
    });
    const cache = createRedisMembershipCache(redis);
    await cache.set(id, owner.userId, 'member', 30);
    await cache.set(id, member.userId, 'member', 30);

    const evicted: EvictedCall[] = [];
    const res = await dispatch({
      method: 'DELETE',
      path: `/conversations/${id}`,
      cookie: owner.cookie,
      app: createApp(evicted),
    });
    expect(res.status).toBe(200);
    expect(evicted).toEqual(
      expect.arrayContaining([
        { conversationId: id, principalId: owner.userId },
        { conversationId: id, principalId: member.userId },
      ])
    );
    expect(await cache.get(id, owner.userId)).toBeNull();
    expect(await cache.get(id, member.userId)).toBeNull();
  });
});

function randomB64(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

function rotationFor(expectedEpoch: number, memberKeys: Uint8Array[]): Record<string, unknown> {
  return {
    expectedEpoch,
    epochPublicKey: randomB64(),
    confirmationHash: randomB64(),
    chainLink: randomB64(),
    memberWraps: memberKeys.map((key) => ({ memberPublicKey: toBase64(key), wrap: randomB64() })),
    encryptedTitle: B64,
  };
}

async function addFullHistory(
  owner: TestUser,
  conversationId: string,
  target: TestUser,
  privilege = 'write'
): Promise<string> {
  const res = await send('POST', `/conversations/${conversationId}/members`, owner.cookie, {
    userId: target.userId,
    privilege,
    giveFullHistory: true,
    wrap: randomB64(),
    expectedEpoch: 1,
  });
  if (res.status !== 200) throw new Error(`member add failed: ${String(res.status)}`);
  const body: MemberBody = await res.json();
  return body.member.id;
}

async function epochRows(conversationId: string): Promise<(typeof epochs.$inferSelect)[]> {
  return db
    .select()
    .from(epochs)
    .where(eq(epochs.conversationId, conversationId))
    .orderBy(epochs.epochNumber);
}

describe('conversations routes: members list', () => {
  it('lists active members with usernames for any member', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await get(`/conversations/${id}/members`, member.cookie);
    expect(res.status).toBe(200);
    const body: { members: { userId: string | null }[] } = await res.json();
    expect(body.members).toHaveLength(2);
    expect(body.members.map((m) => m.userId)).toEqual(
      expect.arrayContaining([owner.userId, member.userId])
    );
  });

  it('hides the member list from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/members`, outsider.cookie);
    expect(res.status).toBe(404);
  });

  it('carries linkId — null for real members, the link id for link-guest members', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const link = await mintLinkBody(owner, id);
    const res = await get(`/conversations/${id}/members`, owner.cookie);
    expect(res.status).toBe(200);
    const body: { members: { userId: string | null; linkId: string | null }[] } = await res.json();
    const ownerRow = body.members.find((m) => m.userId === owner.userId);
    const guestRow = body.members.find((m) => m.userId === null);
    expect(ownerRow?.linkId).toBeNull();
    expect(guestRow?.linkId).toBe(link.link.id);
  });
});

describe('conversations routes: add member (full history)', () => {
  it('adds the member with visibility from the first epoch and a current-epoch wrap', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(200);
    const body: MemberBody = await res.json();
    expect(body.member).toMatchObject({
      userId: target.userId,
      privilege: 'write',
      visibleFromEpoch: 1,
      accepted: false,
    });
    expect(body.newEpochNumber).toBeNull();

    const allEpochs = await epochRows(id);
    expect(allEpochs).toHaveLength(1);
    const epochId = allEpochs[0]?.id;
    if (epochId === undefined) throw new Error('epoch missing');
    const wraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epochId));
    expect(wraps).toHaveLength(2);
  });

  it('rejects a wrap built for a stale epoch without persisting anything', async () => {
    const owner = await newUser();
    const member = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    // Rotate to epoch 2 by adding `member` without history.
    await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: member.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, member.publicKey]),
    });
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.STALE_EPOCH,
      details: { currentEpoch: 2 },
    });
    const targetRows = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          eq(conversationMembers.userId, target.userId)
        )
      );
    expect(targetRows).toHaveLength(0);
  });

  it('answers already-member for an active member', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, target);
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.ALREADY_MEMBER });
  });

  it('answers 404 for an unknown target user', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: crypto.randomUUID(),
      privilege: 'write',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(404);
  });

  it('enforces the member limit with the typed error', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    const fillers = Array.from({ length: 99 }, (_, index) =>
      userFactory.build({
        email: `${crypto.randomUUID()}@fill.test`,
        username: `zzfill${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}${String(index)}`,
        opaqueRegistration: BYTES,
        publicKey: crypto.getRandomValues(new Uint8Array(32)),
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    );
    const fillerIds = await db.insert(users).values(fillers).returning({ id: users.id });
    createdUserIds.push(...fillerIds.map((row) => row.id));
    await db.insert(conversationMembers).values(
      fillerIds.map((row) => ({
        conversationId: id,
        userId: row.id,
        privilege: 'read' as const,
        visibleFromEpoch: 1,
      }))
    );
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.MEMBER_LIMIT_REACHED,
      details: { limit: 100 },
    });
  });

  it('forbids a write-privilege member from adding members', async () => {
    const owner = await newUser();
    const member = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member, 'write');
    const res = await send('POST', `/conversations/${id}/members`, member.cookie, {
      userId: target.userId,
      privilege: 'read',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(403);
  });

  it('forbids granting a privilege not strictly below the caller', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, admin, 'admin');
    const res = await send('POST', `/conversations/${id}/members`, admin.cookie, {
      userId: target.userId,
      privilege: 'admin',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(403);
  });

  it('hides the surface from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/members`, outsider.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: add member (rotation)', () => {
  it('chains epoch 2 onto epoch 1, advances the conversation to it, and seats one epoch-2 wrap per member while the founder keeps its epoch-1 wrap', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, target.publicKey]),
    });
    expect(res.status).toBe(200);
    const body: MemberBody = await res.json();
    expect(body.newEpochNumber).toBe(2);
    expect(body.member).toMatchObject({ visibleFromEpoch: 2 });

    const allEpochs = await epochRows(id);
    expect(allEpochs.map((e) => e.epochNumber)).toEqual([1, 2]);
    expect(allEpochs[1]?.previousEpochId).toBe(allEpochs[0]?.id);
    const conversationRow = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(conversationRow[0]?.currentEpoch).toBe(2);

    const epoch1Id = allEpochs[0]?.id;
    const epoch2Id = allEpochs[1]?.id;
    if (epoch1Id === undefined || epoch2Id === undefined) throw new Error('epochs missing');
    const retained = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch1Id));
    expect(retained.map((w) => toBase64(new Uint8Array(w.memberPublicKey)))).toEqual([
      toBase64(owner.publicKey),
    ]);
    const newWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id));
    expect(newWraps).toHaveLength(2);
    const byKey = new Map(newWraps.map((w) => [toBase64(new Uint8Array(w.memberPublicKey)), w]));
    expect(byKey.get(toBase64(owner.publicKey))?.visibleFromEpoch).toBe(1);
    expect(byKey.get(toBase64(target.publicKey))?.visibleFromEpoch).toBe(2);
  });

  it('rejects a wrap set that does not match the active members exactly', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: false,
      // Missing the new member's wrap.
      rotation: rotationFor(1, [owner.publicKey]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.WRAP_SET_MISMATCH });
    expect(await epochRows(id)).toHaveLength(1);
    const memberRows = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, id));
    expect(memberRows).toHaveLength(1);
  });

  it('rejects a stale rotation with the authoritative epoch', async () => {
    const owner = await newUser();
    const m1 = await newUser();
    const m2 = await newUser();
    const id = await createConversation(owner);
    await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: m1.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, m1.publicKey]),
    });
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: m2.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, m1.publicKey, m2.publicKey]),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.STALE_EPOCH,
      details: { currentEpoch: 2 },
    });
  });
});

describe('conversations routes: rotation safety', () => {
  it('rolls back the whole rotation when a mid-rotation write fails', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);

    const manifest = createConversationsManifest({
      billing: createBillingStores(),
      stores: (db_) => {
        const stores = createConversationsStores(db_);
        return {
          ...stores,
          epochs: {
            ...stores.epochs,
            // The injected seam failure: every new-epoch wrap write fails.
            insertWraps: () => errAsync(unavailableError('injected mid-rotation failure')),
          },
        };
      },
      revoker: createMembershipRevoker,
      realtime: () => recordingRealtime([]),
      deleteForkMessages: (db) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(db, conversationId, ids),
      linkResolution: (db) => createLinkResolutionAdapter(db),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);

    const res = await dispatch({
      method: 'POST',
      path: `/conversations/${id}/members/${memberId}/remove`,
      cookie: owner.cookie,
      body: { rotation: rotationFor(1, [owner.publicKey]) },
      app,
    });
    expect(res.status).toBe(503);

    const conversationRow = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(conversationRow[0]?.currentEpoch).toBe(1);
    expect(await epochRows(id)).toHaveLength(1);
    const memberRows = await db
      .select()
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, id), isNull(conversationMembers.leftAt)));
    expect(memberRows).toHaveLength(2);
  });

  it('serializes concurrent rotations: exactly one wins, the loser sees stale-epoch', async () => {
    const owner = await newUser();
    const m1 = await newUser();
    const m2 = await newUser();
    const id = await createConversation(owner);
    const m1Id = await addFullHistory(owner, id, m1);
    const m2Id = await addFullHistory(owner, id, m2);

    const [r1, r2] = await Promise.all([
      send('POST', `/conversations/${id}/members/${m1Id}/remove`, owner.cookie, {
        rotation: rotationFor(1, [owner.publicKey, m2.publicKey]),
      }),
      send('POST', `/conversations/${id}/members/${m2Id}/remove`, owner.cookie, {
        rotation: rotationFor(1, [owner.publicKey, m1.publicKey]),
      }),
    ]);
    const statuses = [r1.status, r2.status].toSorted((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const conversationRow = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(conversationRow[0]?.currentEpoch).toBe(2);
    const allEpochs = await epochRows(id);
    expect(allEpochs.map((e) => e.epochNumber)).toEqual([1, 2]);
    const epoch2Id = allEpochs[1]?.id;
    if (epoch2Id === undefined) throw new Error('epoch 2 missing');
    expect(
      await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id))
    ).toHaveLength(2);
  });

  it('enforces epoch-number uniqueness per conversation at the database', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    await expect(
      db.insert(epochs).values({
        conversationId: id,
        epochNumber: 1,
        epochPublicKey: BYTES,
        confirmationHash: BYTES,
      })
    ).rejects.toThrow();
  });
});

describe('conversations routes: remove member', () => {
  async function removalSetup(): Promise<{
    owner: TestUser;
    member: TestUser;
    id: string;
    memberId: string;
  }> {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    return { owner, member, id, memberId };
  }

  it('marks the member left and rotates the epoch', async () => {
    const { owner, member, id, memberId } = await removalSetup();
    const res = await send(
      'POST',
      `/conversations/${id}/members/${memberId}/remove`,
      owner.cookie,
      {
        rotation: rotationFor(1, [owner.publicKey]),
      }
    );
    expect(res.status).toBe(200);
    const body: { removed: boolean; newEpochNumber: number } = await res.json();
    expect(body.removed).toBe(true);
    expect(body.newEpochNumber).toBe(2);
    const rows = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          eq(conversationMembers.userId, member.userId)
        )
      );
    expect(rows[0]?.leftAt).not.toBeNull();
  });

  it('evicts the removed member: cache deleted, socket eviction invoked, reads revoked', async () => {
    const { owner, member, id, memberId } = await removalSetup();
    const cache = createRedisMembershipCache(redis);
    await cache.set(id, member.userId, 'member', 30);
    const evicted: EvictedCall[] = [];
    const res = await dispatch({
      method: 'POST',
      path: `/conversations/${id}/members/${memberId}/remove`,
      cookie: owner.cookie,
      body: { rotation: rotationFor(1, [owner.publicKey]) },
      app: createApp(evicted),
    });
    expect(res.status).toBe(200);
    expect(evicted).toEqual([{ conversationId: id, principalId: member.userId }]);
    expect(await cache.get(id, member.userId)).toBeNull();
    const read = await get(`/conversations/${id}`, member.cookie);
    expect(read.status).toBe(404);
  });

  it('rewrites the title when the owner rotates a member out', async () => {
    const { owner, id, memberId } = await removalSetup();
    const rewritten = randomB64();
    const res = await send(
      'POST',
      `/conversations/${id}/members/${memberId}/remove`,
      owner.cookie,
      {
        rotation: { ...rotationFor(1, [owner.publicKey]), encryptedTitle: rewritten },
      }
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(row?.title).toEqual(fromBase64(rewritten));
    expect(row?.titleEpochNumber).toBe(2);
  });

  it('refuses removing yourself', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const id = await createConversation(owner);
    const adminId = await addFullHistory(owner, id, admin, 'admin');
    const res = await send('POST', `/conversations/${id}/members/${adminId}/remove`, admin.cookie, {
      rotation: rotationFor(1, [owner.publicKey]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CANNOT_REMOVE_SELF });
  });

  it('refuses removing the owner', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, admin, 'admin');
    const ownerRows = await db
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          eq(conversationMembers.userId, owner.userId)
        )
      );
    const ownerMemberId = ownerRows[0]?.id;
    if (ownerMemberId === undefined) throw new Error('owner member missing');
    const res = await send(
      'POST',
      `/conversations/${id}/members/${ownerMemberId}/remove`,
      admin.cookie,
      { rotation: rotationFor(1, [admin.publicKey]) }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CANNOT_REMOVE_OWNER });
  });

  it('refuses a removal without a strictly higher privilege', async () => {
    const owner = await newUser();
    const adminA = await newUser();
    const adminB = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, adminA, 'admin');
    const bId = await addFullHistory(owner, id, adminB, 'admin');
    const res = await send('POST', `/conversations/${id}/members/${bId}/remove`, adminA.cookie, {
      rotation: rotationFor(1, [owner.publicKey, adminA.publicKey]),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.PRIVILEGE_INSUFFICIENT });
  });

  it('refuses a write member removing anyone as privilege-insufficient', async () => {
    const { member, id } = await removalSetup();
    const writer = member;
    const ownerRows = await db
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, id));
    const someId = ownerRows[0]?.id;
    if (someId === undefined) throw new Error('member missing');
    const res = await send('POST', `/conversations/${id}/members/${someId}/remove`, writer.cookie, {
      rotation: rotationFor(1, [writer.publicKey]),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.PRIVILEGE_INSUFFICIENT });
  });

  it('answers 404 for an unknown member id', async () => {
    const { owner, id } = await removalSetup();
    const res = await send(
      'POST',
      `/conversations/${id}/members/${crypto.randomUUID()}/remove`,
      owner.cookie,
      { rotation: rotationFor(1, [owner.publicKey]) }
    );
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: title update', () => {
  it('accepts a title naming an epoch of the conversation', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const title = randomB64();
    const res = await send('PATCH', `/conversations/${id}`, owner.cookie, {
      title,
      titleEpochNumber: 1,
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(row?.title).toEqual(fromBase64(title));
    expect(row?.titleEpochNumber).toBe(1);
  });

  it('refuses a title naming an epoch the conversation has none of and stores nothing', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const [before] = await db.select().from(conversations).where(eq(conversations.id, id));
    const res = await send('PATCH', `/conversations/${id}`, owner.cookie, {
      title: randomB64(),
      titleEpochNumber: 9999,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    const [after] = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(after?.title).toEqual(before?.title);
    expect(after?.titleEpochNumber).toBe(before?.titleEpochNumber);
  });

  it('accepts a title at the epoch a rotation minted', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    const removed = await send(
      'POST',
      `/conversations/${id}/members/${memberId}/remove`,
      owner.cookie,
      { rotation: rotationFor(1, [owner.publicKey]) }
    );
    expect(removed.status).toBe(200);
    const title = randomB64();
    const res = await send('PATCH', `/conversations/${id}`, owner.cookie, {
      title,
      titleEpochNumber: 2,
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(row?.title).toEqual(fromBase64(title));
    expect(row?.titleEpochNumber).toBe(2);
  });

  it('refuses a non-owner member as forbidden whatever the epoch', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await send('PATCH', `/conversations/${id}`, member.cookie, {
      title: randomB64(),
      titleEpochNumber: 9999,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('refuses a title at the current epoch while a departure is pending and stores nothing', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const left = await send('POST', `/conversations/${id}/leave`, member.cookie, {});
    expect(left.status).toBe(200);
    const [before] = await db.select().from(conversations).where(eq(conversations.id, id));
    const res = await send('PATCH', `/conversations/${id}`, owner.cookie, {
      title: randomB64(),
      titleEpochNumber: 1,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.ROTATION_PENDING });
    const [after] = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(after?.title).toEqual(before?.title);
  });
});

describe('conversations routes: leave', () => {
  it('lets a member leave and evicts them, rotating nothing', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const evicted: EvictedCall[] = [];
    const res = await dispatch({
      method: 'POST',
      path: `/conversations/${id}/leave`,
      cookie: member.cookie,
      body: {},
      app: createApp(evicted),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ left: true });
    expect(evicted).toEqual([{ conversationId: id, principalId: member.userId }]);
    expect(await epochRows(id)).toHaveLength(1);
    const list = await get('/conversations', member.cookie);
    const listBody: ListBody = await list.json();
    expect(listBody.conversations.map((c) => c.id)).not.toContain(id);
  });

  it('leaves the epoch, the title and the leaver wrap for the next rotation to settle', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await send('POST', `/conversations/${id}/leave`, member.cookie, {});
    expect(res.status).toBe(200);
    const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(row?.title).toEqual(new Uint8Array([1, 2, 3]));
    expect(row?.titleEpochNumber).toBe(1);
    expect(row?.currentEpoch).toBe(1);
    const wraps = await db
      .select({ memberPublicKey: epochMembers.memberPublicKey })
      .from(epochMembers)
      .innerJoin(epochs, eq(epochs.id, epochMembers.epochId))
      .where(eq(epochs.conversationId, id));
    expect(wraps.map((w) => toBase64(new Uint8Array(w.memberPublicKey)))).toContain(
      toBase64(member.publicKey)
    );
  });

  it('refuses a leave that still carries a rotation', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await send('POST', `/conversations/${id}/leave`, member.cookie, {
      rotation: rotationFor(1, [owner.publicKey]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    const active = await db
      .select()
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, id), isNull(conversationMembers.leftAt)));
    expect(active).toHaveLength(2);
  });

  it('deletes the conversation when the owner leaves', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const evicted: EvictedCall[] = [];
    const res = await dispatch({
      method: 'POST',
      path: `/conversations/${id}/leave`,
      cookie: owner.cookie,
      body: {},
      app: createApp(evicted),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await db.select().from(conversations).where(eq(conversations.id, id))).toHaveLength(0);
    expect(evicted.map((e) => e.principalId)).toEqual(
      expect.arrayContaining([owner.userId, member.userId])
    );
  });

  it('answers 404 for a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/leave`, outsider.cookie, {});
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: mute and pin', () => {
  it('sets only the caller membership flag', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await send('PATCH', `/conversations/${id}/membership/mute`, member.cookie, {
      muted: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ muted: true });
    const rows = await db
      .select({ userId: conversationMembers.userId, muted: conversationMembers.muted })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, id));
    expect(rows.find((r) => r.userId === member.userId)?.muted).toBe(true);
    expect(rows.find((r) => r.userId === owner.userId)?.muted).toBe(false);
  });

  it('pins for the caller and reports it in the list', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send('PATCH', `/conversations/${id}/membership/pin`, owner.cookie, {
      pinned: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pinned: true });
    const list = await get('/conversations', owner.cookie);
    const body: ListBody = await list.json();
    expect(body.conversations.find((c) => c.id === id)?.pinned).toBe(true);
  });

  it('answers 404 to a non-member flag write', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await send('PATCH', `/conversations/${id}/membership/mute`, outsider.cookie, {
      muted: true,
    });
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: keychain', () => {
  it('answers the full chain for a founding member after a rotation', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, target.publicKey]),
    });
    const res = await get(`/conversations/${id}/keychain`, owner.cookie);
    expect(res.status).toBe(200);
    const body = keyChainResponseSchema.parse(await res.json());
    expect(body.currentEpoch).toBe(2);
    expect(body.rotationPending).toBe(false);
    // The founder keeps its epoch-1 wrap across the rotation, and the epoch-2
    // record carries the chain link down to epoch 1.
    expect(body.wraps.map((w) => w.epochNumber)).toEqual([1, 2]);
    expect(body.epochs.map((e) => [e.epochNumber, e.previousEpochNumber])).toEqual([
      [1, null],
      [2, 1],
    ]);
    expect(body.epochs[1]?.chainLink).toEqual(expect.any(String));
  });

  it('filters chain links below a late joiner visibility floor', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, target.publicKey]),
    });
    const res = await get(`/conversations/${id}/keychain`, target.cookie);
    const body = keyChainResponseSchema.parse(await res.json());
    expect(body.wraps.map((w) => w.epochNumber)).toEqual([2]);
    // The late joiner's floor is their own join epoch: the epoch-2 record is
    // served, but its link into epoch 1 is not.
    expect(body.epochs).toEqual([
      expect.objectContaining({ epochNumber: 2, previousEpochNumber: 1, chainLink: null }),
    ]);
  });

  it('hides the keychain from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/keychain`, outsider.cookie);
    expect(res.status).toBe(404);
  });
});

async function seedMessage(conversationId: string, sequenceNumber: number): Promise<string> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber,
    })
    .returning({ id: messages.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('message seed failed');
  return id;
}

async function seedChildMessage(
  conversationId: string,
  sequenceNumber: number,
  parentMessageId: string | null
): Promise<string> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber,
      parentMessageId,
    })
    .returning({ id: messages.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('child message seed failed');
  return id;
}

async function seedForkRow(
  conversationId: string,
  name: string,
  tipMessageId: string | null
): Promise<string> {
  const rows = await db
    .insert(conversationForks)
    .values({ conversationId, name, tipMessageId })
    .returning({ id: conversationForks.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('fork seed failed');
  return id;
}

async function messageIds(conversationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return rows.map((row) => row.id).toSorted((a, b) => a.localeCompare(b));
}

async function forkTipOf(forkId: string): Promise<string | null> {
  const rows = await db
    .select({ tip: conversationForks.tipMessageId })
    .from(conversationForks)
    .where(eq(conversationForks.id, forkId));
  return rows[0]?.tip ?? null;
}

interface ForksBody {
  forks: ForkView[];
  created?: ForkView | null;
}

interface ForkView {
  id: string;
  name: string;
  tipMessageId: string | null;
  createdAt: string;
}

async function createForkVia(
  owner: TestUser,
  conversationId: string,
  fromMessageId: string,
  name?: string
): Promise<string> {
  const forkId = crypto.randomUUID();
  const res = await send('POST', `/conversations/${conversationId}/forks`, owner.cookie, {
    id: forkId,
    fromMessageId,
    ...(name === undefined ? {} : { name }),
  });
  if (res.status !== 200) throw new Error(`fork create failed: ${String(res.status)}`);
  return forkId;
}

describe('conversations routes: forks list', () => {
  it('answers an empty fork list for a linear conversation', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/forks`, owner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forks: [] });
  });

  it('hides the fork list from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/forks`, outsider.cookie);
    expect(res.status).toBe(404);
  });

  it('withholds a fork tipped before the caller epoch floor', async () => {
    const owner = await newUser();
    const joiner = await newUser();
    const id = await createConversation(owner);
    const early = await seedMessage(id, 1);
    // Adding without full history advances to epoch 2 and floors the joiner there.
    await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: joiner.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, joiner.publicKey]),
    });
    const late = await seedMessageAtEpoch(id, 2, 2);
    // Creates Main (tipped at the latest message, epoch 2) plus a fork tipped
    // at the epoch-1 message the joiner may not see.
    await createForkVia(owner, id, early, 'Early');

    const ownerRes = await get(`/conversations/${id}/forks`, owner.cookie);
    const ownerBody: ForksBody = await ownerRes.json();
    expect(ownerBody.forks.map((fork) => fork.tipMessageId)).toEqual([late, early]);

    const res = await get(`/conversations/${id}/forks`, joiner.cookie);
    expect(res.status).toBe(200);
    const body: ForksBody = await res.json();
    expect(body.forks.map((fork) => fork.tipMessageId)).toEqual([late]);
  });
});

describe('conversations routes: fork delete orphan cleanup', () => {
  it('deletes only the deleted branch, preserving shared ancestors and surviving tips', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    // m0 → m1, then Main (m2), F1 (f1a→f1b), F2 (f2a→f2b) all branch off m1.
    const m0 = await seedChildMessage(id, 1, null);
    const m1 = await seedChildMessage(id, 2, m0);
    const m2 = await seedChildMessage(id, 3, m1);
    const f1a = await seedChildMessage(id, 4, m1);
    const f1b = await seedChildMessage(id, 5, f1a);
    const f2a = await seedChildMessage(id, 6, m1);
    const f2b = await seedChildMessage(id, 7, f2a);
    await seedForkRow(id, 'Main', m2);
    const f1 = await seedForkRow(id, 'F1', f1b);
    const f2 = await seedForkRow(id, 'F2', f2b);

    const res = await dispatch({
      method: 'DELETE',
      path: `/conversations/${id}/forks/${f2}`,
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);

    // Only F2's exclusive branch (f2a, f2b) is gone; the shared ancestors and
    // both surviving branches remain.
    expect(await messageIds(id)).toEqual(
      [m0, m1, m2, f1a, f1b].toSorted((a, b) => a.localeCompare(b))
    );
    // The surviving fork tips were never nulled by the ON DELETE SET NULL cascade.
    expect(await forkTipOf(f1)).toBe(f1b);
  });
});

describe('conversations routes: fork events', () => {
  it('broadcasts fork:created when a new branch is created', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const forkId = crypto.randomUUID();
    const res = await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/forks`,
      cookie: owner.cookie,
      body: { id: forkId, fromMessageId: m1, name: 'Alt take' },
    });
    expect(res.status).toBe(200);
    const created = broadcasts.filter((b) => b.event.type === 'fork:created');
    expect(created).toHaveLength(1);
    expect(created[0]?.event).toMatchObject({
      forkId,
      conversationId: id,
      name: 'Alt take',
      tipMessageId: m1,
    });
  });

  it('broadcasts fork:created for a branch the floored creator cannot list', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const joiner = await newUser();
    const id = await createConversation(owner);
    const early = await seedMessage(id, 1);
    // Adding without full history advances to epoch 2 and floors the joiner there.
    await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: joiner.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, joiner.publicKey]),
    });
    const late = await seedMessageAtEpoch(id, 2, 2);
    const forkId = crypto.randomUUID();
    const res = await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/forks`,
      cookie: joiner.cookie,
      body: { id: forkId, fromMessageId: early, name: 'Alt take' },
    });
    expect(res.status).toBe(200);
    const created = broadcasts.filter((b) => b.event.type === 'fork:created');
    expect(created).toHaveLength(1);
    expect(created[0]?.event).toMatchObject({ forkId, conversationId: id, tipMessageId: early });
    const body: ForksBody = await res.json();
    // The response names what it created and lists what the creator may see:
    // Main, tipped at the post-join message. The new branch is in neither list.
    expect(body.created).toMatchObject({ id: forkId, name: 'Alt take', tipMessageId: early });
    expect(body.forks.map((fork) => fork.tipMessageId)).toEqual([late]);
  });

  it('broadcasts fork:renamed when a branch is renamed', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Original');
    const res = await dispatch({
      app,
      method: 'PATCH',
      path: `/conversations/${id}/forks/${forkId}`,
      cookie: owner.cookie,
      body: { name: 'Renamed' },
    });
    expect(res.status).toBe(200);
    const renamed = broadcasts.filter((b) => b.event.type === 'fork:renamed');
    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.event).toMatchObject({ forkId, conversationId: id, name: 'Renamed' });
  });

  it('broadcasts fork:deleted when a branch is deleted', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const m2 = await seedMessage(id, 2);
    await createForkVia(owner, id, m1, 'First');
    const second = await createForkVia(owner, id, m2, 'Second');
    const res = await dispatch({
      app,
      method: 'DELETE',
      path: `/conversations/${id}/forks/${second}`,
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const deleted = broadcasts.filter((b) => b.event.type === 'fork:deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.event).toMatchObject({ forkId: second, conversationId: id });
  });
});

describe('conversations routes: forks create', () => {
  it('creates the Main fork at the latest message alongside the first branch', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const m2 = await seedMessage(id, 2);
    const forkId = crypto.randomUUID();
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: forkId,
      fromMessageId: m1,
      name: 'Alt take',
    });
    expect(res.status).toBe(200);
    const body: ForksBody = await res.json();
    expect(body.created).toMatchObject({ id: forkId, name: 'Alt take', tipMessageId: m1 });
    expect(body.forks).toHaveLength(2);
    expect(body.forks[0]).toMatchObject({ name: 'Main', tipMessageId: m2 });
    expect(body.forks[1]).toMatchObject({ id: forkId, name: 'Alt take', tipMessageId: m1 });
  });

  it('auto-names a fork when no name is given', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: m1,
    });
    expect(res.status).toBe(200);
    const body: ForksBody = await res.json();
    expect(body.forks.map((f) => f.name)).toEqual(['Main', 'Fork 1']);
  });

  it('converges a re-create of the same fork id without duplicating rows', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: forkId,
      fromMessageId: m1,
      name: 'Alt',
    });
    expect(res.status).toBe(200);
    const body: ForksBody = await res.json();
    expect(body.created).toBeNull();
    expect(body.forks).toHaveLength(2);
  });

  it('rejects a duplicate fork name without persisting anything', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    await createForkVia(owner, id, m1, 'Alt');
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: m1,
      name: 'Alt',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORK_NAME_TAKEN });
    const rows = await db
      .select()
      .from(conversationForks)
      .where(eq(conversationForks.conversationId, id));
    expect(rows).toHaveLength(2);
  });

  it('answers a conflict when a reused fork id lands in a conversation that has forks', async () => {
    const owner = await newUser();
    const first = await createConversation(owner);
    const firstMessage = await seedMessage(first, 1);
    const forkId = await createForkVia(owner, first, firstMessage, 'Alt');

    const second = await createConversation(owner);
    const secondMessage = await seedMessage(second, 1);
    await createForkVia(owner, second, secondMessage, 'Existing');

    const res = await send('POST', `/conversations/${second}/forks`, owner.cookie, {
      id: forkId,
      fromMessageId: secondMessage,
      name: 'Reused id',
    });

    expect(res.status).toBe(409);
    // The body carries the bare code: nothing about the other conversation's fork.
    expect(await res.json()).toEqual({ code: ERROR_CODES.CONFLICT });
    // Creation-ordered, the order the store lists in — a bare select would
    // assert nothing but the heap order the inserts happened to leave.
    const rows = await db
      .select({ id: conversationForks.id, name: conversationForks.name })
      .from(conversationForks)
      .where(eq(conversationForks.conversationId, second))
      .orderBy(asc(conversationForks.createdAt), asc(conversationForks.id));
    expect(rows.map((row) => row.name)).toEqual(['Main', 'Existing']);
  });

  it('answers a conflict when a reused fork id lands in a conversation with no forks', async () => {
    const owner = await newUser();
    const first = await createConversation(owner);
    const firstMessage = await seedMessage(first, 1);
    const forkId = await createForkVia(owner, first, firstMessage, 'Alt');

    const second = await createConversation(owner);
    const secondMessage = await seedMessage(second, 1);
    const res = await send('POST', `/conversations/${second}/forks`, owner.cookie, {
      id: forkId,
      fromMessageId: secondMessage,
      name: 'Reused id',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CONFLICT });
    // Refusals ride the success channel and COMMIT, so this path must persist
    // nothing at all: the requested branch is inserted before Main, and a
    // conflict on it leaves the conversation forkless rather than holding a
    // Main row the request only materialized on the way to refusing.
    const rows = await db
      .select({ id: conversationForks.id, name: conversationForks.name })
      .from(conversationForks)
      .where(eq(conversationForks.conversationId, second));
    expect(rows).toEqual([]);
    // The first conversation's fork is untouched.
    const original = await db
      .select({ conversationId: conversationForks.conversationId })
      .from(conversationForks)
      .where(eq(conversationForks.id, forkId));
    expect(original.map((row) => row.conversationId)).toEqual([first]);
  });

  it('rejects a duplicate fork name the caller epoch floor withholds', async () => {
    const owner = await newUser();
    const joiner = await newUser();
    const id = await createConversation(owner);
    const early = await seedMessage(id, 1);
    // Adding without full history advances to epoch 2 and floors the joiner there.
    await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: joiner.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, joiner.publicKey]),
    });
    const late = await seedMessageAtEpoch(id, 2, 2);
    await createForkVia(owner, id, early, 'Early');

    // The joiner cannot list 'Early' — its tip sits below their floor.
    const listed = await get(`/conversations/${id}/forks`, joiner.cookie);
    const listedBody: ForksBody = await listed.json();
    expect(listedBody.forks.map((fork) => fork.name)).toEqual(['Main']);

    // The name pre-check reads the unfiltered set, so the withheld name is
    // still taken: a floored caller cannot mint a name it cannot see.
    const res = await send('POST', `/conversations/${id}/forks`, joiner.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: late,
      name: 'Early',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORK_NAME_TAKEN });
  });

  it('rejects a first branch named Main without persisting anything', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: m1,
      name: 'Main',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORK_NAME_TAKEN });
    const rows = await db
      .select()
      .from(conversationForks)
      .where(eq(conversationForks.conversationId, id));
    expect(rows).toHaveLength(0);
  });

  it('enforces the fork limit with the typed error', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    await db.insert(conversationForks).values(
      Array.from({ length: 5 }, (_, index) => ({
        conversationId: id,
        name: `Seeded ${String(index)}`,
        tipMessageId: m1,
      }))
    );
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: m1,
      name: 'One too many',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.FORK_LIMIT_REACHED,
      details: { limit: 5 },
    });
  });

  it('answers 404 for a branch-from message outside the conversation', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const other = await createConversation(owner);
    const foreign = await seedMessage(other, 1);
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: foreign,
      name: 'Alt',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('forbids a read-privilege member from creating a fork', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, reader, 'read');
    const m1 = await seedMessage(id, 1);
    const res = await send('POST', `/conversations/${id}/forks`, reader.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: m1,
      name: 'Alt',
    });
    expect(res.status).toBe(403);
  });

  it('hides the surface from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const res = await send('POST', `/conversations/${id}/forks`, outsider.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: m1,
      name: 'Alt',
    });
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: forks rename', () => {
  it('renames a fork and answers the updated record', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PATCH', `/conversations/${id}/forks/${forkId}`, owner.cookie, {
      name: 'Renamed',
    });
    expect(res.status).toBe(200);
    const body: { fork: ForkView } = await res.json();
    expect(body.fork).toMatchObject({ id: forkId, name: 'Renamed' });
  });

  it('rejects a rename onto a taken name', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PATCH', `/conversations/${id}/forks/${forkId}`, owner.cookie, {
      name: 'Main',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORK_NAME_TAKEN });
  });

  it('answers 404 for an unknown fork', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send(
      'PATCH',
      `/conversations/${id}/forks/${crypto.randomUUID()}`,
      owner.cookie,
      { name: 'Renamed' }
    );
    expect(res.status).toBe(404);
  });

  it('forbids a read-privilege member from renaming', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, reader, 'read');
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PATCH', `/conversations/${id}/forks/${forkId}`, reader.cookie, {
      name: 'Renamed',
    });
    expect(res.status).toBe(403);
  });
});

describe('conversations routes: fork tip', () => {
  it('moves the tip when the expected state holds', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const m2 = await seedMessage(id, 2);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PUT', `/conversations/${id}/forks/${forkId}/tip`, owner.cookie, {
      tipMessageId: m2,
      expectedTipMessageId: m1,
    });
    expect(res.status).toBe(200);
    const body: { fork: ForkView } = await res.json();
    expect(body.fork).toMatchObject({ id: forkId, tipMessageId: m2 });
  });

  it('rejects a stale expected tip with the authoritative tip', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const m2 = await seedMessage(id, 2);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PUT', `/conversations/${id}/forks/${forkId}/tip`, owner.cookie, {
      tipMessageId: m2,
      expectedTipMessageId: m2,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.FORK_TIP_CONFLICT,
      details: { currentTipMessageId: m1 },
    });
  });

  it('serializes concurrent tip updates: exactly one wins', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const m2 = await seedMessage(id, 2);
    const m3 = await seedMessage(id, 3);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const [r1, r2] = await Promise.all([
      send('PUT', `/conversations/${id}/forks/${forkId}/tip`, owner.cookie, {
        tipMessageId: m2,
        expectedTipMessageId: m1,
      }),
      send('PUT', `/conversations/${id}/forks/${forkId}/tip`, owner.cookie, {
        tipMessageId: m3,
        expectedTipMessageId: m1,
      }),
    ]);
    const statuses = [r1.status, r2.status].toSorted((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    const rows = await db
      .select({ tipMessageId: conversationForks.tipMessageId })
      .from(conversationForks)
      .where(eq(conversationForks.id, forkId));
    const winner = r1.status === 200 ? r1 : r2;
    const winnerBody: { fork: ForkView } = await winner.json();
    expect(rows[0]?.tipMessageId).toBe(winnerBody.fork.tipMessageId);
    const loser = r1.status === 200 ? r2 : r1;
    expect(await loser.json()).toEqual({
      code: ERROR_CODES.FORK_TIP_CONFLICT,
      details: { currentTipMessageId: winnerBody.fork.tipMessageId },
    });
  });

  it('answers 404 for a tip message outside the conversation', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const other = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const foreign = await seedMessage(other, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PUT', `/conversations/${id}/forks/${forkId}/tip`, owner.cookie, {
      tipMessageId: foreign,
      expectedTipMessageId: m1,
    });
    expect(res.status).toBe(404);
  });

  it('answers 404 for an unknown fork', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const res = await send(
      'PUT',
      `/conversations/${id}/forks/${crypto.randomUUID()}/tip`,
      owner.cookie,
      { tipMessageId: m1, expectedTipMessageId: null }
    );
    expect(res.status).toBe(404);
  });

  it('forbids a read-privilege member from moving a tip', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, reader, 'read');
    const m1 = await seedMessage(id, 1);
    const m2 = await seedMessage(id, 2);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PUT', `/conversations/${id}/forks/${forkId}/tip`, reader.cookie, {
      tipMessageId: m2,
      expectedTipMessageId: m1,
    });
    expect(res.status).toBe(403);
  });
});

describe('conversations routes: forks delete', () => {
  it('deletes a fork and answers the remaining forks', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const alt = await createForkVia(owner, id, m1, 'Alt');
    const extra = await createForkVia(owner, id, m1, 'Extra');
    const res = await send('DELETE', `/conversations/${id}/forks/${extra}`, owner.cookie);
    expect(res.status).toBe(200);
    const body: ForksBody = await res.json();
    expect(body.forks.map((f) => f.id)).toContain(alt);
    expect(body.forks.map((f) => f.id)).not.toContain(extra);
    expect(body.forks).toHaveLength(2);
  });

  it('reverts to linear when only one fork would remain', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const alt = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('DELETE', `/conversations/${id}/forks/${alt}`, owner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forks: [] });
    const rows = await db
      .select()
      .from(conversationForks)
      .where(eq(conversationForks.conversationId, id));
    expect(rows).toHaveLength(0);
  });

  it('converges when the fork is already gone', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    await createForkVia(owner, id, m1, 'Alt');
    await createForkVia(owner, id, m1, 'Extra');
    const res = await send(
      'DELETE',
      `/conversations/${id}/forks/${crypto.randomUUID()}`,
      owner.cookie
    );
    expect(res.status).toBe(200);
    const body: ForksBody = await res.json();
    expect(body.forks).toHaveLength(3);
  });

  it('forbids a read-privilege member from deleting', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, reader, 'read');
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('DELETE', `/conversations/${id}/forks/${forkId}`, reader.cookie);
    expect(res.status).toBe(403);
  });

  it('hides the surface from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('DELETE', `/conversations/${id}/forks/${forkId}`, outsider.cookie);
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: idempotency-key body binding', () => {
  it('rejects a reused key with a different body', async () => {
    const owner = await newUser();
    const key = crypto.randomUUID();
    const id = crypto.randomUUID();
    createdConversationIds.push(id);
    const first = await dispatch({
      method: 'POST',
      path: '/conversations',
      cookie: owner.cookie,
      body: createBody(id),
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    const second = await dispatch({
      method: 'POST',
      path: '/conversations',
      cookie: owner.cookie,
      body: createBody(crypto.randomUUID()),
      idempotencyKey: key,
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ code: ERROR_CODES.IDEMPOTENCY_BODY_MISMATCH });
  });
});

describe('conversations routes: unknown conversation answers not-found', () => {
  const UNKNOWN = testUuidV7(0xde_ad);
  const MEMBER_BODY = {
    userId: testUuidV7(0xbe_ef),
    privilege: 'write',
    giveFullHistory: true,
    wrap: B64,
    expectedEpoch: 1,
  };
  const cases: [string, string, unknown][] = [
    ['GET', `/conversations/${UNKNOWN}`, undefined],
    ['DELETE', `/conversations/${UNKNOWN}`, undefined],
    ['GET', `/conversations/${UNKNOWN}/members`, undefined],
    ['POST', `/conversations/${UNKNOWN}/members`, MEMBER_BODY],
    [
      'POST',
      `/conversations/${UNKNOWN}/members/${UNKNOWN}/remove`,
      { rotation: rotationFor(1, [crypto.getRandomValues(new Uint8Array(32))]) },
    ],
    ['POST', `/conversations/${UNKNOWN}/leave`, {}],
    ['GET', `/conversations/${UNKNOWN}/keychain`, undefined],
    ['GET', `/conversations/${UNKNOWN}/forks`, undefined],
    [
      'POST',
      `/conversations/${UNKNOWN}/forks`,
      { id: crypto.randomUUID(), fromMessageId: crypto.randomUUID(), name: 'Alt' },
    ],
    ['PATCH', `/conversations/${UNKNOWN}/forks/${UNKNOWN}`, { name: 'Renamed' }],
    [
      'PUT',
      `/conversations/${UNKNOWN}/forks/${UNKNOWN}/tip`,
      { tipMessageId: crypto.randomUUID(), expectedTipMessageId: null },
    ],
    ['DELETE', `/conversations/${UNKNOWN}/forks/${UNKNOWN}`, undefined],
  ];

  it.each(cases)('answers 404 to %s %s', async (method, path, body) => {
    const user = await newUser();
    const res = await send(method, path, user.cookie, body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});

describe('conversations routes: store unavailability answers 503 everywhere', () => {
  function failingApp(): Hono<AppEnv> {
    const fail = (): ResultAsync<never, DomainError> =>
      errAsync(unavailableError('injected store failure'));
    const failingGroup = new Proxy({}, { get: () => fail });
    const manifest = createConversationsManifest({
      billing: createBillingStores(),
      stores: () =>
        ({
          conversations: failingGroup,
          members: failingGroup,
          epochs: failingGroup,
          users: failingGroup,
          messages: failingGroup,
          forks: failingGroup,
        }) as unknown as ConversationsStores,
      revoker: createMembershipRevoker,
      realtime: () => recordingRealtime([]),
      deleteForkMessages: (db) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(db, conversationId, ids),
      linkResolution: (db) => createLinkResolutionAdapter(db),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  const ID = testUuidV7(1);
  const cases: [string, string, unknown][] = [
    ['POST', '/conversations', createBody(testUuidV7(2))],
    ['GET', '/conversations', undefined],
    ['GET', `/conversations/${ID}`, undefined],
    ['GET', `/conversations/${ID}/websocket`, undefined],
    ['DELETE', `/conversations/${ID}`, undefined],
    ['GET', `/conversations/${ID}/members`, undefined],
    [
      'POST',
      `/conversations/${ID}/members`,
      { userId: ID, privilege: 'write', giveFullHistory: true, wrap: B64, expectedEpoch: 1 },
    ],
    [
      'POST',
      `/conversations/${ID}/members/${ID}/remove`,
      { rotation: rotationFor(1, [crypto.getRandomValues(new Uint8Array(32))]) },
    ],
    ['POST', `/conversations/${ID}/leave`, {}],
    ['PATCH', `/conversations/${ID}/membership/mute`, { muted: true }],
    ['PATCH', `/conversations/${ID}/membership/pin`, { pinned: true }],
    ['GET', `/conversations/${ID}/keychain`, undefined],
    ['GET', `/conversations/${ID}/forks`, undefined],
    [
      'POST',
      `/conversations/${ID}/forks`,
      { id: crypto.randomUUID(), fromMessageId: ID, name: 'Alt' },
    ],
    ['PATCH', `/conversations/${ID}/forks/${ID}`, { name: 'Renamed' }],
    [
      'PUT',
      `/conversations/${ID}/forks/${ID}/tip`,
      { tipMessageId: ID, expectedTipMessageId: null },
    ],
    ['DELETE', `/conversations/${ID}/forks/${ID}`, undefined],
  ];

  it.each(cases)('answers 503 to %s %s', async (method, path, body) => {
    const user = await newUser();
    const res = await dispatch({ method, path, cookie: user.cookie, body, app: failingApp() });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });
});

describe('conversations routes: coverage of remaining refusal arms', () => {
  it('creates an untitled conversation', async () => {
    const owner = await newUser();
    const id = crypto.randomUUID();
    createdConversationIds.push(id);
    const body = createBody(id);
    delete body['title'];
    const res = await send('POST', '/conversations', owner.cookie, body);
    expect(res.status).toBe(200);
    const created: ConversationBody = await res.json();
    expect(created.conversation.title).toBe('');
  });

  it('answers an empty page for a well-formed cursor with the wrong shape', async () => {
    const owner = await newUser();
    await createConversation(owner);
    const cursor = encodeURIComponent(toBase64(new TextEncoder().encode('{"x":1}')));
    const res = await get(`/conversations?cursor=${cursor}`, owner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: [], nextCursor: null });
  });

  it('hides the member list from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/members`, outsider.cookie);
    expect(res.status).toBe(404);
  });

  it('answers 404 to a non-member removing a member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    const res = await send(
      'POST',
      `/conversations/${id}/members/${memberId}/remove`,
      outsider.cookie,
      { rotation: rotationFor(1, [owner.publicKey]) }
    );
    expect(res.status).toBe(404);
  });

  it('answers 404 to a non-member pin write', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await send('PATCH', `/conversations/${id}/membership/pin`, outsider.cookie, {
      pinned: true,
    });
    expect(res.status).toBe(404);
  });

  it('rejects a removal whose wrap set does not match the remaining members', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    const res = await send(
      'POST',
      `/conversations/${id}/members/${memberId}/remove`,
      owner.cookie,
      { rotation: rotationFor(1, [owner.publicKey, member.publicKey]) }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.WRAP_SET_MISMATCH });
  });

  it('completes a delete even when socket eviction fails, logging the miss', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const failingRealtime: RealtimeBroadcast = {
      ...recordingRealtime([]),
      evict: () => errAsync(unavailableError('injected eviction failure')),
    };
    const manifest = createConversationsManifest({
      billing: createBillingStores(),
      stores: createConversationsStores,
      revoker: createMembershipRevoker,
      realtime: () => failingRealtime,
      deleteForkMessages: (db) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(db, conversationId, ids),
      linkResolution: (db) => createLinkResolutionAdapter(db),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await dispatch({
      method: 'DELETE',
      path: `/conversations/${id}`,
      cookie: owner.cookie,
      app,
    });
    expect(res.status).toBe(200);
    expect(await db.select().from(conversations).where(eq(conversations.id, id))).toHaveLength(0);
  });
});

// --- Shares & links ---------------------------------------------------------

let shareSeq = 1000;

/** A mint body's link fields for one credential: its public key and auth hash, base64. */
function linkFields(credential: LinkCredential = mintLinkCredential()): {
  linkPublicKey: string;
  linkAuthHash: string;
} {
  return {
    linkPublicKey: toBase64(credential.linkPublicKey),
    linkAuthHash: toBase64(credential.linkAuthHash),
  };
}

/** Seeds an active membership directly (the add-member rotation flow is exercised elsewhere). */
async function seedMember(
  conversationId: string,
  userId: string,
  privilege: 'read' | 'write' | 'admin'
): Promise<void> {
  await db.insert(conversationMembers).values({
    conversationId,
    userId,
    privilege,
    visibleFromEpoch: 1,
    acceptedAt: new Date(),
  });
}

/** A share-suite message with an explicit author: a member's own turn or the model's reply. */
async function seedAuthoredShareMessage(
  conversationId: string,
  sender: { senderType: 'user' | 'assistant'; senderId: string }
): Promise<string> {
  shareSeq += 1;
  const rows = await db
    .insert(messages)
    .values({
      conversationId,
      ...sender,
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: shareSeq,
    })
    .returning({ id: messages.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('authored message seed failed');
  return id;
}

/**
 * A member's own message with a share-suite-local sequence, avoiding collisions
 * across tests. Only its sender may share it.
 */
async function seedShareMessage(conversationId: string, senderId: string): Promise<string> {
  return seedAuthoredShareMessage(conversationId, { senderType: 'user', senderId });
}

async function getPublic(shareId: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
  return createApp().request(
    `/conversations/shared/message/${shareId}`,
    { method: 'GET', headers },
    testEnv
  );
}

/** POSTs a standalone message-share and returns its share id. */
async function shareMessage(
  actor: TestUser,
  conversationId: string,
  messageId: string
): Promise<string> {
  const res = await send('POST', `/conversations/${conversationId}/shares`, actor.cookie, {
    messageId,
    wrappedContentKey: B64,
  });
  const body: { shareId: string } = await res.json();
  return body.shareId;
}

interface LinkBody {
  created: boolean;
  link: {
    id: string;
    displayName: string | null;
    privilege: string;
    revokedAt: string | null;
    expiresAt: string | null;
  };
}

/**
 * Mints a link as a full-history guest at epoch 1 by default (the fresh
 * conversation's epoch), so a mint seats a real read-privilege guest member.
 */
async function mintLink(
  actor: TestUser,
  conversationId: string,
  extra: Record<string, unknown> = {}
): Promise<Response> {
  return send('POST', `/conversations/${conversationId}/links`, actor.cookie, {
    ...linkFields(),
    privilege: 'read',
    giveFullHistory: true,
    expectedEpoch: 1,
    memberWrap: randomB64(),
    ...extra,
  });
}

async function mintLinkBody(
  actor: TestUser,
  conversationId: string,
  extra: Record<string, unknown> = {}
): Promise<LinkBody> {
  const res = await mintLink(actor, conversationId, extra);
  return res.json();
}

/**
 * Revokes a link with a departure rotation covering the remaining member keys
 * (the guest's key is excluded server-side). Defaults to an owner-only room.
 */
async function revokeLink(
  actor: TestUser,
  conversationId: string,
  linkId: string,
  options: { remainingKeys: Uint8Array[]; expectedEpoch?: number }
): Promise<Response> {
  return send('POST', `/conversations/${conversationId}/links/${linkId}/revoke`, actor.cookie, {
    rotation: rotationFor(options.expectedEpoch ?? 1, options.remainingKeys),
  });
}

/**
 * Fires `fire()` while an uncommitted removal UPDATE holds the actor's
 * conversation_members row lock, then commits the removal. The share/link
 * writes take FOR SHARE on that row, so the request must block until the
 * commit and then observe the removal; an unlocked membership read would
 * instead answer from the pre-removal snapshot and let the write through.
 */
async function raceAgainstRemoval(
  conversationId: string,
  userId: string,
  fire: () => Promise<Response>
): Promise<Response> {
  const raced = await db.transaction(async (tx) => {
    await tx
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId)
        )
      );
    const pending = fire();
    const early = await Promise.race([
      pending,
      new Promise<null>((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, 400);
      }),
    ]);
    // With the FOR SHARE lock held by the uncommitted removal above, the
    // guarded write cannot complete before this transaction commits — an
    // early response means the membership read ran unlocked.
    expect(early).toBeNull();
    return { pending };
  });
  return raced.pending;
}

describe('conversations routes: shared links create', () => {
  it('lets the owner mint a link and never echoes the public key', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const res = await mintLink(owner, conv, { displayName: 'My share' });
    expect(res.status).toBe(200);
    const body: LinkBody = await res.json();
    expect(body.created).toBe(true);
    expect(body.link.displayName).toBe('My share');
    expect(body.link.revokedAt).toBeNull();
    // The raw response must not carry link key material.
    expect(JSON.stringify(body)).not.toContain('linkPublicKey');
  });

  it('replays a retried Idempotency-Key without a duplicate row', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const key = crypto.randomUUID();
    const body = {
      ...linkFields(),
      privilege: 'read',
      giveFullHistory: true,
      expectedEpoch: 1,
      memberWrap: randomB64(),
    };
    const first = await dispatch({
      method: 'POST',
      path: `/conversations/${conv}/links`,
      cookie: owner.cookie,
      body,
      idempotencyKey: key,
    });
    const second = await dispatch({
      method: 'POST',
      path: `/conversations/${conv}/links`,
      cookie: owner.cookie,
      body,
      idempotencyKey: key,
    });
    expect(await second.json()).toEqual(await first.json());
    const rows = await db.select().from(sharedLinks).where(eq(sharedLinks.conversationId, conv));
    expect(rows).toHaveLength(1);
  });

  it('converges a fresh key reusing the same public key (created:false)', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const link = linkFields();
    const firstBody: LinkBody = await mintLinkBody(owner, conv, link);
    const secondBody: LinkBody = await mintLinkBody(owner, conv, link);
    expect(secondBody.created).toBe(false);
    expect(secondBody.link.id).toBe(firstBody.link.id);
  });

  it('reports the seated privilege when a re-mint asks for a different one', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const link = linkFields();
    await mintLinkBody(owner, conv, { ...link, privilege: 'read' });
    const second: LinkBody = await mintLinkBody(owner, conv, { ...link, privilege: 'write' });
    expect(second.created).toBe(false);
    expect(second.link.privilege).toBe('read');
  });

  it('refuses a re-mint of a revoked link instead of reporting it as live', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const link = linkFields();
    const first: LinkBody = await mintLinkBody(owner, conv, link);
    const revoked = await send(
      'POST',
      `/conversations/${conv}/links/${first.link.id}/revoke`,
      owner.cookie,
      { rotation: rotationFor(1, [owner.publicKey]) }
    );
    expect(revoked.status).toBe(200);
    const res = await mintLink(owner, conv, { ...link, expectedEpoch: 2 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CONFLICT });
  });

  it('refuses a mint whose expiry has already lapsed', async () => {
    // A lapsed link holds no member slot and takes no epoch wrap, so a mint
    // that arrives already expired would seat nothing while the member cap
    // counted nothing — the mint window is the only bound left on those rows.
    const owner = await newUser();
    const conv = await createConversation(owner);

    const res = await mintLink(owner, conv, {
      expiresAt: new Date(Date.now() - MINUTE_MS).toISOString(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
    const rows = await db.select().from(sharedLinks).where(eq(sharedLinks.conversationId, conv));
    expect(rows).toHaveLength(0);
  });

  it('forbids a write-privilege member from minting links', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, writer.userId, 'write');
    const res = await mintLink(writer, conv);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('answers not-found to a non-member minting a link', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const conv = await createConversation(owner);
    const res = await mintLink(stranger, conv);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('refuses a mint racing a concurrent member removal instead of inserting', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, admin.userId, 'admin');
    const res = await raceAgainstRemoval(conv, admin.userId, () => mintLink(admin, conv));
    expect(res.status).toBe(404);
    const rows = await db.select().from(sharedLinks).where(eq(sharedLinks.conversationId, conv));
    expect(rows).toHaveLength(0);
  });

  it('seats a full-history read-guest member and wraps the epoch key, without rotating', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    // A real guest member is seated (userId null, accepted, read-privilege).
    const memberRows = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.linkId, linkBody.link.id));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.userId).toBeNull();
    expect(memberRows[0]?.privilege).toBe('read');
    expect(memberRows[0]?.acceptedAt).not.toBeNull();
    expect(memberRows[0]?.leftAt).toBeNull();
    // The current epoch now carries the owner wrap plus the new link wrap; no rotation.
    const epochChain = await epochRows(conv);
    expect(epochChain).toHaveLength(1);
    const wraps = await db
      .select()
      .from(epochMembers)
      .where(eq(epochMembers.epochId, epochChain[0]?.id ?? ''));
    expect(wraps).toHaveLength(2);
  });

  it('seats a rotation guest, advancing the epoch and seating the link key', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { linkPublicKey: linkKey, linkAuthHash } = mintLinkCredential();
    const res = await send('POST', `/conversations/${conv}/links`, owner.cookie, {
      linkPublicKey: toBase64(linkKey),
      linkAuthHash: toBase64(linkAuthHash),
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, linkKey]),
    });
    expect(res.status).toBe(200);
    const body: LinkBody & { newEpochNumber: number | null } = await res.json();
    expect(body.created).toBe(true);
    expect(body.newEpochNumber).toBe(2);
    const chain = await epochRows(conv);
    expect(chain).toHaveLength(2);
    const memberRows = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.linkId, body.link.id));
    expect(memberRows[0]?.privilege).toBe('write');
    expect(memberRows[0]?.visibleFromEpoch).toBe(2);
  });
});

describe('conversations routes: shared links list', () => {
  it('lists links for an active read-privilege member', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, reader.userId, 'read');
    await mintLink(owner, conv);
    await mintLink(owner, conv);
    const res = await get(`/conversations/${conv}/links`, reader.cookie);
    expect(res.status).toBe(200);
    const body: { links: unknown[] } = await res.json();
    expect(body.links).toHaveLength(2);
  });

  it('answers not-found to a non-member listing links', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const conv = await createConversation(owner);
    const res = await get(`/conversations/${conv}/links`, stranger.cookie);
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: shared links revoke', () => {
  it('revokes a live link: marks the guest left, rotates out, evicts, and denies presign', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    const res = await revokeLink(owner, conv, linkBody.link.id, {
      remainingKeys: [owner.publicKey],
    });
    expect(res.status).toBe(200);
    const body: {
      revoked: boolean;
      memberId: string | null;
      newEpochNumber: number;
      evicteePrincipalIds: string[];
    } = await res.json();
    expect(body.revoked).toBe(true);
    expect(body.memberId).not.toBeNull();
    expect(body.newEpochNumber).toBe(2);
    expect(body.evicteePrincipalIds).toEqual([linkBody.link.id]);
    const rows = await db.select().from(sharedLinks).where(eq(sharedLinks.id, linkBody.link.id));
    expect(rows[0]?.revokedAt).not.toBeNull();
    // Security-critical: the guest member row is marked left, so the presign
    // member path (which consults leftAt, never shared_links.revokedAt) denies it.
    const memberRows = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.linkId, linkBody.link.id));
    expect(memberRows[0]?.leftAt).not.toBeNull();
    const active = await isActiveConversationMember(db, conv, {
      kind: 'linkGuest',
      linkId: linkBody.link.id,
    });
    expect(active._unsafeUnwrap()).toBe(false);
    // The revoke rotated the conversation forward, past the revoked guest.
    const chain = await epochRows(conv);
    expect(chain).toHaveLength(2);
  });

  it('is an idempotent no-op when the link is already revoked', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    await revokeLink(owner, conv, linkBody.link.id, { remainingKeys: [owner.publicKey] });
    const again = await revokeLink(owner, conv, linkBody.link.id, {
      remainingKeys: [owner.publicKey],
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ revoked: true, alreadyRevoked: true });
  });

  it('answers not-found revoking an unknown link', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const res = await revokeLink(owner, conv, crypto.randomUUID(), {
      remainingKeys: [owner.publicKey],
    });
    expect(res.status).toBe(404);
  });

  it('refuses stale-epoch when the departure rotation targets another epoch', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    const res = await revokeLink(owner, conv, linkBody.link.id, {
      remainingKeys: [owner.publicKey],
      expectedEpoch: 5,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.STALE_EPOCH,
      details: { currentEpoch: 1 },
    });
  });

  it('forbids a write-privilege member from revoking', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, writer.userId, 'write');
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    const res = await revokeLink(writer, conv, linkBody.link.id, {
      remainingKeys: [owner.publicKey],
    });
    expect(res.status).toBe(403);
  });

  it('answers not-found to a non-member revoking a link', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const conv = await createConversation(owner);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    const res = await revokeLink(stranger, conv, linkBody.link.id, {
      remainingKeys: [owner.publicKey],
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('revokes an already-expired member-less link with a null member id', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { linkPublicKey, linkAuthHash } = mintLinkCredential();
    const rows = await db
      .insert(sharedLinks)
      .values({
        conversationId: conv,
        linkPublicKey,
        linkAuthHash,
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: sharedLinks.id });
    const linkId = rows[0]?.id ?? '';
    const res = await revokeLink(owner, conv, linkId, { remainingKeys: [owner.publicKey] });
    expect(res.status).toBe(200);
    const body: { revoked: boolean; memberId: string | null } = await res.json();
    expect(body.revoked).toBe(true);
    expect(body.memberId).toBeNull();
    const after = await db.select().from(sharedLinks).where(eq(sharedLinks.id, linkId));
    expect(after[0]?.revokedAt).not.toBeNull();
  });
});

describe('conversations routes: public share read', () => {
  it('reads one standalone shared message by its share id with no authentication and leaks nothing else', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    const shareId = await shareMessage(owner, conv, messageId);
    const res = await getPublic(shareId);
    expect(res.status).toBe(200);
    const body: {
      shareId: string;
      messageId: string;
      wrappedContentKey: string;
      createdAt: string;
      contentItems: unknown[];
    } = await res.json();
    // Exactly the share wrap, the AAD inputs a reader needs, the deleted flag
    // and the message's own creation date, and nothing else: no sequence
    // number, no sibling messages, no membership.
    expect(Object.keys(body).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'contentItems',
      'conversationId',
      'createdAt',
      'deleted',
      'epochNumber',
      'epochWrappedContentKey',
      'messageCreatedAt',
      'messageId',
      'senderId',
      'shareId',
      'wrappedContentKey',
    ]);
    // The row id is surfaced so the client can mint media presign URLs with it.
    expect(body.shareId).toBe(shareId);
    expect(body.messageId).toBe(messageId);
    expect(body.wrappedContentKey).toBe(B64);
  });

  it('returns exactly its own message, never a sibling standalone share', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageA = await seedShareMessage(conv, owner.userId);
    const messageB = await seedShareMessage(conv, owner.userId);
    const shareA = await shareMessage(owner, conv, messageA);
    const shareB = await shareMessage(owner, conv, messageB);

    const resA = await getPublic(shareA);
    const resB = await getPublic(shareB);
    const readA: { messageId: string } = await resA.json();
    const readB: { messageId: string } = await resB.json();
    expect(readA.messageId).toBe(messageA);
    expect(readB.messageId).toBe(messageB);
  });

  it('answers not-found for an unknown share id', async () => {
    const res = await getPublic(crypto.randomUUID());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});

describe('conversations routes: shared messages create + severing', () => {
  it('answers not-found when the message is not in the conversation', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const res = await send('POST', `/conversations/${conv}/shares`, owner.cookie, {
      messageId: crypto.randomUUID(),
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('answers not-found to a non-member sharing a message', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    const res = await send('POST', `/conversations/${conv}/shares`, stranger.cookie, {
      messageId,
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(404);
  });

  it('refuses a read-privilege member, since publishing to the open internet is a write act', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, reader.userId, 'read');
    const messageId = await seedShareMessage(conv, owner.userId);
    const res = await send('POST', `/conversations/${conv}/shares`, reader.cookie, {
      messageId,
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
    const rows = await db
      .select()
      .from(sharedMessages)
      .where(eq(sharedMessages.messageId, messageId));
    expect(rows).toHaveLength(0);
  });

  it('lets a member share their own message', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, writer.userId, 'write');
    const messageId = await seedAuthoredShareMessage(conv, {
      senderType: 'user',
      senderId: writer.userId,
    });
    const res = await send('POST', `/conversations/${conv}/shares`, writer.cookie, {
      messageId,
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(sharedMessages)
      .where(eq(sharedMessages.messageId, messageId));
    expect(rows.map((row) => row.createdBy)).toEqual([writer.userId]);
  });

  it('refuses a member sharing another member’s message', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, writer.userId, 'write');
    const messageId = await seedAuthoredShareMessage(conv, {
      senderType: 'user',
      senderId: owner.userId,
    });
    const res = await send('POST', `/conversations/${conv}/shares`, writer.cookie, {
      messageId,
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
    const rows = await db
      .select()
      .from(sharedMessages)
      .where(eq(sharedMessages.messageId, messageId));
    expect(rows).toHaveLength(0);
  });

  it('lets any member share a message the model wrote', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, writer.userId, 'write');
    const messageId = await seedAuthoredShareMessage(conv, {
      senderType: 'assistant',
      senderId: ASSISTANT_SENDER_ID,
    });
    const res = await send('POST', `/conversations/${conv}/shares`, writer.cookie, {
      messageId,
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(200);
  });

  /** A writer seated at epoch 2, with one message on each side of their floor. */
  async function lateJoinerSetup(): Promise<{
    joiner: TestUser;
    conversationId: string;
    preJoin: string;
    atFloor: string;
  }> {
    const owner = await newUser();
    const joiner = await newUser();
    const conversationId = await createConversation(owner);
    shareSeq += 1;
    const preJoin = await seedMessage(conversationId, shareSeq);
    await send('POST', `/conversations/${conversationId}/members`, owner.cookie, {
      userId: joiner.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, joiner.publicKey]),
    });
    shareSeq += 1;
    const atFloor = await seedMessageAtEpoch(conversationId, shareSeq, 2, joiner.userId);
    return { joiner, conversationId, preJoin, atFloor };
  }

  it('answers a pre-join message exactly as it answers a message that does not exist', async () => {
    const { joiner, conversationId, preJoin } = await lateJoinerSetup();

    const preJoinRes = await send(
      'POST',
      `/conversations/${conversationId}/shares`,
      joiner.cookie,
      {
        messageId: preJoin,
        wrappedContentKey: B64,
      }
    );
    const absentRes = await send('POST', `/conversations/${conversationId}/shares`, joiner.cookie, {
      messageId: crypto.randomUUID(),
      wrappedContentKey: B64,
    });

    // Indistinguishable by construction: a refusal that differed would itself
    // disclose that the message exists.
    expect(preJoinRes.status).toBe(404);
    expect(preJoinRes.status).toBe(absentRes.status);
    const preJoinBody = await preJoinRes.text();
    expect(preJoinBody).toBe(await absentRes.text());
    expect(JSON.parse(preJoinBody)).toEqual({ code: ERROR_CODES.NOT_FOUND });

    const rows = await db
      .select()
      .from(sharedMessages)
      .where(eq(sharedMessages.messageId, preJoin));
    expect(rows).toHaveLength(0);
  });

  it('lets a late joiner share a message written at their own epoch floor', async () => {
    const { joiner, conversationId, atFloor } = await lateJoinerSetup();
    const res = await send('POST', `/conversations/${conversationId}/shares`, joiner.cookie, {
      messageId: atFloor,
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(200);
  });

  it('refuses a share racing a concurrent member removal instead of inserting', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, writer.userId, 'write');
    const messageId = await seedShareMessage(conv, writer.userId);
    const res = await raceAgainstRemoval(conv, writer.userId, () =>
      send('POST', `/conversations/${conv}/shares`, writer.cookie, {
        messageId,
        wrappedContentKey: B64,
      })
    );
    expect(res.status).toBe(404);
    const rows = await db
      .select()
      .from(sharedMessages)
      .where(eq(sharedMessages.messageId, messageId));
    expect(rows).toHaveLength(0);
  });

  it('severs a shared message when its creator is deleted (FK cascade on createdBy)', async () => {
    const owner = await newUser();
    const creator = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, creator.userId, 'write');
    const messageId = await seedShareMessage(conv, creator.userId);
    const shareId = await shareMessage(creator, conv, messageId);
    const before = await db.select().from(sharedMessages).where(eq(sharedMessages.id, shareId));
    expect(before).toHaveLength(1);
    expect(before[0]?.createdBy).toBe(creator.userId);

    // Account deletion clears membership first; then the user row deletion
    // severs the share by FK cascade — the semantics this slice owns.
    await db
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conv),
          eq(conversationMembers.userId, creator.userId)
        )
      );
    await db.delete(users).where(eq(users.id, creator.userId));

    const after = await db.select().from(sharedMessages).where(eq(sharedMessages.id, shareId));
    expect(after).toHaveLength(0);
  });
});

async function seedMessageAtEpoch(
  conversationId: string,
  sequenceNumber: number,
  epochNumber: number,
  senderId: string | null = null
): Promise<string> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      senderId,
      wrappedContentKey: BYTES,
      epochNumber,
      sequenceNumber,
    })
    .returning({ id: messages.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('epoch message seed failed');
  return id;
}

async function seedTextContentItem(messageId: string, position: number): Promise<string> {
  const rows = await db
    .insert(contentItems)
    .values({ messageId, contentType: 'text', position, encryptedBlob: BYTES })
    .returning({ id: contentItems.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('content item seed failed');
  return id;
}

/**
 * One billed generation anchored to a content item: the usage_records row the
 * settlement writes plus the llm_completions token detail carrying the
 * persisted reasoning token count the history read serves.
 */
async function seedLlmCompletion(
  contentItemId: string,
  conversationId: string,
  userId: string,
  // An omitted `effort` leaves the column null — "no reasoning wire was sent" —
  // which is a different fact from the `off` it can carry explicitly.
  reasoning: { tokens: number; effort?: ResolvedReasoningEffort; durationMs?: number }
): Promise<void> {
  const rows = await db
    .insert(usageRecords)
    .values({
      // A self-funded turn's payer is its sender, so one id serves both.
      payerUserId: userId,
      contentItemId,
      conversationId,
      runId: crypto.randomUUID(),
      modelId: 'anthropic/claude',
      providerName: 'openai',
      modality: 'text',
      costNanoUsd: 1_360_000n,
      idempotencyKey: crypto.randomUUID(),
    })
    .returning({ id: usageRecords.id });
  const usageRecordId = rows[0]?.id;
  if (usageRecordId === undefined) throw new Error('usage record seed failed');
  await db.insert(llmCompletions).values({
    usageRecordId,
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: reasoning.tokens,
    ...(reasoning.effort === undefined ? {} : { reasoningEffort: reasoning.effort }),
    ...(reasoning.durationMs === undefined ? {} : { reasoningDurationMs: reasoning.durationMs }),
  });
}

/**
 * A settled AI text content item carrying the display mirror the chat
 * settlement writes: billed cost, generating model, and smart-model flag.
 */
async function seedAiTextContentItem(
  messageId: string,
  position: number,
  settled: { costNanoUsd: bigint; modelId: string; isSmartModel: boolean }
): Promise<string> {
  const rows = await db
    .insert(contentItems)
    .values({
      messageId,
      contentType: 'text',
      position,
      encryptedBlob: BYTES,
      costNanoUsd: settled.costNanoUsd,
      modelId: settled.modelId,
      providerName: 'openai',
      isSmartModel: settled.isSmartModel,
    })
    .returning({ id: contentItems.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('ai content item seed failed');
  return id;
}

async function seedMediaContentItem(messageId: string, position: number): Promise<string> {
  const rows = await db
    .insert(contentItems)
    .values({
      messageId,
      contentType: 'image',
      position,
      storageKey: crypto.randomUUID(),
      mimeType: 'image/png',
      sizeBytes: 42,
    })
    .returning({ id: contentItems.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('media content item seed failed');
  return id;
}

interface MemberKeysBody {
  members: {
    memberId: string;
    userId: string | null;
    linkId: string | null;
    publicKey: string;
    privilege: string;
    visibleFromEpoch: number;
  }[];
}

describe('conversations routes: member public keys', () => {
  it('returns the active-member public-key set to any member ordered by join', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await get(`/conversations/${id}/member-keys`, member.cookie);
    expect(res.status).toBe(200);
    const body: MemberKeysBody = await res.json();
    expect(body.members).toHaveLength(2);
    expect(body.members[0]?.userId).toBe(owner.userId);
    expect(body.members[0]?.publicKey).toBe(toBase64(owner.publicKey));
    expect(body.members[1]?.userId).toBe(member.userId);
    expect(body.members[1]?.publicKey).toBe(toBase64(member.publicKey));
    expect(body.members.every((m) => m.linkId === null)).toBe(true);
  });

  it('includes link members joined to the link public key', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const { linkPublicKey, linkAuthHash } = mintLinkCredential();
    const linkRows = await db
      .insert(sharedLinks)
      .values({ conversationId: id, linkPublicKey, linkAuthHash })
      .returning({ id: sharedLinks.id });
    const linkId = linkRows[0]?.id;
    if (linkId === undefined) throw new Error('link seed failed');
    await db.insert(conversationMembers).values({
      conversationId: id,
      linkId,
      privilege: 'read',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });
    const res = await get(`/conversations/${id}/member-keys`, owner.cookie);
    const body: MemberKeysBody = await res.json();
    const linkMember = body.members.find((m) => m.linkId === linkId);
    expect(linkMember?.userId).toBeNull();
    expect(linkMember?.publicKey).toBe(toBase64(linkPublicKey));
  });

  it('serves a read-privilege member (membership, not admin, is the gate)', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const id = await createConversation(owner);
    await seedMember(id, reader.userId, 'read');
    const res = await get(`/conversations/${id}/member-keys`, reader.cookie);
    expect(res.status).toBe(200);
    const body: MemberKeysBody = await res.json();
    expect(body.members.map((m) => m.userId)).toEqual(
      expect.arrayContaining([owner.userId, reader.userId])
    );
  });

  it('hides the key set from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/member-keys`, outsider.cookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('excludes a member who has left', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await seedMember(id, member.userId, 'write');
    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          eq(conversationMembers.userId, member.userId)
        )
      );
    const res = await get(`/conversations/${id}/member-keys`, owner.cookie);
    const body: MemberKeysBody = await res.json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0]?.userId).toBe(owner.userId);
  });
});

interface BatchBody {
  keys: Record<string, { currentEpoch: number }>;
  missing: string[];
}

async function getBatch(ids: string[], cookie: string): Promise<Response> {
  return get(`/conversations/member-keys/batch?conversationIds=${ids.join(',')}`, cookie);
}

describe('conversations routes: batch keychain', () => {
  it('returns keychains for accessible ids and lists the rest as missing (never 404)', async () => {
    const owner = await newUser();
    const other = await newUser();
    const mine = await createConversation(owner);
    const foreign = await createConversation(other);
    const absent = crypto.randomUUID();
    const res = await getBatch([mine, foreign, absent], owner.cookie);
    expect(res.status).toBe(200);
    const body: BatchBody = await res.json();
    expect(Object.keys(body.keys)).toEqual([mine]);
    expect(body.keys[mine]?.currentEpoch).toBe(1);
    expect(body.missing).toEqual(expect.arrayContaining([foreign, absent]));
    expect(body.missing).not.toContain(mine);
  });

  it('rejects a batch over the 100-id cap', async () => {
    const owner = await newUser();
    const ids = Array.from({ length: 101 }, () => crypto.randomUUID());
    const res = await getBatch(ids, owner.cookie);
    expect(res.status).toBe(400);
  });
});

interface HistoryBody {
  messages: {
    id: string;
    sequenceNumber: number;
    epochNumber: number;
    wrappedContentKey: string;
    deleted: boolean;
    contentItems: {
      id: string;
      contentType: string;
      encryptedBlob: string | null;
      byteLength: number | null;
      cost: string | null;
      modelName: string | null;
      isSmartModel: boolean;
      reasoningTokens: number | null;
      reasoningEffort: string | null;
      reasoningDurationMs: number | null;
    }[];
  }[];
  nextCursor: string | null;
}

async function getHistory(conversationId: string, cookie: string, query = ''): Promise<Response> {
  return get(`/conversations/${conversationId}/messages${query}`, cookie);
}

async function historyBody(
  conversationId: string,
  cookie: string,
  query = ''
): Promise<HistoryBody> {
  const res = await getHistory(conversationId, cookie, query);
  const body: HistoryBody = await res.json();
  return body;
}

const MESSAGE_DELETED_AT = new Date(TEST_DAY_START);

/**
 * The state an account deletion leaves on a message the departed user sent in
 * someone else's conversation: the row stays, stamped, with no content items.
 */
async function markMessageDeleted(messageId: string): Promise<void> {
  await db
    .update(messages)
    .set({ deletedAt: MESSAGE_DELETED_AT })
    .where(eq(messages.id, messageId));
}

/** The key and the ISO and epoch-millisecond spellings of the deletion instant. */
function expectNoDeletionInstant(serialized: string): void {
  expect(serialized).not.toContain('deletedAt');
  expect(serialized).not.toContain(MESSAGE_DELETED_AT.toISOString());
  expect(serialized).not.toContain(String(MESSAGE_DELETED_AT.getTime()));
}

describe('conversations routes: message history', () => {
  it('serves a live message as not deleted', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const message = await seedMessage(id, 1);
    await seedTextContentItem(message, 0);
    const body = await historyBody(id, owner.cookie);
    expect(body.messages[0]?.deleted).toBe(false);
  });

  it('serves a deleted message as deleted with no content items', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const message = await seedMessage(id, 1);
    await markMessageDeleted(message);
    const body = await historyBody(id, owner.cookie);
    expect(body.messages[0]).toMatchObject({ id: message, deleted: true, contentItems: [] });
  });

  it('never serves the instant a message was deleted', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    await markMessageDeleted(await seedMessage(id, 1));
    const res = await getHistory(id, owner.cookie);
    expect(res.status).toBe(200);
    expectNoDeletionInstant(await res.text());
  });

  it('returns messages ordered by sequence with their content items for a member', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const first = await seedMessage(id, 1);
    const second = await seedMessage(id, 2);
    await seedTextContentItem(first, 0);
    await seedTextContentItem(second, 0);
    const res = await getHistory(id, owner.cookie);
    expect(res.status).toBe(200);
    const body: HistoryBody = await res.json();
    expect(body.messages.map((m) => m.sequenceNumber)).toEqual([1, 2]);
    expect(body.messages[0]?.wrappedContentKey).toBe(toBase64(BYTES));
    expect(body.messages[0]?.contentItems[0]?.contentType).toBe('text');
    expect(body.messages[0]?.contentItems[0]?.encryptedBlob).toBe(toBase64(BYTES));
  });

  it('carries the content-item id and null bytes for a media item (presign deferred)', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const message = await seedMessage(id, 1);
    const mediaId = await seedMediaContentItem(message, 0);
    const res = await getHistory(id, owner.cookie);
    const body: HistoryBody = await res.json();
    const item = body.messages[0]?.contentItems[0];
    expect(item?.id).toBe(mediaId);
    expect(item?.contentType).toBe('image');
    expect(item?.encryptedBlob).toBeNull();
    expect(item?.byteLength).toBe(42);
    expect(JSON.stringify(body)).not.toContain('http');
  });

  it('carries the billed cost, model name, and smart-model flag for a settled AI content item', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const message = await seedMessage(id, 1);
    await seedAiTextContentItem(message, 0, {
      costNanoUsd: 1_360_000n,
      modelId: 'anthropic/claude',
      isSmartModel: true,
    });
    const body = await historyBody(id, owner.cookie);
    const item = body.messages[0]?.contentItems[0];
    expect(item?.cost).toBe('1360000');
    expect(item?.modelName).toBe('anthropic/claude');
    expect(item?.isSmartModel).toBe(true);
  });

  it('carries the persisted reasoning token count on a settled AI content item', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const message = await seedMessage(id, 1);
    const item = await seedAiTextContentItem(message, 0, {
      costNanoUsd: 1_360_000n,
      modelId: 'anthropic/claude',
      isSmartModel: false,
    });
    await seedLlmCompletion(item, id, owner.userId, { tokens: 1204 });
    const body = await historyBody(id, owner.cookie);
    expect(body.messages[0]?.contentItems[0]?.reasoningTokens).toBe(1204);
  });

  it('sums reasoning tokens across a content item’s completion rows', async () => {
    // A multi-step generation records one llm_completions row per step under
    // the same anchored content item; the wire count is the item's total.
    const owner = await newUser();
    const id = await createConversation(owner);
    const message = await seedMessage(id, 1);
    const item = await seedAiTextContentItem(message, 0, {
      costNanoUsd: 1_360_000n,
      modelId: 'anthropic/claude',
      isSmartModel: false,
    });
    await seedLlmCompletion(item, id, owner.userId, { tokens: 1000 });
    await seedLlmCompletion(item, id, owner.userId, { tokens: 204 });
    const body = await historyBody(id, owner.cookie);
    expect(body.messages[0]?.contentItems[0]?.reasoningTokens).toBe(1204);
  });

  it('carries null reasoning tokens for an item with no completion row', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const message = await seedMessage(id, 1);
    await seedTextContentItem(message, 0);
    const body = await historyBody(id, owner.cookie);
    expect(body.messages[0]?.contentItems[0]?.reasoningTokens).toBeNull();
  });

  it('carries the persisted reasoning level on a settled AI content item', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const message = await seedMessage(id, 1);
    const item = await seedAiTextContentItem(message, 0, {
      costNanoUsd: 1_360_000n,
      modelId: 'anthropic/claude',
      isSmartModel: false,
    });
    await seedLlmCompletion(item, id, owner.userId, { tokens: 1204, effort: 'high' });
    const body = await historyBody(id, owner.cookie);
    expect(body.messages[0]?.contentItems[0]?.reasoningEffort).toBe('high');
  });

  it('serves a reasoning-off level as `off`, distinct from an unrecorded one', async () => {
    // The two facts the persisted column keeps apart: `off` means the user
    // chose no reasoning, null means no reasoning wire was sent at all.
    const owner = await newUser();
    const id = await createConversation(owner);
    const message = await seedMessage(id, 1);
    const settled = { costNanoUsd: 1_360_000n, modelId: 'anthropic/claude', isSmartModel: false };
    const chosenOff = await seedAiTextContentItem(message, 0, settled);
    const noReasoning = await seedAiTextContentItem(message, 1, settled);
    await seedLlmCompletion(chosenOff, id, owner.userId, { tokens: 0, effort: 'off' });
    await seedLlmCompletion(noReasoning, id, owner.userId, { tokens: 0 });
    const body = await historyBody(id, owner.cookie);
    expect(body.messages[0]?.contentItems[0]?.reasoningEffort).toBe('off');
    expect(body.messages[0]?.contentItems[1]?.reasoningEffort).toBeNull();
  });

  it('takes the level from the completion row that recorded one', async () => {
    // A multi-step generation writes one completion row per step and the
    // classifier's own charge anchors to the same content item with no level,
    // so the item's level is taken from the row carrying it — never folded.
    const owner = await newUser();
    const id = await createConversation(owner);
    const message = await seedMessage(id, 1);
    const item = await seedAiTextContentItem(message, 0, {
      costNanoUsd: 1_360_000n,
      modelId: 'anthropic/claude',
      isSmartModel: true,
    });
    await seedLlmCompletion(item, id, owner.userId, { tokens: 0 });
    await seedLlmCompletion(item, id, owner.userId, { tokens: 1000, effort: 'max' });
    await seedLlmCompletion(item, id, owner.userId, { tokens: 204, effort: 'max' });
    const body = await historyBody(id, owner.cookie);
    expect(body.messages[0]?.contentItems[0]?.reasoningEffort).toBe('max');
    expect(body.messages[0]?.contentItems[0]?.reasoningTokens).toBe(1204);
  });

  it('gives each multi-model sibling its own resolved level', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const settled = { costNanoUsd: 1_360_000n, modelId: 'anthropic/claude', isSmartModel: false };
    const first = await seedMessage(id, 1);
    const second = await seedMessage(id, 2);
    const firstItem = await seedAiTextContentItem(first, 0, settled);
    const secondItem = await seedAiTextContentItem(second, 0, settled);
    await seedLlmCompletion(firstItem, id, owner.userId, { tokens: 900, effort: 'max' });
    await seedLlmCompletion(secondItem, id, owner.userId, { tokens: 10, effort: 'lite' });
    const body = await historyBody(id, owner.cookie);
    expect(body.messages[0]?.contentItems[0]?.reasoningEffort).toBe('max');
    expect(body.messages[1]?.contentItems[0]?.reasoningEffort).toBe('lite');
  });

  it('carries a zero reasoning token count for a completion that spent none', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const message = await seedMessage(id, 1);
    const item = await seedAiTextContentItem(message, 0, {
      costNanoUsd: 1_360_000n,
      modelId: 'anthropic/claude',
      isSmartModel: false,
    });
    await seedLlmCompletion(item, id, owner.userId, { tokens: 0 });
    const body = await historyBody(id, owner.cookie);
    expect(body.messages[0]?.contentItems[0]?.reasoningTokens).toBe(0);
  });

  it('reports null cost/model and a false smart flag for a plain (unsettled) text item', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const message = await seedMessage(id, 1);
    await seedTextContentItem(message, 0);
    const body = await historyBody(id, owner.cookie);
    const item = body.messages[0]?.contentItems[0];
    expect(item?.cost).toBeNull();
    expect(item?.modelName).toBeNull();
    expect(item?.isSmartModel).toBe(false);
  });

  it('denies a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await getHistory(id, outsider.cookie);
    expect(res.status).toBe(404);
  });

  it('hides messages below a late joiner visibility floor', async () => {
    const owner = await newUser();
    const joiner = await newUser();
    const id = await createConversation(owner);
    const early = await seedMessage(id, 1);
    // Adding with rotation advances to epoch 2 and floors the joiner there.
    await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: joiner.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, joiner.publicKey]),
    });
    const late = await seedMessageAtEpoch(id, 2, 2);
    const ownerBody = await historyBody(id, owner.cookie);
    expect(ownerBody.messages.map((m) => m.id)).toEqual([early, late]);
    const joinerBody = await historyBody(id, joiner.cookie);
    expect(joinerBody.messages.map((m) => m.id)).toEqual([late]);
  });

  it('paginates by sequence with a following cursor', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    await seedMessage(id, 1);
    await seedMessage(id, 2);
    await seedMessage(id, 3);
    const firstPage = await historyBody(id, owner.cookie, '?limit=2');
    expect(firstPage.messages.map((m) => m.sequenceNumber)).toEqual([1, 2]);
    expect(firstPage.nextCursor).toBe('2');
    const secondPage = await historyBody(
      id,
      owner.cookie,
      `?limit=2&cursor=${firstPage.nextCursor ?? ''}`
    );
    expect(secondPage.messages.map((m) => m.sequenceNumber)).toEqual([3]);
    expect(secondPage.nextCursor).toBeNull();
  });
});

interface PublicShareContentBody {
  messageId: string;
  contentItems: { id: string; contentType: string; encryptedBlob: string | null }[];
}

/** The public share read's content items, narrowed to the reasoning fields. */
interface PublicShareReasoningBody {
  contentItems: {
    id: string;
    reasoningTokens: number | null;
    reasoningEffort: string | null;
    reasoningDurationMs: number | null;
  }[];
}

describe('conversations routes: public share content items', () => {
  it('serves a live shared message as not deleted', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    await seedTextContentItem(messageId, 0);
    const shareId = await shareMessage(owner, conv, messageId);
    const res = await getPublic(shareId);
    const body: { deleted: boolean } = await res.json();
    expect(body.deleted).toBe(false);
  });

  it('serves a deleted shared message as deleted with no content items', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    const shareId = await shareMessage(owner, conv, messageId);
    await markMessageDeleted(messageId);
    const res = await getPublic(shareId);
    expect(res.status).toBe(200);
    const body: PublicShareContentBody & { deleted: boolean } = await res.json();
    expect(body).toMatchObject({ messageId, deleted: true, contentItems: [] });
  });

  it('never serves the instant a shared message was deleted', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    const shareId = await shareMessage(owner, conv, messageId);
    await markMessageDeleted(messageId);
    const res = await getPublic(shareId);
    expect(res.status).toBe(200);
    expectNoDeletionInstant(await res.text());
  });

  it('returns text encryptedBlob inline and media by content-item id', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    const textId = await seedTextContentItem(messageId, 0);
    const mediaId = await seedMediaContentItem(messageId, 1);
    const shareId = await shareMessage(owner, conv, messageId);
    const res = await getPublic(shareId);
    expect(res.status).toBe(200);
    const body: PublicShareContentBody = await res.json();
    const items = body.contentItems;
    expect(items.map((item) => item.id)).toEqual([textId, mediaId]);
    expect(items[0]?.encryptedBlob).toBe(toBase64(BYTES));
    expect(items[1]?.encryptedBlob).toBeNull();
    expect(items[1]?.id).toBe(mediaId);
    expect(JSON.stringify(body)).not.toContain('http');
  });

  it('carries the message location tuple and epoch wrap the envelope AAD binds', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    await seedTextContentItem(messageId, 0);
    const shareId = await shareMessage(owner, conv, messageId);
    const res = await getPublic(shareId);
    expect(res.status).toBe(200);
    const body: {
      conversationId: string;
      epochNumber: number;
      senderId: string | null;
      epochWrappedContentKey: string;
    } = await res.json();
    expect(body.conversationId).toBe(conv);
    expect(body.epochNumber).toBe(1);
    expect(body.senderId).toBe(owner.userId);
    // The message row's epoch wrap, not the share wrap the POST supplied.
    expect(body.epochWrappedContentKey).toBe(toBase64(BYTES));
    expect(body.epochWrappedContentKey).not.toBe(B64);
  });

  it('serves the model and never the billed cost onto the unauthenticated read', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    // The underlying content item carries settled display metadata; the public
    // read serves the model and the smart-model flag and strips the cost.
    await seedAiTextContentItem(messageId, 0, {
      costNanoUsd: 1_360_000n,
      modelId: 'anthropic/claude',
      isSmartModel: true,
    });
    const shareId = await shareMessage(owner, conv, messageId);
    const res = await getPublic(shareId);
    expect(res.status).toBe(200);
    const body: { contentItems: Record<string, unknown>[] } = await res.json();
    const item = body.contentItems[0];
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'byteLength',
      'contentType',
      'durationMs',
      'encryptedBlob',
      'height',
      'id',
      'isSmartModel',
      'mimeType',
      'modelName',
      'position',
      'reasoningDurationMs',
      'reasoningEffort',
      'reasoningTokens',
      'width',
    ]);
    expect(item?.['modelName']).toBe('anthropic/claude');
    expect(item?.['isSmartModel']).toBe(true);
    expect(item).not.toHaveProperty('cost');
    expect(JSON.stringify(body)).not.toContain('1360000');
  });

  it('serves a null model on a user item', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    await seedTextContentItem(messageId, 0);
    const shareId = await shareMessage(owner, conv, messageId);
    const res = await getPublic(shareId);
    const body: { contentItems: { modelName: string | null; isSmartModel: boolean }[] } =
      await res.json();
    expect(body.contentItems[0]?.modelName).toBeNull();
    expect(body.contentItems[0]?.isSmartModel).toBe(false);
  });

  it('serves the shared message row creation date, not the share date', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    await seedTextContentItem(messageId, 0);
    await db
      .update(messages)
      .set({ createdAt: new Date(TEST_DAY_START - MINUTE_MS) })
      .where(eq(messages.id, messageId));
    const shareId = await shareMessage(owner, conv, messageId);
    const [row] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, messageId));
    const res = await getPublic(shareId);
    expect(res.status).toBe(200);
    const body: { createdAt: string; messageCreatedAt: string } = await res.json();
    expect(body.messageCreatedAt).toBe(row?.createdAt.toISOString());
    expect(body.messageCreatedAt).not.toBe(body.createdAt);
  });

  it('serves the same reasoning level and token count the author’s history read serves', async () => {
    // One message read twice: the owner's authenticated history and the
    // unauthenticated share. Comparing the two reads of the SAME row is what
    // proves the shared reasoning surface is the author's, not a second
    // projection that happens to look alike.
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    const contentItemId = await seedAiTextContentItem(messageId, 0, {
      costNanoUsd: 1_360_000n,
      modelId: 'anthropic/claude',
      isSmartModel: false,
    });
    await seedLlmCompletion(contentItemId, conv, owner.userId, { tokens: 1204, effort: 'high' });
    const shareId = await shareMessage(owner, conv, messageId);

    const history = await historyBody(conv, owner.cookie);
    const historyItem = history.messages
      .find((message) => message.id === messageId)
      ?.contentItems.find((candidate) => candidate.id === contentItemId);
    const res = await getPublic(shareId);
    expect(res.status).toBe(200);
    const body: PublicShareReasoningBody = await res.json();
    const sharedItem = body.contentItems.find((candidate) => candidate.id === contentItemId);

    expect(historyItem?.reasoningEffort).toBe('high');
    expect(historyItem?.reasoningTokens).toBe(1204);
    expect(sharedItem?.reasoningEffort).toBe(historyItem?.reasoningEffort);
    expect(sharedItem?.reasoningTokens).toBe(historyItem?.reasoningTokens);
  });

  it('serves the same reasoning time the author’s history read serves', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    const contentItemId = await seedAiTextContentItem(messageId, 0, {
      costNanoUsd: 1_360_000n,
      modelId: 'anthropic/claude',
      isSmartModel: false,
    });
    await seedLlmCompletion(contentItemId, conv, owner.userId, {
      tokens: 1204,
      effort: 'high',
      durationMs: 14_000,
    });
    const shareId = await shareMessage(owner, conv, messageId);

    const history = await historyBody(conv, owner.cookie);
    const historyItem = history.messages
      .find((message) => message.id === messageId)
      ?.contentItems.find((candidate) => candidate.id === contentItemId);
    const res = await getPublic(shareId);
    const body: PublicShareReasoningBody = await res.json();
    const sharedItem = body.contentItems.find((candidate) => candidate.id === contentItemId);

    expect(historyItem?.reasoningDurationMs).toBe(14_000);
    expect(sharedItem?.reasoningDurationMs).toBe(14_000);
  });

  it('serves a null reasoning time on both reads for a completion row settled without one', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    const contentItemId = await seedAiTextContentItem(messageId, 0, {
      costNanoUsd: 1_360_000n,
      modelId: 'anthropic/claude',
      isSmartModel: false,
    });
    await seedLlmCompletion(contentItemId, conv, owner.userId, { tokens: 1204, effort: 'high' });
    const shareId = await shareMessage(owner, conv, messageId);

    const history = await historyBody(conv, owner.cookie);
    const historyItem = history.messages
      .find((message) => message.id === messageId)
      ?.contentItems.find((candidate) => candidate.id === contentItemId);
    const res = await getPublic(shareId);
    const body: PublicShareReasoningBody = await res.json();
    const sharedItem = body.contentItems.find((candidate) => candidate.id === contentItemId);

    expect(historyItem?.reasoningDurationMs).toBeNull();
    expect(sharedItem?.reasoningDurationMs).toBeNull();
  });

  it('serves null reasoning fields for an item whose turn recorded no completion row', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    await seedTextContentItem(messageId, 0);
    const shareId = await shareMessage(owner, conv, messageId);
    const res = await getPublic(shareId);
    const body: PublicShareReasoningBody = await res.json();
    expect(body.contentItems[0]?.reasoningEffort).toBeNull();
    expect(body.contentItems[0]?.reasoningTokens).toBeNull();
  });

  it('serves a reasoning-off level as `off`, distinct from an unrecorded one', async () => {
    // `off` is a level the author chose and the badge shows; null is the
    // absence of any recorded level. Collapsing them would make a turn that
    // deliberately ran without reasoning indistinguishable from one that never
    // sent a reasoning wire.
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv, owner.userId);
    const reasoned = await seedAiTextContentItem(messageId, 0, {
      costNanoUsd: 1_360_000n,
      modelId: 'anthropic/claude',
      isSmartModel: false,
    });
    await seedLlmCompletion(reasoned, conv, owner.userId, { tokens: 0, effort: 'off' });
    await seedTextContentItem(messageId, 1);
    const shareId = await shareMessage(owner, conv, messageId);

    const res = await getPublic(shareId);
    const body: PublicShareReasoningBody = await res.json();
    expect(body.contentItems[0]?.reasoningEffort).toBe('off');
    expect(body.contentItems[0]?.reasoningTokens).toBe(0);
    expect(body.contentItems[1]?.reasoningEffort).toBeNull();
    expect(body.contentItems[1]?.reasoningTokens).toBeNull();
  });
});

async function memberIdOf(conversationId: string, userId: string): Promise<string> {
  const rows = await db
    .select({ id: conversationMembers.id })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId)
      )
    );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('member row missing');
  return id;
}

describe('conversations routes: accept invite', () => {
  it('flips a pending membership to accepted', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await send('PATCH', `/conversations/${id}/membership/accept`, member.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    const rows = await db
      .select({ acceptedAt: conversationMembers.acceptedAt })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          eq(conversationMembers.userId, member.userId)
        )
      );
    expect(rows[0]?.acceptedAt).not.toBeNull();
  });

  it('is idempotent on repeat accept', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    await send('PATCH', `/conversations/${id}/membership/accept`, member.cookie);
    const res = await send('PATCH', `/conversations/${id}/membership/accept`, member.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
  });

  it('denies a non-member accept', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await send('PATCH', `/conversations/${id}/membership/accept`, outsider.cookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});

describe('conversations routes: decline invite', () => {
  it('marks a pending membership left and broadcasts member:removed', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    const res = await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/membership/decline`,
      cookie: member.cookie,
    });
    expect(res.status).toBe(200);
    const body: { declined: boolean; memberId: string } = await res.json();
    expect(body.declined).toBe(true);
    const rows = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.id, memberId));
    expect(rows[0]?.leftAt).not.toBeNull();
    const removed = broadcasts.filter((b) => b.event.type === 'member:removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.event).toMatchObject({
      conversationId: id,
      memberId,
      userId: member.userId,
    });
  });

  it('evicts the decliner: cache deleted and socket eviction invoked', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const cache = createRedisMembershipCache(redis);
    await cache.set(id, member.userId, 'member', 30);
    const evicted: EvictedCall[] = [];
    const res = await dispatch({
      app: createApp(evicted),
      method: 'POST',
      path: `/conversations/${id}/membership/decline`,
      cookie: member.cookie,
    });
    expect(res.status).toBe(200);
    expect(evicted).toEqual([{ conversationId: id, principalId: member.userId }]);
    expect(await cache.get(id, member.userId)).toBeNull();
  });

  it('refuses to decline an already-accepted membership', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    await send('PATCH', `/conversations/${id}/membership/accept`, member.cookie);
    const res = await send('POST', `/conversations/${id}/membership/decline`, member.cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('answers not-found for a non-member decline', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/membership/decline`, outsider.cookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});

describe('conversations routes: change privilege', () => {
  it('lets an admin change a lower member privilege and broadcasts it', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const adminMember = await newUser();
    const writer = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, adminMember, 'admin');
    const writerId = await addFullHistory(owner, id, writer, 'write');
    const res = await dispatch({
      app,
      method: 'PATCH',
      path: `/conversations/${id}/member/${writerId}/privilege`,
      cookie: adminMember.cookie,
      body: { privilege: 'read' },
    });
    expect(res.status).toBe(200);
    const body: { updated: boolean; memberId: string; privilege: string } = await res.json();
    expect(body).toMatchObject({ updated: true, memberId: writerId, privilege: 'read' });
    const rows = await db
      .select({ privilege: conversationMembers.privilege })
      .from(conversationMembers)
      .where(eq(conversationMembers.id, writerId));
    expect(rows[0]?.privilege).toBe('read');
    const changed = broadcasts.filter((b) => b.event.type === 'member:privilege-changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.event).toMatchObject({ memberId: writerId, privilege: 'read' });
  });

  it('refuses a non-admin changing a privilege as privilege-insufficient', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const other = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, writer, 'write');
    const otherId = await addFullHistory(owner, id, other, 'write');
    const res = await send(
      'PATCH',
      `/conversations/${id}/member/${otherId}/privilege`,
      writer.cookie,
      { privilege: 'read' }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.PRIVILEGE_INSUFFICIENT });
  });

  it('refuses an admin changing their own privilege', async () => {
    const owner = await newUser();
    const adminMember = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, adminMember, 'admin');
    const adminId = await memberIdOf(id, adminMember.userId);
    const res = await send(
      'PATCH',
      `/conversations/${id}/member/${adminId}/privilege`,
      adminMember.cookie,
      { privilege: 'read' }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CANNOT_CHANGE_OWN_PRIVILEGE });
  });

  it('answers not-found for a missing target member', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send(
      'PATCH',
      `/conversations/${id}/member/${crypto.randomUUID()}/privilege`,
      owner.cookie,
      { privilege: 'read' }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('refuses a grant that is not strictly below the caller as privilege-insufficient', async () => {
    const owner = await newUser();
    const adminMember = await newUser();
    const writer = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, adminMember, 'admin');
    const writerId = await addFullHistory(owner, id, writer, 'write');
    const res = await send(
      'PATCH',
      `/conversations/${id}/member/${writerId}/privilege`,
      adminMember.cookie,
      { privilege: 'admin' }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.PRIVILEGE_INSUFFICIENT });
  });
});

describe('conversations routes: link privilege change', () => {
  it('lets an admin change a link guest privilege and broadcasts it', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const id = await createConversation(owner);
    const link = await mintLinkBody(owner, id);
    const res = await dispatch({
      app,
      method: 'PATCH',
      path: `/conversations/${id}/links/${link.link.id}/privilege`,
      cookie: owner.cookie,
      body: { privilege: 'write' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: true });
    const rows = await db
      .select({ id: conversationMembers.id, privilege: conversationMembers.privilege })
      .from(conversationMembers)
      .where(and(eq(conversationMembers.linkId, link.link.id), isNull(conversationMembers.leftAt)));
    expect(rows[0]?.privilege).toBe('write');
    const changed = broadcasts.filter((b) => b.event.type === 'member:privilege-changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.event).toMatchObject({ memberId: rows[0]?.id, privilege: 'write' });
  });

  it('forbids a non-admin caller', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const id = await createConversation(owner);
    const link = await mintLinkBody(owner, id);
    await seedMember(id, writer.userId, 'write');
    const res = await send(
      'PATCH',
      `/conversations/${id}/links/${link.link.id}/privilege`,
      writer.cookie,
      { privilege: 'write' }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('answers not-found for a missing link', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send(
      'PATCH',
      `/conversations/${id}/links/${crypto.randomUUID()}/privilege`,
      owner.cookie,
      { privilege: 'write' }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('answers not-found for a revoked link', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const link = await mintLinkBody(owner, id);
    await db
      .update(sharedLinks)
      .set({ revokedAt: new Date() })
      .where(eq(sharedLinks.id, link.link.id));
    const res = await send(
      'PATCH',
      `/conversations/${id}/links/${link.link.id}/privilege`,
      owner.cookie,
      { privilege: 'write' }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});

describe('conversations routes: link name change', () => {
  it('lets an admin rename a link', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const link = await mintLinkBody(owner, id);
    const res = await send(
      'PATCH',
      `/conversations/${id}/links/${link.link.id}/name`,
      owner.cookie,
      { displayName: 'Renamed Link' }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const rows = await db
      .select({ displayName: sharedLinks.displayName })
      .from(sharedLinks)
      .where(eq(sharedLinks.id, link.link.id));
    expect(rows[0]?.displayName).toBe('Renamed Link');
  });

  it('forbids a non-admin caller', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const id = await createConversation(owner);
    const link = await mintLinkBody(owner, id);
    await seedMember(id, writer.userId, 'write');
    const res = await send(
      'PATCH',
      `/conversations/${id}/links/${link.link.id}/name`,
      writer.cookie,
      { displayName: 'Nope' }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('answers not-found for a missing link', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send(
      'PATCH',
      `/conversations/${id}/links/${crypto.randomUUID()}/name`,
      owner.cookie,
      { displayName: 'Nope' }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});

describe('conversations routes: my-name set (guest self)', () => {
  it('lets a link guest rename its own display label', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const guest = mintLinkCredential();
    const link = await mintLinkBody(owner, id, linkFields(guest));
    const res = await createApp().request(
      `/conversations/${id}/my-name`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          [LINK_CREDENTIAL_HEADER]: guest.token,
        },
        body: JSON.stringify({ displayName: 'Guest Alias' }),
      },
      testEnv
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const rows = await db
      .select({ displayName: sharedLinks.displayName })
      .from(sharedLinks)
      .where(eq(sharedLinks.id, link.link.id));
    expect(rows[0]?.displayName).toBe('Guest Alias');
  });

  it('forbids a full-session user (no link display name to set)', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send('PATCH', `/conversations/${id}/my-name`, owner.cookie, {
      displayName: 'Nope',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('answers 401 with no session and no link credential', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await createApp().request(
      `/conversations/${id}/my-name`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'x' }),
      },
      testEnv
    );
    expect(res.status).toBe(401);
  });
});

describe('conversations routes: update title', () => {
  it('lets the owner update the ciphertext title, round-tripped untouched', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const title = randomB64();
    const res = await send('PATCH', `/conversations/${id}`, owner.cookie, {
      title,
      titleEpochNumber: 1,
    });
    expect(res.status).toBe(200);
    const body: { conversation: { title: string; titleEpochNumber: number } } = await res.json();
    expect(body.conversation.title).toBe(title);
    expect(body.conversation.titleEpochNumber).toBe(1);
  });

  // Four characters over the cap, not one: base64 has no valid length ≡ 1
  // (mod 4), so a one-character overrun would be refused for its encoding.
  it('refuses a title over the ciphertext cap with the uniform validation answer', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send('PATCH', `/conversations/${id}`, owner.cookie, {
      title: 'A'.repeat(1028),
      titleEpochNumber: 1,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('forbids a non-owner title update', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await send('PATCH', `/conversations/${id}`, member.cookie, {
      title: randomB64(),
      titleEpochNumber: 1,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('answers not-found for a missing conversation', async () => {
    const owner = await newUser();
    const res = await send('PATCH', `/conversations/${crypto.randomUUID()}`, owner.cookie, {
      title: randomB64(),
      titleEpochNumber: 1,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('replays the stored response for a retried Idempotency-Key', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const key = crypto.randomUUID();
    const title = randomB64();
    const first = await dispatch({
      method: 'PATCH',
      path: `/conversations/${id}`,
      cookie: owner.cookie,
      body: { title, titleEpochNumber: 1 },
      idempotencyKey: key,
    });
    const second = await dispatch({
      method: 'PATCH',
      path: `/conversations/${id}`,
      cookie: owner.cookie,
      body: { title, titleEpochNumber: 1 },
      idempotencyKey: key,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
  });
});

describe('conversations routes: membership events', () => {
  it('broadcasts member:added and rotation:complete on a rotation add', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    const res = await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/members`,
      cookie: owner.cookie,
      body: {
        userId: target.userId,
        privilege: 'write',
        giveFullHistory: false,
        rotation: rotationFor(1, [owner.publicKey, target.publicKey]),
      },
    });
    expect(res.status).toBe(200);
    const added = broadcasts.filter((b) => b.event.type === 'member:added');
    expect(added).toHaveLength(1);
    expect(added[0]?.event).toMatchObject({
      conversationId: id,
      userId: target.userId,
      privilege: 'write',
    });
    const rotated = broadcasts.filter((b) => b.event.type === 'rotation:complete');
    expect(rotated).toHaveLength(1);
    expect(rotated[0]?.event).toMatchObject({ conversationId: id, newEpochNumber: 2 });
  });

  it('broadcasts member:added without rotation:complete on a full-history add', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/members`,
      cookie: owner.cookie,
      body: {
        userId: target.userId,
        privilege: 'write',
        giveFullHistory: true,
        wrap: randomB64(),
        expectedEpoch: 1,
      },
    });
    expect(broadcasts.filter((b) => b.event.type === 'member:added')).toHaveLength(1);
    expect(broadcasts.filter((b) => b.event.type === 'rotation:complete')).toHaveLength(0);
  });

  it('broadcasts member:removed and rotation:complete on removal', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    const res = await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/members/${memberId}/remove`,
      cookie: owner.cookie,
      body: { rotation: rotationFor(1, [owner.publicKey]) },
    });
    expect(res.status).toBe(200);
    const removed = broadcasts.filter((b) => b.event.type === 'member:removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.event).toMatchObject({ conversationId: id, memberId });
    const rotated = broadcasts.filter((b) => b.event.type === 'rotation:complete');
    expect(rotated).toHaveLength(1);
    expect(rotated[0]?.event).toMatchObject({ newEpochNumber: 2 });
  });

  it('broadcasts member:removed and no rotation:complete on a non-owner leave', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    const res = await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/leave`,
      cookie: member.cookie,
      body: {},
    });
    expect(res.status).toBe(200);
    const removed = broadcasts.filter((b) => b.event.type === 'member:removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.event).toMatchObject({
      conversationId: id,
      memberId,
      userId: member.userId,
    });
    expect(broadcasts.filter((b) => b.event.type === 'rotation:complete')).toEqual([]);
  });

  it('broadcasts rotation:complete carrying the new epoch after a maintenance rotation', async () => {
    const broadcasts: BroadcastCall[] = [];
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const left = await send('POST', `/conversations/${id}/leave`, member.cookie, {});
    expect(left.status).toBe(200);
    const res = await dispatch({
      app: createApp([], broadcasts),
      method: 'POST',
      path: `/conversations/${id}/epochs`,
      cookie: owner.cookie,
      body: rotationFor(1, [owner.publicKey]),
    });
    expect(await res.json()).toEqual({ rotated: true, newEpochNumber: 2 });
    expect(broadcasts).toEqual([
      {
        conversationId: id,
        event: expect.objectContaining({
          type: 'rotation:complete',
          conversationId: id,
          newEpochNumber: 2,
        }),
      },
    ]);
  });

  it('captures no superseded epoch for a maintenance rotation', async () => {
    const capturedCodes: string[] = [];
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const left = await send('POST', `/conversations/${id}/leave`, member.cookie, {});
    expect(left.status).toBe(200);
    const res = await dispatch({
      app: createApp([], [], capturedCodes),
      method: 'POST',
      path: `/conversations/${id}/epochs`,
      cookie: owner.cookie,
      body: rotationFor(1, [owner.publicKey]),
    });
    expect(res.status).toBe(200);
    expect(capturedCodes.filter((code) => code === 'epoch_rotation_superseded')).toEqual([]);
    // The control: a recovery through the same recorder is captured.
    const recovery = await dispatch({
      app: createApp([], [], capturedCodes),
      method: 'POST',
      path: `/conversations/${id}/epochs`,
      cookie: owner.cookie,
      body: { ...rotationFor(2, [owner.publicKey]), predecessorEpoch: 1 },
    });
    expect(await recovery.json()).toEqual({ rotated: true, newEpochNumber: 3 });
    expect(capturedCodes.filter((code) => code === 'epoch_rotation_superseded')).toEqual([
      'epoch_rotation_superseded',
    ]);
  });

  it('broadcasts nothing when a rotation is answered as already done', async () => {
    const broadcasts: BroadcastCall[] = [];
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await dispatch({
      app: createApp([], broadcasts),
      method: 'POST',
      path: `/conversations/${id}/epochs`,
      cookie: owner.cookie,
      body: rotationFor(1, [owner.publicKey]),
    });
    expect(await res.json()).toEqual({ rotated: false, currentEpoch: 1 });
    expect(broadcasts).toEqual([]);
  });

  it('broadcasts nothing when a rotation is refused', async () => {
    const broadcasts: BroadcastCall[] = [];
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const left = await send('POST', `/conversations/${id}/leave`, member.cookie, {});
    expect(left.status).toBe(200);
    const res = await dispatch({
      app: createApp([], broadcasts),
      method: 'POST',
      path: `/conversations/${id}/epochs`,
      cookie: owner.cookie,
      body: rotationFor(1, [owner.publicKey, member.publicKey]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.WRAP_SET_MISMATCH });
    expect(broadcasts).toEqual([]);
  });

  it('does not fail the mutation when a broadcast errors', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    const failingRealtime: RealtimeBroadcast = {
      broadcast: () => errAsync(unavailableError('broadcast down')),
      evict: () => okAsync(0),
      presence: () => okAsync([]),
      startRun: () =>
        okAsync({ started: true, runId: 'r', deadlineAt: 0, assistantMessageIds: [] }),
      stopRun: () => okAsync(false),
      upgrade: () => okAsync(new Response(null, { status: 200 })),
    };
    const manifest = createConversationsManifest({
      billing: createBillingStores(),
      stores: createConversationsStores,
      revoker: createMembershipRevoker,
      realtime: () => failingRealtime,
      deleteForkMessages: (writer) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(writer, conversationId, ids),
      linkResolution: (db) => createLinkResolutionAdapter(db),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/members/${memberId}/remove`,
      cookie: owner.cookie,
      body: { rotation: rotationFor(1, [owner.publicKey]) },
    });
    expect(res.status).toBe(200);
    const rows = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.id, memberId));
    expect(rows[0]?.leftAt).not.toBeNull();
  });
});

interface UpgradeCall {
  conversationId: string;
  principal: UpgradePrincipal;
}

/**
 * An app whose realtime double records every upgrade principal, so the
 * link-guest WS tests can assert the forwarded `isGuest` flag and principalId.
 * `storesOverride` and `linkResolution` let a test inject a failing store or a
 * down link-resolution port to exercise the defensive error branches.
 */
function createUpgradeCaptureApp(
  upgrades: UpgradeCall[],
  options: {
    storesOverride?: (stores: ConversationsStores) => ConversationsStores;
    linkResolution?: ConversationsRouteDeps['linkResolution'];
  } = {}
): Hono<AppEnv> {
  const realtime: RealtimeBroadcast = {
    ...recordingRealtime([]),
    upgrade: (conversationId, principal) => {
      upgrades.push({ conversationId, principal });
      // A real DO answers 101; the Response constructor forbids that status, so
      // the double answers 200 and the assertions ride the captured principal.
      return okAsync(new Response(null, { status: 200 }));
    },
  };
  const override = options.storesOverride;
  const manifest = createConversationsManifest({
    billing: createBillingStores(),
    stores: (db) => {
      const stores = createConversationsStores(db);
      return override === undefined ? stores : override(stores);
    },
    revoker: createMembershipRevoker,
    realtime: () => realtime,
    deleteForkMessages: (db) => (conversationId, ids) =>
      deleteForkMessagesWithinTx(db, conversationId, ids),
    linkResolution: options.linkResolution ?? ((db) => createLinkResolutionAdapter(db)),
  });
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

/**
 * Seats a read-privilege link-guest member; returns the link id, the token the guest
 * presents, and the auth hash the link stores.
 */
async function seatGuest(
  owner: TestUser,
  conversationId: string
): Promise<{ linkId: string; guestKey: string; linkAuthHash: Uint8Array }> {
  const guest = mintLinkCredential();
  const body = await mintLinkBody(owner, conversationId, linkFields(guest));
  return { linkId: body.link.id, guestKey: guest.token, linkAuthHash: guest.linkAuthHash };
}

describe('conversations routes: link-guest reads', () => {
  async function guestGet(
    path: string,
    guestKey?: string,
    app: Hono<AppEnv> = createApp()
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (guestKey !== undefined) headers[LINK_CREDENTIAL_HEADER] = guestKey;
    return app.request(path, { method: 'GET', headers }, testEnv);
  }

  it('lets an active guest read its conversation, members, keychain, member-keys, links, and my-name', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, conv);

    const conversation = await guestGet(`/conversations/${conv}`, guestKey);
    expect(conversation.status).toBe(200);
    const convBody: ConversationBody = await conversation.json();
    expect(convBody.conversation.id).toBe(conv);
    expect(convBody.membership).toMatchObject({ privilege: 'read' });

    const members = await guestGet(`/conversations/${conv}/members`, guestKey);
    expect(members.status).toBe(200);
    const memberBody: { members: { linkId: string | null }[] } = await members.json();
    expect(memberBody.members.length).toBe(2);

    const keychain = await guestGet(`/conversations/${conv}/keychain`, guestKey);
    expect(keychain.status).toBe(200);
    const keychainBody: { wraps: unknown[] } = await keychain.json();
    expect(keychainBody.wraps.length).toBeGreaterThan(0);

    const memberKeys = await guestGet(`/conversations/${conv}/member-keys`, guestKey);
    expect(memberKeys.status).toBe(200);
    const memberKeysBody: { members: { linkId: string | null }[] } = await memberKeys.json();
    expect(memberKeysBody.members.some((m) => m.linkId !== null)).toBe(true);

    const links = await guestGet(`/conversations/${conv}/links`, guestKey);
    expect(links.status).toBe(200);

    const myName = await guestGet(`/conversations/${conv}/my-name`, guestKey);
    expect(myName.status).toBe(200);
    expect(await myName.json()).toEqual({ displayName: null, privilege: 'read' });
  });

  it("returns the guest's link display name from my-name", async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const guest = mintLinkCredential();
    await mintLinkBody(owner, conv, { ...linkFields(guest), displayName: 'Reviewer' });

    const res = await guestGet(`/conversations/${conv}/my-name`, guest.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ displayName: 'Reviewer', privilege: 'read' });
  });

  it('still lets the full member owner read normally (unchanged)', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    await seatGuest(owner, conv);

    const conversation = await get(`/conversations/${conv}`, owner.cookie);
    expect(conversation.status).toBe(200);
    const members = await get(`/conversations/${conv}/members`, owner.cookie);
    expect(members.status).toBe(200);
    const keychain = await get(`/conversations/${conv}/keychain`, owner.cookie);
    expect(keychain.status).toBe(200);
    const myName = await get(`/conversations/${conv}/my-name`, owner.cookie);
    expect(myName.status).toBe(200);
    expect(await myName.json()).toMatchObject({ privilege: 'owner' });
  });

  it('denies a guest reading a DIFFERENT conversation with its credential (typed match)', async () => {
    const owner = await newUser();
    const convA = await createConversation(owner);
    const convB = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, convA);

    for (const path of [
      `/conversations/${convB}`,
      `/conversations/${convB}/members`,
      `/conversations/${convB}/keychain`,
      `/conversations/${convB}/my-name`,
    ]) {
      const res = await guestGet(path, guestKey);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
    }
  });

  it('answers 401 to a guest presenting a malformed credential (never 500)', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    await seatGuest(owner, conv);

    const res = await guestGet(`/conversations/${conv}`, 'not!base64!!');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('answers 401 to an anonymous request with no session and no credential', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const res = await guestGet(`/conversations/${conv}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('denies all reads to a revoked guest (link revoked)', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { linkId, guestKey } = await seatGuest(owner, conv);
    const revoked = await revokeLink(owner, conv, linkId, { remainingKeys: [owner.publicKey] });
    expect(revoked.status).toBe(200);

    for (const path of [
      `/conversations/${conv}`,
      `/conversations/${conv}/members`,
      `/conversations/${conv}/keychain`,
      `/conversations/${conv}/my-name`,
      `/conversations/${conv}/messages`,
    ]) {
      const res = await guestGet(path, guestKey);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });

  it('lets a full-history guest read the whole conversation message history', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const first = await seedMessage(conv, 1);
    const second = await seedMessage(conv, 2);
    const { guestKey } = await seatGuest(owner, conv);

    const res = await guestGet(`/conversations/${conv}/messages`, guestKey);
    expect(res.status).toBe(200);
    const body: HistoryBody = await res.json();
    expect(body.messages.map((m) => m.id)).toEqual([first, second]);
  });

  it('serves a guest the deleted flag of each message it reads', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const live = await seedMessage(conv, 1);
    const deleted = await seedMessage(conv, 2);
    await markMessageDeleted(deleted);
    const { guestKey } = await seatGuest(owner, conv);

    const res = await guestGet(`/conversations/${conv}/messages`, guestKey);
    expect(res.status).toBe(200);
    const body: HistoryBody = await res.json();
    expect(body.messages.map((m) => [m.id, m.deleted])).toEqual([
      [live, false],
      [deleted, true],
    ]);
  });

  it('serves a guest a null cost on a billed content item the owner reads priced', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const message = await seedMessage(conv, 1);
    await seedAiTextContentItem(message, 0, {
      costNanoUsd: 1_360_000n,
      modelId: 'anthropic/claude',
      isSmartModel: false,
    });
    const { guestKey } = await seatGuest(owner, conv);

    const res = await guestGet(`/conversations/${conv}/messages`, guestKey);
    expect(res.status).toBe(200);
    const body: HistoryBody = await res.json();
    expect(body.messages[0]?.contentItems[0]?.cost).toBeNull();

    // The same row still carries its cost on the owner's read.
    const ownerBody = await historyBody(conv, owner.cookie);
    expect(ownerBody.messages[0]?.contentItems[0]?.cost).toBe('1360000');
  });

  it('floors a rotation guest at its epoch, hiding pre-join history', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const early = await seedMessage(conv, 1);
    // A rotation mint seats the guest at the new epoch (2), never epoch 1.
    const guest = mintLinkCredential();
    await mintLinkBody(owner, conv, {
      ...linkFields(guest),
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, guest.linkPublicKey]),
    });
    const late = await seedMessageAtEpoch(conv, 2, 2);

    const res = await guestGet(`/conversations/${conv}/messages`, guest.token);
    expect(res.status).toBe(200);
    const body: HistoryBody = await res.json();
    expect(body.messages.map((m) => m.id)).toEqual([late]);
    expect(body.messages.map((m) => m.id)).not.toContain(early);

    // The owner (floor 1) still sees both — the authenticated path is unchanged.
    const ownerBody = await historyBody(conv, owner.cookie);
    expect(ownerBody.messages.map((m) => m.id)).toEqual([early, late]);
  });

  it('answers 503 (never 500) when link resolution fails closed on a store outage', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, conv);
    const manifest = createConversationsManifest({
      billing: createBillingStores(),
      stores: createConversationsStores,
      revoker: createMembershipRevoker,
      realtime: () => recordingRealtime([]),
      deleteForkMessages: (db) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(db, conversationId, ids),
      linkResolution: () => ({
        resolveLinkCredential: () => errAsync(unavailableError('link store down')),
      }),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);

    const res = await guestGet(`/conversations/${conv}`, guestKey, app);
    expect(res.status).toBe(503);
  });

  it('denies a guest whose member row is left even while the link stays live (active-member gate)', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { linkId, guestKey } = await seatGuest(owner, conv);
    // Leave the link live but mark the guest member row left — the resolver
    // still resolves (link liveness), so only the active-member gate denies.
    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(eq(conversationMembers.linkId, linkId));

    const res = await guestGet(`/conversations/${conv}`, guestKey);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});

describe('conversations domain: admin share-link revoke/unrevoke', () => {
  async function guestGet(path: string, guestKey: string): Promise<Response> {
    return createApp().request(
      path,
      { method: 'GET', headers: { [LINK_CREDENTIAL_HEADER]: guestKey } },
      testEnv
    );
  }

  /** The composition-root resolver behind every public link read (lazy revokedAt/expiry). */
  function resolveCredential(
    linkAuthHash: Uint8Array
  ): ReturnType<ReturnType<typeof createLinkResolutionAdapter>['resolveLinkCredential']> {
    return createLinkResolutionAdapter(db).resolveLinkCredential(linkAuthHash);
  }

  it('admin revoke departs the guest and the public read refuses lazily; unrevoke restores the link', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { linkId, guestKey, linkAuthHash } = await seatGuest(owner, conv);
    const stores = createConversationsStores(db);

    // Live link: the unauthenticated guest read succeeds.
    const before = await guestGet(`/conversations/${conv}`, guestKey);
    expect(before.status).toBe(200);

    const revoked = await adminRevokeSharedLink(stores, { conversationId: conv, linkId });
    expect(revoked._unsafeUnwrap()).toEqual({
      revoked: true,
      memberId: expect.any(String),
      evicteePrincipalIds: [linkId],
    });

    // Lazy enforcement end-to-end: nothing was pushed to the reader — the
    // public read's credential resolution now refuses on revokedAt.
    const after = await guestGet(`/conversations/${conv}`, guestKey);
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
    const deadCredential = await resolveCredential(linkAuthHash);
    expect(deadCredential._unsafeUnwrap()).toBeNull();

    // Guest member departed (the presign gate keys on leftAt) — no rotation:
    // the conversation stays on epoch 1 (authorization-only revocation).
    const memberRows = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.linkId, linkId));
    expect(memberRows[0]?.leftAt).not.toBeNull();
    const convRow = await db
      .select({ currentEpoch: conversations.currentEpoch })
      .from(conversations)
      .where(eq(conversations.id, conv));
    expect(convRow[0]?.currentEpoch).toBe(1);

    const unrevoked = await adminUnrevokeSharedLink(stores, { conversationId: conv, linkId });
    expect(unrevoked._unsafeUnwrap()).toEqual({ unrevoked: true });

    // The link is live again at the public read's lazy predicate...
    const liveCredential = await resolveCredential(linkAuthHash);
    expect(liveCredential._unsafeUnwrap()).toEqual({ linkId, conversationId: conv });
    // ...but unrevoke cleared revokedAt ONLY: the departed guest member stays
    // left until the normal link flow re-seats one, so the member-gated read
    // answers not-found, not success.
    const stillDeparted = await guestGet(`/conversations/${conv}`, guestKey);
    expect(stillDeparted.status).toBe(404);

    // The normal link flow's seating restores the full read end-to-end.
    const reseated = await stores.members.insertLinkMember({
      conversationId: conv,
      linkId,
      privilege: 'read',
      visibleFromEpoch: 1,
    });
    expect(reseated._unsafeUnwrap()).not.toBeNull();
    const restored = await guestGet(`/conversations/${conv}`, guestKey);
    expect(restored.status).toBe(200);
  });

  it('double-revoke, double-unrevoke, and revoke→unrevoke→revoke are safe no-ops with distinguishable outcomes', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { linkId } = await seatGuest(owner, conv);
    const stores = createConversationsStores(db);

    const first = await adminRevokeSharedLink(stores, { conversationId: conv, linkId });
    expect(first._unsafeUnwrap()).toMatchObject({ revoked: true, evicteePrincipalIds: [linkId] });
    const again = await adminRevokeSharedLink(stores, { conversationId: conv, linkId });
    expect(again._unsafeUnwrap()).toEqual({ revoked: true, alreadyRevoked: true });

    const unrevoke = await adminUnrevokeSharedLink(stores, { conversationId: conv, linkId });
    expect(unrevoke._unsafeUnwrap()).toEqual({ unrevoked: true });
    const unrevokeAgain = await adminUnrevokeSharedLink(stores, { conversationId: conv, linkId });
    expect(unrevokeAgain._unsafeUnwrap()).toEqual({ unrevoked: true, alreadyLive: true });

    // Re-revoke after unrevoke: a full revoke again — the guest was already
    // departed by the first revoke, so the member id is null this time.
    const reRevoke = await adminRevokeSharedLink(stores, { conversationId: conv, linkId });
    expect(reRevoke._unsafeUnwrap()).toEqual({
      revoked: true,
      memberId: null,
      evicteePrincipalIds: [linkId],
    });
  });

  it('refuses not-found for an unknown conversation and an unknown or foreign link', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const other = await createConversation(owner);
    const { linkId } = await seatGuest(owner, conv);
    const stores = createConversationsStores(db);

    const unknownConv = await adminRevokeSharedLink(stores, {
      conversationId: crypto.randomUUID(),
      linkId,
    });
    expect(unknownConv._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
    const unknownLink = await adminRevokeSharedLink(stores, {
      conversationId: conv,
      linkId: crypto.randomUUID(),
    });
    expect(unknownLink._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
    const foreign = await adminUnrevokeSharedLink(stores, { conversationId: other, linkId });
    expect(foreign._unsafeUnwrap()).toEqual({ refusal: 'not-found' });
  });
});

describe('conversations routes: link-guest websocket upgrade', () => {
  // A client whose every call fails fast: nothing listens on the discard port.
  const unreachableRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });

  /**
   * An upgrade-capturing app whose handlers see an unreachable Redis. The rebind
   * runs after the pipeline, so the stages ahead of the routes use the real one
   * and only the handler's own ticket write or read fails.
   */
  function createUnreachableRedisApp(upgrades: UpgradeCall[]): Hono<AppEnv> {
    const manifest = createConversationsManifest({
      billing: createBillingStores(),
      stores: createConversationsStores,
      revoker: createMembershipRevoker,
      realtime: () => ({
        ...recordingRealtime([]),
        upgrade: (conversationId, principal) => {
          upgrades.push({ conversationId, principal });
          return okAsync(new Response(null, { status: 200 }));
        },
      }),
      deleteForkMessages: (db) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(db, conversationId, ids),
      linkResolution: (db) => createLinkResolutionAdapter(db),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.use(async (c, next) => {
      bindRequestValue(c, 'redis', unreachableRedis);
      await next();
    });
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  function mintTicket(
    app: Hono<AppEnv>,
    conversationId: string,
    headers: Record<string, string>
  ): Promise<Response> {
    return Promise.resolve(
      app.request(
        `/conversations/${conversationId}/websocket-ticket`,
        { method: 'POST', headers },
        testEnv
      )
    );
  }

  async function ticketFor(
    app: Hono<AppEnv>,
    conversationId: string,
    guestKey: string
  ): Promise<string> {
    const res = await mintTicket(app, conversationId, { [LINK_CREDENTIAL_HEADER]: guestKey });
    expect(res.status).toBe(200);
    const body: { ticket: string } = await res.json();
    return body.ticket;
  }

  function upgradeWith(
    app: Hono<AppEnv>,
    conversationId: string,
    query: Record<string, string>,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    const search = new URLSearchParams(query).toString();
    const path = `/conversations/${conversationId}/websocket`;
    return Promise.resolve(
      app.request(
        search === '' ? path : `${path}?${search}`,
        { method: 'GET', headers: { Origin: 'capacitor://localhost', ...headers } },
        testEnv
      )
    );
  }

  it('upgrades an active guest presenting a fresh ticket, with its linkId as principalId', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { linkId, guestKey } = await seatGuest(owner, conv);
    const upgrades: UpgradeCall[] = [];
    const app = createUpgradeCaptureApp(upgrades);

    const ticket = await ticketFor(app, conv, guestKey);
    const res = await upgradeWith(app, conv, { [UPGRADE_TICKET_PARAM]: ticket });
    expect(res.status).toBe(200);
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]?.principal).toMatchObject({ isGuest: true, principalId: linkId });
  });

  it('upgrades a full-session member with isGuest false', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const upgrades: UpgradeCall[] = [];
    const app = createUpgradeCaptureApp(upgrades);

    const res = await upgradeWith(app, conv, {}, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(upgrades[0]?.principal).toMatchObject({ isGuest: false, principalId: owner.userId });
  });

  it('refuses a replayed ticket with 401, upgrading only once', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, conv);
    const upgrades: UpgradeCall[] = [];
    const app = createUpgradeCaptureApp(upgrades);

    const ticket = await ticketFor(app, conv, guestKey);
    const first = await upgradeWith(app, conv, { [UPGRADE_TICKET_PARAM]: ticket });
    expect(first.status).toBe(200);
    const replay = await upgradeWith(app, conv, { [UPGRADE_TICKET_PARAM]: ticket });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
    expect(upgrades).toHaveLength(1);
  });

  it('refuses a ticket nobody minted with 401', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const upgrades: UpgradeCall[] = [];
    const app = createUpgradeCaptureApp(upgrades);

    const res = await upgradeWith(app, conv, { [UPGRADE_TICKET_PARAM]: 'A'.repeat(43) });
    expect(res.status).toBe(401);
    expect(upgrades).toHaveLength(0);
  });

  it('refuses an upgrade presenting neither a session nor a ticket with 401', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const upgrades: UpgradeCall[] = [];
    const app = createUpgradeCaptureApp(upgrades);

    const res = await upgradeWith(app, conv, {});
    expect(res.status).toBe(401);
    expect(upgrades).toHaveLength(0);
  });

  it('answers 404 to a ticket presented on another conversation', async () => {
    const owner = await newUser();
    const convA = await createConversation(owner);
    const convB = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, convA);
    const upgrades: UpgradeCall[] = [];
    const app = createUpgradeCaptureApp(upgrades);

    const ticket = await ticketFor(app, convA, guestKey);
    const res = await upgradeWith(app, convB, { [UPGRADE_TICKET_PARAM]: ticket });
    expect(res.status).toBe(404);
    expect(upgrades).toHaveLength(0);
  });

  it('hides the conversation with 404 from a guest whose member row left after minting', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, conv);
    const upgrades: UpgradeCall[] = [];
    const app = createUpgradeCaptureApp(upgrades);
    const ticket = await ticketFor(app, conv, guestKey);
    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(and(eq(conversationMembers.conversationId, conv), isNull(conversationMembers.userId)));

    const res = await upgradeWith(app, conv, { [UPGRADE_TICKET_PARAM]: ticket });
    // Existence-hiding parity: a non-member (here a departed guest) is answered
    // the blind not-found, never a 403 that would confirm the room exists.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
    expect(upgrades).toHaveLength(0);
  });

  it('refuses the link credential header on the upgrade with 401', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, conv);
    const upgrades: UpgradeCall[] = [];
    const app = createUpgradeCaptureApp(upgrades);

    const res = await upgradeWith(app, conv, {}, { [LINK_CREDENTIAL_HEADER]: guestKey });
    expect(res.status).toBe(401);
    expect(upgrades).toHaveLength(0);
  });

  it('refuses the link credential in the linkPublicKey query on the upgrade with 401', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, conv);
    const upgrades: UpgradeCall[] = [];
    const app = createUpgradeCaptureApp(upgrades);

    const res = await upgradeWith(app, conv, { linkPublicKey: guestKey });
    expect(res.status).toBe(401);
    expect(upgrades).toHaveLength(0);
  });

  it('does not accept a query credential on plain HTTP guest reads', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, conv);

    const res = await createApp().request(
      `/conversations/${conv}?linkPublicKey=${encodeURIComponent(guestKey)}`,
      { method: 'GET' },
      testEnv
    );
    expect(res.status).toBe(401);
  });

  it("forwards the guest's link display name into the upgrade principal", async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const guest = mintLinkCredential();
    await mintLinkBody(owner, conv, { ...linkFields(guest), displayName: 'Reviewer' });
    const upgrades: UpgradeCall[] = [];
    const app = createUpgradeCaptureApp(upgrades);

    const ticket = await ticketFor(app, conv, guest.token);
    const res = await upgradeWith(app, conv, { [UPGRADE_TICKET_PARAM]: ticket });
    expect(res.status).toBe(200);
    expect(upgrades[0]?.principal).toMatchObject({ isGuest: true, displayName: 'Reviewer' });
  });

  it('answers 503 when the member read fails for a full-session upgrade', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const upgrades: UpgradeCall[] = [];
    const app = createUpgradeCaptureApp(upgrades, {
      storesOverride: (stores) => ({
        ...stores,
        members: {
          ...stores.members,
          activeByUser: () => errAsync(unavailableError('members down')),
        },
      }),
    });

    const res = await upgradeWith(app, conv, {}, { cookie: owner.cookie });
    expect(res.status).toBe(503);
    expect(upgrades).toHaveLength(0);
  });

  it('answers 503 when the guest member read fails for a link-guest upgrade', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, conv);
    const ticket = await ticketFor(createUpgradeCaptureApp([]), conv, guestKey);
    const upgrades: UpgradeCall[] = [];
    const app = createUpgradeCaptureApp(upgrades, {
      storesOverride: (stores) => ({
        ...stores,
        members: {
          ...stores.members,
          activeLinkGuest: () => errAsync(unavailableError('members down')),
        },
      }),
    });

    const res = await upgradeWith(app, conv, { [UPGRADE_TICKET_PARAM]: ticket });
    expect(res.status).toBe(503);
    expect(upgrades).toHaveLength(0);
  });

  it('answers 503 when Redis cannot spend the ticket', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const upgrades: UpgradeCall[] = [];
    const app = createUnreachableRedisApp(upgrades);

    const res = await upgradeWith(app, conv, { [UPGRADE_TICKET_PARAM]: 'A'.repeat(43) });
    expect(res.status).toBe(503);
    expect(upgrades).toHaveLength(0);
  });

  it('refuses a full-session caller the ticket mint with 403', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);

    const res = await mintTicket(createUpgradeCaptureApp([]), conv, { cookie: owner.cookie });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('refuses a ticket mint presenting no credential with 401', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);

    const res = await mintTicket(createUpgradeCaptureApp([]), conv, {});
    expect(res.status).toBe(401);
  });

  it('answers 404 to a guest minting a ticket for another conversation', async () => {
    const owner = await newUser();
    const convA = await createConversation(owner);
    const convB = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, convA);

    const res = await mintTicket(createUpgradeCaptureApp([]), convB, {
      [LINK_CREDENTIAL_HEADER]: guestKey,
    });
    expect(res.status).toBe(404);
  });

  it('answers 404 to a departed guest minting a ticket', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, conv);
    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(and(eq(conversationMembers.conversationId, conv), isNull(conversationMembers.userId)));

    const res = await mintTicket(createUpgradeCaptureApp([]), conv, {
      [LINK_CREDENTIAL_HEADER]: guestKey,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('answers 503 when the guest member read fails for a ticket mint', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, conv);
    const app = createUpgradeCaptureApp([], {
      storesOverride: (stores) => ({
        ...stores,
        members: {
          ...stores.members,
          activeLinkGuest: () => errAsync(unavailableError('members down')),
        },
      }),
    });

    const res = await mintTicket(app, conv, { [LINK_CREDENTIAL_HEADER]: guestKey });
    expect(res.status).toBe(503);
  });

  it('answers 503 when Redis cannot store the ticket', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { guestKey } = await seatGuest(owner, conv);

    const res = await mintTicket(createUnreachableRedisApp([]), conv, {
      [LINK_CREDENTIAL_HEADER]: guestKey,
    });
    expect(res.status).toBe(503);
  });
});

/**
 * The store-failure arms of two reads whose only fallible dependency is a
 * store: each answers the typed `unavailable` at the route seam, and neither
 * arm is reachable through a request whose stores all work.
 */
describe('conversations routes: store failures reach the wire', () => {
  it('answers 503 when the batched keychain read fails', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const app = createUpgradeCaptureApp([], {
      storesOverride: (stores) => ({
        ...stores,
        users: { ...stores.users, byId: () => errAsync(unavailableError('users down')) },
      }),
    });

    const res = await get(
      `/conversations/member-keys/batch?conversationIds=${conv}`,
      owner.cookie,
      {
        app,
      }
    );
    expect(res.status).toBe(503);
  });

  it('answers 503 when the link-privilege change fails its membership read', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const app = createUpgradeCaptureApp([], {
      storesOverride: (stores) => ({
        ...stores,
        members: {
          ...stores.members,
          activeByUser: () => errAsync(unavailableError('members down')),
        },
      }),
    });

    const res = await dispatch({
      method: 'PATCH',
      path: `/conversations/${conv}/links/${crypto.randomUUID()}/privilege`,
      cookie: owner.cookie,
      body: { privilege: 'write' },
      app,
    });
    expect(res.status).toBe(503);
  });
});

describe('conversations routes: membership lifecycle owns budget rows', () => {
  async function budgetRow(memberId: string): Promise<{ budgetNanoUsd: bigint }[]> {
    return db
      .select({ budgetNanoUsd: memberBudgets.budgetNanoUsd })
      .from(memberBudgets)
      .where(eq(memberBudgets.memberId, memberId));
  }

  it('removal deletes the removed member’s budget row in the same transaction', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    await db.insert(memberBudgets).values({ memberId, budgetNanoUsd: 500n, spentNanoUsd: 100n });

    const res = await send(
      'POST',
      `/conversations/${id}/members/${memberId}/remove`,
      owner.cookie,
      {
        rotation: rotationFor(1, [owner.publicKey]),
      }
    );

    expect(res.status).toBe(200);
    expect(await budgetRow(memberId)).toHaveLength(0);
  });

  it('removal leaves the budget rows of remaining members alone', async () => {
    const owner = await newUser();
    const removed = await newUser();
    const staying = await newUser();
    const id = await createConversation(owner);
    const removedId = await addFullHistory(owner, id, removed);
    const stayingId = await addFullHistory(owner, id, staying);
    await db.insert(memberBudgets).values({ memberId: removedId, budgetNanoUsd: 500n });
    await db.insert(memberBudgets).values({ memberId: stayingId, budgetNanoUsd: 700n });

    const res = await send(
      'POST',
      `/conversations/${id}/members/${removedId}/remove`,
      owner.cookie,
      { rotation: rotationFor(1, [owner.publicKey, staying.publicKey]) }
    );

    expect(res.status).toBe(200);
    expect(await budgetRow(removedId)).toHaveLength(0);
    expect(await budgetRow(stayingId)).toHaveLength(1);
  });

  it('a failed removal (stale epoch) deletes nothing — the row rides the same transaction', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    await db.insert(memberBudgets).values({ memberId, budgetNanoUsd: 500n });

    const res = await send(
      'POST',
      `/conversations/${id}/members/${memberId}/remove`,
      owner.cookie,
      {
        rotation: rotationFor(7, [owner.publicKey]),
      }
    );

    expect(res.status).toBe(409);
    expect(await budgetRow(memberId)).toHaveLength(1);
  });

  it('a voluntary leave also deletes the departing member’s budget row (same lifecycle seam)', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    await db.insert(memberBudgets).values({ memberId, budgetNanoUsd: 500n, spentNanoUsd: 42n });

    const res = await send('POST', `/conversations/${id}/leave`, member.cookie, {});

    expect(res.status).toBe(200);
    expect(await budgetRow(memberId)).toHaveLength(0);
  });
});
