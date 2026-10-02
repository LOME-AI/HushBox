import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  ERROR_CODES,
  Node as NodeSchema,
  WEB_SEARCH_TOOL_NAME,
  WorkflowDefinition,
  createEnvUtilities,
  serializeSegments,
  textTag,
  utcDayKey,
} from '@hushbox/shared';
import { Mode, envConfig, resolveRaw } from '@hushbox/shared/env.config';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { generateEpochKeyPair } from '@hushbox/crypto';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { TRIAL_DAILY_SPEND_CAP_NANO_USD } from '../../billing/index.js';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  SettlementConflictError,
  createConstraintRegistry,
} from '../../workflows/index.js';
import { conflictError } from '../../../lib/errors/index.js';
import { ok, okAsync } from '../../../lib/result/index.js';
import { InferenceError, createToolRegistry, mockProviderEnabled } from '../../models/index.js';
import { createChatConversationRuntime } from '../conversation-runtime.js';
import {
  adaptersFor,
  attachVideoProgress,
  chatSettlementIdentity,
  createConversationRuntime,
  createExecutionResolvers,
  createTurnExecutionRegistry,
  engineRandom,
  prepareStartRequest,
  usesMockProvider,
  withAnswerMessageIds,
  withMediaPutBarrier,
  withPostCommitSnapshotRefresh,
} from './runtime.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_NODE_ID, TRIAL_TURN_HOOKS } from './constants.js';
import type { ChatHookBindings, ConversationRuntimeDeps, HeldStartRequest } from './runtime.js';
import type { MediaPersistPlan } from '@hushbox/shared';
import type { ChatStores } from '../ports/stores.js';
import type { ModelBinding } from '../../workflows/index.js';
import type { ModelProvider, ToolRegistry } from '../../models/index.js';
import type { Bindings } from '../../../lib/context/index.js';
import type { VariableConfig } from '@hushbox/shared/env.config';
import type { TransformCompute } from '../../media/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  InferenceEvent,
  InferenceRequest,
  MockDirectives,
  ModelDescriptor,
  Node,
  RunContext,
} from '@hushbox/shared';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);
const FIXTURE_UTC_DAY = utcDayKey(new Date(TEST_DAY_START));

const telemetry: Telemetry = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  captureError: vi.fn(),
};

const chatStores: ChatStores = {
  latestMessageIdWithinTx: () => Promise.resolve(null),
  insertMessageWithinTx: () => Promise.resolve(),
  insertContentItemWithinTx: () => Promise.resolve(),
  messageRefWithinTx: () => Promise.resolve(null),
  deleteMessagesByIdWithinTx: () => Promise.resolve(),
  childMessageIdsWithinTx: () => Promise.resolve([]),
  reparentMessagesWithinTx: () => Promise.resolve(),
};

const DEFINITION: WorkflowDefinition = {
  version: 1,
  deadlineClass: 'text',
  hooks: CHAT_TURN_HOOKS,
  nodes: [],
  edges: [],
} as unknown as WorkflowDefinition;

const CONTEXT: RunContext = {
  mode: 'paid',
  payerUserId: 'u1',
  sender: { kind: 'user', userId: 'u1' },
  conversationId: 'c1',
  walletId: 'w1',
  epochNumber: 1,
  userMessage: { id: 'um1', content: 'hi' },
  runId: 'run-1',
  fence: { id: 'f', executorId: 'e', claims: 1 },
};

/** Redis whose snapshot read and script exec both reject — the fail-closed admission path. */
const rejectingRedis = {
  get: () => Promise.reject(new Error('redis down')),
  createScript: () => ({ exec: () => Promise.reject(new Error('redis down')) }),
} as unknown as ConversationRuntimeDeps['redis'];

/**
 * A db whose only supported read is the admission hook's membership lookup,
 * which returns no member — so no member-budget scope applies and admission
 * proceeds to the balance/run-cap gate the tests actually exercise.
 */
const noMemberDb = {
  select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
} as unknown as ConversationRuntimeDeps['db'];

/** Text-turn paths must never reach storage; a throwing proxy proves it. */
const untouchedStorage = new Proxy(
  {},
  {
    get() {
      throw new Error('storage must not be touched by this path');
    },
  }
) as ConversationRuntimeDeps['storage'];

function deps(overrides: Partial<ConversationRuntimeDeps>): ConversationRuntimeDeps {
  return {
    db: noMemberDb,
    redis: {} as unknown as ConversationRuntimeDeps['redis'],
    telemetry,
    apiKey: 'k',
    searchApiKey: 'k',
    isCI: false,
    chatStores,
    storage: untouchedStorage,
    readEpochPublicKey: () => Promise.resolve(null),
    ...overrides,
  };
}

/** A Redis whose trial daily-spend counter reads at the cap — the trial admission refuses. */
const trialCapReachedRedis = {
  get: () => Promise.resolve(TRIAL_DAILY_SPEND_CAP_NANO_USD.toString(10)),
} as unknown as ConversationRuntimeDeps['redis'];

/** A db whose catalog read rejects — the executor build must fail the run. */
const catalogDownDb = {
  select: () => ({ from: () => Promise.reject(new Error('catalog down')) }),
} as unknown as ConversationRuntimeDeps['db'];

/** The referee's claim-insert chain, recording the row before failing the claim. */
function claimRecordingDb(rows: Record<string, unknown>[]): ConversationRuntimeDeps['db'] {
  const chain = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        rows.push(row);
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.reject(new Error('claim insert refused')),
          }),
        };
      },
    }),
  };
  return chain as unknown as ConversationRuntimeDeps['db'];
}

/** A db whose key-row insert rejects — the referee surfaces an infra failure. */
const refereeDownDb = {
  insert: () => ({
    values: () => ({
      onConflictDoNothing: () => ({ returning: () => Promise.reject(new Error('db down')) }),
    }),
  }),
} as unknown as ConversationRuntimeDeps['db'];

const HOOKS = {
  admission: () =>
    Promise.resolve({
      admitted: true as const,
      holdRef: 'h',
      circuit: { estimateNanoUsd: 1n, costCircuitMultiplier: 5n, costCircuitLimitNanoUsd: 5n },
    }),
  settlement: () => Promise.resolve(),
  answerMessageIds: new Map<string, string>(),
  assistantMessageIds: [],
};

