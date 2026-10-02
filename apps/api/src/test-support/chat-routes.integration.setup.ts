/**
 * Shared fixtures for the chat route integration suites
 * (`slices/chat/routes-*.integration.test.ts`).
 *
 * It lives outside `apps/api/src/slices/` because it seeds five slices' tables directly —
 * conversations, epochs, wallets, member budgets, shared links, the catalog. That
 * is ordinary test-fixture reach, not a chat-slice write path, and single-writer-
 * per-table (which exempts `*.test.ts`, and attributes every other file under
 * `src/slices/<slice>/` to that slice) would otherwise read it as one.
 *
 * Model ids and the created-row registries are module state, so every importing
 * test file gets its own set, and the cleanup below is scoped to the ids that
 * file minted.
 */
import { afterAll } from 'vitest';
import { Hono } from 'hono';
import { Redis } from '@upstash/redis';
import { sealData } from 'iron-session';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationForks,
  conversationMembers,
  conversations,
  createDb,
  memberBudgets,
  messages,
  modelCatalog,
  sharedLinks,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { createEnvUtilities } from '@hushbox/shared';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-instants';
import { mediaParameterSpecs } from '@hushbox/shared/affordability';
import { okAsync } from '../lib/result/index.js';
import { applyPipeline } from '../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../middleware/pipeline-session.js';
import { normalizeCatalog } from '../slices/models/domain/index.js';
import { createBillingStores } from '../slices/billing/index.js';
import { createConversationsStores } from '../slices/conversations/index.js';
import { createLinkResolutionAdapter } from '../composition/bindings/link-resolution.js';
import { seedConversationWithEpoch } from './conversation-seed.js';
import { mintLinkCredential } from './link-credential.js';
import { CHAT_ROUTE_POSTURES, createChatManifest } from '../slices/chat/index.js';
import {
  LINK_CREDENTIAL_HEADER,
  callerIpId,
  trialQuotaIpKey,
} from '../slices/chat/domain/index.js';
import type { RealtimeBroadcast } from '../slices/conversations/index.js';
import type { LanguageTokenPricing } from '../slices/models/domain/index.js';
import type { ErrorCode } from '@hushbox/shared';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

/** The realtime port's start outcome, mirrored locally (not on the barrel surface). */
type RunStartOutcome =
  | {
      readonly started: true;
      readonly runId: string;
      readonly deadlineAt: number;
      readonly assistantMessageIds: readonly string[];
    }
  // The refusal code is as wide as the registry, exactly as the port declares
  // it: the DO answers any registry code on its 409 body and the adapter's
  // schema gates only registry membership, so narrowing it here would hide
  // codes the route really has to answer.
  | { readonly started: false; readonly code: ErrorCode }
  | { readonly outcome: 'replay'; readonly response: unknown }
  | {
      readonly outcome: 'attach';
      readonly userMessageId: string | null;
      readonly assistantMessageIds: readonly string[] | null;
    };

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for chat route integration tests'
  );
}

const SECRET = 'secret-at-least-32-characters-long!!';
// The real SRH token is required: the trial route writes quota counters through
// `c.var.redis` (the paid route never touches Redis in these tests — the
// revocation check is deliberately unwired, so cookies pass without it).
export const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

export const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
export const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
export const BYTES = new Uint8Array([3, 3, 3]);
export const MODEL = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
export const MODEL_B = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
export const MODEL_C = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
// Web-search fixtures are cheap, tool-capable, priceable text models. Left in the
// catalog they sink the trial premium-price 75th-percentile threshold and wrongly
// mark the over-1¢ trial fixtures premium. Each seed is dropped in its own
// `finally`; this prefix lets the file that mints them also purge any row left by
// a retried earlier attempt of itself, killed before the finally could run — the
// slot database outlives a watch re-run.
export const WEB_SEARCH_MODEL_PREFIX = 'chat-route-search';

