import { afterAll, beforeAll, beforeEach } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { evidenceDatabaseUrl } from '@hushbox/db/test-db';
import {
  CLASSIFICATION_VARIABLES,
  DECIMAL_USD_PATTERN,
  ModelDescriptor,
  callShapeFamilyFor,
  combinedRateNanoUsd,
  createEnvUtilities,
  isExposedModel,
  planReasoning,
  planReasoningOff,
  priceableModelFrom,
  promptUtf8Bytes,
  reasoningPlanModelFrom,
  sentTextsOf,
  utcDayKey,
} from '@hushbox/shared';
import { perSecondPricingFixture, tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { requireEnv } from '@hushbox/shared/require-env';
import { OLD_RELEASE_SECONDS, TEST_DAY_START } from '@hushbox/shared/test-instants';
import { CASSETTE_ROOT, resolveModelProvider } from './resolve-model-provider.js';
import { OPENROUTER_BASE_URL } from './openrouter-provider.js';
import { callMaxPrice, maxPriceReachesAnchor } from '../domain/pricing/call-routing.js';
import { priceMediaBillableNanoUsd } from '../domain/pricing/estimate.js';
import { fetchGatewayCatalog } from '../domain/catalog/gateway-metadata.js';
import { normalizeCatalog } from '../domain/catalog/normalize.js';
import { ENDPOINT_BUCKETS, endpointBucketCounts } from '../domain/catalog/price-schedule.js';
import {
  TEST_GATEWAY_BASE_URL,
  catalogFetch,
  imageModelFixture,
  modelEntryFixture,
} from '../domain/catalog/gateway-fixtures.js';
import {
  beginCassetteScope,
  cassetteScopeIsOpen,
  createCassetteFetch,
  endCassetteScope,
} from './cassette/recording-fetch.js';
import { createCassetteStore } from './cassette/cassette-store.js';
import { cassetteModeFor } from './cassette/mode.js';
import type { Database } from '@hushbox/db';
import type {
  EnvContext,
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  MaxPrice,
  MediaValue,
  ProviderMetadata,
} from '@hushbox/shared';
import type { GatewayCatalog, ZdrEndpoint } from '../domain/catalog/gateway-metadata.js';
import type { EndpointBucket } from '../domain/catalog/price-schedule.js';
import type { ModelProvider } from '../ports/index.js';

/**
 * Shared harness for the AI-inference adapter integration tests (language,
 * image, video). The suites run EVERYWHERE, all but the few bodies that gate
 * themselves on {@link SHOULD_RUN} because they assert something only a real
 * response carries. The provider-agnostic majority exercise:
 *
 *   - locally (any non-CI shell): the deterministic mock provider — no key, no
 *     db, no cassette, and structurally NO service-evidence write (the mock
 *     path of {@link resolveModelProvider} records nothing);
 *   - CI-vitest: the real provider under `OPENROUTER_API_KEY_RESTRICTED` with
 *     record-on-miss cassettes (the first uncached call is real, then replays
 *     from the shared cassette store); the factory's evidence wrapper records
 *     `openrouter-inference` service-evidence on the first successful event,
 *     so `verify:evidence --require=openrouter-inference` has a row to assert.
 *
 * There is no local cassette system. Which path a run takes is decided by ONE
 * gate ({@link deriveCiVitestGate}, which {@link deriveIntegrationEnv} inverts)
 * — never by raw `process.env['CI']`/`['E2E']` sniffing — so a CI-shaped local
 * shell cannot reach the real evidence-writing path.
 *
 * The gate asks the environment and nothing else. It can, because the loader
 * deletes every classification variable the generating mode leaves unstated:
 * a phase generated in a non-CI mode presents a non-CI classification even on
 * a runner that sets the flag itself, so the credentialled phase is the only
 * one the gate admits. The values a real call needs are then REQUIRED rather
 * than tested for — the registry defines both in every mode, so an absent one
 * means the generated files were never loaded, which is a crash and not a
 * reason to quietly resolve the mock.
 */

/** The env vars `createEnvUtilities` consumes, read from the ambient process. */
export function processEnvContext(): EnvContext {
  const context: EnvContext = {};
  for (const name of CLASSIFICATION_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) {
      context[name] = value;
    }
  }
  // VITEST sits outside CLASSIFICATION_VARIABLES: the vitest runner sets it,
  // no registry mode declares it, so it is read here directly.
  const vitest = process.env['VITEST'];
  if (vitest !== undefined) {
    context.VITEST = vitest;
  }
  return context;
}

interface IntegrationEnv {
  /** True unless this run is the credentialled CI-vitest one — resolve the mock. */
  readonly useMock: boolean;
  readonly isCI: boolean;
}

