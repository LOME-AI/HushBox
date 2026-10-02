import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  accountDeletionEvents,
  contentItems,
  conversationMembers,
  createDb,
  jobs,
  messages,
  termsAcceptances,
  users,
} from '@hushbox/db';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishLogin as opaqueClientFinishLogin,
  finishRegistration as opaqueClientFinishRegistration,
  generateAccountKeyPair,
  rewrapAccountKeyForPasswordChange,
  startLogin as opaqueClientStartLogin,
  startRegistration as opaqueClientStartRegistration,
} from '@hushbox/crypto';
import {
  DELETE_ACCOUNT_CONFIRMATION_PHRASE,
  TERMS_OF_SERVICE_REVISION,
  toBase64,
} from '@hushbox/shared';
import { createApp } from '../app.js';
import { SESSION_COOKIE_NAME } from '../lib/context/index.js';
import { WELCOME_CREDIT_NANO_USD } from '../slices/billing/index.js';
import { MEDIA_RECLAIM_USER_JOB_TYPE } from '../slices/media/index.js';
import { seedConversationWithEpoch } from '../test-support/conversation-seed.js';
import type { ExecutionContext } from 'hono';
import type { Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

// Registration grants the welcome credit into the purchased wallet, so a deletion
// here acknowledges that amount as forfeited.
const ACKNOWLEDGED_FORFEIT = WELCOME_CREDIT_NANO_USD.toString();

// `res.json()` is typed `unknown` by the typechecker but already-typed by the
// lint program, so an inline assertion is simultaneously required (typecheck)
// and flagged as redundant (lint). Reading through a generic seam satisfies
// both: the cast to a free type parameter is not a lint no-op.
async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`app deletion tests: missing ${name}. Run via the package test script.`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');

/**
 * The real composition root wires identity's deletion dep (`deletionPurge`) —
 * this suite drives the full OPAQUE step-up deletion through `createApp()` so
 * that closure executes against real slices. The R2_* env is required because
 * the purge closure constructs the real R2 storage binding (offline —
 * aws4fetch signs lazily, no network at build).
 */
const devEnv: Bindings &
  TelemetryEnv & {
    FRONTEND_URL: string;
    MARKETING_URL: string;
    FRONTEND_PREVIEW_URL: string;
    R2_S3_ENDPOINT: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
    R2_BUCKET_MEDIA: string;
  } = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  OPAQUE_KEK: requiredEnv('OPAQUE_KEK'),
  TOTP_ENCRYPTION_SECRET: requiredEnv('TOTP_ENCRYPTION_SECRET'),
  ENUMERATION_DECOY_SECRET: requiredEnv('ENUMERATION_DECOY_SECRET'),
  TELEMETRY_SINKS: 'console',
  FRONTEND_URL: 'http://localhost:5173',
  MARKETING_URL: requiredEnv('MARKETING_URL'),
  FRONTEND_PREVIEW_URL: requiredEnv('FRONTEND_PREVIEW_URL'),
  R2_S3_ENDPOINT: requiredEnv('R2_S3_ENDPOINT'),
  R2_ACCESS_KEY_ID: requiredEnv('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: requiredEnv('R2_SECRET_ACCESS_KEY'),
  R2_BUCKET_MEDIA: requiredEnv('R2_BUCKET_MEDIA'),
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const app = createApp();

const PREFIX = `appdel${crypto.randomUUID().slice(0, 6)}`;
// Unique per-run IP so the register/login edge IP limiters never trip across
// repeated local runs (Redis windows persist between suite executions).
const RUN_IP = `198.51.100.${String(Math.floor(Math.random() * 200) + 1)}`;

let accountCounter = 0;
function uniqueAccount(): { email: string; username: string; password: string } {
  accountCounter += 1;
  const tag = `${PREFIX}${String(accountCounter)}`;
  return { email: `${tag}@app-deletion.test`, username: tag, password: 'correct horse battery' };
}

/** Real key material: register-finish refuses blobs that are not key-shaped. */
const accountKeyPair = generateAccountKeyPair();
const KEY_BLOBS = {
  accountPublicKey: toBase64(accountKeyPair.publicKey),
  passwordWrappedPrivateKey: toBase64(
    rewrapAccountKeyForPasswordChange(accountKeyPair.privateKey, new Uint8Array(32).fill(8))
  ),
  recoveryWrappedPrivateKey: toBase64(
    rewrapAccountKeyForPasswordChange(accountKeyPair.privateKey, new Uint8Array(32).fill(9))
  ),
  recoveryPublicKey: toBase64(generateAccountKeyPair().publicKey),
};

function recordingExecutionCtx(): { ctx: ExecutionContext; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      tasks.push(promise);
    },
    passThroughOnException: () => {},
  } as ExecutionContext;
  return { ctx, tasks };
}

/**
 * `devEnv` plus a dispatcher namespace that records the shard each wake
 * addressed, so a test reads the nudges the pipeline's post-response
 * discharge actually issued rather than the shards a collector held.
 */
