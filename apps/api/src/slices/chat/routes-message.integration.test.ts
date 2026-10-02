// POST /chat/:conversationId/message: the user-only persist path and its push side-band.
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { generateEpochKeyPair } from '@hushbox/crypto';
import { conversationMembers, deviceTokens, epochs, messages } from '@hushbox/db';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import { createBillingStores } from '../billing/index.js';
import { createConversationsStores } from '../conversations/index.js';
import { createLinkResolutionAdapter } from '../../composition/bindings/link-resolution.js';
import {
  createDeviceTokenStore,
  createMockPushSender,
  createNotificationPreferencesStore,
  notifyEvent,
} from '../notifications/index.js';
import { createChatManifest } from './index.js';
import { createChatStores } from './adapters/stores.js';
import {
  BYTES,
  STARTED,
  cookie,
  createdConversationIds,
  db,
  fakeRealtime,
  postPath,
  seedUser,
  testEnv,
} from '../../test-support/chat-routes.integration.setup.js';
import { seedConversationWithEpoch } from '../../test-support/conversation-seed.js';
import type { MembershipReader } from '../notifications/index.js';
import type { NotifyNewMessage } from './index.js';
import type { Telemetry } from '../../lib/telemetry/index.js';
import type { RealtimeBroadcast } from '../conversations/index.js';
import type { AppEnv } from '../../lib/context/index.js';