/**
 * The CI-vitest real-call gate: CI, not E2E — classified by the one
 * `createEnvUtilities` derivation, never raw CI/E2E sniffing. That pair selects
 * the credentialled phase on its own, because a loaded environment carries only
 * the classification its generating mode states. Pinned by
 * `integration.setup.test.ts`.
 */
export function deriveCiVitestGate(env: EnvContext): boolean {
  const envUtilities = createEnvUtilities(env);
  return envUtilities.isCI && !envUtilities.isE2E;
}

/**
 * THE single env→provider derivation for the adapter integration suites, and
 * the inverse of the gate above: the real provider exactly where a real call is
 * possible, the deterministic mock everywhere else.
 */
export function deriveIntegrationEnv(env: EnvContext): IntegrationEnv {
  const envUtilities = createEnvUtilities(env);
  return { useMock: !deriveCiVitestGate(env), isCI: envUtilities.isCI };
}

/**
 * The ambient gate value the real-only assertions hang `skipIf` on — a whole
 * `describe` where the suite is dedicated to the real path, an individual `it`
 * where one real-only body sits among provider-agnostic ones.
 */
export const SHOULD_RUN = deriveCiVitestGate(processEnvContext());

/**
 * The models the language and video adapter suites call. Each MUST be ZDR-reachable
 * at record time: a real language call carries OpenRouter's `provider.zdr:true`,
 * which fails closed on a non-ZDR model, so a wrong id fails loudly on the
 * record run, the right place to catch it. A video call carries no field the
 * Videos API enforces. (The adapters' own descriptor ZDR guard never fires here
 * — `descriptorFor` hardcodes `zdrReachable: true`, so the operative fail-closed
 * is the request's routing, not the descriptor check.) Hardcoded (not picked
 * from the drifting live catalog) so each inference request hashes stably and
 * its cassette replays deterministically; this is the single place to adjust.
 * The image suite derives its model instead, through {@link ROUTING_SUBJECTS}.
 */
const REAL_MODEL_IDS = {
  language: 'openai/gpt-4o',
  video: 'google/veo-3.1-generate-001',
} as const;

/**
 * Cheap reasoning models for the reasoning cassette tests, one per wire
 * shape. Same ZDR-at-record-time contract as {@link REAL_MODEL_IDS}: a
 * non-ZDR-reachable id fails loudly on the CI record run. The effort-native
 * pick must RETURN reasoning text (OpenAI o-series bills reasoning but
 * streams none, so it cannot pin the delta assertions); gpt-oss models
 * stream their raw reasoning. Gemini 2.5 takes `reasoning.max_tokens` as a
 * thinking budget (budget-native) and streams thought summaries.
 */
const REASONING_MODEL_IDS = {
  effortNative: 'openai/gpt-oss-20b',
  budgetNative: 'google/gemini-2.5-flash',
} as const;

interface RealProviderSetup {
  readonly provider: ModelProvider;
  readonly db: Database;
}

/**
 * Build the real provider through the factory. Reached only from a suite's
 * first provider use (never at module scope) so no db/cassette construction
 * happens at import, and none at all in a suite that takes the lifecycle
 * without ever asking for a provider.
 * Both values a real call needs are required, not probed: the key through
 * {@link requireEnv} and the database through {@link evidenceDatabaseUrl},
 * each of which throws on an absent one — in CI there is no skip.
 */
function setupRealProvider(): RealProviderSetup {
  const apiKey = requireEnv('OPENROUTER_API_KEY', process.env['OPENROUTER_API_KEY']);
  const { isCI } = deriveIntegrationEnv(processEnvContext());
  // The provider's evidence row has to outlive this worker's database —
  // `verify:evidence` reads the stack's own in a later process.
  const db = createDb(evidenceDatabaseUrl(process.env), { neonDev: LOCAL_NEON_DEV_CONFIG });
  const provider = resolveModelProvider({
    useMock: false,
    apiKey,
    isCI,
    db,
    maxPriceReachesAnchor,
  });
  return { provider, db };
}

interface IntegrationProviderSetup {
  readonly provider: ModelProvider;
  /** Closes the real path's db pool; a no-op on the mock path. */
  readonly teardown: () => Promise<void>;
}

/**
 * What a caller reaching past {@link useIntegrationProvider} is told. The whole
 * message is the fix, because the reader is someone who has just written a new
 * suite and has no reason to know this harness keys repeated requests.
 */