/**
 * Every model id seeded through a helper here that takes the id from its caller.
 * The cleanup below deletes these, which the constants above cannot cover: a
 * caller-minted id is named by nothing the cleanup can enumerate, so an
 * unregistered one is deleted by nothing and outlives the file that seeded it.
 *
 * The model catalog is one table per WORKER SLOT, not per file, so a surviving
 * row joins the premium-price percentile every later file in that slot is judged
 * against — and the percentile is what decides whether a trial send is refused
 * as premium.
 */
export const seededModelIds: string[] = [];

const createdUserIds: string[] = [];
export const createdConversationIds: string[] = [];

/**
 * The rate-limit identity of a caller presenting `ip` in `cf-connecting-ip`, or
 * of one presenting no IP header at all — computed through the route's own
 * implementation, never re-derived here.
 */
export function ipIdentity(ip?: string): Promise<string> {
  return callerIpId(
    (name) => (name === 'cf-connecting-ip' ? ip : undefined),
    createEnvUtilities(testEnv)
  );
}

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db
    .delete(modelCatalog)
    .where(
      inArray(modelCatalog.modelId, [
        MODEL,
        MODEL_B,
        MODEL_C,
        ...seededModelIds,
        ...trialDecoyModelIds,
        ...trialGateModelIds,
      ])
    );
  // The header-less trial test spends the sentinel IP's counters, the one trial
  // IP identity that is not unique per test. Only the daily quota one outlives
  // the run — its key is scoped to the UTC day, so an uncleared one is spent
  // again by the next run on the same day until it refuses; the send throttle's
  // window expires on its own. The key comes from the counter that writes it,
  // never re-derived here: the previous cleanup wrote the template itself and
  // went on deleting a key nothing writes once the counter moved.
  await redis.del(trialQuotaIpKey(new Date(), await ipIdentity())._unsafeUnwrap());
  await db.$client.end();
});

/** The context length every text fixture declares to the gateway. */
const TEXT_CONTEXT_LENGTH = 100_000;

/**
 * A text fixture's gateway rates, in the decimal-USD-per-token form OpenRouter
 * publishes. Ingestion converts them to nano-USD and bakes the platform fee, so
 * the rates on the stored row are larger numbers than the ones written here.
 *
 * The cheap default is the smallest rate the gateway can express, with output
 * priced at twice input; the decoys are absurd on purpose — 1 USD per token
 * puts them far above every other fixture, which is all the trial premium
 * percentile needs from them.
 */
const CHEAP_GATEWAY_RATES: LanguageTokenPricing = {
  prompt: '0.000000001',
  completion: '0.000000002',
};
const DECOY_GATEWAY_RATES: LanguageTokenPricing = { prompt: '1', completion: '1' };

/**
 * The descriptor ingestion itself mints for a text model, produced by running
 * the catalog's own normalization over a gateway entry rather than by copying
 * its output. Everything ingestion decides — the version stamp, the behavior
 * list, the parameter specs, the modality lists, the fee bake — therefore
 * cannot drift from the catalog: there is no second statement of it to drift.
 * A fixture states only what OpenRouter would carry.
 *
 * Each fixture normalizes as its own single-model pool, so the catalog's
 * top-context exemption always covers it. That is what admits a fixture priced
 * far under the commercial floor, which the cheap rates deliberately are.
 */
function ingestedTextDescriptor(
  modelId: string,
  gateway: {
    readonly supportedParameters?: readonly string[];
    readonly pricing?: LanguageTokenPricing;
  }
): Record<string, unknown> {
  const entries = normalizeCatalog(
    [
      {
        source: 'language',
        id: modelId,
        provider: 'p',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportedParameters: gateway.supportedParameters ?? [],
        contextLength: TEXT_CONTEXT_LENGTH,
        pricing: gateway.pricing ?? CHEAP_GATEWAY_RATES,
        // Outside the trial premium-recency window, so a seeded text model is
        // eligible on that leg; `recentReleaseSeconds` seeds the contrast.
        releasedAt: OLD_RELEASE_SECONDS,
        deprecated: false,
      },
    ],
    new Set([modelId]),
    Date.now()
  );
  const entry = entries[0];
  if (entry?.kind !== 'normalized') {
    throw new Error(`ingestion refused the text fixture ${modelId}`);
  }
  // `fetchedAt` is the one descriptor field normalization does not mint:
  // ingestion stamps it at persist time, and these fixtures insert directly.
  return { ...entry.content, fetchedAt: 0 };
}