describe('chat route: POST /chat/:conversationId/message (user-only send)', () => {
  /** A conversation whose epoch key is REAL (the route wraps content to it). */
  async function seedMessageConversation(
    userId: string,
    options: { readonly member?: boolean; readonly privilege?: 'read' | 'write' } = {}
  ): Promise<string> {
    const { conversationId } = await seedConversationWithEpoch(db, {
      userId,
      title: BYTES,
      epochPublicKey: generateEpochKeyPair().publicKey,
    });
    createdConversationIds.push(conversationId);
    if (options.member !== false) {
      await db.insert(conversationMembers).values({
        conversationId,
        userId,
        visibleFromEpoch: 1,
        privilege: options.privilege ?? 'write',
      });
    }
    return conversationId;
  }

  /** Posts a user-only send; a fresh Idempotency-Key rides unless `headers` names one. */
  function postMessage(
    realtime: RealtimeBroadcast,
    conversationId: string,
    headers: Record<string, string>,
    body: unknown
  ): Promise<Response> {
    return postPath(
      `/chat/${conversationId}/message`,
      realtime,
      { 'Idempotency-Key': crypto.randomUUID(), ...headers },
      body
    );
  }

  /** The id a user-only response body names for the row it stored. */
  function messageIdOf(body: unknown): string {
    const messageId =
      typeof body === 'object' && body !== null && 'messageId' in body ? body.messageId : undefined;
    if (typeof messageId !== 'string') throw new Error('the response named no message id');
    return messageId;
  }

  it('rejects an anonymous request', async () => {
    const res = await postMessage(
      fakeRealtime(STARTED),
      crypto.randomUUID(),
      {},
      { content: 'hi' }
    );
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body with 400', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const res = await postMessage(
      fakeRealtime(STARTED),
      conversationId,
      { cookie: await cookie(userId) },
      { content: '' }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('refuses a body that names its own message id with 400, storing nothing', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const messageId = crypto.randomUUID();
    const res = await postMessage(
      fakeRealtime(STARTED),
      conversationId,
      { cookie: await cookie(userId) },
      { messageId, content: 'a client picks the id' }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
    expect(await db.select().from(messages).where(eq(messages.id, messageId))).toEqual([]);
  });

  it('requires an Idempotency-Key header', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const res = await postPath(
      `/chat/${conversationId}/message`,
      fakeRealtime(STARTED),
      { cookie: await cookie(userId) },
      { content: 'no key' }
    );
    expect(res.status).toBe(400);
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(rows).toEqual([]);
  });

  it('replays the same minted message id for a resend under the same key', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const sessionCookie = await cookie(userId);
    const key = crypto.randomUUID();
    const send = (): Promise<Response> =>
      postMessage(
        fakeRealtime(STARTED),
        conversationId,
        { cookie: sessionCookie, 'Idempotency-Key': key },
        { content: 'sent once, resent once' }
      );

    const firstSend = await send();
    expect(firstSend.status).toBe(200);
    const firstBody: unknown = await firstSend.json();
    const resend = await send();
    expect(resend.status).toBe(200);
    expect(await resend.json()).toEqual(firstBody);
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(rows).toHaveLength(1);
  });

  it('refuses a reused key carrying a different body with 409', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const sessionCookie = await cookie(userId);
    const key = crypto.randomUUID();
    const first = await postMessage(
      fakeRealtime(STARTED),
      conversationId,
      { cookie: sessionCookie, 'Idempotency-Key': key },
      { content: 'the first body' }
    );
    expect(first.status).toBe(200);
    const reused = await postMessage(
      fakeRealtime(STARTED),
      conversationId,
      { cookie: sessionCookie, 'Idempotency-Key': key },
      { content: 'a different body' }
    );
    expect(reused.status).toBe(409);
    expect(await reused.json()).toEqual({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
  });

  it('refuses a non-member with 403', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId, { member: false });
    const res = await postMessage(
      fakeRealtime(STARTED),
      conversationId,
      { cookie: await cookie(userId) },
      { content: 'hi' }
    );
    expect(res.status).toBe(403);
  });

  it('refuses a read-only member with 403', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId, { privilege: 'read' });
    const res = await postMessage(
      fakeRealtime(STARTED),
      conversationId,
      { cookie: await cookie(userId) },
      { content: 'hi' }
    );
    expect(res.status).toBe(403);
  });

  it('persists under a server-minted id and broadcasts message:new post-commit', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const broadcasts: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      broadcast: (targetId, event) => {
        broadcasts.push({ targetId, event });
        return okAsync({ delivered: 1, paused: 0, evicted: 0 });
      },
    });

    const res = await postMessage(
      realtime,
      conversationId,
      { cookie: await cookie(userId) },
      { content: 'group message, ai off' }
    );

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ messageId: expect.any(String), sequenceNumber: 1, epochNumber: 1 });
    const messageId = messageIdOf(body);
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.senderType).toBe('user');
    expect(rows[0]?.senderId).toBe(userId);
    expect(broadcasts).toEqual([
      {
        targetId: conversationId,
        event: expect.objectContaining({
          type: 'message:new',
          messageId,
          conversationId,
          senderType: 'user',
          senderId: userId,
          sequenceNumber: 1,
        }),
      },
    ]);
  });

  it('still answers 200 when the broadcast fails (best-effort, already committed)', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const realtime = fakeRealtime(STARTED, {
      broadcast: () => errAsync(unavailableError('room unreachable')),
    });

    const res = await postMessage(
      realtime,
      conversationId,
      { cookie: await cookie(userId) },
      { content: 'commit survives broadcast failure' }
    );

    expect(res.status).toBe(200);
    const messageId = messageIdOf(await res.json());
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(1);
  });

  it('honors injected chatStores and epoch reader (manifest composer pass-through)', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const readerCalls: number[] = [];
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: createBillingStores(),
      realtime: () => fakeRealtime(STARTED),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
      chatStores: createChatStores(),
      readEpochPublicKey: async (tx, targetConversation, epochNumber) => {
        readerCalls.push(epochNumber);
        const rows = await tx
          .select({ key: epochs.epochPublicKey })
          .from(epochs)
          .where(eq(epochs.conversationId, targetConversation));
        return rows[0]?.key ?? null;
      },
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);

    const res = await app.request(
      `/chat/${conversationId}/message`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await cookie(userId),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ content: 'through injected deps' }),
      },
      testEnv
    );
    expect(res.status).toBe(200);
    expect(readerCalls).toEqual([1]);
  });

  it('maps a domain write failure through the slice error map (503)', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: createBillingStores(),
      realtime: () => fakeRealtime(STARTED),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
      // A missing wrap key is the defect arm: the write fails unavailable.
      readEpochPublicKey: () => Promise.resolve(null),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);

    const res = await app.request(
      `/chat/${conversationId}/message`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await cookie(userId),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ content: 'will fail' }),
      },
      testEnv
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });

  it('refuses a caller on a nonexistent conversation with 403 (member gate answers first)', async () => {
    const userId = await seedUser();
    const res = await postMessage(
      fakeRealtime(STARTED),
      crypto.randomUUID(),
      { cookie: await cookie(userId) },
      { content: 'nowhere' }
    );
    expect(res.status).toBe(403);
  });

  // The post-commit push side-band: the runless send historically fired NO push
  // (unlike the AI turn). These exercise the wired capability — its arguments,
  // its suppression, and its strict best-effort isolation from the response.

  /**
   * A collecting ExecutionContext. The route registers its push as a side-band;
   * what this collects is the pipeline teardown that drains those side-bands, so
   * awaiting the collected tasks awaits the push.
   */
  function collectingCtx(): { ctx: ExecutionContext; settled: () => Promise<void> } {
    const tasks: Promise<unknown>[] = [];
    const ctx: ExecutionContext = {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
      passThroughOnException: () => {
        /* no-op in tests */
      },
      props: {},
    };
    return {
      ctx,
      settled: async () => {
        await Promise.all(tasks);
      },
    };
  }

  /** A noop telemetry for the composed test notify (only `.warn` is ever reached). */
  function noopTelemetry(): Telemetry {
    const noop = (): void => undefined;
    return {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      captureError: noop,
    } as unknown as Telemetry;
  }

  /** Mounts the user-only route with an injected push capability (factory ignores env/db). */
  function appWithNotify(realtime: RealtimeBroadcast, notify: NotifyNewMessage): Hono<AppEnv> {
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: createBillingStores(),
      realtime: () => realtime,
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
      notifyNewMessage: () => notify,
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  async function postMessageNotify(args: {
    app: Hono<AppEnv>;
    conversationId: string;
    userId: string;
    body: unknown;
    ctx: ExecutionContext;
    idempotencyKey?: string;
  }): Promise<Response> {
    return args.app.request(
      `/chat/${args.conversationId}/message`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await cookie(args.userId),
          'Idempotency-Key': args.idempotencyKey ?? crypto.randomUUID(),
        },
        body: JSON.stringify(args.body),
      },
      testEnv,
      args.ctx
    );
  }

  it('fires the push side-band with the sender and the live-presence snapshot', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const presentId = crypto.randomUUID();
    const calls: {
      conversationId: string;
      senderUserId: string;
      presentUserIds: readonly string[];
    }[] = [];
    const notify: NotifyNewMessage = (args) => {
      calls.push(args);
      return Promise.resolve();
    };
    const realtime = fakeRealtime(STARTED, { presence: () => okAsync([presentId]) });
    const { ctx, settled } = collectingCtx();

    const res = await postMessageNotify({
      app: appWithNotify(realtime, notify),
      conversationId,
      userId,
      body: { content: 'ai off, notify the room' },
      ctx,
    });
    expect(res.status).toBe(200);
    await settled();

    // The sender is the poster and the present set is the live DO snapshot —
    // both handed straight to the capability (suppression happens downstream).
    expect(calls).toEqual([{ conversationId, senderUserId: userId, presentUserIds: [presentId] }]);
  });

  it('pushes only the absent, non-muted member — present, muted, and sender suppressed', async () => {
    const sender = await seedUser();
    const conversationId = await seedMessageConversation(sender);
    const absent = await seedUser();
    const present = await seedUser();
    const muted = await seedUser();
    await db.insert(deviceTokens).values([
      { userId: sender, token: `tok-${crypto.randomUUID()}`, platform: 'ios' },
      { userId: absent, token: `tok-absent-${crypto.randomUUID()}`, platform: 'ios' },
      { userId: present, token: `tok-${crypto.randomUUID()}`, platform: 'ios' },
      { userId: muted, token: `tok-${crypto.randomUUID()}`, platform: 'ios' },
    ]);
    const absentTokenRows = await db
      .select({ token: deviceTokens.token })
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, absent));
    const absentToken = absentTokenRows[0]?.token;

    const mockPush = createMockPushSender();
    // The route hands the capability the sender + presence; this stand-in runs
    // the real recipient selection + device-token read over the DO's exact
    // suppression rules (mute / presence / sender), observing what it sends.
    const members = [
      { userId: sender, muted: false },
      { userId: absent, muted: false },
      { userId: present, muted: false },
      { userId: muted, muted: true },
    ];
    const membership: MembershipReader = { listActiveUserMembers: () => okAsync(members) };
    const notify: NotifyNewMessage = ({ conversationId: cid, senderUserId, presentUserIds }) =>
      notifyEvent(
        {
          membership,
          preferences: createNotificationPreferencesStore(db),
          deviceTokens: createDeviceTokenStore(db),
          push: mockPush,
          logger: noopTelemetry(),
        },
        {
          category: 'message',
          conversationId: cid,
          actorUserId: senderUserId,
          presentUserIds,
        }
      ).match(
        () => {
          /* delivered — best-effort */
        },
        () => {
          /* logged already — best-effort */
        }
      );
    const realtime = fakeRealtime(STARTED, { presence: () => okAsync([present]) });
    const { ctx, settled } = collectingCtx();

    const res = await postMessageNotify({
      app: appWithNotify(realtime, notify),
      conversationId,
      userId: sender,
      body: { content: 'only the absent member is pushed' },
      ctx,
    });
    expect(res.status).toBe(200);
    await settled();

    const sent = mockPush.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(
      sent[0]?.recipients.map((recipient) =>
        recipient.platform === 'web' ? recipient.endpoint : recipient.token
      )
    ).toEqual([absentToken]);
  });

  it('still answers 200 and commits when the push capability rejects', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const notify: NotifyNewMessage = () => Promise.reject(new Error('push subsystem down'));
    const { ctx, settled } = collectingCtx();

    const res = await postMessageNotify({
      app: appWithNotify(fakeRealtime(STARTED), notify),
      conversationId,
      userId,
      body: { content: 'push blows up but the send stands' },
      ctx,
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ messageId: expect.any(String), sequenceNumber: 1, epochNumber: 1 });
    const messageId = messageIdOf(body);
    await settled();
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(1);
  });

  it('neither pushes nor broadcasts on a replayed resend, only on the committed save', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    let calls = 0;
    const notify: NotifyNewMessage = () => {
      calls += 1;
      return Promise.resolve();
    };
    const broadcasts: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      broadcast: (targetId, event) => {
        broadcasts.push({ targetId, event });
        return okAsync({ delivered: 1, paused: 0, evicted: 0 });
      },
    });
    const app = appWithNotify(realtime, notify);
    const body = { content: 'same message twice' };
    const idempotencyKey = crypto.randomUUID();

    const first = collectingCtx();
    const firstRes = await postMessageNotify({
      app,
      conversationId,
      userId,
      body,
      ctx: first.ctx,
      idempotencyKey,
    });
    expect(firstRes.status).toBe(200);
    await first.settled();

    const second = collectingCtx();
    const replay = await postMessageNotify({
      app,
      conversationId,
      userId,
      body,
      ctx: second.ctx,
      idempotencyKey,
    });
    expect(replay.status).toBe(200);
    await second.settled();

    expect(calls).toBe(1);
    expect(broadcasts).toHaveLength(1);
  });

  it('still answers 200 and commits when the push FACTORY throws synchronously', async () => {
    // The factory (createPushSenderFromEnv, run at notifyFactory(env, db)) throws
    // synchronously on a misconfigured deploy. That construction must sit inside the
    // best-effort guard, or the throw escapes onto the request path after commit +
    // broadcast and turns the 200 into a 500 — violating the best-effort guarantee.
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const broadcasts: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      broadcast: (targetId, event) => {
        broadcasts.push({ targetId, event });
        return okAsync({ delivered: 1, paused: 0, evicted: 0 });
      },
    });
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: createBillingStores(),
      realtime: () => realtime,
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
      notifyNewMessage: () => {
        throw new Error('FCM config missing');
      },
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const { ctx, settled } = collectingCtx();

    const res = await postMessageNotify({
      app,
      conversationId,
      userId,
      body: { content: 'factory blows up but the send stands' },
      ctx,
    });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({ messageId: expect.any(String), sequenceNumber: 1, epochNumber: 1 });
    const messageId = messageIdOf(body);
    await settled();
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
  });

  it('serves a push side-band that queries the request pool after the response', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    let releasePush = (): void => {
      throw new Error('gate not installed');
    };
    const gate = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    const outcome: { failure: string | undefined } = { failure: undefined };
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: createBillingStores(),
      realtime: () => fakeRealtime(STARTED, { presence: () => okAsync([]) }),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
      // The real capability reads membership and device tokens off the request
      // db; this stands in for those reads at a moment the test controls.
      notifyNewMessage: (_env, requestDb) => async () => {
        await gate;
        try {
          await requestDb.execute(sql`select 1`);
          // eslint-disable-next-line catch-swallow/no-silent-catch -- the throw IS the assertion subject: it is recorded into `outcome.failure` and read after the side-band task settles
        } catch (error) {
          outcome.failure = error instanceof Error ? error.message : String(error);
        }
      },
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const { ctx, settled } = collectingCtx();

    const res = await postMessageNotify({
      app,
      conversationId,
      userId,
      body: { content: 'push outlives the response' },
      ctx,
    });
    expect(res.status).toBe(200);
    releasePush();
    await settled();

    expect(outcome.failure).toBeUndefined();
  });

  it('builds the push side-band over the telemetry the request composed', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    let requestLogger: Telemetry | undefined;
    const sideBandTelemetry: Telemetry[] = [];
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: createBillingStores(),
      realtime: () => fakeRealtime(STARTED, { presence: () => okAsync([]) }),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
      notifyNewMessage: (_env, _db, telemetry) => {
        sideBandTelemetry.push(telemetry);
        return () => Promise.resolve();
      },
    });
    const app = applyPipeline(new Hono<AppEnv>());
    // Registered after the pipeline, so it reads the telemetry the pipeline
    // composed for this request — the object the side-band must be handed.
    app.use('*', async (c, next) => {
      requestLogger = c.var.logger;
      await next();
    });
    app.route(manifest.basePath, manifest.routes);
    const { ctx, settled } = collectingCtx();

    const res = await postMessageNotify({
      app,
      conversationId,
      userId,
      body: { content: 'the side-band reports somewhere' },
      ctx,
    });
    expect(res.status).toBe(200);
    await settled();

    expect(requestLogger).toBeDefined();
    // Identity, not shape: a console sink minted inside the capability answers
    // every Telemetry call the same way and is retained nowhere.
    expect(sideBandTelemetry).toEqual([requestLogger]);
  });

  it('skips the push and still answers 200 when presence is unavailable', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    let calls = 0;
    const notify: NotifyNewMessage = () => {
      calls += 1;
      return Promise.resolve();
    };
    const realtime = fakeRealtime(STARTED, {
      presence: () => errAsync(unavailableError('room unreachable')),
    });
    const { ctx, settled } = collectingCtx();

    const res = await postMessageNotify({
      app: appWithNotify(realtime, notify),
      conversationId,
      userId,
      body: { content: 'presence down, no push' },
      ctx,
    });
    expect(res.status).toBe(200);
    await settled();
    expect(calls).toBe(0);
  });
});