const UNSCOPED_PROVIDER_MESSAGE =
  'This provider was used outside a cassette occurrence scope. Take the suite lifecycle — ' +
  '`const provider = useIntegrationProvider();` at the top of the describe, then `provider()` ' +
  'where you need it — or, for a case that is not a suite lifecycle, wrap it in ' +
  '`beginCassetteScope()` / `endCassetteScope()`. Unscoped, a repeated request keys past its ' +
  'recording and reaches the live gateway: a charged OpenRouter generation on the CI path.';

/**
 * Refuse inference outside an occurrence scope, on both the mock and the real
 * path. The cassette is what makes an unscoped call expensive, but only the
 * credentialled run has one, and a failure reachable only there is a bill
 * rather than a test result — so the gate is on the provider this harness hands
 * out, which every run builds, and the machine that would have spent nothing is
 * the one that goes red.
 */
function refusingOutsideScope(provider: ModelProvider): ModelProvider {
  return {
    infer(request, descriptor, options) {
      if (!cassetteScopeIsOpen()) {
        throw new Error(UNSCOPED_PROVIDER_MESSAGE);
      }
      return provider.infer(request, descriptor, options);
    },
  };
}

/**
 * Resolve the provider from the env — deterministic mock everywhere the run is
 * not the credentialled CI-vitest one, real + cassettes + evidence where it is.
 * A suite reaches this through {@link useIntegrationProvider}, which carries the
 * lifecycle a suite would otherwise have to remember; the injectable `env` and
 * the bare form exist for the harness pin test. The provider it hands back
 * refuses to infer outside an occurrence scope
 * ({@link refusingOutsideScope}), so reaching past that lifecycle is a red test
 * rather than a working, unscoped provider.
 */
export function setupIntegrationProvider(
  env: EnvContext = processEnvContext()
): IntegrationProviderSetup {
  const { useMock, isCI } = deriveIntegrationEnv(env);
  if (useMock) {
    return {
      provider: refusingOutsideScope(
        resolveModelProvider({
          useMock: true,
          apiKey: '',
          isCI,
          db: undefined,
          maxPriceReachesAnchor,
        })
      ),
      teardown: () => Promise.resolve(),
    };
  }
  const { provider, db } = setupRealProvider();
  return {
    provider: refusingOutsideScope(provider),
    teardown: async (): Promise<void> => {
      await db.$client.end();
    },
  };
}

/**
 * A suite's whole provider lifecycle: the provider on first use, its teardown
 * when the file ends, and a fresh cassette occurrence scope before each test.
 *
 * The scope is why this exists rather than a bare {@link setupIntegrationProvider}
 * call in `beforeAll`. One closure serves the whole file and keys a repeated
 * request by how often it has been seen, so two tests sending byte-identical
 * requests — which each modality suite does, one per modality — would key the
 * second past its recording and reach the live gateway, a charged generation
 * on the credentialled path, for video a whole second one. Registering the reset here is what keeps that from being
 * a thing a suite remembers: the door that hands over the provider is the door
 * that opens the scope, and `integration.setup.test.ts` drives an identical
 * pair through this lifecycle, so removing the hook reddens a test that runs
 * on every machine rather than quietly spending money in CI.
 *
 * The scope opens at the suite's start as well as before each test, because a
 * suite may infer in its own `beforeAll` (`smart-model.integration.test.ts`
 * does), and the provider refuses outside a scope. It closes when the file
 * ends, which is what leaves the refusal reachable for a later suite in the
 * same file that takes no lifecycle.
 */
export function useIntegrationProvider(): () => ModelProvider {
  let setup: IntegrationProviderSetup | undefined;

  // Registered before the taking suite's own hooks, so its `beforeAll` runs
  // first and a scope is open for anything that suite does there.
  beforeAll(() => {
    beginCassetteScope();
  });

  beforeEach(() => {
    beginCassetteScope();
  });

  afterAll(async () => {
    endCassetteScope();
    if (setup !== undefined) {
      await setup.teardown();
      setup = undefined;
    }
  });

  return (): ModelProvider => {
    setup ??= setupIntegrationProvider();
    return setup.provider;
  };
}

/**
 * Each language model's price at its dearest standard-tier endpoint, as the
 * public ZDR listing priced it on 2026-10-04, baked billable. That is at or
 * above the model's anchor, its cheapest eligible ZDR endpoint. A real call
 * routes under the `max_price` derived from it (these rates × 5/4, rounded up,
 * un-baked), which admits every standard-tier endpoint; the gateway refuses the
 * call for price on the record run only when no listed endpoint is priced
 * within that `max_price`.
 */
