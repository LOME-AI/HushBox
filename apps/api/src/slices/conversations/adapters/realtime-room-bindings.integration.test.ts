import { Redis } from '@upstash/redis';
import { Hono } from 'hono';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  sharedLinks,
  users,
} from '@hushbox/db';
import { sharedLinkFactory, userFactory } from '@hushbox/db/factories';
import { createConversationRoomClass } from '@hushbox/realtime';
import { DECLARED_CURSORS_PARAM, serializeStreamCursors } from '@hushbox/realtime/protocol';
import { LINK_CREDENTIAL_HEADER, UPGRADE_TICKET_PARAM } from '@hushbox/shared';
import { MINUTE_MS, freezeClock, setClock } from '@hushbox/shared/test-time';
import { applyPipeline } from '../../../middleware/pipeline.js';
import { createLinkResolutionAdapter } from '../../../composition/bindings/link-resolution.js';
import { REALTIME_REDIS_KEYS } from '../../../lib/redis/define-key.js';
import { createBillingStores } from '../../billing/index.js';
import { deleteForkMessagesWithinTx } from '../../chat/index.js';
import { createConversationsManifest } from '../routes.js';
import { createConversationsStores } from './stores.js';
import {
  MEMBERSHIP_STALE_AFTER_MS,
  createMembershipRevoker,
  membershipCacheKey,
} from './membership.js';
import { createPushMembershipReader } from './push-membership-reader.js';
import { createRealtimeBroadcast } from './realtime-do.js';
import {
  createRedisUserRoomTracker,
  createRoomBindings,
  openRoomSourceDb,
} from './realtime-room-bindings.js';
import { seedConversationWithEpoch } from '../../../test-support/conversation-seed.js';
import { mintLinkCredential } from '../../../test-support/link-credential.js';
import type { NeonDevConfig } from '@hushbox/db';
import type { BroadcastReceipt, RealtimeEvent } from '@hushbox/realtime';
import type { ServerFrame } from '@hushbox/realtime/protocol';
import type { CreateRoomRuntime } from './realtime-room-bindings.js';
import type { AppEnv, Bindings } from '../../../lib/context/index.js';
import type { ConversationRoomNamespace } from './realtime-do.js';

/**
 * A runtime factory double: this suite exercises the verifier the room
 * composes, not the injected runtime, so the executor/binder/referee are stubs
 * (the real runtime is wired by the app root, and needs no OPENROUTER key here).
 */
const fakeRuntime: CreateRoomRuntime = () => ({
  executor: {
    start: () => {
      throw new Error('unused in verifier tests');
    },
  },
  bindHooks: () => ({
    admission: () => Promise.resolve({ admitted: false, code: 'INTERNAL' }),
    settlement: () => Promise.resolve(),
    assistantMessageIds: [],
  }),
  claimRun: () => Promise.resolve({ outcome: 'attach' }),
  releaseHold: () => Promise.resolve(),
  heartbeat: () => Promise.resolve('alive'),
  failRun: () => Promise.resolve(),
});

// The realtime barrel transitively imports the workerd-only platform module;
// stubbed in node — the DO class itself is not under test, the composed
// verifier the room receives is.
vi.mock('cloudflare:workers', () => ({
  // Never instantiated here — the stub only satisfies `extends` at load time.
  DurableObject: class {
    constructor(protected readonly ctx: unknown) {}
  },
}));

const NODE_ENV = process.env['NODE_ENV'];
const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!NODE_ENV || !DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('NODE_ENV, DATABASE_URL and UPSTASH_REDIS_* are required for room binding tests');
}

const ENV: Bindings = {
  NODE_ENV,
  ...(process.env['CI'] === undefined ? {} : { CI: process.env['CI'] }),
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  TELEMETRY_SINKS: 'console',
};

/** The worker routes' bindings: the room's, plus the session secret the pipeline reads. */
const ROUTE_ENV: Bindings = { ...ENV, IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!' };

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];
const createdRedisKeys: string[] = [];

async function seedUser(): Promise<string> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@room-bindings.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey: crypto.getRandomValues(new Uint8Array(32)),
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  return userId;
}