export async function seedModelId(modelId: string): Promise<void> {
  seededModelIds.push(modelId);
  await db
    .insert(modelCatalog)
    .values({ modelId, descriptor: ingestedTextDescriptor(modelId, {}) })
    .onConflictDoNothing();
}

export async function seedModel(): Promise<void> {
  await seedModelId(MODEL);
}

/** A tool-capable text model — the web-search build gate requires `tools`. */
export async function seedToolCapableModelId(modelId: string): Promise<void> {
  seededModelIds.push(modelId);
  await db
    .insert(modelCatalog)
    .values({
      modelId,
      descriptor: ingestedTextDescriptor(modelId, { supportedParameters: ['tools'] }),
    })
    .onConflictDoNothing();
}

// The trial premium gate ranks a model's combined price against the 75th
// percentile of the exposed text catalog. In an isolated run the only text
// models are the cheap fixtures, so without a pricier spread every model ties
// the threshold and reads as premium. These decoys give the catalog a spread so
// the cheap fixtures sit well below the quartile and stay trial-eligible.
export const trialDecoyModelIds: string[] = [];

/** How many decoys one {@link seedTrialDecoys} mints. */
const TRIAL_DECOY_COUNT = 3;

export async function seedTrialDecoys(): Promise<void> {
  for (let index = 0; index < TRIAL_DECOY_COUNT; index += 1) {
    const modelId = `chat-route-decoy/${crypto.randomUUID().slice(0, 8)}`;
    trialDecoyModelIds.push(modelId);
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        descriptor: ingestedTextDescriptor(modelId, { pricing: DECOY_GATEWAY_RATES }),
      })
      .onConflictDoNothing();
  }
}

// Trial-gate fixtures (image, premium-recent, over-priced) seeded per test.
const trialGateModelIds: string[] = [];

/**
 * The video fixture's per-second SKUs, and — through `Object.keys` below — its
 * declared resolution domain. One object, because ingestion prices a video row
 * per second over exactly the resolutions it declares, so two literals here
 * could drift into a row the catalog cannot produce.
 */
const VIDEO_SKUS = { '720p': '40000000', '1080p': '80000000' } as const;

/** The text-model descriptor every gate fixture starts from. */
function baseGateDescriptor(modelId: string): Record<string, unknown> {
  return ingestedTextDescriptor(modelId, {});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merges nested objects key by key; arrays and scalars replace outright. */
function deepMerge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, override] of Object.entries(overrides)) {
    const current = merged[key];
    merged[key] =
      isPlainObject(current) && isPlainObject(override) ? deepMerge(current, override) : override;
  }
  return merged;
}

async function insertGateModel(
  modelId: string,
  descriptor: Record<string, unknown>
): Promise<void> {
  trialGateModelIds.push(modelId);
  await db.insert(modelCatalog).values({ modelId, descriptor }).onConflictDoNothing();
}

/**
 * Seeds a cheap, old, priceable text model, with `descriptorOverrides` merged
 * into it DEEPLY: `{ limits: { … } }` names one limit and keeps the rest.
 *
 * A shallow spread here is a trap rather than a style choice: `{ limits: {} }`
 * would wipe `contextLength`, so a fixture meaning "declares no reasoning
 * efforts" would silently also mean "has no context length" — an unintended
 * property that goes on to win a classifier tiebreak in a later test. A fixture
 * that means to drop a field says so through
 * {@link seedUnrepresentableGateModel}.
 */
