import { afterAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { eq, inArray, like } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  jobs,
  ledgerEntries,
  payments,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { ERROR_CODES } from '@hushbox/shared';
import { okAsync } from '../../lib/result/index.js';
import { createJobRegistry } from '../../lib/jobs/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { createPaymentVerifyJobRegistration, createWebhookVerifier } from './domain/index.js';
import { createConversationFundingReader } from '../../composition/bindings/conversation-funding.js';
import { createMockPaymentProvider } from './adapters/payment-mock.js';
import { createHelcimPaymentProvider } from './adapters/payment-helcim.js';
import { createFixtureFetch } from './adapters/payment-helcim-fixtures.js';
import { createBillingManifest, createBillingStores } from './index.js';
import { createSessionRevokeJobRegistration } from '../identity/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { MockPaymentProvider } from './adapters/payment-mock.js';
import type { PaymentMockDirectives, PaymentProvider } from './ports/index.js';
import type { BillingRouteDeps } from './routes.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for billing route integration tests'
  );
}

const SECRET = 'secret-at-least-32-characters-long!!';
const WEBHOOK_VERIFIER = 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=';
const RELEASE_PATH = '/billing/mock/release-webhook';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
  JOB_DISPATCHER: {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (): Promise<unknown> => Promise.resolve(new Response(null, { status: 200 })),
    }),
  },
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const username = `blhw${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@billing-held-webhook.test`,
        username,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
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

async function sessionCookie(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      userId,
      sessionId: 'session-1',
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

interface HeldWebhookApp {
  readonly app: Hono<AppEnv>;
  /** Every provider the charge and release routes asked for, in request order. */
  readonly providers: MockPaymentProvider[];
  /** The mock directives each provider request carried, in request order. */
  readonly directives: (PaymentMockDirectives | undefined)[];
}

/**
 * The billing manifest with a per-request mock provider built from the
 * request's directives, as the composition root builds one, whose signed
 * webhooks land on this same app.
 */
function buildApp(overrides: Partial<BillingRouteDeps> = {}): HeldWebhookApp {
  const appHolder: { app?: Hono<AppEnv> } = {};
  const providers: MockPaymentProvider[] = [];
  const directives: (PaymentMockDirectives | undefined)[] = [];
  const paymentProvider = (
    _env: Bindings,
    _db: unknown,
    _lifetime: unknown,
    mockDirectives?: PaymentMockDirectives
  ): PaymentProvider => {
    directives.push(mockDirectives);
    const provider = createMockPaymentProvider({
      webhookUrl: 'http://localhost/billing/webhooks/payment',
      webhookVerifier: WEBHOOK_VERIFIER,
      webhookDelayMs: 0,
      holdWebhook: mockDirectives?.holdWebhook === true,
      fetchImpl: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (appHolder.app === undefined) {
          return Promise.reject(new Error('webhook delivered before the app was built'));
        }
        return Promise.resolve(appHolder.app.request(url.pathname, init, testEnv));
      },
    });
    providers.push(provider);
    return provider;
  };
  const registry = createJobRegistry();
  registry.register(
    createPaymentVerifyJobRegistration({
      db,
      stores,
      resolveProvider: () => createHelcimPaymentProvider({ apiToken: 'unused' }),
    })
  );
  registry.register(
    createSessionRevokeJobRegistration({
      resolveRevoke: () => ({
        redis: new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false }),
      }),
    })
  );
  const deps: BillingRouteDeps = {
    stores,
    conversationFunding: createConversationFundingReader,
    paymentProvider,
    webhookVerifier: () => createWebhookVerifier({ verifier: WEBHOOK_VERIFIER }),
    jobRegistry: registry,
    accountDefense: {
      lockForChargebackWithinTx: () =>
        Promise.resolve({ locked: false, email: null, userName: null }),
    },
    accountLockedEmail: { sendChargebackLockEmail: () => okAsync() },
    ...overrides,
  };
  const manifest = createBillingManifest(deps);
  // An empty cache-policy map default-denies storage on every route, which is
  // what lets the production-mode case assemble a pipeline at all.
  const app = applyPipeline(new Hono<AppEnv>(), { cache: { policies: {} } });
  app.route(manifest.basePath, manifest.routes);
  appHolder.app = app;
  return { app, providers, directives };
}

async function charge(
  app: Hono<AppEnv>,
  userId: string,
  extraHeaders: Record<string, string> = {}
): Promise<{ paymentId: string; status: string }> {
  const res = await app.request(
    '/billing/payments',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        cookie: await sessionCookie(userId),
        ...extraHeaders,
      },
      body: JSON.stringify({
        amountNanoUsd: '5000000000',
        cardToken: 'tok',
        customerCode: 'cust',
      }),
    },
    testEnv
  );
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  return body as { paymentId: string; status: string };
}

async function paymentStatus(paymentId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: payments.status })
    .from(payments)
    .where(eq(payments.id, paymentId));
  return row?.status;
}

async function flushAll(providers: readonly MockPaymentProvider[]): Promise<void> {
  await Promise.all(providers.map((provider) => provider.flushWebhooks()));
}