const LANGUAGE_PRICING: Readonly<Record<string, ModelDescriptor['pricing']>> = {
  [REAL_MODEL_IDS.language]: tokenPricingFixture({
    input: 2875n,
    output: 11_500n,
    anchorContextTokens: 128_000,
  }),
  [REASONING_MODEL_IDS.effortNative]: tokenPricingFixture({
    input: 87n,
    output: 345n,
    anchorContextTokens: 131_072,
  }),
  [REASONING_MODEL_IDS.budgetNative]: tokenPricingFixture({
    input: 345n,
    output: 2875n,
    anchorContextTokens: 1_048_576,
  }),
};

/**
 * The price of the kind each output modality is charged by: a nominal one for
 * video, which no adapter reads, and a language model's listed price.
 */
function pricingFor(id: string, outputs: ModelDescriptor['outputs']): ModelDescriptor['pricing'] {
  if (outputs.includes('video')) {
    return perSecondPricingFixture({ anchor: { '720p': 1n }, dearest: { '720p': 1n } });
  }
  const pricing = LANGUAGE_PRICING[id];
  if (pricing === undefined) throw new Error(`no listed price for language model ${id}`);
  return pricing;
}

/** A minimal single-modality descriptor mirroring the adapter unit tests' shape. */
function descriptorFor(
  id: string,
  outputs: ModelDescriptor['outputs'],
  behaviors: string[]
): ModelDescriptor {
  const provider = id.split('/')[0] ?? id;
  return {
    id,
    provider,
    version: '4',
    inputs: ['text'],
    outputs,
    parameters: {},
    behaviors,
    limits: {},
    pricing: pricingFor(id, outputs),
    zdrReachable: true,
    releasedAt: OLD_RELEASE_SECONDS,
    fetchedAt: 0,
  };
}

export function languageDescriptor(): ModelDescriptor {
  return descriptorFor(REAL_MODEL_IDS.language, ['text'], ['streaming']);
}

export function videoDescriptor(): ModelDescriptor {
  return descriptorFor(REAL_MODEL_IDS.video, ['video'], []);
}

/**
 * Each reasoning descriptor carries its model's real gateway context window
 * (OpenRouter `context_length`), because the shared reasoning plan clamps the
 * thinking budget to it and reads an absent window as no room at all — a
 * `limits: {}` descriptor silently floors every rung to 1024 tokens and
 * changes the request body these suites record against.
 */
const REASONING_CONTEXT_LENGTH_TOKENS = {
  effortNative: 131_072,
  budgetNative: 1_048_576,
} as const;

/**
 * The gateway completion ceilings (OpenRouter `top_provider
 * .max_completion_tokens`) of the same two rows. Without them the plan clamps
 * only to the context window, and the budget-native ladder's top rung wires
 * 65,536 — one token above what that model accepts.
 */
const REASONING_MAX_OUTPUT_TOKENS = {
  effortNative: 131_072,
  budgetNative: 65_535,
} as const;

/** Effort-native reasoning model: enumerated levels pick the `{effort}` wire. */
export function reasoningEffortDescriptor(): ModelDescriptor {
  return {
    ...descriptorFor(REASONING_MODEL_IDS.effortNative, ['text'], ['streaming']),
    limits: {
      contextLength: REASONING_CONTEXT_LENGTH_TOKENS.effortNative,
      maxOutputTokens: REASONING_MAX_OUTPUT_TOKENS.effortNative,
    },
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  };
}

/** Budget-native reasoning model: no effort vocabulary → `{max_tokens}` wire. */
export function reasoningBudgetDescriptor(): ModelDescriptor {
  return {
    ...descriptorFor(REASONING_MODEL_IDS.budgetNative, ['text'], ['streaming']),
    limits: {
      contextLength: REASONING_CONTEXT_LENGTH_TOKENS.budgetNative,
      maxOutputTokens: REASONING_MAX_OUTPUT_TOKENS.budgetNative,
    },
    reasoning: { mandatory: false },
  };
}

/**
 * Answer headroom (H) for the reasoning requests. Generous relative to the
 * short stable prompt so a low-effort run cannot exhaust its completion cap
 * in thinking (an empty `length` finish would fail the answer assertions).
 */
const REASONING_ANSWER_HEADROOM_TOKENS = 512;

/**
 * The reasoning config comes from the shared plan — no code path sets
 * `reasoning` except via `planReasoning` output — so the wire shape under
 * test is exactly the one production sends. Deterministic inputs keep the
 * request hash (and its cassette) stable.
 */
function reasoningParameters(descriptor: ModelDescriptor): Record<string, unknown> {
  const result = planReasoning(
    reasoningPlanModelFrom(descriptor),
    'low',
    REASONING_ANSWER_HEADROOM_TOKENS
  );
  if (!result.feasible) {
    throw new Error(`reasoning plan infeasible for ${descriptor.id}: ${result.reason}`);
  }
  return { reasoning: result.plan.wire, maxOutputTokens: result.plan.maxTokens };
}