describe('usesMockProvider (production-inert gate)', () => {
  const crafted: MockDirectives = {
    classifierResolution: 'x/model',
    classifierFailure: true,
    failingModels: ['m'],
    classifierDelayMs: 5,
  };

  it('selects the mock in dev/E2E when a run carries directives', () => {
    expect(usesMockProvider({ mockProviderEnabled: true }, {})).toBe(true);
    expect(usesMockProvider({ mockProviderEnabled: true }, { classifierResolution: 'a' })).toBe(
      true
    );
  });

  it('selects the real provider in dev/E2E when a run carries NO directives', () => {
    const absent: MockDirectives | undefined = undefined;
    expect(usesMockProvider({ mockProviderEnabled: true }, absent)).toBe(false);
  });

  it('NEVER selects the mock in production, even for a crafted directives body', () => {
    // The paramount safety property: the DO-side env gate is false in production,
    // so no request body content can reach the mock there.
    expect(usesMockProvider({ mockProviderEnabled: false }, crafted)).toBe(false);
    expect(usesMockProvider({ mockProviderEnabled: false }, {})).toBe(false);
  });

  it('defaults to the real provider when the gate is unset (CI-vitest / cassettes)', () => {
    expect(usesMockProvider({}, crafted)).toBe(false);
  });
});