async function seedMemberConversation(): Promise<{ userId: string; conversationId: string }> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userRows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@room-bindings.test`,
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
  await db.insert(conversationMembers).values({
    conversationId,
    userId,
    privilege: 'owner',
    visibleFromEpoch: 1,
    acceptedAt: new Date(),
  });
  createdRedisKeys.push(membershipCacheKey.buildKey(conversationId, userId));
  return { userId, conversationId };
}

afterAll(async () => {
  if (createdRedisKeys.length > 0) await redis.del(...createdRedisKeys);
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

/**
 * The dev branch configures the driver through the neon package's process-wide
 * static config rather than per-`Pool` options, so nothing on the returned
 * handle distinguishes the branches — what does is which configuration each one
 * leaves behind. Seeding an unreachable proxy first makes that observable: the
 * dev branch overwrites it with the local-proxy settings, the production branch
 * inherits whatever is already there.
 */
const UNREACHABLE_NEON_PROXY: NeonDevConfig = {
  ...LOCAL_NEON_DEV_CONFIG,
  wsProxy: () => '127.0.0.1:1/v1',
};

const applySharedDriverConfig = async (config: NeonDevConfig): Promise<void> => {
  const configured = createDb(DATABASE_URL, { neonDev: config });
  await configured.$client.end();
};

describe('openRoomSourceDb', () => {
  it('reaches the database through the local proxy in dev', async () => {
    await applySharedDriverConfig(UNREACHABLE_NEON_PROXY);
    const dev = openRoomSourceDb(DATABASE_URL, { isDev: true });
    try {
      await expect(dev.execute(sql`select 1`)).resolves.toBeDefined();
    } finally {
      await dev.$client.end();
      await applySharedDriverConfig(LOCAL_NEON_DEV_CONFIG);
    }
  });

  it('leaves the local-proxy configuration unapplied outside dev', async () => {
    await applySharedDriverConfig(UNREACHABLE_NEON_PROXY);
    const production = openRoomSourceDb(DATABASE_URL, { isDev: false });
    try {
      await expect(production.execute(sql`select 1`)).rejects.toThrow();
    } finally {
      await production.$client.end();
      await applySharedDriverConfig(LOCAL_NEON_DEV_CONFIG);
    }
  });
});

describe('user-room tracker (session-revocation eviction, ARCHITECTURE §Streaming & realtime)', () => {
  function trackerUserId(): string {
    const userId = `evict-${crypto.randomUUID()}`;
    createdRedisKeys.push(REALTIME_REDIS_KEYS.userActiveRooms.buildKey(userId));
    return userId;
  }

  it('SADDs the room and refreshes the 24h backstop TTL on track', async () => {
    const tracker = createRedisUserRoomTracker(redis);
    const userId = trackerUserId();
    await tracker.track(userId, 'conv-a');
    const key = REALTIME_REDIS_KEYS.userActiveRooms.buildKey(userId);
    expect(await redis.smembers(key)).toEqual(['conv-a']);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(REALTIME_REDIS_KEYS.userActiveRooms.ttlSeconds);
  });

  it('accumulates multiple rooms for one user', async () => {
    const tracker = createRedisUserRoomTracker(redis);
    const userId = trackerUserId();
    await tracker.track(userId, 'conv-a');
    await tracker.track(userId, 'conv-b');
    const members = await redis.smembers(REALTIME_REDIS_KEYS.userActiveRooms.buildKey(userId));
    expect([...members].toSorted((a, b) => a.localeCompare(b))).toEqual(['conv-a', 'conv-b']);
  });

  it('SREMs only the closed room on untrack, leaving the others', async () => {
    const tracker = createRedisUserRoomTracker(redis);
    const userId = trackerUserId();
    await tracker.track(userId, 'conv-a');
    await tracker.track(userId, 'conv-b');
    await tracker.untrack(userId, 'conv-a');
    expect(await redis.smembers(REALTIME_REDIS_KEYS.userActiveRooms.buildKey(userId))).toEqual([
      'conv-b',
    ]);
  });

  it('wires the Redis tracker into the DO bindings', async () => {
    const bindings = createRoomBindings(ENV, fakeRuntime);
    expect(bindings.userRooms).toBeDefined();
    const userId = trackerUserId();
    await bindings.userRooms?.track(userId, 'conv-wired');
    expect(await redis.smembers(REALTIME_REDIS_KEYS.userActiveRooms.buildKey(userId))).toEqual([
      'conv-wired',
    ]);
  });
});

describe('createPushMembershipReader', () => {
  it('returns active user members with mute, excluding left members', async () => {
    const { userId: owner, conversationId } = await seedMemberConversation();
    const mutedMember = await seedUser();
    const leftMember = await seedUser();
    await db.insert(conversationMembers).values([
      {
        conversationId,
        userId: mutedMember,
        privilege: 'write',
        visibleFromEpoch: 1,
        acceptedAt: new Date(),
        muted: true,
      },
      {
        conversationId,
        userId: leftMember,
        privilege: 'write',
        visibleFromEpoch: 1,
        acceptedAt: new Date(),
        leftAt: new Date(),
      },
    ]);

    const result = await createPushMembershipReader(db).listActiveUserMembers(conversationId);
    const members = result._unsafeUnwrap();

    expect(members).toContainEqual({ userId: owner, muted: false });
    expect(members).toContainEqual({ userId: mutedMember, muted: true });
    expect(members.map((member) => member.userId)).not.toContain(leftMember);
  });
});

describe('createRoomBindings verifier composition (the DO binding site)', () => {
  it('verifies an active member against the real cache and source', async () => {
    const { userId, conversationId } = await seedMemberConversation();
    const bindings = createRoomBindings(ENV, fakeRuntime);
    expect(await bindings.verifier.verify(conversationId, userId)).toBe('member');
  });

  it('answers revoked for a removed member after eviction invalidates the cache', async () => {
    const { userId, conversationId } = await seedMemberConversation();
    expect(await createRoomBindings(ENV, fakeRuntime).verifier.verify(conversationId, userId)).toBe(
      'member'
    );

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(inArray(conversationMembers.conversationId, [conversationId]));
    const invalidated = await createMembershipRevoker(redis).invalidate(conversationId, userId);
    invalidated._unsafeUnwrap();

    // A fresh DO instance (deploy/eviction) holds no in-memory memo; the
    // composed cache+source path must answer the authoritative revocation.
    expect(await createRoomBindings(ENV, fakeRuntime).verifier.verify(conversationId, userId)).toBe(
      'revoked'
    );
  });
});

/** The server half of a workerd socket pair, as far as the room shell touches it. */
class PlatformSocket {
  readonly sent: string[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  private attachment: unknown = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

/**
 * undici refuses to construct any status below 200, so the room's `101` is
 * built as a `204` and stamped afterwards; every other response is untouched.
 */
class SwitchingProtocolsResponse extends Response {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init?.status === 101 ? { ...init, status: 204 } : init);
    if (init?.status === 101) Object.defineProperty(this, 'status', { value: 101 });
  }
}

interface RoomPlatform {
  readonly state: DurableObjectState;
  readonly accepted: PlatformSocket[];
  /** Awaits every duty the room handed the platform's `waitUntil`. */
  settleDuties(): Promise<void>;
}

/**
 * The workerd surface the room shell reads, which node cannot construct: the
 * room is the real class over the real bindings, and only the platform around
 * it is stood in for here.
 */
function roomPlatform(conversationId: string): RoomPlatform {
  const storage = new Map<string, unknown>();
  const accepted: PlatformSocket[] = [];
  const duties: Promise<unknown>[] = [];
  vi.stubGlobal(
    'WebSocketPair',
    class {
      readonly 0 = new PlatformSocket();
      readonly 1 = new PlatformSocket();
    }
  );
  vi.stubGlobal(
    'WebSocketRequestResponsePair',
    class {
      constructor(
        readonly request: string,
        readonly response: string
      ) {}
    }
  );
  vi.stubGlobal('Response', SwitchingProtocolsResponse);
  const state = {
    id: { name: conversationId, toString: () => conversationId },
    storage: {
      get: (key: string): Promise<unknown> => Promise.resolve(storage.get(key)),
      put: (key: string, value: unknown): Promise<void> => {
        storage.set(key, value);
        return Promise.resolve();
      },
      setAlarm: (): Promise<void> => Promise.resolve(),
      deleteAlarm: (): Promise<void> => Promise.resolve(),
    },
    getWebSockets: (): PlatformSocket[] => [...accepted],
    acceptWebSocket: (socket: PlatformSocket): void => {
      accepted.push(socket);
    },
    setWebSocketAutoResponse: (): void => undefined,
    waitUntil: (promise: Promise<unknown>): void => {
      duties.push(promise);
    },
  };
  return {
    // A type assertion because `DurableObjectState` and the `WebSocket` its
    // socket list returns are workerd classes with no node constructor; the
    // room reads only the members built above.
    state: state as unknown as DurableObjectState,
    accepted,
    settleDuties: async (): Promise<void> => {
      await Promise.all(duties);
    },
  };
}

type Room = InstanceType<ReturnType<typeof createConversationRoomClass<Bindings>>>;

async function roomFetch(room: Room, request: Request): Promise<Response> {
  if (room.fetch === undefined) throw new Error('the room class serves no fetch');
  return room.fetch(request);
}

async function broadcastMessage(
  room: Room,
  conversationId: string,
  messageId: string
): Promise<BroadcastReceipt> {
  const event = {
    type: 'message:new',
    timestamp: Date.now(),
    messageId,
    conversationId,
    senderType: 'ai',
  } satisfies RealtimeEvent;
  const response = await roomFetch(
    room,
    new Request('https://room/broadcast', { method: 'POST', body: JSON.stringify(event) })
  );
  return response.json<BroadcastReceipt>();
}

function deliveredMessageIds(socket: PlatformSocket): string[] {
  return socket.sent
    .map((data) => JSON.parse(data) as ServerFrame)
    .flatMap((frame) =>
      frame.type === 'event' && frame.event.type === 'message:new' ? [frame.event.messageId] : []
    );
}

describe('a link guest socket open across its link lapsing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Opens a guest socket on a live link, proves a broadcast reaches it, then
   * lapses the link and broadcasts again once the membership cache has let go
   * of the old answer. Postgres judges expiry against its own clock, so the
   * lapse is a row update rather than a moved JS clock.
   */
  async function lapseUnderOpenSocket(): Promise<{
    guest: PlatformSocket;
    controlMessageId: string;
    afterLapseMessageId: string;
    afterLapseReceipt: BroadcastReceipt;
  }> {
    const { conversationId } = await seedMemberConversation();
    const linkRows = await db
      .insert(sharedLinks)
      .values(sharedLinkFactory.build({ conversationId }))
      .returning({ id: sharedLinks.id });
    const linkId = linkRows[0]?.id;
    if (linkId === undefined) throw new Error('shared link seed failed');
    await db.insert(conversationMembers).values({
      conversationId,
      linkId,
      privilege: 'read',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });
    const cacheKey = membershipCacheKey.buildKey(conversationId, linkId);
    createdRedisKeys.push(cacheKey);

    const openedAt = Date.now();
    freezeClock(openedAt, { toFake: ['Date'] });
    const platform = roomPlatform(conversationId);
    const ConversationRoom = createConversationRoomClass<Bindings>((env) =>
      createRoomBindings(env, fakeRuntime)
    );
    const room = new ConversationRoom(platform.state, ENV);
    const upgrade = await roomFetch(
      room,
      new Request(
        `https://room/websocket?principalId=${linkId}&conversationId=${conversationId}&isGuest=true`
      )
    );
    expect(upgrade.status).toBe(101);
    await platform.settleDuties();
    const guest = platform.accepted[0];
    if (guest === undefined) throw new Error('the room accepted no socket');

    const controlMessageId = crypto.randomUUID();
    await broadcastMessage(room, conversationId, controlMessageId);

    await db
      .update(sharedLinks)
      .set({ expiresAt: new Date(openedAt - MINUTE_MS) })
      .where(eq(sharedLinks.id, linkId));
    // The lapse invalidates nothing, so the cached answer stands until its
    // TTL: the delete stands in for that expiry, and the clock moves past the
    // room's in-memory reuse of the answer.
    await redis.del(cacheKey);
    setClock(openedAt + MEMBERSHIP_STALE_AFTER_MS);

    const afterLapseMessageId = crypto.randomUUID();
    const afterLapseReceipt = await broadcastMessage(room, conversationId, afterLapseMessageId);
    return { guest, controlMessageId, afterLapseMessageId, afterLapseReceipt };
  }

  it('delivers no frame broadcast after the link expires', async () => {
    const { guest, controlMessageId, afterLapseMessageId } = await lapseUnderOpenSocket();
    expect(deliveredMessageIds(guest)).toContain(controlMessageId);
    expect(deliveredMessageIds(guest)).not.toContain(afterLapseMessageId);
  });

  it('closes the socket through the non-member path once the link expires', async () => {
    const { guest, afterLapseReceipt } = await lapseUnderOpenSocket();
    expect(afterLapseReceipt).toEqual({ delivered: 0, paused: 0, evicted: 1 });
    expect(guest.closes).toEqual([{ code: 1008, reason: 'revoked' }]);
  });
});