export async function seedGateModel(
  modelId: string,
  descriptorOverrides: Record<string, unknown>
): Promise<void> {
  await insertGateModel(modelId, deepMerge(baseGateDescriptor(modelId), descriptorOverrides));
}

/**
 * Seeds a gate fixture the catalog would not admit at the rates and exemptions
 * these tests use — a missing context length, or a text model priced by a
 * media unit, which no token turn can price. Nested overrides REPLACE here, so
 * the caller states the whole object and the absence is deliberate rather than
 * incidental.
 *
 * A missing context length is not categorically unemittable — `contextLength`
 * is optional and omitted when the gateway states none — and it is the
 * combination that makes that row inadmissible. A text model priced by a media
 * unit is unemittable, since ingestion prices every text model by tokens; it
 * stands for a stored price no token turn can read. Each exists to drive a
 * fail-closed path, and the name is what keeps them countable.
 */
export async function seedUnrepresentableGateModel(
  modelId: string,
  descriptorOverrides: Record<string, unknown>
): Promise<void> {
  await insertGateModel(modelId, { ...baseGateDescriptor(modelId), ...descriptorOverrides });
}

/**
 * Seeds a video model. A media modality REPLACES the text rates rather than
 * joining them: normalization prices video from resolution SKUs alone, so a
 * descriptor carrying token rates too is a row the catalog could not produce.
 */
export async function seedVideoGateModel(modelId: string): Promise<void> {
  await insertGateModel(modelId, {
    ...baseGateDescriptor(modelId),
    outputs: ['video'],
    // A media row carries neither the language family's 'streaming' behavior
    // nor a context length: ingestion hard-codes both empty for image and video.
    behaviors: [],
    limits: {},
    // Minted through the same function ingestion mints with: a video row that
    // declares no aspect ratio is excluded outright, so the specs are a
    // condition of the row existing rather than decoration.
    parameters: mediaParameterSpecs({
      aspectRatio: ['16:9'],
      resolution: Object.keys(VIDEO_SKUS),
      durationSeconds: [6],
    }),
    pricing: { kind: 'perSecond', anchor: VIDEO_SKUS, dearest: VIDEO_SKUS },
  });
}

/**
 * Seeds an image model. Its own helper because image pricing REPLACES the text
 * rates rather than joining them: normalization emits a per-image price alone
 * for an image model, so a descriptor carrying token rates is a row the catalog
 * could not produce.
 */
export async function seedImageGateModel(modelId: string): Promise<void> {
  await insertGateModel(modelId, {
    ...baseGateDescriptor(modelId),
    outputs: ['image'],
    // See the video helper: empty behaviors and empty limits are both what
    // ingestion emits for a media row, and neither survives the text base.
    behaviors: [],
    limits: {},
    // See the video helper: an image row declaring no aspect ratio is excluded
    // at ingestion, so the spec is a condition of the row existing.
    parameters: mediaParameterSpecs({ aspectRatio: ['1:1', '4:3'] }),
    pricing: { kind: 'perImage', anchor: '40000000', dearest: '40000000' },
  });
}

/**
 * The catalog a trial suite is judged against: one cheap eligible model and the
 * pricey decoys that hold the top quartile above it, and nothing else.
 *
 * The wipe is the point rather than an economy. The premium gate ranks a model's
 * combined price against `floor(0.75 × pool)` of the exposed priceable-TEXT
 * catalog, and that catalog is one table per WORKER SLOT — so cheap rows another
 * test file left there crowd the distribution's cheap side and the quartile lands
 * on a cheap row, turning a send this suite expects to start (201) into a premium
 * refusal (403) and a refusal whose intended class is *cost* (402) into that same
 * premium one. Neither depends on anything this suite does, only on which files
 * shared its slot. Per-test re-seeding (every test seeds the models it needs)
 * makes the wipe safe.
 */