describe('adaptersFor: the per-run model provider', () => {
  /** A run's model provider, resolved through the derivation that also picks its search. */
  function providerOf(
    deps: { readonly mockProviderEnabled: boolean; readonly apiKey: string; isDevServer?: boolean },
    mockDirectives?: MockDirectives,
    awaitStreamRelease?: () => Promise<void>
  ): ModelProvider {
    return adaptersFor(
      { searchApiKey: '', isCI: false, telemetry, ...deps },
      mockDirectives,
      awaitStreamRelease
    ).provider;
  }

  function languageDescriptor(id: string): ModelDescriptor {
    return {
      id,
      provider: 'p',
      version: '1',
      inputs: ['text'],
      outputs: ['text'],
      parameters: {},
      behaviors: [],
      limits: {},
      pricing: tokenPricingFixture({ input: 1n, output: 1n }),
      zdrReachable: true,
      releasedAt: FIXTURE_STAMP_SECONDS,
      fetchedAt: 0,
    };
  }
  function classifierRequest(model: string): InferenceRequest {
    return {
      model,
      inputs: [{ modality: 'text', text: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nchoose` }],
      parameters: {},
      outputs: ['text'],
      utcDay: FIXTURE_UTC_DAY,
    };
  }
  async function classifierText(provider: ModelProvider): Promise<string> {
    const model = 'base/model';
    let text = '';
    for await (const event of provider.infer(classifierRequest(model), languageDescriptor(model))) {
      if (event.kind === 'text-delta') text += event.content;
    }
    return text;
  }

  it('varies mock classifier behavior per run by the run’s directives (A vs B)', async () => {
    const dev = { mockProviderEnabled: true, apiKey: '' } as const;
    const a = await classifierText(providerOf(dev, { classifierResolution: 'model-A' }));
    const b = await classifierText(providerOf(dev, { classifierResolution: 'model-B' }));
    // The mock answers one labelled line per dimension, as the shared prompt instructs.
    expect(a).toBe('model: model-A');
    expect(b).toBe('model: model-B');
    expect(a).not.toBe(b);
  });

  it('fails a directed model’s generation on the mock (a distinct per-run behavior)', async () => {
    const dev = { mockProviderEnabled: true, apiKey: '' } as const;
    const model = 'base/model';
    const textRequest: InferenceRequest = {
      model,
      inputs: [{ modality: 'text', text: 'hello' }],
      parameters: {},
      outputs: ['text'],
      utcDay: FIXTURE_UTC_DAY,
    };
    const provider = providerOf(dev, { failingModels: [model] });
    const stream = provider.infer(textRequest, languageDescriptor(model));
    const drain = async (): Promise<void> => {
      for await (const event of stream) expect(event).toBeDefined();
    };
    await expect(drain()).rejects.toThrow();
  });

  it('returns the real provider in production regardless of a crafted directives body', () => {
    // No network is driven here — the decisive guarantee is that the gate the
    // real branch is chosen through is false, so the mock is never constructed.
    const production = { mockProviderEnabled: false, apiKey: 'k' } as const;
    expect(usesMockProvider(production, { classifierResolution: 'model-A' })).toBe(false);
  });

  it('threads the held-stream release awaitable into the per-run mock provider', async () => {
    const dev = { mockProviderEnabled: true, apiKey: '' } as const;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const model = 'base/model';
    const request: InferenceRequest = {
      model,
      inputs: [{ modality: 'text', text: 'hello' }],
      parameters: {},
      outputs: ['text'],
      utcDay: FIXTURE_UTC_DAY,
    };
    const provider = providerOf(dev, { holdPrimaryStream: true }, () => gate);
    const iterator = provider.infer(request, languageDescriptor(model))[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);

    let settled = false;
    const secondPull = (async () => {
      const result = await iterator.next();
      settled = true;
      return result;
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    releaseGate();
    await secondPull;
    expect(settled).toBe(true);
  });

  it('threads deps.isDevServer so the mock applies default delays ONLY on a dev server', async () => {
    vi.useFakeTimers();
    try {
      const model = 'base/model';
      const request: InferenceRequest = {
        model,
        inputs: [{ modality: 'text', text: 'a prompt long enough to force several echo chunks' }],
        parameters: {},
        outputs: ['text'],
        utcDay: FIXTURE_UTC_DAY,
      };
      const drain = async (provider: ModelProvider): Promise<void> => {
        for await (const event of provider.infer(request, languageDescriptor(model))) {
          expect(event).toBeDefined();
        }
      };

      // Dev server → the 60ms inter-chunk default applies (no directive set), so
      // a multi-chunk echo cannot settle until the timers advance.
      const devServer = { mockProviderEnabled: true, apiKey: '', isDevServer: true } as const;
      let devSettled = false;
      const devPending = (async (): Promise<void> => {
        await drain(providerOf(devServer, {}));
        devSettled = true;
      })();
      await vi.advanceTimersByTimeAsync(0);
      expect(devSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(60 * 50);
      await devPending;
      expect(devSettled).toBe(true);

      // isDevServer omitted (E2E / vitest / CI branch) → instant: settles with no advance.
      const notDevServer = { mockProviderEnabled: true, apiKey: '' } as const;
      let plainSettled = false;
      const plainPending = (async (): Promise<void> => {
        await drain(providerOf(notDevServer, {}));
        plainSettled = true;
      })();
      await vi.advanceTimersByTimeAsync(0);
      expect(plainSettled).toBe(true);
      await plainPending;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('adaptersFor (the composition root of a run’s adapters)', () => {
  /** The classification variables the env registry gives one mode, as the Worker's bindings carry them. */
  function classificationFor(mode: Mode): Bindings {
    const read = (config: VariableConfig): string | undefined => {
      const raw = resolveRaw(config, mode);
      return typeof raw === 'string' ? raw : undefined;
    };
    const nodeEnv = read(envConfig.NODE_ENV);
    const ci = read(envConfig.CI);
    const e2e = read(envConfig.E2E);
    return {
      ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
      ...(ci === undefined ? {} : { CI: ci }),
      ...(e2e === undefined ? {} : { E2E: e2e }),
    };
  }

  const unreachableModel: ModelDescriptor = {
    id: 'probe/model',
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: tokenPricingFixture({ input: 1n, output: 1n }),
    zdrReachable: false,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };

  /**
   * The mock streams any model it is handed; the real adapter refuses a model
   * outside the ZDR set before any call leaves the process.
   */
  function isMockModelProvider(provider: ModelProvider): boolean {
    const request: InferenceRequest = {
      model: unreachableModel.id,
      inputs: [{ modality: 'text', text: 'probe' }],
      parameters: {},
      outputs: ['text'],
      utcDay: FIXTURE_UTC_DAY,
    };
    try {
      provider.infer(request, unreachableModel);
      return true;
    } catch (error) {
      if (error instanceof InferenceError) return false;
      throw error;
    }
  }

  /**
   * Whether the run's web-search tool searches with the fake. The fake answers
   * even under a cancelled signal; Brave honours the cancellation before any
   * request leaves the process, rethrowing the signal's reason.
   */
  async function searchesWithTheFake(tools: ToolRegistry): Promise<boolean> {
    const cancelled = new AbortController();
    cancelled.abort(new Error('probe cancelled'));
    try {
      await tools[WEB_SEARCH_TOOL_NAME].execute({ query: 'probe' }, { signal: cancelled.signal });
      return true;
    } catch (error) {
      if (error === cancelled.signal.reason) return false;
      throw error;
    }
  }

  const realKeys = { apiKey: 'test-openrouter-key', searchApiKey: 'test-brave-key' };

  function runAdapters(
    mode: Mode,
    mockDirectives?: MockDirectives,
    keys: { readonly apiKey: string; readonly searchApiKey: string } = realKeys
  ): ReturnType<typeof adaptersFor> {
    const utilities = createEnvUtilities(classificationFor(mode));
    return adaptersFor(
      {
        mockProviderEnabled: mockProviderEnabled(utilities),
        isCI: utilities.isCI,
        ...keys,
        db: noMemberDb,
        telemetry,
      },
      mockDirectives
    );
  }

  const cases = Object.values(Mode).flatMap((mode) => [
    { mode, run: 'carrying mock directives', directives: {} satisfies MockDirectives },
    { mode, run: 'carrying none', directives: undefined },
  ]);

  it.each(cases)(
    'resolves the fake search adapter exactly when the mock model provider, in $mode for a run $run',
    async ({ mode, directives }) => {
      const adapters = runAdapters(mode, directives);
      expect(await searchesWithTheFake(adapters.tools)).toBe(
        isMockModelProvider(adapters.provider)
      );
    }
  );

  it('pairs the stand-ins on the development stack', async () => {
    const adapters = runAdapters(Mode.Development, {});
    expect(isMockModelProvider(adapters.provider)).toBe(true);
    expect(await searchesWithTheFake(adapters.tools)).toBe(true);
  });

  it('pairs the real adapters in production', async () => {
    const adapters = runAdapters(Mode.Production, {});
    expect(isMockModelProvider(adapters.provider)).toBe(false);
    expect(await searchesWithTheFake(adapters.tools)).toBe(false);
  });

  /** A local stack's key, which each resolver refuses to record CI cassettes with. */
  function localPlaceholder(config: VariableConfig): string {
    const raw = resolveRaw(config, Mode.Development);
    if (typeof raw !== 'string') throw new Error('a local placeholder key is a plain string');
    return raw;
  }

  /** Whether building a run's adapters is refused for recording CI cassettes with `keys`. */
  function refusesToRecord(
    mode: Mode,
    mockDirectives: MockDirectives | undefined,
    keys: { readonly apiKey: string; readonly searchApiKey: string },
    key: string
  ): boolean {
    try {
      runAdapters(mode, mockDirectives, keys);
      return false;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return (
        error.message.includes('refusing to record CI cassettes') && error.message.includes(key)
      );
    }
  }

  it.each(cases)(
    'records web search through the CI cassette exactly when inference is, in $mode for a run $run',
    ({ mode, directives }) => {
      const searchRecords = refusesToRecord(
        mode,
        directives,
        { ...realKeys, searchApiKey: localPlaceholder(envConfig.BRAVE_SEARCH_API_KEY) },
        'BRAVE_SEARCH_API_KEY'
      );
      const inferenceRecords = refusesToRecord(
        mode,
        directives,
        { ...realKeys, apiKey: localPlaceholder(envConfig.OPENROUTER_API_KEY) },
        'OPENROUTER_API_KEY'
      );
      expect(searchRecords).toBe(inferenceRecords);
    }
  );

  it('records web search through the CI cassette on the CI test stack', () => {
    const placeholders = {
      apiKey: 'test-openrouter-key',
      searchApiKey: localPlaceholder(envConfig.BRAVE_SEARCH_API_KEY),
    };
    expect(refusesToRecord(Mode.CiVitest, undefined, placeholders, 'BRAVE_SEARCH_API_KEY')).toBe(
      true
    );
  });

  /** The R2 bindings the composer's storage adapter reads (local-stack names). */
  const r2Env = {
    R2_S3_ENDPOINT: 'http://localhost:9000',
    R2_BUCKET_MEDIA: 'media',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
  };

  /** The key a mode's composer refuses to build without, or `undefined` when it builds. */
  function missingKey(mode: Mode, keys: Record<string, string>): string | undefined {
    try {
      createChatConversationRuntime({
        db: noMemberDb,
        // Construction never reads Redis: admission reaches it only once a run starts.
        redis: {} as unknown as ConversationRuntimeDeps['redis'],
        telemetry,
        env: { ...classificationFor(mode), ...r2Env, ...keys },
        readEpochPublicKey: () => Promise.resolve(null),
      });
      return undefined;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return /missing required binding (\w+)/.exec(error.message)?.[1];
    }
  }

  it.each(Object.values(Mode))(
    'demands the web-search key exactly where it demands the inference key, in %s',
    (mode) => {
      const demandsInferenceKey =
        missingKey(mode, { BRAVE_SEARCH_API_KEY: 'k' }) === 'OPENROUTER_API_KEY';
      const demandsSearchKey =
        missingKey(mode, { OPENROUTER_API_KEY: 'k' }) === 'BRAVE_SEARCH_API_KEY';
      expect(demandsSearchKey).toBe(demandsInferenceKey);
    }
  );

  it('demands the web-search key in production, naming it', () => {
    expect(missingKey(Mode.Production, { OPENROUTER_API_KEY: 'k' })).toBe('BRAVE_SEARCH_API_KEY');
  });

  it('builds on the development stack with neither key', () => {
    expect(missingKey(Mode.Development, {})).toBeUndefined();
  });
});

describe('conversation runtime executor', () => {
  it('fails the run when the model catalog snapshot is unavailable', async () => {
    const runtime = createConversationRuntime(deps({ db: catalogDownDb }));
    const handle = runtime.executor.start({
      definition: DEFINITION,
      inputs: {},
      hooks: HOOKS,
      runKey: 'k',
      emit: () => {},
    });
    await expect(handle.done).rejects.toThrow(/catalog/);
  });

  it('attaches (and terminally stops) the video progress wiring on a media-classed run', async () => {
    vi.useFakeTimers();
    try {
      const mediaDefinition = { ...DEFINITION, deadlineClass: 'media' } as WorkflowDefinition;
      const runtime = createConversationRuntime(deps({ db: catalogDownDb }));
      const handle = runtime.executor.start({
        definition: mediaDefinition,
        inputs: {},
        hooks: HOOKS,
        runKey: 'k',
        emit: () => {},
      });
      await expect(handle.done).rejects.toThrow(/catalog/);
      // The terminal sink cleared the wrapper — a killed run leaks no timer.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('attachVideoProgress (start-request wiring)', () => {
  it('returns the very same request for a text-classed run (byte-identical path)', () => {
    const request: HeldStartRequest = {
      definition: DEFINITION,
      inputs: {},
      hooks: HOOKS,
      runKey: 'k',
      emit: () => {},
    };
    const attached = attachVideoProgress(request);
    expect(attached.request).toBe(request);
  });

  it('wraps emit for a media-classed run and injects video progress frames', () => {
    vi.useFakeTimers();
    try {
      const frames: Parameters<HeldStartRequest['emit']>[0][] = [];
      const mediaDefinition = WorkflowDefinition.parse({
        version: 1,
        deadlineClass: 'media',
        hooks: { admission: 'chat', settlement: 'chat' },
        nodes: [
          {
            id: 'answer',
            type: 'modelCall',
            version: 1,
            out: 'out',
            model: 'video-model',
            params: { durationSeconds: 9 },
            in: { node: 'input', port: 'prompt' },
          },
        ],
        edges: [],
      });
      const request: HeldStartRequest = {
        definition: mediaDefinition,
        inputs: {},
        hooks: HOOKS,
        runKey: 'k',
        emit: (frame) => frames.push(frame),
      };
      const attached = attachVideoProgress(request);
      expect(attached.request).not.toBe(request);
      attached.request.emit({
        streamId: 'answer#0',
        cursor: 1,
        event: { kind: 'stream-start', modelId: 'video-model', outputModality: 'video' },
      });
      vi.advanceTimersByTime(8000);
      expect(frames.map((frame) => frame.event.kind)).toEqual(['stream-start', 'media-progress']);
      attached.stopProgress();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('conversation runtime claimRun (infra failure)', () => {
  it('rethrows a non-conflict referee failure as unavailable', async () => {
    const runtime = createConversationRuntime(deps({ db: refereeDownDb }));
    await expect(
      runtime.claimRun({
        runKey: 'k',
        runId: 'r',
        bodyHash: 'h',
        identity: {
          mode: 'paid',
          payerUserId: 'u1',
          sender: { kind: 'user', userId: 'u1' },
          conversationId: 'c1',
          walletId: 'w1',
          epochNumber: 1,
          userMessage: { id: 'um1', content: 'hi' },
        },
      })
    ).rejects.toThrow(/run referee unavailable/);
  });

  it('scopes a trial claim on the session id (reaching the referee with the trial identity)', async () => {
    const runtime = createConversationRuntime(deps({ db: refereeDownDb }));
    // The trial branch derives the key-row scope from the session id; the fake
    // referee then rejects, proving the trial identity flowed through the claim.
    await expect(
      runtime.claimRun({
        runKey: 'k',
        runId: 'r',
        bodyHash: 'h',
        identity: { mode: 'trial', sessionId: 's1' },
      })
    ).rejects.toThrow(/run referee unavailable/);
  });
});

describe('conversation runtime bindHooks (policy dispatch)', () => {
  const TRIAL_CONTEXT: RunContext = {
    mode: 'trial',
    sessionId: 's1',
    runId: 'run-1',
    fence: { id: 'f', executorId: 'e', claims: 1 },
  };

  it('fails fast when the definition declares an unregistered policy', () => {
    const runtime = createConversationRuntime(deps({}));
    const unknownDefinition = {
      ...DEFINITION,
      hooks: { admission: 'mystery', settlement: 'mystery' },
    } as unknown as WorkflowDefinition;
    expect(() => runtime.bindHooks(CONTEXT, unknownDefinition)).toThrow(/no policy registered/);
  });

  it('accepts a fork-scoped run context', () => {
    const runtime = createConversationRuntime(deps({}));
    // A no-throw carries a claim here only because the binder does refuse: the
    // unregistered-policy and non-paid-identity cases in this describe throw.
    expect(() => runtime.bindHooks({ ...CONTEXT, forkId: 'fork-1' }, DEFINITION)).not.toThrow();
  });

  it('accepts a regenerate run context', () => {
    const runtime = createConversationRuntime(deps({}));
    expect(() =>
      runtime.bindHooks(
        { ...CONTEXT, regenerate: { action: 'retry', targetMessageId: 'anchor-1' } },
        DEFINITION
      )
    ).not.toThrow();
  });

  it('fails fast when a chat definition is bound under a non-paid identity', () => {
    const runtime = createConversationRuntime(deps({}));
    expect(() => runtime.bindHooks(TRIAL_CONTEXT, DEFINITION)).toThrow(/paid run identity/);
  });

  const TRIAL_DEFINITION = { ...DEFINITION, hooks: TRIAL_TURN_HOOKS } as WorkflowDefinition;

  it('binds the trial policy for a trial definition under a trial identity', async () => {
    const runtime = createConversationRuntime(deps({ redis: trialCapReachedRedis }));
    const hooks = runtime.bindHooks(TRIAL_CONTEXT, TRIAL_DEFINITION);
    // TRIAL_CAPACITY_REACHED comes from the daily-spend counter the trial
    // admission reads; the chat policy places a wallet hold and can never
    // produce it, so the code names which policy was bound.
    const decision = await hooks.admission({ definition: TRIAL_DEFINITION, estimate: 1n as never });
    expect(decision).toEqual({ admitted: false, code: ERROR_CODES.TRIAL_CAPACITY_REACHED });
  });

  it('fails fast when a trial definition is bound under a non-trial identity', () => {
    const runtime = createConversationRuntime(deps({}));
    expect(() => runtime.bindHooks(CONTEXT, TRIAL_DEFINITION)).toThrow(/trial run identity/);
  });
});

describe('createExecutionResolvers', () => {
  it('resolves no sub-workflow for any ref', () => {
    const resolvers = createExecutionResolvers(
      createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES)
    );
    expect(resolvers.subWorkflows.resolve('anything')).toBeUndefined();
  });

  it('delegates schema lookups to the constraint registry (both arms)', () => {
    const constraints = createConstraintRegistry({
      ...DEFAULT_WORKFLOW_CAPABILITIES,
      schemas: [{ name: 'probe', version: 1, schema: z.string() }],
    });
    const resolvers = createExecutionResolvers(constraints);
    expect(resolvers.schemas.resolveSchema('probe')).toBeDefined();
    expect(resolvers.schemas.resolveSchema('missing')).toBeUndefined();
  });
});

/**
 * A provider whose stream carries no terminal finish, so the call lands on the
 * pathological missing-inline-cost path — the path where the modelCall node
 * raises the provider-cost alert.
 */
const costlessProvider: ModelProvider = {
  infer: () =>
    (async function* stream(): AsyncGenerator<InferenceEvent> {
      await Promise.resolve();
      yield { kind: 'text-delta', index: 0, content: 'ok' };
    })(),
};

const ANSWER_DESCRIPTOR: ModelDescriptor = {
  id: 'answer-model',
  provider: 'p',
  version: '1',
  inputs: ['text'],
  outputs: ['text'],
  parameters: {},
  behaviors: [],
  limits: {},
  pricing: tokenPricingFixture({ input: 1n, output: 1n }),
  zdrReachable: true,
  releasedAt: FIXTURE_STAMP_SECONDS,
  fetchedAt: 0,
};

const ANSWER_BINDING: ModelBinding = {
  descriptor: ANSWER_DESCRIPTOR,
  ports: { in: [textTag()], out: textTag() },
  price: () => ok(1n),
};

function answerNode(): Extract<Node, { type: 'modelCall' }> {
  return NodeSchema.parse({
    id: 'm',
    type: 'modelCall',
    version: 1,
    out: 'out',
    model: 'answer-model',
    params: {},
    in: { node: 'input', port: 'prompt' },
  }) as Extract<Node, { type: 'modelCall' }>;
}

describe('createTurnExecutionRegistry', () => {
  it('raises the missing-provider-cost alert through the runtime telemetry', async () => {
    const runtimeTelemetry: Telemetry = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      captureError: vi.fn(),
    };
    const execution = createTurnExecutionRegistry({
      provider: costlessProvider,
      models: { resolve: (id) => (id === 'answer-model' ? ANSWER_BINDING : undefined) },
      compute: { execute: vi.fn(), resolvePorts: vi.fn() } as unknown as TransformCompute,
      constraints: createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES),
      telemetry: runtimeTelemetry,
      tools: createToolRegistry({
        search: { search: () => Promise.reject(new Error('this answer node carries no tools')) },
      }),
    });
    const node = answerNode();
    // The closed node run context, with an unmetered value store.
    const nodeContext = {
      values: {
        budgetBytes: 1_000_000,
        store: <V>(value: V) => ok(value),
        resolve: <V>(value: V): V => value,
        usedBytes: () => 0,
        reserve: () => ({ allowanceBytes: 1_000_000, release: () => undefined }),
      },
      clock: { now: () => 0 },
      rng: { random: () => 0.5 },
      signal: new AbortController().signal,
    };
    const result = await execution.resolveExecution(node)?.run(node, ['hi'], nodeContext);
    expect(result?.isOk()).toBe(true);
    expect(runtimeTelemetry.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      'inference_provider_cost_unavailable'
    );
  });
});

describe('engineRandom', () => {
  it('returns a value in [0, 1)', () => {
    const value = engineRandom();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });
});

describe('conversation runtime admission (fail-closed)', () => {
  it('maps a Redis-down admission failure to ADMISSION_UNAVAILABLE', async () => {
    const runtime = createConversationRuntime(deps({ redis: rejectingRedis }));
    const hooks = runtime.bindHooks(CONTEXT, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: 1n as never });
    expect(decision).toEqual({ admitted: false, code: 'ADMISSION_UNAVAILABLE' });
  });

  it('mints the run claim under the injected id source', async () => {
    const claimRows: Record<string, unknown>[] = [];
    const now = (): Date => new Date(TEST_DAY_START);
    const newId = (): string => 'fixed-id';
    const runtime = createConversationRuntime(
      deps({ db: claimRecordingDb(claimRows), now, newId })
    );
    // The executor id the claim is written under comes from the injected id
    // source; reading it back off the claim row is what separates the injection
    // from the uuid default. The clock rides the same construction.
    runtime.bindHooks(CONTEXT, DEFINITION);
    await expect(
      runtime.claimRun({
        runKey: 'k',
        runId: 'r',
        bodyHash: 'h',
        identity: { mode: 'trial', sessionId: 's1' },
      })
    ).rejects.toThrow(/run referee unavailable/);
    expect(claimRows[0]?.['claimedBy']).toBe('fixed-id');
  });
});

/** Redis whose admission script grants — drives the hold-readout grant path. */
const grantingRedis = {
  get: () => Promise.resolve({ balanceNanoUsd: '1000000000', ledgerSeq: 1, type: 'purchased' }),
  createScript: () => ({ exec: () => Promise.resolve('admitted') }),
} as unknown as ConversationRuntimeDeps['redis'];

/** A db whose key-row update matches (or misses) the fence. */
function keyRowUpdateDb(rows: readonly unknown[]): ConversationRuntimeDeps['db'] {
  return {
    update: () => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve(rows) }) }),
    }),
  } as unknown as ConversationRuntimeDeps['db'];
}

const keyRowDownDb = {
  update: () => ({
    set: () => ({ where: () => ({ returning: () => Promise.reject(new Error('db down')) }) }),
  }),
} as unknown as ConversationRuntimeDeps['db'];

const FENCE = { id: 'f', executorId: 'e', claims: 1 };

describe('conversation runtime admission (hold identity on the grant)', () => {
  it('carries the wallet-hold identity on the admission grant', async () => {
    const runtime = createConversationRuntime(deps({ redis: grantingRedis }));
    const hooks = runtime.bindHooks(CONTEXT, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: 1n as never });
    expect(decision).toMatchObject({
      admitted: true,
      hold: { walletId: 'w1', holdId: 'run-1', scopeIds: [] },
    });
  });
});

describe('conversation runtime executor (admitted propagation)', () => {
  it('settles admitted as an internal failure when the executor build fails', async () => {
    const runtime = createConversationRuntime(deps({ db: catalogDownDb }));
    const handle = runtime.executor.start({
      definition: DEFINITION,
      inputs: {},
      hooks: HOOKS,
      runKey: 'k',
      emit: () => {},
    });
    await expect(handle.admitted).resolves.toEqual({ admitted: false, code: 'INTERNAL' });
    await expect(handle.done).rejects.toThrow(/catalog/);
  });
});

describe('conversation runtime money capabilities', () => {
  it('releases a hold through Redis (wallet hash plus every scope hash)', async () => {
    const hdel = vi.fn(() => Promise.resolve(1));
    const runtime = createConversationRuntime(
      deps({ redis: { hdel } as unknown as ConversationRuntimeDeps['redis'] })
    );
    await runtime.releaseHold({ walletId: 'w1', holdId: 'run-1', scopeIds: ['s1'] });
    expect(hdel).toHaveBeenCalledTimes(2);
  });

  it('swallows a release failure (the hold TTL is the backstop)', async () => {
    const hdel = vi.fn(() => Promise.reject(new Error('redis down')));
    const runtime = createConversationRuntime(
      deps({ redis: { hdel } as unknown as ConversationRuntimeDeps['redis'] })
    );
    await expect(
      runtime.releaseHold({ walletId: 'w1', holdId: 'run-1', scopeIds: [] })
    ).resolves.toBeUndefined();
  });

  it('reports alive when the heartbeat touch matches the fence', async () => {
    const runtime = createConversationRuntime(deps({ db: keyRowUpdateDb([{ id: 'f' }]) }));
    await expect(runtime.heartbeat(FENCE)).resolves.toBe('alive');
  });

  it('reports lost when the heartbeat touch matches no row', async () => {
    const runtime = createConversationRuntime(deps({ db: keyRowUpdateDb([]) }));
    await expect(runtime.heartbeat(FENCE)).resolves.toBe('lost');
  });

  it('treats a heartbeat store failure as alive (never stops a healthy run)', async () => {
    const runtime = createConversationRuntime(deps({ db: keyRowDownDb }));
    await expect(runtime.heartbeat(FENCE)).resolves.toBe('alive');
  });

  it('resolves failRun on the fenced flip and on a fence miss alike', async () => {
    await expect(
      createConversationRuntime(deps({ db: keyRowUpdateDb([{ id: 'f' }]) })).failRun(FENCE)
    ).resolves.toBeUndefined();
    await expect(
      createConversationRuntime(deps({ db: keyRowUpdateDb([]) })).failRun(FENCE)
    ).resolves.toBeUndefined();
  });

  it('swallows a failRun store failure (the lease lapse is the backstop)', async () => {
    const runtime = createConversationRuntime(deps({ db: keyRowDownDb }));
    await expect(runtime.failRun(FENCE)).resolves.toBeUndefined();
  });
});

describe('post-commit snapshot refresh (chat settlement wrap)', () => {
  const REQUEST = { runKey: 'k', outputs: {}, charges: [] };

  it('refreshes the wallet snapshot only after the settlement commits', async () => {
    const calls: string[] = [];
    const walletDb = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ balanceNanoUsd: 5n, ledgerSeq: 2n, type: 'purchased' }]),
        }),
      }),
    } as unknown as ConversationRuntimeDeps['db'];
    const casRedis = {
      createScript: () => ({
        exec: () => {
          calls.push('refresh');
          return Promise.resolve(1);
        },
      }),
    } as unknown as ConversationRuntimeDeps['redis'];
    const hook = withPostCommitSnapshotRefresh(
      () => {
        calls.push('settle');
        return Promise.resolve();
      },
      { db: walletDb, redis: casRedis, telemetry },
      'w1'
    );
    await hook(REQUEST);
    expect(calls).toEqual(['settle', 'refresh']);
  });

  it('never fails a settled run when the refresh fails', async () => {
    const hook = withPostCommitSnapshotRefresh(
      () => Promise.resolve(),
      { db: noMemberDb, redis: rejectingRedis, telemetry },
      'w1'
    );
    await expect(hook(REQUEST)).resolves.toBeUndefined();
  });

  it('refreshes the wallet snapshot after a billed refusal, then rethrows the refusal', async () => {
    const exec = vi.fn(() => Promise.resolve(1));
    const walletDb = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ balanceNanoUsd: 5n, ledgerSeq: 2n, type: 'purchased' }]),
        }),
      }),
    } as unknown as ConversationRuntimeDeps['db'];
    const casRedis = {
      createScript: () => ({ exec }),
    } as unknown as ConversationRuntimeDeps['redis'];
    const refusal = new SettlementConflictError(conflictError('refused'), 'settlement refused');
    const hook = withPostCommitSnapshotRefresh(
      () => Promise.reject(refusal),
      { db: walletDb, redis: casRedis, telemetry },
      'w1'
    );
    await expect(hook(REQUEST)).rejects.toBe(refusal);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('propagates a settlement failure without attempting the refresh', async () => {
    const exec = vi.fn(() => Promise.resolve(1));
    const casRedis = {
      createScript: () => ({ exec }),
    } as unknown as ConversationRuntimeDeps['redis'];
    const hook = withPostCommitSnapshotRefresh(
      () => Promise.reject(new Error('settlement boom')),
      { db: noMemberDb, redis: casRedis, telemetry },
      'w1'
    );
    await expect(hook(REQUEST)).rejects.toThrow('settlement boom');
    expect(exec).not.toHaveBeenCalled();
  });
});

const MEDIA_DEFINITION: WorkflowDefinition = {
  version: 1,
  deadlineClass: 'media',
  hooks: CHAT_TURN_HOOKS,
  nodes: [
    { id: CHAT_TURN_NODE_ID, type: 'modelCall', model: 'x/img', params: { aspectRatio: '1:1' } },
  ],
  edges: [],
} as unknown as WorkflowDefinition;

const EPOCH_KEYS = generateEpochKeyPair();

describe('chatSettlementIdentity', () => {
  const context = { ...CONTEXT, mode: 'paid' as const };
  const ANSWER_IDS: ReadonlyMap<string, string> = new Map([[CHAT_TURN_NODE_ID, 'answer-id']]);

  it('carries no mediaPlans for a text run', () => {
    const identity = chatSettlementIdentity(context, ANSWER_IDS);
    expect('mediaPlans' in identity).toBe(false);
    expect(identity.conversationId).toBe('c1');
    expect(identity.runId).toBe('run-1');
  });

  it('carries the SAME plans instance the mappers fill for a media run', () => {
    const plans = new Map<string, MediaPersistPlan>();
    const identity = chatSettlementIdentity(context, ANSWER_IDS, plans);
    expect(identity.mediaPlans).toBe(plans);
  });

  it('carries the fork the turn extends, so settlement chains onto the fork tip', () => {
    const identity = chatSettlementIdentity({ ...context, forkId: 'fork-1' }, ANSWER_IDS);
    expect(identity.forkId).toBe('fork-1');
  });

  it('carries the answer ids the run minted, so settlement stores each answer under its own', () => {
    expect(chatSettlementIdentity(context, ANSWER_IDS).answerMessageIds).toBe(ANSWER_IDS);
  });
});

describe('bindHooks media wiring', () => {
  it('attaches no mediaPersist and reads no epoch key for a text definition', () => {
    const readEpochPublicKey = vi.fn(() => Promise.resolve(null));
    const runtime = createConversationRuntime(deps({ readEpochPublicKey }));
    const bindings: ChatHookBindings = runtime.bindHooks(CONTEXT, DEFINITION);
    expect(bindings.mediaPersist).toBeUndefined();
    expect(readEpochPublicKey).not.toHaveBeenCalled();
  });

  it('attaches a mediaPersist whose mint pre-mints per-node plans for a media definition', async () => {
    const readEpochPublicKey = vi.fn(() =>
      Promise.resolve(EPOCH_KEYS.publicKey as Uint8Array | null)
    );
    const runtime = createConversationRuntime(deps({ readEpochPublicKey }));
    const bindings: ChatHookBindings = runtime.bindHooks(CONTEXT, MEDIA_DEFINITION);
    expect(bindings.mediaPersist).toBeDefined();
    // Binding is cheap and sync — the epoch read happens only at mint.
    expect(readEpochPublicKey).not.toHaveBeenCalled();
    await bindings.mediaPersist?.mint();
    expect(readEpochPublicKey).toHaveBeenCalledTimes(1);
    expect(bindings.mediaPersist?.mapFilePartFor(CHAT_TURN_NODE_ID)).toBeDefined();
    expect(bindings.mediaPersist?.mapFilePartFor('unknown-node')).toBeUndefined();
  });
});

/** A text turn of two answer nodes, as the multi-model builder declares them (shape-parsed). */
function twoAnswerDefinition(hooks: { admission: string; settlement: string }): WorkflowDefinition {
  return WorkflowDefinition.parse({
    version: 1,
    deadlineClass: 'text',
    hooks,
    nodes: ['answer0', 'answer1'].map((id) => ({
      id,
      type: 'modelCall',
      version: 1,
      out: 'out',
      model: `x/${id}`,
      params: {},
      in: { node: 'input', port: 'prompt' },
    })),
    edges: [],
  });
}

const TWO_ANSWER_DEFINITION = twoAnswerDefinition({ admission: 'chat', settlement: 'chat' });

/** A storage that accepts every put; the mint path reads nothing back. */
const acceptingStorage: ConversationRuntimeDeps['storage'] = {
  put: () => okAsync(),
  presignGet: () => {
    throw new Error('storage reads are not on the mint path');
  },
  head: () => {
    throw new Error('storage reads are not on the mint path');
  },
  delete: () => {
    throw new Error('storage deletes are not on the mint path');
  },
  list: () => {
    throw new Error('storage reads are not on the mint path');
  },
};

/** An id source that counts, so a test can name every id a binding mints. */
function countingIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `id-${String(next)}`;
  };
}

describe('bindHooks answer ids', () => {
  it("mints one id per answer node, in the definition's node order, for the room", () => {
    const runtime = createConversationRuntime(deps({ newId: countingIds() }));
    const bindings = runtime.bindHooks(CONTEXT, TWO_ANSWER_DEFINITION);
    expect([...bindings.answerMessageIds]).toEqual([
      ['answer0', 'id-1'],
      ['answer1', 'id-2'],
    ]);
    expect(bindings.assistantMessageIds).toEqual(['id-1', 'id-2']);
  });

  it('mints fresh ids for each binding of the same run, as a retried execution rebinds', () => {
    const runtime = createConversationRuntime(deps({}));
    const first = runtime.bindHooks(CONTEXT, TWO_ANSWER_DEFINITION);
    const retried = runtime.bindHooks(CONTEXT, TWO_ANSWER_DEFINITION);
    expect(retried.assistantMessageIds).not.toEqual(first.assistantMessageIds);
  });

  it("stores a media node's file under the id minted for its answer", async () => {
    const runtime = createConversationRuntime(
      deps({
        readEpochPublicKey: () => Promise.resolve<Uint8Array | null>(EPOCH_KEYS.publicKey),
        storage: acceptingStorage,
      })
    );
    // Storage keys are built from uuids only.
    const context: RunContext = { ...CONTEXT, conversationId: crypto.randomUUID() };
    const bindings = runtime.bindHooks(context, MEDIA_DEFINITION);
    await bindings.mediaPersist?.mint();
    const mapper = bindings.mediaPersist?.mapFilePartFor(CHAT_TURN_NODE_ID);
    const [, done] = mapper?.({ mediaType: 'image/png', data: new Uint8Array([1]) }, 0) ?? [];
    const answerId = bindings.answerMessageIds.get(CHAT_TURN_NODE_ID);
    expect(done?.kind === 'media-done' ? done.value.ref : undefined).toContain(
      `/${answerId ?? ''}/`
    );
  });

  it('mints no answer ids for a trial run, which stores no row', () => {
    const runtime = createConversationRuntime(deps({}));
    const bindings = runtime.bindHooks(
      { mode: 'trial', sessionId: 's1', runId: 'run-1', fence: CONTEXT.fence },
      { ...TWO_ANSWER_DEFINITION, hooks: TRIAL_TURN_HOOKS }
    );
    expect(bindings.assistantMessageIds).toEqual([]);
    expect(bindings.answerMessageIds.size).toBe(0);
  });
});

describe('withAnswerMessageIds (stream-start wiring)', () => {
  function requestWith(
    answerMessageIds: ReadonlyMap<string, string>,
    frames: Parameters<HeldStartRequest['emit']>[0][]
  ): HeldStartRequest {
    return {
      definition: TWO_ANSWER_DEFINITION,
      inputs: {},
      hooks: { ...HOOKS, answerMessageIds, assistantMessageIds: [...answerMessageIds.values()] },
      runKey: 'k',
      emit: (frame) => frames.push(frame),
    };
  }

  it("stamps each answer stream's stream-start with the id minted for its node", () => {
    const frames: Parameters<HeldStartRequest['emit']>[0][] = [];
    const request = withAnswerMessageIds(requestWith(new Map([['answer1', 'id-b']]), frames));
    request.emit({
      streamId: 'answer1#3',
      cursor: 1,
      event: { kind: 'stream-start', modelId: 'x/b' },
    });
    expect(frames[0]?.event).toEqual({ kind: 'stream-start', modelId: 'x/b', messageId: 'id-b' });
  });

  it('passes every other event through untouched', () => {
    const frames: Parameters<HeldStartRequest['emit']>[0][] = [];
    const request = withAnswerMessageIds(requestWith(new Map([['answer1', 'id-b']]), frames));
    const frame = {
      streamId: 'answer1#3',
      cursor: 2,
      event: { kind: 'text-delta' as const, index: 0, content: 'x' },
    };
    request.emit(frame);
    expect(frames[0]).toBe(frame);
  });

  it('leaves the stream-start of a node with no minted id unstamped', () => {
    const frames: Parameters<HeldStartRequest['emit']>[0][] = [];
    const request = withAnswerMessageIds(requestWith(new Map([['answer1', 'id-b']]), frames));
    request.emit({
      streamId: 'answer0#0',
      cursor: 1,
      event: { kind: 'stream-start', modelId: 'x/a' },
    });
    expect(frames[0]?.event).toEqual({ kind: 'stream-start', modelId: 'x/a' });
  });

  it('returns the very same request for a run that minted no answer ids', () => {
    const request = requestWith(new Map(), []);
    expect(withAnswerMessageIds(request)).toBe(request);
  });
});

describe('withMediaPutBarrier', () => {
  const REQUEST = { runKey: 'k', outputs: {}, charges: [] };

  it('awaits the puts before settling', async () => {
    const order: string[] = [];
    const hook = withMediaPutBarrier(
      () => {
        order.push('settle');
        return Promise.resolve();
      },
      () => {
        order.push('flush');
        return Promise.resolve();
      }
    );
    await hook(REQUEST);
    expect(order).toEqual(['flush', 'settle']);
  });

  it('rejects without settling when a put failed', async () => {
    const settle = vi.fn(() => Promise.resolve());
    const hook = withMediaPutBarrier(settle, () => Promise.reject(new Error('put lost')));
    await expect(hook(REQUEST)).rejects.toThrow('put lost');
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('prepareStartRequest', () => {
  const baseRequest = {
    definition: DEFINITION,
    inputs: {},
    hooks: HOOKS,
    runKey: 'run-key',
    emit: vi.fn(),
  } as unknown as HeldStartRequest;

  it('returns the request untouched for a run without mediaPersist', async () => {
    const prepared = await prepareStartRequest(baseRequest);
    expect(prepared).toBe(baseRequest);
    expect(prepared.mapFilePartFor).toBeUndefined();
  });

  it('mints before returning and threads the mapper resolver for a media run', async () => {
    const mint = vi.fn(() => Promise.resolve());
    const mapper = vi.fn();
    const mapFilePartFor = vi.fn(() => mapper);
    const request = {
      ...baseRequest,
      hooks: { ...HOOKS, mediaPersist: { mint, mapFilePartFor } },
    } as unknown as HeldStartRequest;
    const prepared = await prepareStartRequest(request);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(prepared.mapFilePartFor?.(CHAT_TURN_NODE_ID)).toBe(mapper);
    expect(mapFilePartFor).toHaveBeenCalledWith(CHAT_TURN_NODE_ID);
  });

  it('hands resent history through untouched — the route is the only strip seam', async () => {
    // The route strips embedded reasoning before it prices, hashes and
    // classifies the turn. A second strip here would be a second server-side
    // mechanism at the same authority, and it would decouple the bytes the
    // provider receives from the bytes admission was solved from.
    const history = [
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: serializeSegments([
          { kind: 'reasoning', children: [{ kind: 'text', text: 'inner thoughts' }] },
          { kind: 'text', text: 'the answer' },
        ]),
      },
    ];
    const request = { ...baseRequest, history } as unknown as HeldStartRequest;
    const prepared = await prepareStartRequest(request);
    expect(prepared).toBe(request);
    expect(prepared.history).toBe(history);
  });

  it('hands resent history through untouched on the media mint path too', async () => {
    const mint = vi.fn(() => Promise.resolve());
    const history = [
      {
        role: 'assistant',
        content: serializeSegments([
          { kind: 'reasoning', children: [{ kind: 'text', text: 'inner thoughts' }] },
          { kind: 'text', text: 'the answer' },
        ]),
      },
    ];
    const request = {
      ...baseRequest,
      history,
      hooks: { ...HOOKS, mediaPersist: { mint, mapFilePartFor: vi.fn() } },
    } as unknown as HeldStartRequest;
    const prepared = await prepareStartRequest(request);
    expect(prepared.history).toBe(history);
    expect(mint).toHaveBeenCalledTimes(1);
  });
});