describe('a link guest socket opened by a ticket minted before its link lapsed', () => {
  /**
   * Mints a guest's socket ticket on a live link, optionally lapses the link, then
   * upgrades through the worker route with that ticket. The route reaches the room
   * through the real realtime adapter, whose namespace here is this in-process room.
   */
  async function upgradeThroughTicket(options: { readonly lapse: boolean }): Promise<{
    upgradeStatus: number;
    accepted: readonly PlatformSocket[];
    messageId: string;
  }> {
    const { conversationId } = await seedMemberConversation();
    const credential = mintLinkCredential();
    const linkRows = await db
      .insert(sharedLinks)
      .values(
        sharedLinkFactory.build({
          conversationId,
          linkPublicKey: credential.linkPublicKey,
          linkAuthHash: credential.linkAuthHash,
        })
      )
      .returning({ id: sharedLinks.id });
    const linkId = linkRows[0]?.id;
    if (linkId === undefined) throw new Error('shared link seed failed');
    await db.insert(conversationMembers).values({
      conversationId,
      linkId,
      privilege: 'read',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });
    createdRedisKeys.push(membershipCacheKey.buildKey(conversationId, linkId));

    const platform = roomPlatform(conversationId);
    const ConversationRoom = createConversationRoomClass<Bindings>((env) =>
      createRoomBindings(env, fakeRuntime)
    );
    const room = new ConversationRoom(platform.state, ENV);
    const namespace: ConversationRoomNamespace = {
      idFromName: (name) => ({ toString: () => name }),
      get: () => ({ fetch: (input, init) => roomFetch(room, new Request(input, init)) }),
    };
    const app = applyPipeline(new Hono<AppEnv>());
    const manifest = createConversationsManifest({
      stores: createConversationsStores,
      billing: createBillingStores(),
      revoker: createMembershipRevoker,
      realtime: () => createRealtimeBroadcast(namespace),
      deleteForkMessages: (writer) => (id, ids) => deleteForkMessagesWithinTx(writer, id, ids),
      linkResolution: (writer) => createLinkResolutionAdapter(writer),
    });
    app.route(manifest.basePath, manifest.routes);

    const minted = await app.request(
      `/conversations/${conversationId}/websocket-ticket`,
      { method: 'POST', headers: { [LINK_CREDENTIAL_HEADER]: credential.token } },
      ROUTE_ENV
    );
    expect(minted.status).toBe(200);
    const { ticket } = await minted.json<{ ticket: string }>();

    if (options.lapse) {
      await db
        .update(sharedLinks)
        .set({ expiresAt: new Date(Date.now() - MINUTE_MS) })
        .where(eq(sharedLinks.id, linkId));
    }

    // A declared cursor sends the upgrade through the room's replay path too, so
    // the replay is held to the same membership check as live fan-out.
    const upgradeQuery = new URLSearchParams({
      [UPGRADE_TICKET_PARAM]: ticket,
      [DECLARED_CURSORS_PARAM]: serializeStreamCursors([
        { streamId: 's1', lastEventId: 0, runId: crypto.randomUUID() },
      ]),
    });
    const upgrade = await app.request(
      `/conversations/${conversationId}/websocket?${upgradeQuery.toString()}`,
      { method: 'GET', headers: { Origin: 'capacitor://localhost', Upgrade: 'websocket' } },
      ROUTE_ENV
    );
    await platform.settleDuties();
    const messageId = crypto.randomUUID();
    await broadcastMessage(room, conversationId, messageId);
    return { upgradeStatus: upgrade.status, accepted: platform.accepted, messageId };
  }

  it('delivers a frame to the guest while its link stays live', async () => {
    const { upgradeStatus, accepted, messageId } = await upgradeThroughTicket({ lapse: false });
    expect(upgradeStatus).toBe(101);
    expect(accepted.flatMap((socket) => deliveredMessageIds(socket))).toContain(messageId);
  });

  it('sends only ready once its link lapsed between the ticket and the upgrade', async () => {
    const { upgradeStatus, accepted } = await upgradeThroughTicket({ lapse: true });
    expect(upgradeStatus).toBe(101);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.sent.map((data) => JSON.parse(data) as ServerFrame)).toEqual([
      { type: 'ready' },
    ]);
  });

  it('closes the socket as revoked once its link lapsed between the ticket and the upgrade', async () => {
    const { upgradeStatus, accepted } = await upgradeThroughTicket({ lapse: true });
    expect(upgradeStatus).toBe(101);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.closes).toContainEqual({ code: 1008, reason: 'revoked' });
  });
});