export async function pinTrialCatalogBaseline(): Promise<void> {
  await db.delete(modelCatalog);
  await seedModel();
  await seedTrialDecoys();
}

/**
 * {@link pinTrialCatalogBaseline} plus the fixture at `fixtureId`, for a test
 * whose verdict turns on that fixture's own price or limits.
 */
export async function withPinnedTrialCatalog<T>(
  fixtureId: string,
  descriptorOverrides: Record<string, unknown>,
  postSend: () => Promise<T>
): Promise<T> {
  await pinTrialCatalogBaseline();
  await seedGateModel(fixtureId, descriptorOverrides);
  return postSend();
}

/** The dear-fixture case of {@link withPinnedTrialCatalog}: priced just under the quartile. */
export async function withDearTrialCatalog<T>(
  dearId: string,
  postSend: () => Promise<T>
): Promise<T> {
  return withPinnedTrialCatalog(
    dearId,
    { pricing: { anchor: { base: { input: '999', output: '1' } } } },
    postSend
  );
}

/**
 * Cheap text rows standing in for what an earlier test file leaves in the slot's
 * catalog, so a trial suite's baseline is pinned against real pressure rather
 * than against an empty table. Seeded once, before the baseline that has to clear
 * them.
 *
 * The count is derived, not chosen. The threshold is the pool's
 * `floor(0.75 × (cheap + decoys))`-th combined rate, and it lands ON a cheap row
 * — marking every cheap fixture premium — from `cheap = 3 × decoys + 1` upward.
 *
 * That count is derived over the BASELINE pool alone — {@link pinTrialCatalogBaseline}'s
 * one cheap model beside the decoys — where these rows supply every cheap row but
 * that one, and one fewer leaves the threshold on a decoy. A caller that seeds
 * further cheap fixtures of its own during the run crosses the boundary at a
 * lower count, so for it this figure is a margin rather than the boundary itself.
 */
export async function seedInheritedCatalogRows(): Promise<void> {
  for (let index = 0; index < 3 * TRIAL_DECOY_COUNT; index += 1) {
    await seedModelId(`chat-route-inherited/${crypto.randomUUID().slice(0, 8)}`);
  }
}