afterAll(async () => {
  await db.delete(jobs).where(like(jobs.dedupeKey, 'payment.verify:%'));
  if (createdUserIds.length > 0) {
    const paymentRows = await db
      .select({ id: payments.id })
      .from(payments)
      .where(inArray(payments.userId, createdUserIds));
    const paymentIds = paymentRows.map((row) => row.id);
    if (paymentIds.length > 0) {
      const legRows = await db
        .select({ transactionId: ledgerEntries.transactionId })
        .from(ledgerEntries)
        .where(inArray(ledgerEntries.paymentId, paymentIds));
      const transactionIds = [...new Set(legRows.map((row) => row.transactionId))];
      if (transactionIds.length > 0) {
        await db.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, transactionIds));
      }
      await db.delete(payments).where(inArray(payments.id, paymentIds));
    }
    await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('POST /billing/payments — the webhook hold directive', () => {
  it('threads the hold header to the payment provider in local dev', async () => {
    const { app, directives } = buildApp();
    await charge(app, await createUser(), { 'x-mock-hold-payment-webhook': 'true' });
    expect(directives).toStrictEqual([{ holdWebhook: true }]);
  });

  it('threads no hold when the request carries no hold header', async () => {
    const { app, directives } = buildApp();
    await charge(app, await createUser());
    expect(directives).toStrictEqual([{}]);
  });
});

describe('GET /billing/mock/release-webhook (dev-only held-webhook release)', () => {
  it('leaves a held payment awaiting its webhook until released', async () => {
    const { app, providers } = buildApp();
    const { paymentId, status } = await charge(app, await createUser(), {
      'x-mock-hold-payment-webhook': 'true',
    });
    await flushAll(providers);

    expect(status).toBe('awaiting_webhook');
    expect(await paymentStatus(paymentId)).toBe('awaiting_webhook');
  });

  it('completes a held payment by delivering its signed webhook', async () => {
    const { app, providers } = buildApp();
    const { paymentId } = await charge(app, await createUser(), {
      'x-mock-hold-payment-webhook': 'true',
    });
    await flushAll(providers);

    const res = await app.request(`${RELEASE_PATH}?paymentId=${paymentId}`, {}, testEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: true });
    expect(await paymentStatus(paymentId)).toBe('completed');
  });

  it('answers 404 for a payment that does not exist', async () => {
    const { app } = buildApp();
    const res = await app.request(`${RELEASE_PATH}?paymentId=${crypto.randomUUID()}`, {}, testEnv);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('refuses a payment whose charge has no provider transaction yet', async () => {
    const userId = await createUser();
    const [row] = await db
      .insert(payments)
      .values({
        userId,
        amountNanoUsd: 5_000_000_000n,
        status: 'pending',
        idempotencyKey: `pay:${userId}:${crypto.randomUUID()}`,
      })
      .returning({ id: payments.id });
    const { app } = buildApp();

    const res = await app.request(`${RELEASE_PATH}?paymentId=${row?.id ?? ''}`, {}, testEnv);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CONFLICT });
  });

  it('rejects a payment id that is not a uuid', async () => {
    const { app } = buildApp();
    const res = await app.request(`${RELEASE_PATH}?paymentId=not-a-uuid`, {}, testEnv);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('releases nothing where the provider cannot summon a webhook', async () => {
    const fixture = createFixtureFetch();
    const { app } = buildApp({
      paymentProvider: () =>
        createHelcimPaymentProvider({ apiToken: 'sandbox-token', fetchImpl: fixture.fetchImpl }),
    });
    const res = await app.request(`${RELEASE_PATH}?paymentId=${crypto.randomUUID()}`, {}, testEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: false });
    expect(fixture.requests()).toHaveLength(0);
  });

  it('answers 503 when the release cannot deliver its webhook', async () => {
    const { app, providers } = buildApp();
    const { paymentId } = await charge(app, await createUser(), {
      'x-mock-hold-payment-webhook': 'true',
    });
    await flushAll(providers);
    const failing = createMockPaymentProvider({
      webhookUrl: 'http://localhost/billing/webhooks/payment',
      webhookVerifier: WEBHOOK_VERIFIER,
      fetchImpl: () => Promise.reject(new Error('connection refused')),
      webhookRetry: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 },
      telemetry: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        captureError: vi.fn(),
      },
    });
    const { app: releasingApp } = buildApp({ paymentProvider: () => failing });

    const res = await releasingApp.request(`${RELEASE_PATH}?paymentId=${paymentId}`, {}, testEnv);

    expect(res.status).toBe(503);
    expect(await paymentStatus(paymentId)).toBe('awaiting_webhook');
  });

  it('answers 404 in production (dev-only route class)', async () => {
    const released = vi.fn();
    const { app } = buildApp({
      paymentProvider: () => {
        released();
        return createHelcimPaymentProvider({ apiToken: 'unused' });
      },
    });
    const res = await app.request(
      `${RELEASE_PATH}?paymentId=${crypto.randomUUID()}`,
      {},
      { ...testEnv, NODE_ENV: 'production' }
    );
    expect(res.status).toBe(404);
    // The handler never ran — no provider was even asked for.
    expect(released).not.toHaveBeenCalled();
  });
});
