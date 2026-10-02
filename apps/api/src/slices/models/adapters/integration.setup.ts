import { afterAll, beforeAll, beforeEach } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { evidenceDatabaseUrl } from '@hushbox/db/test-db';
import {
  CLASSIFICATION_VARIABLES,
  createEnvUtilities,
  planReasoning,
  planReasoningOff,
  reasoningPlanModelFrom,
  utcDayKey,
} from '@hushbox/shared';
import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from '@hushbox/shared/pricing-fixture';
import { requireEnv } from '@hushbox/shared/require-env';
import { OLD_RELEASE_SECONDS, TEST_DAY_START } from '@hushbox/shared/test-instants';
import { resolveModelProvider } from './resolve-model-provider.js';
import {
  beginCassetteScope,
  cassetteScopeIsOpen,
  endCassetteScope,
} from './cassette/recording-fetch.js';
import type { Database } from '@hushbox/db';
import type {
  EnvContext,
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  MediaValue,
  ModelDescriptor,
  ProviderMetadata,
} from '@hushbox/shared';
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
 * The model called per modality. Each MUST be ZDR-reachable at record time:
 * every real call carries OpenRouter's `provider.zdr:true`, which fails closed
 * on a non-ZDR model — so a wrong id fails loudly on the record run, the right
 * place to catch it. (The adapters' own descriptor ZDR guard never fires here —
 * `descriptorFor` hardcodes `zdrReachable: true`, so the operative fail-closed
 * is the per-request `provider.zdr` flag, not the descriptor check.) Hardcoded
 * (not picked from the drifting live catalog) so each inference request hashes
 * stably and its cassette replays deterministically; this is the single place
 * to adjust.
 */
const REAL_MODEL_IDS = {
  language: 'openai/gpt-4o',
  image: 'google/imagen-4.0-generate-001',
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
  const provider = resolveModelProvider({ useMock: false, apiKey, isCI, db });
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
        resolveModelProvider({ useMock: true, apiKey: '', isCI, db: undefined })
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

/** A nominal price of the kind each output modality is charged by; no adapter reads it. */
function pricingFor(outputs: ModelDescriptor['outputs']): ModelDescriptor['pricing'] {
  if (outputs.includes('image')) return perImagePricingFixture({ anchor: 1n, dearest: 1n });
  if (outputs.includes('video')) {
    return perSecondPricingFixture({ anchor: { '720p': 1n }, dearest: { '720p': 1n } });
  }
  return tokenPricingFixture({ input: 1n, output: 1n });
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
    version: '3',
    inputs: ['text'],
    outputs,
    parameters: {},
    behaviors,
    limits: {},
    pricing: pricingFor(outputs),
    zdrReachable: true,
    releasedAt: OLD_RELEASE_SECONDS,
    fetchedAt: 0,
  };
}

export function languageDescriptor(): ModelDescriptor {
  return descriptorFor(REAL_MODEL_IDS.language, ['text'], ['streaming']);
}

export function imageDescriptor(): ModelDescriptor {
  return descriptorFor(REAL_MODEL_IDS.image, ['image'], []);
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

export function reasoningEffortRequest(): InferenceRequest {
  return {
    model: REASONING_MODEL_IDS.effortNative,
    inputs: [{ modality: 'text', text: REASONING_PROMPT }],
    parameters: reasoningParameters(reasoningEffortDescriptor()),
    outputs: ['text'],
    utcDay: FIXTURE_UTC_DAY,
  };
}

export function reasoningBudgetRequest(): InferenceRequest {
  return {
    model: REASONING_MODEL_IDS.budgetNative,
    inputs: [{ modality: 'text', text: REASONING_PROMPT }],
    parameters: reasoningParameters(reasoningBudgetDescriptor()),
    outputs: ['text'],
    utcDay: FIXTURE_UTC_DAY,
  };
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
  return {
    model: REASONING_MODEL_IDS.effortNative,
    inputs: [{ modality: 'text', text: REASONING_PROMPT }],
    parameters: { reasoning: result.plan.wire, maxOutputTokens: result.plan.maxTokens },
    outputs: ['text'],
    utcDay: FIXTURE_UTC_DAY,
  };
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
  return textInputRequest(REAL_MODEL_IDS.language, 'Reply with a short greeting.', ['text']);
}

export function imageRequest(): InferenceRequest {
  return textInputRequest(REAL_MODEL_IDS.image, 'A small red dot on a white background', ['image']);
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