/** Stable prompt: a short question that invites a brief visible thought. */
const REASONING_PROMPT = 'What is 17 + 25? Reply with just the number.';

/**
 * The day every recorded request renders. A fixture rather than the wall clock
 * is what keeps a cassette warm: the day is hashed with the rest of the body,
 * so a live clock re-keys every recording at UTC midnight and charges a fresh
 * set of real calls. The recorded prompts therefore tell the model a frozen
 * date; the suites assert stream shape, usage and billing facts, never content.
 */
const FIXTURE_UTC_DAY = utcDayKey(new Date(TEST_DAY_START));

/** A language request's price reservation: the call's `max_price` at the UTF-8 bytes of every text it sends. */
function routedLanguage(request: InferenceRequest, descriptor: ModelDescriptor): InferenceRequest {
  const bound = promptUtf8Bytes(sentTextsOf(request));
  return { ...request, routing: { maxPrice: callMaxPrice(descriptor.pricing, bound) } };
}

export function reasoningEffortRequest(): InferenceRequest {
  return routedLanguage(
    {
      model: REASONING_MODEL_IDS.effortNative,
      inputs: [{ modality: 'text', text: REASONING_PROMPT }],
      parameters: reasoningParameters(reasoningEffortDescriptor()),
      outputs: ['text'],
      utcDay: FIXTURE_UTC_DAY,
    },
    reasoningEffortDescriptor()
  );
}

export function reasoningBudgetRequest(): InferenceRequest {
  return routedLanguage(
    {
      model: REASONING_MODEL_IDS.budgetNative,
      inputs: [{ modality: 'text', text: REASONING_PROMPT }],
      parameters: reasoningParameters(reasoningBudgetDescriptor()),
      outputs: ['text'],
      utcDay: FIXTURE_UTC_DAY,
    },
    reasoningBudgetDescriptor()
  );
}

/**
 * The hard-off exchange: an explicit `{ enabled: false }` wire (never
 * parameter omission) on a reasoning-capable, non-mandatory model, built via
 * `planReasoningOff`. Same stable prompt/model as the active reasoning
 * requests so the cassette hash stays deterministic.
 */
export function reasoningOffRequest(): InferenceRequest {
  const result = planReasoningOff(
    reasoningPlanModelFrom(reasoningEffortDescriptor()),
    REASONING_ANSWER_HEADROOM_TOKENS
  );
  if (!result.feasible) {
    throw new Error(`reasoning off-plan infeasible for ${REASONING_MODEL_IDS.effortNative}`);
  }
  return routedLanguage(
    {
      model: REASONING_MODEL_IDS.effortNative,
      inputs: [{ modality: 'text', text: REASONING_PROMPT }],
      parameters: { reasoning: result.plan.wire, maxOutputTokens: result.plan.maxTokens },
      outputs: ['text'],
      utcDay: FIXTURE_UTC_DAY,
    },
    reasoningEffortDescriptor()
  );
}

function textInputRequest(
  model: string,
  text: string,
  outputs: ModelDescriptor['outputs']
): InferenceRequest {
  return {
    model,
    inputs: [{ modality: 'text', text }],
    parameters: {},
    outputs,
    utcDay: FIXTURE_UTC_DAY,
  };
}

export function languageRequest(): InferenceRequest {
  return routedLanguage(
    textInputRequest(REAL_MODEL_IDS.language, 'Reply with a short greeting.', ['text']),
    languageDescriptor()
  );
}

/** An image call to a derived subject, as the image suite sends it. */
export function imageRequest(subject: ModelDescriptor): InferenceRequest {
  return textInputRequest(subject.id, 'A small red dot on a white background', ['image']);
}

export function videoRequest(): InferenceRequest {
  return textInputRequest(REAL_MODEL_IDS.video, 'A short panning shot of a calm landscape', [
    'video',
  ]);
}

interface MediaCapture {
  readonly mapFilePart: FilePartMapper;
  readonly captured: Uint8Array[];
}

/**
 * A real {@link FilePartMapper}: the port makes the caller decide where bytes
 * rest, so this maps each generated file part to media events and captures the
 * real bytes for structural assertions (the tests never persist to R2).
 */
export function makeMediaCapture(modality: 'image' | 'video'): MediaCapture {
  const captured: Uint8Array[] = [];
  const mapFilePart: FilePartMapper = (part, index) => {
    captured.push(part.data);
    const value: MediaValue = {
      ref: `media/integration/${modality}/${String(index)}`,
      mimeType: part.mediaType,
      modality,
      byteLength: part.data.byteLength,
      metadata: {},
    };
    return [
      { kind: 'media-start', index, modality, mimeType: part.mediaType },
      { kind: 'media-done', index, value },
    ];
  };
  return { mapFilePart, captured };
}