function recordingDispatcherEnv(): {
  env: Bindings & TelemetryEnv;
  wokenShards: string[];
} {
  const wokenShards: string[] = [];
  const env = {
    ...devEnv,
    JOB_DISPATCHER: {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({
        fetch: (): Promise<Response> => {
          wokenShards.push(String(id));
          return Promise.resolve(new Response(null));
        },
      }),
    },
  } as Bindings & TelemetryEnv;
  return { env, wokenShards };
}

interface PostOptions {
  readonly env?: Bindings & TelemetryEnv;
  readonly cookie?: string;
  readonly ctx?: ExecutionContext;
}

async function post(path: string, body: unknown, options: PostOptions = {}): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': RUN_IP,
        'user-agent': PREFIX,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      },
      body: JSON.stringify(body),
    },
    options.env ?? devEnv,
    options.ctx
  );
}

/** Register + verify + login through the real app; returns the session cookie. */
async function registerLoginFull(): Promise<{
  account: { email: string; username: string; password: string };
  userId: string;
  cookie: string;
}> {
  const account = uniqueAccount();
  const { ctx } = recordingExecutionCtx();

  const registerClient = createOpaqueClient();
  const { serialized } = await opaqueClientStartRegistration(registerClient, account.password);
  const init = await post(
    '/auth/register/init',
    { email: account.email, username: account.username, registrationRequest: serialized },
    { ctx }
  );
  expect(init.status).toBe(200);
  const initBody = await jsonBody<{
    registrationResponse: number[];
    registerSessionId: string;
  }>(init);
  const { record } = await opaqueClientFinishRegistration(
    registerClient,
    initBody.registrationResponse,
    OPAQUE_SERVER_IDENTIFIER
  );
  const finish = await post(
    '/auth/register/finish',
    {
      email: account.email,
      registrationRecord: record,
      registerSessionId: initBody.registerSessionId,
      ...KEY_BLOBS,
      acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
    },
    { ctx }
  );
  expect(finish.status).toBe(201);
  const created = await jsonBody<{ userId: string }>(finish);

  // Model the verification-link click-through (login is gated on it).
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, created.userId));

  const loginClient = createOpaqueClient();
  const { ke1 } = await opaqueClientStartLogin(loginClient, account.password);
  const loginInit = await post('/auth/login/init', { identifier: account.email, ke1 }, { ctx });
  expect(loginInit.status).toBe(200);
  const loginBody = await jsonBody<{ ke2: number[]; loginSessionId: string }>(loginInit);
  const { ke3 } = await opaqueClientFinishLogin(
    loginClient,
    loginBody.ke2,
    OPAQUE_SERVER_IDENTIFIER
  );
  const loginFinish = await post(
    '/auth/login/finish',
    { identifier: account.email, ke3, loginSessionId: loginBody.loginSessionId },
    { ctx }
  );
  expect(loginFinish.status).toBe(200);
  const header = loginFinish.headers.get('set-cookie') ?? '';
  const value = header.split(`${SESSION_COOKIE_NAME}=`)[1]?.split(';')[0] ?? '';
  return { account, userId: created.userId, cookie: `${SESSION_COOKIE_NAME}=${value}` };
}

/** The OPAQUE deletion step-up: init → client finish → the finish-call ke3. */
async function deletionKe3(
  cookie: string,
  password: string
): Promise<{ ke3: number[]; sessionId: string }> {
  const client = createOpaqueClient();
  const { ke1 } = await opaqueClientStartLogin(client, password);
  const res = await post('/auth/account/delete/init', { ke1 }, { cookie });
  expect(res.status).toBe(200);
  const body = await jsonBody<{ ke2: number[]; deleteAccountSessionId: string }>(res);
  const { ke3 } = await opaqueClientFinishLogin(client, body.ke2, OPAQUE_SERVER_IDENTIFIER);
  return { ke3, sessionId: body.deleteAccountSessionId };
}

/** Seeds an owned conversation carrying one media content item. */
async function seedOwnedMedia(userId: string): Promise<{ storageKey: string }> {
  const conversation = await seedConversationWithEpoch(db, {
    userId,
    title: new Uint8Array([1]),
    epochPublicKey: new Uint8Array([1]),
    confirmationHash: new Uint8Array([1]),
  });
  await db
    .insert(conversationMembers)
    .values({ conversationId: conversation.conversationId, userId, visibleFromEpoch: 1 });
  const [message] = await db
    .insert(messages)
    .values({
      conversationId: conversation.conversationId,
      senderType: 'user',
      senderId: userId,
      wrappedContentKey: new Uint8Array([1]),
      epochNumber: 1,
      sequenceNumber: 1,
    })
    .returning({ id: messages.id });
  if (!message) throw new Error('message seed failed');
  const storageKey = `media/${conversation.conversationId}/${message.id}/${crypto.randomUUID()}`;
  await db.insert(contentItems).values({
    messageId: message.id,
    contentType: 'image',
    storageKey,
    mimeType: 'image/png',
    sizeBytes: 3,
  });
  return { storageKey };
}