export async function seedUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@chat-route.test`,
        username: `cr${suffix}`,
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

export async function seedConversation(userId: string, withMember: boolean): Promise<string> {
  const { conversationId } = await seedConversationWithEpoch(db, { userId, title: BYTES });
  createdConversationIds.push(conversationId);
  if (withMember) {
    await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });
  }
  return conversationId;
}

export async function seedPurchasedWallet(userId: string): Promise<void> {
  await db.insert(wallets).values({ userId, type: 'purchased', balanceNanoUsd: 10_000_000n });
}

export async function seedFork(conversationId: string): Promise<string> {
  const rows = await db
    .insert(conversationForks)
    .values({ conversationId, name: 'Branch', tipMessageId: null })
    .returning({ id: conversationForks.id });
  const forkId = rows[0]?.id;
  if (forkId === undefined) throw new Error('fork seed failed');
  return forkId;
}

export async function cookie(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      userId,
      sessionId: 's1',
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

export function fakeRealtime(
  outcome: RunStartOutcome,
  overrides: Partial<RealtimeBroadcast> = {}
): RealtimeBroadcast {
  return {
    broadcast: () => okAsync({ delivered: 0, paused: 0, evicted: 0 }),
    evict: () => okAsync(0),
    presence: () => okAsync([]),
    startRun: () => okAsync(outcome),
    stopRun: () => okAsync(false),
    upgrade: () => okAsync(new Response(null, { status: 200 })),
    ...overrides,
  };
}

/**
 * A realtime double that counts run starts, for asserting that a route refused
 * BEFORE handing the run to the DO — which is where the admission hold is placed
 * and the provider is reached. An empty count is the proof; the outcome is the
 * ordinary started one so a non-refusing path still behaves normally.
 */
export function recordingRealtime(): {
  readonly starts: number[];
  readonly realtime: RealtimeBroadcast;
} {
  const starts: number[] = [];
  return {
    starts,
    realtime: fakeRealtime(STARTED, {
      startRun: () => {
        starts.push(1);
        return okAsync(STARTED);
      },
    }),
  };
}

export function createApp(realtime: RealtimeBroadcast): Hono<AppEnv> {
  const manifest = createChatManifest({
    conversations: createConversationsStores,
    billing: createBillingStores(),
    realtime: () => realtime,
    trialRoomName: (sessionId) => `trial:${sessionId}`,
    // The real composition-root adapter over the conversations shared-link store,
    // so the public guest-send seam resolves credentials against seeded links.
    linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
  });
  const app = applyPipeline(new Hono<AppEnv>(), {
    rateLimit: { postures: CHAT_ROUTE_POSTURES },
  });
  app.route(manifest.basePath, manifest.routes);
  return app;
}

export async function postPath(
  path: string,
  realtime: RealtimeBroadcast,
  headers: Record<string, string>,
  body: unknown
): Promise<Response> {
  return createApp(realtime).request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    testEnv
  );
}

export async function post(
  realtime: RealtimeBroadcast,
  headers: Record<string, string>,
  body: unknown
): Promise<Response> {
  return postPath('/chat', realtime, headers, body);
}

export async function postTrial(
  realtime: RealtimeBroadcast,
  headers: Record<string, string>,
  body: unknown
): Promise<Response> {
  return postPath('/chat/trial', realtime, headers, body);
}

export async function getPath(
  path: string,
  realtime: RealtimeBroadcast,
  headers: Record<string, string>
): Promise<Response> {
  return createApp(realtime).request(path, { method: 'GET', headers }, testEnv);
}

/** The one upgrade the trial WS route makes; captured server-side to assert the target. */
interface UpgradeCall {
  readonly conversationId: string;
  readonly principalId: string;
  readonly isGuest: boolean;
}

/** A realtime double whose `upgrade` records its target so the route's server-derived room is checkable. */
export function recordingUpgrade(): {
  readonly calls: UpgradeCall[];
  readonly realtime: RealtimeBroadcast;
} {
  const calls: UpgradeCall[] = [];
  const realtime = fakeRealtime(STARTED, {
    upgrade: (conversationId, principal) => {
      calls.push({
        conversationId,
        principalId: principal.principalId,
        isGuest: principal.isGuest,
      });
      return okAsync(new Response(null, { status: 200 }));
    },
  });
  return { calls, realtime };
}

/** Fresh anti-evasion identities per test so the SRH counters never collide. */
export function trialHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Idempotency-Key': crypto.randomUUID(),
    'x-trial-token': crypto.randomUUID(),
    'cf-connecting-ip': `198.51.100.7-${crypto.randomUUID()}`,
    ...extra,
  };
}

export const STARTED: RunStartOutcome = {
  started: true,
  runId: 'run-x',
  deadlineAt: 999,
  assistantMessageIds: ['answer-x'],
};

// A release timestamp (unix SECONDS) inside the premium-recency window, so the
// seeded model reads as premium on the recency leg alone — independent of the
// shared catalog's price spread. Evaluated at seed time; the gate reads the wall
// clock a few ms later, so the model is unambiguously recent.
function recentReleaseSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Seeds a premium text model (registered for afterAll cleanup) and passes its id
 * to the test body, dropping it immediately afterwards so its cheap price never
 * lingers in the shared catalog to sink a later test's trial percentile.
 */
export async function withPremiumModel(run: (modelId: string) => Promise<void>): Promise<void> {
  const modelId = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
  await seedGateModel(modelId, { releasedAt: recentReleaseSeconds() });
  try {
    await run(modelId);
  } finally {
    await db.delete(modelCatalog).where(eq(modelCatalog.modelId, modelId));
  }
}

/** A member with a zero purchased balance (cannot access premium) plus a free wallet. */
export async function seedZeroBalanceMember(): Promise<{ userId: string; conversationId: string }> {
  const userId = await seedUser();
  const conversationId = await seedConversation(userId, true);
  await db.insert(wallets).values({ userId, type: 'purchased', balanceNanoUsd: 0n });
  await db.insert(wallets).values({ userId, type: 'free', balanceNanoUsd: 0n });
  return { userId, conversationId };
}

/**
 * An owner-funded group conversation: the owner has an ample balance, a
 * per-conversation budget, and a per-member cap for the sender, so a group turn
 * pays the OWNER's wallet. The sending member has no wallet of their own — so
 * the payer is never the caller, the direct-billing tier gate is skipped, and
 * the caller's own wallet read is a path distinct from the turn context's.
 *
 * Both caps are sized to cover a real turn. A cap merely above zero would once
 * have read as owner-funded here and then been refused at admission; the payer
 * freeze now compares the turn's minimum, so a fixture claiming owner funding
 * has to seed funding that can actually pay for one.
 */
export async function seedOwnerFundedGroup(): Promise<{
  conversationId: string;
  owner: string;
  sender: string;
}> {
  const owner = await seedUser();
  const { conversationId } = await seedConversationWithEpoch(db, {
    userId: owner,
    title: BYTES,
    conversationBudgetNanoUsd: 10_000_000n,
  });
  createdConversationIds.push(conversationId);
  await db
    .insert(wallets)
    .values({ userId: owner, type: 'purchased', balanceNanoUsd: 10_000_000n });

  const sender = await seedUser();
  const memberRows = await db
    .insert(conversationMembers)
    .values({ conversationId, userId: sender, visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  const memberId = memberRows[0]?.id;
  if (memberId === undefined) throw new Error('member seed failed');
  await db.insert(memberBudgets).values({ memberId, budgetNanoUsd: 10_000_000n });
  return { conversationId, owner, sender };
}

/**
 * A group conversation whose owner is well funded but whose SENDING MEMBER
 * holds a cap too small to fund a turn — the band `minTurnCost` exists to
 * decide. The member has their own purchased wallet, so §Funding Decision
 * Matrix priority 1's fall-through has somewhere to land.
 *
 * `groupFundingNanoUsd` sets the other two headroom dimensions (the conversation
 * cap and the owner's balance) together, because a media minimum runs to tens of
 * cents — an owner-funded media arm needs all three dimensions above it, and
 * raising one alone leaves the min where it was.
 */
export async function seedUnderfundedMemberGroup(
  memberCapNanoUsd: bigint,
  groupFundingNanoUsd = 10_000_000n
): Promise<{
  conversationId: string;
  owner: string;
  sender: string;
}> {
  const owner = await seedUser();
  const { conversationId } = await seedConversationWithEpoch(db, {
    userId: owner,
    title: BYTES,
    conversationBudgetNanoUsd: groupFundingNanoUsd,
  });
  createdConversationIds.push(conversationId);
  await db
    .insert(wallets)
    .values({ userId: owner, type: 'purchased', balanceNanoUsd: groupFundingNanoUsd });

  const sender = await seedUser();
  await seedPurchasedWallet(sender);
  const memberRows = await db
    .insert(conversationMembers)
    .values({ conversationId, userId: sender, visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  const memberId = memberRows[0]?.id;
  if (memberId === undefined) throw new Error('member seed failed');
  await db.insert(memberBudgets).values({ memberId, budgetNanoUsd: memberCapNanoUsd });
  return { conversationId, owner, sender };
}

export async function seedMessage(
  conversationId: string,
  options: {
    readonly senderType: 'user' | 'assistant';
    readonly senderId: string | null;
    readonly sequenceNumber: number;
    readonly parentMessageId: string | null;
  }
): Promise<string> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: options.senderType,
      senderId: options.senderId,
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: options.sequenceNumber,
      parentMessageId: options.parentMessageId,
    })
    .returning({ id: messages.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('message seed failed');
  return id;
}

/**
 * An assistant reply of `parentMessageId` plus the text content item recording
 * which model produced it — the pair the regenerate route reads to decide
 * whether a re-run is running a model that was already chosen on the turn.
 */
export async function seedAssistantReply(
  conversationId: string,
  options: {
    readonly parentMessageId: string;
    readonly sequenceNumber: number;
    readonly modelId: string;
  }
): Promise<string> {
  const messageId = await seedMessage(conversationId, {
    senderType: 'assistant',
    senderId: null,
    sequenceNumber: options.sequenceNumber,
    parentMessageId: options.parentMessageId,
  });
  await db.insert(contentItems).values({
    messageId,
    contentType: 'text',
    position: 0,
    encryptedBlob: BYTES,
    modelId: options.modelId,
  });
  return messageId;
}

export async function postRegenerate(
  realtime: RealtimeBroadcast,
  headers: Record<string, string>,
  body: unknown
): Promise<Response> {
  return postPath('/chat/regenerate', realtime, headers, body);
}

// The paid run-start body the guest route hands the DO, captured server-side.
export interface CapturedRunBody {
  readonly userId?: string;
  readonly sender?: { readonly kind: string; readonly linkId?: string };
  readonly walletId?: string;
}

export async function postGuest(
  realtime: RealtimeBroadcast,
  credential: string | undefined,
  body: unknown
): Promise<Response> {
  const headers: Record<string, string> = { 'Idempotency-Key': crypto.randomUUID() };
  if (credential !== undefined) headers[LINK_CREDENTIAL_HEADER] = credential;
  return postPath('/chat/guest', realtime, headers, body);
}

interface SeededGuest {
  /** What the guest presents in the credential header: its link auth token, base64. */
  readonly credential: string;
  readonly linkId: string;
  readonly memberId: string;
}

/** Seeds a shared link + its link-guest member (write by default) for a conversation. */
export async function seedGuestLink(
  conversationId: string,
  options: { readonly privilege?: 'read' | 'write'; readonly leftAt?: boolean } = {}
): Promise<SeededGuest> {
  const { token, linkPublicKey, linkAuthHash } = mintLinkCredential();
  const linkRows = await db
    .insert(sharedLinks)
    .values({ conversationId, linkPublicKey, linkAuthHash, displayName: 'Guest' })
    .returning({ id: sharedLinks.id });
  const linkId = linkRows[0]?.id;
  if (linkId === undefined) throw new Error('shared link seed failed');
  const memberRows = await db
    .insert(conversationMembers)
    .values({
      conversationId,
      linkId,
      privilege: options.privilege ?? 'write',
      visibleFromEpoch: 1,
      ...(options.leftAt === true ? { leftAt: new Date() } : {}),
    })
    .returning({ id: conversationMembers.id });
  const memberId = memberRows[0]?.id;
  if (memberId === undefined) throw new Error('guest member seed failed');
  return { credential: token, linkId, memberId };
}

/**
 * Funds an owner-covered guest turn: owner purchased wallet, conversation cap,
 * member cap — every cap sized to cover a real turn, since the payer freeze
 * compares the turn's minimum and a token cap would refuse the guest instead.
 */
export async function seedOwnerFunding(
  ownerId: string,
  conversationId: string,
  memberId: string
): Promise<void> {
  await db
    .insert(wallets)
    .values({ userId: ownerId, type: 'purchased', balanceNanoUsd: 10_000_000n });
  await db
    .update(conversations)
    .set({ conversationBudgetNanoUsd: 10_000_000n })
    .where(eq(conversations.id, conversationId));
  await db.insert(memberBudgets).values({ memberId, budgetNanoUsd: 10_000_000n, spentNanoUsd: 0n });
}