export async function consume(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Assert the stream ended on a `finish` and return its metadata (union narrowing). */
export function finishMetadata(events: readonly InferenceEvent[]): ProviderMetadata {
  const last = events.at(-1);
  if (last?.kind !== 'finish') {
    throw new Error(`expected a terminal finish event, saw ${last?.kind ?? 'nothing'}`);
  }
  return last.metadata;
}

/**
 * A normalized catalog beside the listing it was normalized from. The listing
 * holds the endpoint facts a descriptor drops: each ZDR endpoint's provider
 * name, tag, parameters and listed price, and each image endpoint's rows.
 */
export interface RoutingCatalog {
  readonly descriptors: readonly ModelDescriptor[];
  readonly listing: GatewayCatalog;
}

/** One proof's subject: the cheapest model carrying the behaviour the proof needs, or none. */
export type RoutingSubject = (catalog: RoutingCatalog) => ModelDescriptor | undefined;

/** The clock the catalog is normalized at: fixed, so a replayed listing normalizes identically. */
export const ROUTING_CATALOG_NOW_MS = TEST_DAY_START;

/** The production ingestion pipeline over one catalog fetch: listing, normalization, descriptors. */
export async function routingCatalogFrom(
  fetch: typeof globalThis.fetch,
  baseUrl: string
): Promise<RoutingCatalog> {
  const fetched = await fetchGatewayCatalog({ baseUrl, fetch });
  const listing = fetched.match(
    (catalog) => catalog,
    (error) => {
      throw new Error(`the gateway catalog could not be read: ${error.code}`);
    }
  );
  const descriptors = normalizeCatalog(
    listing.models,
    listing.zdrEndpoints,
    ROUTING_CATALOG_NOW_MS
  ).flatMap((entry) =>
    entry.kind === 'normalized'
      ? [ModelDescriptor.parse({ ...entry.content, fetchedAt: ROUTING_CATALOG_NOW_MS })]
      : []
  );
  return { descriptors, listing };
}

function entryId(entry: Record<string, unknown>): string {
  const id = entry['id'];
  if (typeof id !== 'string') throw new Error('a gateway fixture entry carries no id');
  return id;
}

/**
 * The local listing: one text model and one image model from the gateway
 * fixtures, each ZDR-listed under the tag its endpoint carries, so the
 * provider-agnostic legs each have a subject under the mock.
 */
export function fixtureRoutingCatalog(): Promise<RoutingCatalog> {
  const text = modelEntryFixture();
  const image = imageModelFixture();
  return routingCatalogFrom(
    catalogFetch({ models: [text], images: [image], zdrModelIds: [entryId(text), entryId(image)] }),
    TEST_GATEWAY_BASE_URL
  );
}

/**
 * The catalog the routing proofs derive their subjects from: on the
 * credentialled CI path the live listing through the record-on-miss cassette,
 * in the open occurrence scope, so the listing and the inference it prices
 * record and replay together; everywhere else the local fixture listing.
 */
export function loadRoutingCatalog(): Promise<RoutingCatalog> {
  if (!SHOULD_RUN) return fixtureRoutingCatalog();
  const fetch = createCassetteFetch({
    store: createCassetteStore({ rootDir: CASSETTE_ROOT }),
    mode: cassetteModeFor(),
    realFetch: globalThis.fetch.bind(globalThis),
  });
  return routingCatalogFrom(fetch, OPENROUTER_BASE_URL);
}

/**
 * A suite's routing catalog, loaded by the first test that asks for it, inside
 * that test's occurrence scope. Loading in a test rather than a hook is what
 * makes an unreachable gateway fail every leg that needs the catalog, where a
 * failed hook would report each of them as skipped.
 */
export function useRoutingCatalog(): () => Promise<RoutingCatalog> {
  let loaded: Promise<RoutingCatalog> | undefined;
  return () => (loaded ??= loadRoutingCatalog());
}

/** The cheapest candidate by `priceOf`, ties to the lower id; candidates it cannot price are passed over. */
function cheapestBy(
  candidates: readonly ModelDescriptor[],
  priceOf: (descriptor: ModelDescriptor) => bigint | undefined
): ModelDescriptor | undefined {
  let best: { readonly descriptor: ModelDescriptor; readonly price: bigint } | undefined;
  for (const descriptor of candidates) {
    const price = priceOf(descriptor);
    if (price === undefined) continue;
    if (
      best === undefined ||
      price < best.price ||
      (price === best.price && descriptor.id < best.descriptor.id)
    ) {
      best = { descriptor, price };
    }
  }
  return best?.descriptor;
}

function exposedOf(catalog: RoutingCatalog, family: 'language' | 'image'): ModelDescriptor[] {
  return catalog.descriptors.filter(
    (descriptor) => isExposedModel(descriptor) && callShapeFamilyFor(descriptor.outputs) === family
  );
}

/** A text model's anchor base rates added: the order the catalog's cheapest-model comparisons use. */
function textPrice(descriptor: ModelDescriptor): bigint | undefined {
  const priceable = priceableModelFrom(descriptor);
  return priceable === undefined ? undefined : combinedRateNanoUsd(priceable);
}

/** An image model's price per image at its anchor. */
function imagePrice(descriptor: ModelDescriptor): bigint | undefined {
  return priceMediaBillableNanoUsd(descriptor.pricing, 'image', {}).match(
    (price) => price,
    () => undefined
  );
}

/** Fractional digits a listed rate is read to: above any rate the vendor lists. */
const LISTED_RATE_SCALE = 30;

/** A listed decimal USD rate as an exact count of 10⁻³⁰ USD. */
function listedRateUnits(rate: string): bigint {
  if (!DECIMAL_USD_PATTERN.test(rate)) throw new Error('a listed rate is not a decimal USD amount');
  const [whole = '', fraction = ''] = rate.split('.');
  if (fraction.length > LISTED_RATE_SCALE) {
    throw new Error('a listed rate carries more digits than the comparison reads');
  }
  return BigInt(whole + fraction.padEnd(LISTED_RATE_SCALE, '0'));
}

/** One ZDR endpoint a call can be routed to, with its listed base rates. */
export interface ServingEndpoint {
  readonly providerName: string;
  readonly tag: string;
  readonly prompt: string;
  readonly completion: string;
  /** Whether it lacks a parameter the model may be sent, so serves only calls without it. */
  readonly lacksModelParameter: boolean;
}

/** The bucket ingestion files one endpoint under, asked of ingestion's own count. */
function bucketOf(endpoint: ZdrEndpoint, modelParameters: readonly string[]): EndpointBucket {
  const counts = endpointBucketCounts([endpoint], modelParameters);
  const bucket = ENDPOINT_BUCKETS.find((name) => counts[name] === 1);
  if (bucket === undefined) throw new Error('ingestion filed an endpoint under no bucket');
  return bucket;
}

/**
 * The model's endpoints a call it sends can reach: every standard-tier endpoint
 * with a price the schedule reads, including one lacking a parameter the call
 * does not send.
 */
function servingEndpointsOf(listing: GatewayCatalog, modelId: string): ServingEndpoint[] {
  const model = listing.models.find((entry) => entry.source === 'language' && entry.id === modelId);
  if (model?.source !== 'language') return [];
  return (listing.zdrEndpoints.get(modelId) ?? []).flatMap((endpoint) => {
    const bucket = bucketOf(endpoint, model.supportedParameters);
    if (bucket !== 'reachable' && bucket !== 'unsupported-parameter') return [];
    if (endpoint.pricing === 'unreadable') return [];
    const prompt = endpoint.pricing['prompt'];
    const completion = endpoint.pricing['completion'];
    if (typeof prompt !== 'string' || typeof completion !== 'string') return [];
    return [
      {
        providerName: endpoint.providerName,
        tag: endpoint.tag,
        prompt,
        completion,
        lacksModelParameter: bucket === 'unsupported-parameter',
      },
    ];
  });
}

function rateSum(endpoint: ServingEndpoint): bigint {
  return listedRateUnits(endpoint.prompt) + listedRateUnits(endpoint.completion);
}

/** The endpoints a cheapest-first route tries first: those at the lowest listed prompt + completion. */
export function cheapestServingEndpoints(
  catalog: RoutingCatalog,
  subject: ModelDescriptor
): ServingEndpoint[] {
  const serving = servingEndpointsOf(catalog.listing, subject.id);
  let lowest: bigint | undefined;
  for (const endpoint of serving) {
    const sum = rateSum(endpoint);
    if (lowest === undefined || sum < lowest) lowest = sum;
  }
  return serving.filter((endpoint) => rateSum(endpoint) === lowest);
}

/**
 * Whether the endpoint a cheapest-first route serves from is visible in the
 * serving endpoint's name: every other servable endpoint is at least 10%
 * dearer and under another provider name, and no cheapest endpoint lacks a
 * parameter the model may be sent, whose routing OpenRouter states two ways.
 */
function servesCheapestVisibly(catalog: RoutingCatalog, subject: ModelDescriptor): boolean {
  const cheapest = cheapestServingEndpoints(catalog, subject);
  const [first] = cheapest;
  if (first === undefined) return false;
  const lowest = rateSum(first);
  const names = new Set(cheapest.map((endpoint) => endpoint.providerName));
  const dearer = servingEndpointsOf(catalog.listing, subject.id).filter(
    (endpoint) => rateSum(endpoint) !== lowest
  );
  return (
    dearer.length > 0 &&
    dearer.every((endpoint) => rateSum(endpoint) * 10n >= lowest * 11n) &&
    dearer.every((endpoint) => !names.has(endpoint.providerName)) &&
    cheapest.every((endpoint) => !endpoint.lacksModelParameter)
  );
}

/**
 * The listed price of an image model's one output row across its pinned
 * endpoints, or `undefined` when those endpoints list none or more than one.
 */
export function listedOutputImagePrice(
  catalog: RoutingCatalog,
  subject: ModelDescriptor
): string | undefined {
  const pin = new Set<string>(subject.zdrPin);
  const model = catalog.listing.models.find(
    (entry) => entry.source === 'image' && entry.id === subject.id
  );
  if (model?.source !== 'image') return undefined;
  const rows = model.endpoints
    .filter((endpoint) => endpoint.providerTag !== null && pin.has(endpoint.providerTag))
    .flatMap((endpoint) => endpoint.pricing)
    .filter((row) => row.billable === 'output_image');
  return rows.length === 1 ? rows[0]?.costUsd : undefined;
}

/** A tag's base slug: the provider part before any region or tier variant. */
function baseSlugOf(tag: string): string {
  return tag.split('/')[0] ?? tag;
}

/**
 * A tag from the ZDR listing that pins no endpoint of the image model: its
 * base slug matches none of the model's endpoint tags, so neither OpenRouter's
 * equal-tag nor its base-slug rule reaches one. The first in tag order.
 */
export function foreignZdrTag(
  catalog: RoutingCatalog,
  subject: ModelDescriptor
): string | undefined {
  const model = catalog.listing.models.find(
    (entry) => entry.source === 'image' && entry.id === subject.id
  );
  const own = new Set(
    (model?.source === 'image' ? model.endpoints : []).flatMap((endpoint) =>
      endpoint.providerTag === null ? [] : [baseSlugOf(endpoint.providerTag)]
    )
  );
  const listed = [...catalog.listing.zdrEndpoints.values()].flat().map((endpoint) => endpoint.tag);
  return [...new Set(listed)]
    .toSorted((a, b) => a.localeCompare(b))
    .find((tag) => !own.has(baseSlugOf(tag)));
}

/**
 * Each routing proof's subject, derived from the catalog at run time rather
 * than pinned: a pinned id dies when the vendor retires the model, while a
 * predicate follows whatever currently carries the behaviour, and a changed
 * subject is a cassette miss the record-on-miss run records.
 */
export const ROUTING_SUBJECTS: {
  /** The cheapest exposed text model. */
  readonly ceiling: RoutingSubject;
  /** The cheapest exposed text model whose cheapest-first route shows in the serving endpoint's name. */
  readonly sortCheapest: RoutingSubject;
  /** The cheapest exposed image model whose pinned endpoints list exactly one output price. */
  readonly imageFlat: RoutingSubject;
  /** The cheapest exposed image model, which carries a pin by exposure. */
  readonly imagePin: RoutingSubject;
} = {
  ceiling: (catalog) => cheapestBy(exposedOf(catalog, 'language'), textPrice),
  sortCheapest: (catalog) =>
    cheapestBy(
      exposedOf(catalog, 'language').filter((descriptor) =>
        servesCheapestVisibly(catalog, descriptor)
      ),
      textPrice
    ),
  imageFlat: (catalog) =>
    cheapestBy(
      exposedOf(catalog, 'image').filter(
        (descriptor) => listedOutputImagePrice(catalog, descriptor) !== undefined
      ),
      imagePrice
    ),
  imagePin: (catalog) => cheapestBy(exposedOf(catalog, 'image'), imagePrice),
};

/** A routing proof's output cap: enough for a reply, small enough to cost little. */
const ROUTING_MAX_OUTPUT_TOKENS = 16;

/**
 * A text call to a derived subject, routed at the `max_price` given, or at the
 * call's derived ceiling when none is.
 */
export function routingRequest(subject: ModelDescriptor, maxPrice?: MaxPrice): InferenceRequest {
  const request: InferenceRequest = {
    ...textInputRequest(subject.id, 'Reply with a short greeting.', ['text']),
    parameters: { maxOutputTokens: ROUTING_MAX_OUTPUT_TOKENS },
  };
  return maxPrice === undefined
    ? routedLanguage(request, subject)
    : { ...request, routing: { maxPrice } };
}