async function deleteReclaimJobs(userId: string): Promise<void> {
  await db
    .delete(jobs)
    .where(
      and(eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE), sql`${jobs.payload} ->> 'userId' = ${userId}`)
    );
}

afterAll(async () => {
  // Deleted accounts remove their own rows; the run-unique userAgent marker is
  // the only handle on the anonymous deletion events.
  await db.delete(accountDeletionEvents).where(eq(accountDeletionEvents.userAgent, PREFIX));
  await db.$client.end();
});

describe('composed app: account deletion through the real composition root', () => {
  it('purges a media-owning account and enqueues the bulk reclaim job via the real purge closure', async () => {
    const { account, userId, cookie } = await registerLoginFull();
    const { storageKey } = await seedOwnedMedia(userId);
    const stepUp = await deletionKe3(cookie, account.password);
    const { ctx, tasks } = recordingExecutionCtx();

    // devEnv carries no JOB_DISPATCHER: the pipeline boundary still discharges
    // what the enqueue collected, and `createDispatcherWake` takes its
    // absent-binding no-op (the delivery guarantee stays the dispatcher's
    // perpetual alarm).
    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: stepUp.ke3,
        deleteAccountSessionId: stepUp.sessionId,
        acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      { cookie, ctx }
    );
    expect(finish.status).toBe(200);
    await Promise.all(tasks);

    expect(await db.select().from(users).where(eq(users.id, userId))).toHaveLength(0);
    const jobRows = await db
      .select({ shard: jobs.shard, payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${userId}`
        )
      );
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]?.shard).toBe('bulk');
    expect((jobRows[0]?.payload as { storageKeys: string[] }).storageKeys).toEqual([storageKey]);
    // A committed pending bulk row must not linger where a concurrent
    // jobs-suite bulk pass could claim it.
    await deleteReclaimJobs(userId);
  });

  it('wakes the bulk dispatcher through the bound namespace after a deletion that reclaims media', async () => {
    const { account, userId, cookie } = await registerLoginFull();
    // Media, because the wake now rides the reclaim ENQUEUE rather than the
    // deletion: an account with nothing to reclaim enqueues nothing, so there
    // is no shard for the boundary to nudge.
    await seedOwnedMedia(userId);
    const stepUp = await deletionKe3(cookie, account.password);
    const { ctx, tasks } = recordingExecutionCtx();
    const { env: dispatcherEnv, wokenShards } = recordingDispatcherEnv();

    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: stepUp.ke3,
        deleteAccountSessionId: stepUp.sessionId,
        acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      { env: dispatcherEnv, cookie, ctx }
    );
    expect(finish.status).toBe(200);
    await Promise.all(tasks);

    expect(await db.select().from(users).where(eq(users.id, userId))).toHaveLength(0);
    expect(wokenShards).toEqual(['bulk']);
    await deleteReclaimJobs(userId);
  });

  it('nudges no dispatcher when the deleted account owned nothing to reclaim', async () => {
    const { account, userId, cookie } = await registerLoginFull();
    // No media seeded: the purge closure finds no storage keys, so it enqueues
    // no reclaim row. The wake rides that enqueue, so a deletion with nothing
    // to reclaim leaves no shard behind — deletion itself never nudges.
    const stepUp = await deletionKe3(cookie, account.password);
    const { ctx, tasks } = recordingExecutionCtx();
    const { env: dispatcherEnv, wokenShards } = recordingDispatcherEnv();

    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: stepUp.ke3,
        deleteAccountSessionId: stepUp.sessionId,
        acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      { env: dispatcherEnv, cookie, ctx }
    );
    expect(finish.status).toBe(200);
    await Promise.all(tasks);

    expect(await db.select().from(users).where(eq(users.id, userId))).toHaveLength(0);
    expect(wokenShards).toEqual([]);
    // The reason, asserted rather than assumed: no reclaim row means no shard.
    const reclaimRows = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${userId}`
        )
      );
    expect(reclaimRows).toHaveLength(0);
  });

  it('removes the Terms acceptance the account recorded at registration', async () => {
    const { account, userId, cookie } = await registerLoginFull();
    const acceptancesOf = (): Promise<{ id: string }[]> =>
      db
        .select({ id: termsAcceptances.id })
        .from(termsAcceptances)
        .where(eq(termsAcceptances.userId, userId));
    expect(await acceptancesOf()).toHaveLength(1);
    const stepUp = await deletionKe3(cookie, account.password);
    const { ctx, tasks } = recordingExecutionCtx();

    const finish = await post(
      '/auth/account/delete/finish',
      {
        ke3: stepUp.ke3,
        deleteAccountSessionId: stepUp.sessionId,
        acknowledgedForfeitNanoUsd: ACKNOWLEDGED_FORFEIT,
        confirmationPhrase: DELETE_ACCOUNT_CONFIRMATION_PHRASE,
      },
      { cookie, ctx }
    );
    expect(finish.status).toBe(200);
    await Promise.all(tasks);

    expect(await acceptancesOf()).toEqual([]);
  });
});
