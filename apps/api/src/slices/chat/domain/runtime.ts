import { match } from 'ts-pattern';
import { ERROR_CODES, senderPrincipalId } from '@hushbox/shared';
import {
  createEstimateRun,
  createModelPricingResolver,
  createToolRegistry,
  maxPriceReachesAnchor,
  resolveModelProvider,
  resolveSearchProvider,
} from '../../models/index.js';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  createFencedSettlementHook,
  createLiveExecutionRegistry,
  createWorkflowExecutor,
  keyRowCompletion,
  predicateCode,
  reducerCode,
} from '../../workflows/index.js';
import {
  admitRun,
  createBillingStores,
  releaseHold,
  resolveBudgetScopes,
} from '../../billing/index.js';
import { createConversationsStores, resolveCallerMember } from '../../conversations/index.js';
import { domainWireCode, notFoundError } from '../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { senderCaller, senderUserId } from './messages/sender.js';
import {
  RUN_LEASE_SECONDS,
  claimKeyRow,
  failKeyRow,
  heartbeatKeyRow,
  isIdempotencyConflict,
} from '../../../lib/idempotency/index.js';
import { createTurnCompileRegistries } from './turn/definition.js';
import { answerMessageIds, createMediaPersistRun, mediaCallNodes } from './media/persist.js';
import { createVideoProgressEmitter, nodeIdOf } from './media/progress.js';
import { createChatRefusalCommit } from './settlement/refusal.js';
import { createChatSettlementCommit } from './settlement/settlement.js';
import { bindTrialHooks, requireTrialContext } from './trial/trial.js';
import {
  CHAT_ADMISSION_HOOK,
  CHAT_TURN_ROUTE,
  PER_WALLET_CONCURRENT_RUN_CAP,
  TRIAL_ADMISSION_HOOK,
} from './constants.js';
import type { ErrorCode } from '@hushbox/shared';
import type { HeldStreamRelease, RoomBindings } from '@hushbox/realtime';
import type { AdmissionRefusalReason } from '../../billing/index.js';
import type { ModelProvider, ToolRegistry } from '../../models/index.js';
import type { ConversationCaller } from '../../conversations/index.js';
import type { Storage } from '../../media/index.js';
import type { MediaPersistRun } from './media/persist.js';
import type { ChatSettlementIdentity, EpochPublicKeyReader } from './settlement/settlement.js';
import type { ChatStores } from '../ports/stores.js';
import type { SubWorkflowBinding, createConstraintRegistry } from '../../workflows/index.js';
import type { TurnCompileRegistries } from './turn/definition.js';
import type { AdmissionDeps, BillingStores, BudgetScope } from '../../billing/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type {
  ClaimRun,
  FilePartMapper,
  FlowAbortReason,
  FlowAdmissionOutcome,
  FlowExecutor,
  FlowHoldIdentity,
  FlowHookBindings,
  FlowRunHandle,
  FlowRunOutcome,
  FlowStartRequest,
  FlowStopReason,
  MediaPersistPlan,
  MockDirectives,
  PaidRunIdentity,
  RunClaim,
  RunContext,
  RunFence,
  SchemaNameRegistry,
  SettlementHook,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../lib/telemetry/index.js';

/**
 * The conversation runtime: the real workflow executor, the definition's
 * policy-hook binder, and the run referee, composed from the production
 * factories. This lives in chat's domain — the single layer permitted to
 * import the workflows / models / billing barrels the composition needs — and
 * is consumed by the ConversationRoom DO bindings. Everything the chat turn
 * runs on assembles here.
 */

/**
 * The media pre-mint duties one run's hook bindings carry to the executor
 * start path: `mint` pre-mints the per-node persistence identities (an async
 * DB read, awaited BEFORE `executor.start`) and `mapFilePartFor` resolves the
 * per-node encrypt-and-store mappers the engine threads to `provider.infer`.
 * Absent on every text run.
 */
export interface MediaPersistStart {
  readonly mint: () => Promise<void>;
  readonly mapFilePartFor: (nodeKey: string) => FilePartMapper | undefined;
}

/**
 * The chat runtime's hook bindings: the bindings the room reads, plus the
 * in-process-only media pre-mint duties and answer ids. Like the held-stream
 * field on `HeldStartRequest`, the extra fields ride the in-process DO wiring by
 * structural extension, never the wire protocol, because the binder call and
 * `executor.start` are adjacent in the DO's `startRun`, making the hooks object
 * the one value that travels from bind to start.
 *
 * `answerMessageIds` maps each answer node to the id its message is stored
 * under, minted at bind; `assistantMessageIds` is the same ids in node order,
 * which the room returns on the run start and its attach. A trial run mints none.
 */
export type ChatHookBindings = ReturnType<RoomBindings['bindHooks']> & {
  readonly answerMessageIds: ReadonlyMap<string, string>;
  readonly assistantMessageIds: readonly string[];
  readonly mediaPersist?: MediaPersistStart;
};

/**
 * The chat runtime's executor. A start takes the chat hook bindings, so a start
 * whose hooks lack the answer ids does not compile.
 */
interface ChatExecutor {
  readonly start: (request: HeldStartRequest) => FlowRunHandle;
}

export interface ConversationRuntime {
  readonly executor: ChatExecutor;
  readonly bindHooks: (context: RunContext, definition: WorkflowDefinition) => ChatHookBindings;
  readonly claimRun: ClaimRun;
  /**
   * The run's money/lease duties, called by the DO's terminal sink — all
   * best-effort by design (a failure never fails a run): early hold release
   * (the TTL is the backstop), the fenced key-row lease heartbeat (`lost` =
   * a retry superseded the run), and the fenced `claimed → failed` flip that
   * frees the key for one serialized retry (a settled row no-ops).
   */
  readonly releaseHold: (hold: FlowHoldIdentity) => Promise<void>;
  readonly heartbeat: (fence: RunFence) => Promise<'alive' | 'lost'>;
  readonly failRun: (fence: RunFence) => Promise<void>;
}

export interface ConversationRuntimeDeps {
  /** The DO-scoped database handle for the executor, hooks, and referee. */
  readonly db: Database;
  readonly redis: AdmissionDeps['redis'];
  readonly telemetry: Telemetry;
  /**
   * The R2 storage a media run's mappers encrypt-and-store generated files
   * through DURING streaming (under pre-minted final keys). Text runs never
   * touch it.
   */
  readonly storage: Storage;
  /** The OpenRouter key (via envUtils at the composition boundary — never read here). */
  readonly apiKey: string;
  /**
   * The web-search key (`BRAVE_SEARCH_API_KEY`), read by the composer and never
   * here. Empty exactly where the composer's mock gate is on, as `apiKey` is.
   */
  readonly searchApiKey: string;
  /**
   * The DO-side env gate for the deterministic `x-mock-*` mock provider: true
   * only in dev/E2E (the composer sets it from `mockProviderEnabled(envUtils)`
   * over the DO's OWN env bindings). This is the PARAMOUNT production-inert
   * guarantee — it is false in production, so no per-request `mockDirectives` on
   * a run can ever construct the mock there. Omitted defaults to false (real).
   * Per-run directives ride `FlowStartRequest.mockDirectives`; the mock is
   * selected only when this gate is true AND a run carries directives.
   */
  readonly mockProviderEnabled?: boolean;
  /**
   * CI classification (`createEnvUtilities(env).isCI`), set by the composer. On
   * the real inference path it selects the CI-vitest cassette + service-evidence
   * wiring (true) versus the production plain-fetch wiring (false). Threaded
   * alongside `db` so the provider factory has both.
   */
  readonly isCI: boolean;
  /**
   * Whether the DO runs on a real interactive dev server
   * (`createEnvUtilities(env).isDevServer`), set by the composer. Gates every
   * dev-server default of the mock provider: on only here, so E2E, vitest, CI and
   * production get none of them. Omitted defaults to false; a per-request
   * directive always wins over a default.
   */
  readonly isDevServer?: boolean;
  /** Chat's content persister (chat's own adapter, injected by the composer). */
  readonly chatStores: ChatStores;
  /** The epoch public key read, supplied by the conversations slice (it owns `epochs`). */
  readonly readEpochPublicKey: EpochPublicKeyReader;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** A chat turn resolves no sub-workflows; every ref misses this empty catalog. */
const NO_SUB_WORKFLOWS: Record<string, SubWorkflowBinding | undefined> = {};

type ConstraintRegistry = ReturnType<typeof createConstraintRegistry>;

/**
 * The live-execution-registry lookups the executor is wired with: no
 * sub-workflows (a chat turn has none) and schema resolution over the shared
 * constraint registry (compile ⟺ runtime typing from one source).
 */
export function createExecutionResolvers(constraints: ConstraintRegistry): {
  subWorkflows: { resolve: (ref: string) => SubWorkflowBinding | undefined };
  schemas: SchemaNameRegistry;
} {
  return {
    subWorkflows: { resolve: (ref: string) => NO_SUB_WORKFLOWS[ref] },
    schemas: { resolveSchema: (name: string) => constraints.resolve('schema', name)?.schema },
  };
}

/** The compile-time registries the live execution registry reads, plus the run's provider. */
interface TurnExecutionRegistryDeps extends Pick<
  TurnCompileRegistries,
  'models' | 'compute' | 'constraints'
> {
  readonly provider: ModelProvider;
  /**
   * Required here though the live registry's field is optional: a chat turn
   * that declares web search must find it, not stay unresolved.
   */
  readonly tools: ToolRegistry;
  /**
   * Required, not optional: the modelCall node raises its missing-provider-cost
   * alert through this port, and an absent one silences that alert on the path
   * that bills. The registry's own field is optional, so the compiler only holds
   * the promise where the requirement is declared — here.
   */
  readonly telemetry: Telemetry;
}

/**
 * The chat turn's live execution registry: the compile-time model and transform
 * registries (compile ⟺ runtime from one instance) plus the run's provider and
 * tools.
 */
export function createTurnExecutionRegistry(
  deps: TurnExecutionRegistryDeps
): ReturnType<typeof createLiveExecutionRegistry> {
  return createLiveExecutionRegistry({
    provider: deps.provider,
    tools: deps.tools,
    models: deps.models,
    compute: deps.compute,
    ...createExecutionResolvers(deps.constraints),
    predicates: predicateCode(DEFAULT_WORKFLOW_CAPABILITIES),
    reducers: reducerCode(DEFAULT_WORKFLOW_CAPABILITIES),
    telemetry: deps.telemetry,
  });
}

/** Workflow control randomness (fan-out ordering) — not security-sensitive, but crypto-sourced. */
export function engineRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  /* v8 ignore next -- a length-1 Uint32Array always has index 0 populated */
  return (buffer[0] ?? 0) / 2 ** 32;
}

/**
 * Whether THIS run selects the deterministic mock provider. The paramount
 * production-inert guarantee: it is false unless the DO's OWN env mode enables
 * the mock (`mockProviderEnabled`, derived at composition from the DO's env
 * bindings — never from request content). Only in dev/E2E, and only when the run
 * actually carries `mockDirectives`, is the mock chosen. A crafted production
 * body carrying `mockDirectives` fails the gate here and gets the real provider.
 */
export function usesMockProvider(
  deps: Pick<ConversationRuntimeDeps, 'mockProviderEnabled'>,
  mockDirectives: MockDirectives | undefined
): boolean {
  return (deps.mockProviderEnabled ?? false) && mockDirectives !== undefined;
}

/** One run's model provider and the tool registry its web search runs through. */
interface RunAdapters {
  readonly provider: ModelProvider;
  readonly tools: ToolRegistry;
}

type AdapterDeps = Pick<
  ConversationRuntimeDeps,
  'mockProviderEnabled' | 'apiKey' | 'searchApiKey' | 'isCI' | 'telemetry'
> &
  Partial<Pick<ConversationRuntimeDeps, 'db' | 'isDevServer'>>;

/**
 * A run's adapters. The pair that selects them, `useMock` and `isCI`, is
 * derived once here and handed to both resolvers, so the fake search adapter is
 * chosen exactly when the mock model provider is: the stand-ins or the real
 * adapters, never a mix. All selection logic lives in the models slice's
 * resolvers; this only computes the per-run mock decision and forwards the
 * run's inputs. The tool registry is built from the search adapter resolved here.
 */
export function adaptersFor(
  deps: AdapterDeps,
  mockDirectives?: MockDirectives,
  awaitStreamRelease?: () => Promise<void>
): RunAdapters {
  const useMock = usesMockProvider(deps, mockDirectives);
  const provider = resolveModelProvider({
    useMock,
    apiKey: deps.apiKey,
    isCI: deps.isCI,
    db: deps.db,
    maxPriceReachesAnchor,
    ...(deps.isDevServer === undefined ? {} : { isDevServer: deps.isDevServer }),
    ...(mockDirectives === undefined ? {} : { mockDirectives }),
    ...(awaitStreamRelease === undefined ? {} : { awaitStreamRelease }),
  });
  const search = resolveSearchProvider({
    useMock,
    apiKey: deps.searchApiKey,
    isCI: deps.isCI,
    db: deps.db,
    telemetry: deps.telemetry,
  });
  return { provider, tools: createToolRegistry({ search }) };
}

/**
 * The executor start request as the ConversationRoom DO hands it in: the shared
 * `FlowStartRequest` plus the DO's `HeldStreamRelease`, which rides the in-process
 * executor wiring, NEVER the wire protocol, and only in dev/E2E (the DO adds it
 * solely for a `holdPrimaryStream` run).
 */
export type HeldStartRequest = FlowStartRequest &
  HeldStreamRelease & {
    /**
     * The binder's own bindings object, seen at its runtime (chat) type: a media
     * run's bindings carry `mediaPersist`, which the start path consumes to mint
     * before `executor.start` and to thread `mapFilePartFor` onto the request.
     */
    readonly hooks: ChatHookBindings;
  };

/**
 * The video-progress wiring of the start path: a MEDIA-classed run's `emit` is
 * wrapped by the synthetic per-node video sweep (media-progress frames ride the
 * node's own stream); `stopProgress` is hooked to the run's terminal so an
 * aborted/deadline-killed run clears every timer silently — the existing
 * terminal frames end the tile, no extra signal is invented. A text-classed
 * run's request is returned untouched (the very same object) with a no-op stop.
 */
export function attachVideoProgress(request: HeldStartRequest): {
  readonly request: HeldStartRequest;
  readonly stopProgress: () => void;
} {
  if (request.definition.deadlineClass !== 'media') {
    return { request, stopProgress: noop };
  }
  const progress = createVideoProgressEmitter(request.definition, request.emit);
  return { request: { ...request, emit: progress.emit }, stopProgress: progress.stopAll };
}

/**
 * Stamps each answer stream's `stream-start` with the id minted for its node, so
 * every socket watching the run, the sender's and every other member's, builds
 * the live tile under the id its stored row will carry. A run that minted no
 * answer ids (a trial) is returned untouched, the very same object.
 */
export function withAnswerMessageIds(request: HeldStartRequest): HeldStartRequest {
  const ids = request.hooks.answerMessageIds;
  if (ids.size === 0) return request;
  return {
    ...request,
    emit: (frame): void => {
      const { event } = frame;
      const messageId =
        event.kind === 'stream-start' ? ids.get(nodeIdOf(frame.streamId)) : undefined;
      if (event.kind !== 'stream-start' || messageId === undefined) {
        request.emit(frame);
        return;
      }
      request.emit({ ...frame, event: { ...event, messageId } });
    },
  };
}

/**
 * The media pre-mint step of the start path: a media run (bindings carrying
 * `mediaPersist`) awaits the async plan mint BEFORE the executor starts, then
 * threads the per-node mapper resolver onto the request. A text run's request
 * is returned untouched — the very same object, so that path is byte-identical
 * to the pre-media wiring. A mint failure rejects like an executor-build
 * failure: `done` rejects (run-sink contained) and admission fails closed.
 */
export async function prepareStartRequest(request: HeldStartRequest): Promise<HeldStartRequest> {
  const media = request.hooks.mediaPersist;
  if (media === undefined) return request;
  await media.mint();
  return {
    ...request,
    mapFilePartFor: (nodeKey): FilePartMapper | undefined => media.mapFilePartFor(nodeKey),
  };
}

/** The catalog snapshot + compile registries, shared by every run until a turn names another catalog. */
type ExecutorCommon = ReturnType<typeof createTurnCompileRegistries> & {
  readonly pricingResolver: Parameters<typeof createEstimateRun>[0];
  /** The generation of the catalog read the snapshot was built from. */
  readonly generation: string;
};

/**
 * The executor is built lazily: the catalog pricing snapshot loads on the
 * first run and the one resolver instance feeds BOTH the compile registries
 * and the live execution registry (compile ⟺ runtime never diverge). The
 * snapshot is kept until a run's definition names a catalog generation other
 * than the snapshot's, or until a run naming a generation finds the snapshot's
 * read failed; that run rebuilds it from a fresh read, so the hold prices
 * against the catalog the route priced the turn with, or a newer one. A
 * definition naming no generation runs on the snapshot held.
 */
function createLazyExecutor(deps: ConversationRuntimeDeps): FlowExecutor {
  let cachedCommon: Promise<ExecutorCommon> | undefined;
  let cachedReal: { readonly common: ExecutorCommon; readonly executor: FlowExecutor } | undefined;
  const buildCommon = async (): Promise<ExecutorCommon> => {
    const pricingResolver = await createModelPricingResolver({
      db: deps.db,
      telemetry: deps.telemetry,
    }).match(
      (resolver) => resolver,
      (error) => {
        throw new Error('chat runtime: model catalog snapshot unavailable', { cause: error });
      }
    );
    return {
      pricingResolver,
      generation: pricingResolver.generation,
      ...createTurnCompileRegistries(pricingResolver),
    };
  };
  const commonFor = async (generation: string | undefined): Promise<ExecutorCommon> => {
    const held = (cachedCommon ??= buildCommon());
    try {
      const common = await held;
      if (generation === undefined || common.generation === generation) return common;
    } catch (error) {
      // A failed read carries no generation, so a run naming one retries it; a
      // run naming none fails with the read it was given.
      if (generation === undefined) throw error;
    }
    // Runs that await the same stale or failed snapshot share one rebuild.
    if (cachedCommon === held) cachedCommon = buildCommon();
    return cachedCommon;
  };
  // Only the cheap wiring (execution registry + executor) is built per invocation;
  // the expensive catalog snapshot + compile registries are the shared `common`.
  const buildExecutor = (common: ExecutorCommon, adapters: RunAdapters): FlowExecutor => {
    const execution = createTurnExecutionRegistry({
      provider: adapters.provider,
      tools: adapters.tools,
      models: common.models,
      compute: common.compute,
      constraints: common.constraints,
      telemetry: deps.telemetry,
    });
    return createWorkflowExecutor({
      registries: { nodes: common.nodes, constraints: common.constraints },
      execution,
      estimateRun: createEstimateRun(common.pricingResolver),
      clock: { now: () => Date.now() },
      rng: { random: engineRandom },
      telemetry: deps.telemetry,
    });
  };
  // Per-run adapter selection: the mock path rebuilds the cheap wiring for each
  // run so per-request `mockDirectives` take effect; the real (OpenRouter/cassette)
  // path is built once per catalog snapshot and cached.
  const executorFor = async (request: HeldStartRequest): Promise<FlowExecutor> => {
    const common = await commonFor(request.definition.catalogGeneration);
    if (usesMockProvider(deps, request.mockDirectives)) {
      // The held-stream barrier (dev/E2E only) rides through to the mock provider;
      // undefined on every unheld run and never present on the real path.
      return buildExecutor(
        common,
        adaptersFor(deps, request.mockDirectives, request.awaitStreamRelease)
      );
    }
    if (cachedReal?.common !== common) {
      cachedReal = { common, executor: buildExecutor(common, adaptersFor(deps)) };
    }
    return cachedReal.executor;
  };
  return {
    start(request: HeldStartRequest): FlowRunHandle {
      let inner: FlowRunHandle | undefined;
      let stopped: FlowStopReason | undefined;
      let aborted: FlowAbortReason | undefined;
      const progress = attachVideoProgress(withAnswerMessageIds(request));
      const innerReady = (async (): Promise<FlowRunHandle> => {
        const executor = await executorFor(progress.request);
        inner = executor.start(await prepareStartRequest(progress.request));
        if (stopped) inner.stop(stopped);
        if (aborted) inner.abort(aborted);
        return inner;
      })();
      const done: Promise<FlowRunOutcome> = (async () => {
        try {
          const handle = await innerReady;
          return await handle.done;
        } finally {
          // Every terminal — success, stop, deadline, or a build failure —
          // clears the video-progress timers; nothing outlives the run.
          progress.stopProgress();
        }
      })();
      // A build failure rejects `done` (contained by the DO's run sink), but
      // `admitted` must still settle or the start request would hang.
      const admitted: Promise<FlowAdmissionOutcome> = (async () => {
        try {
          const handle = await innerReady;
          return await handle.admitted;
          // eslint-disable-next-line catch-swallow/no-silent-catch -- admission fails closed to not-admitted; the build error surfaces on `done` (run-sink contained).
        } catch {
          return { admitted: false as const, code: ERROR_CODES.INTERNAL };
        }
      })();
      return {
        runKey: request.runKey,
        done,
        admitted,
        stop(reason: FlowStopReason): void {
          if (inner === undefined) stopped = reason;
          else inner.stop(reason);
        },
        abort(reason: FlowAbortReason): void {
          if (inner === undefined) aborted = reason;
          else inner.abort(reason);
        },
      };
    },
  };
}

/** The run context of a paid turn — the only shape the chat policy binds over. */
type PaidRunContext = PaidRunIdentity & {
  readonly runId: string;
  readonly fence: RunContext['fence'];
};

/**
 * The chat policy runs only under a paid identity (balance hold + epoch-wrapped
 * persistence). A `chat`-hooked definition arriving with any other identity is
 * a composition defect — the binder fails fast rather than bind a policy to the
 * wrong identity.
 */
function requirePaidContext(context: RunContext): PaidRunContext {
  if (context.mode !== 'paid') {
    throw new Error(
      `chat runtime: the chat policy requires a paid run identity, got "${context.mode}"`
    );
  }
  return context;
}

/** The per-run scope inputs: the settlement-time clock and the funding decision. */
interface ScopeContext {
  readonly now: Date;
  readonly ownerFunded: boolean;
}

/**
 * The sender's own user id. Two admission decisions key on it rather than on the
 * payer: the solo (sender-is-owner) check and the owner-funding derivation below.
 */
function contextSenderUserId(context: PaidRunContext): string | undefined {
  return senderUserId(context.sender);
}

/**
 * Whether the run is OWNER-FUNDED, derived from the two identities the run
 * already carries rather than recovered from stored state. The route freezes the
 * paying account onto the run identity, so the turn is owner-funded exactly when
 * the payer is not the sender: a group turn whose headroom covered the turn
 * froze the OWNER, while a solo turn and a fallen-through group turn both froze
 * the sender themselves. A LINK GUEST holds no account, so its sender id is absent and the
 * comparison is true — the guest's always-owner-funded case falls out of the same
 * expression instead of needing a branch of its own.
 */
function isOwnerFunded(context: PaidRunContext): boolean {
  return contextSenderUserId(context) !== context.payerUserId;
}

/** The membership-gate caller for the run's sender. */
function contextSenderCaller(context: PaidRunContext): ConversationCaller {
  return senderCaller(context.sender, context.conversationId);
}

/**
 * Resolves the group budget scopes for admission — emitted ONLY for an
 * OWNER-FUNDED group turn. The scopes are what make the admission Lua gate the
 * run on `Math.min` over the sender's durable per-member budget and the durable
 * per-conversation budget (plus the owner-wallet balance, gated by the payer
 * wallet itself). Three cases emit nothing:
 *   - a SOLO turn (sender is the owner): the owner funds from their wallet and
 *     is never member-capped;
 *   - a PERSONAL fall-through group turn (the route chose the sender's OWN
 *     wallet as payer because the group headroom was ≤ 0): the sender self-funds
 *     and admission gates their own balance alone — no group scope applies;
 *   - a missing conversation (defensive): the group budget scopes are skipped,
 *     but a free-wallet payer still emits its user-keyed daily-allowance scope
 *     (the free snapshot skips the balance check, so the cap must stay paired).
 * Owner-funding is derived ONCE per run from the run identity's payer and sender
 * (`ownerFunded`, threaded to both hooks), so scope emission agrees with the payer
 * and with settlement's accrual by construction. An owner-funded group turn's absent member row reads a
 * zero cap here (deny), but the route only chooses owner-funding when the group
 * headroom is positive, so that combination is not route-reachable. The
 * membership/budget reads fail closed through the hook's error mapping.
 */
function resolveMemberBudgetScopes(
  deps: ConversationRuntimeDeps,
  stores: BillingStores,
  context: PaidRunContext,
  scope: ScopeContext
): ResultAsync<readonly BudgetScope[], DomainError> {
  const conversationsStores = createConversationsStores(deps.db);
  // The daily-allowance ceiling, emitted ONLY when the payer wallet is a `free`
  // one — the route fell through to it because the purchased balance was ≤ 0
  // (turn-context). Recovered here from the wallet's type, read off the payer's
  // own wallets: a free-funded turn is gated on the daily allowance alone, and
  // the allowance is the payer's, which is who settlement debits it from. Group
  // funding never lands here — an owner funds from their purchased wallet.
  const freeTierScopes = (): ResultAsync<readonly BudgetScope[], DomainError> =>
    stores.readWallets(deps.db, context.payerUserId).andThen((wallets) => {
      const payerIsFree = wallets.some(
        (wallet) => wallet.id === context.walletId && wallet.type === 'free'
      );
      return payerIsFree
        ? resolveBudgetScopes(stores, deps.db, {
            now: scope.now,
            allowance: { userId: context.payerUserId },
          })
        : okAsync<readonly BudgetScope[], DomainError>([]);
    });
  // The SENDER identity the group-scope decision keys on (recovered from
  // `context.sender`, never from `payerUserId` — which names the OWNER on
  // EVERY owner-funded turn, a member's as much as a guest's): a user by userId,
  // a link guest which is NEVER the owner and never free-tier (the owner always
  // pays).
  const senderIsGuest = context.sender.kind === 'linkGuest';
  const resolvedSenderUserId = contextSenderUserId(context);
  return conversationsStores.conversations.get(context.conversationId).andThen((conversation) => {
    // No conversation (defensive): the conversation was deleted between route-time
    // validation and this hook. Only the conversation-keyed member/conversation
    // BUDGET scopes are legitimately skipped — the free-tier allowance is
    // user-keyed and does not depend on the conversation existing, so a free-wallet
    // payer must still be capped by it (the free snapshot skips the balance check;
    // the two must never be unpaired). A purchased payer emits `[]` and stays
    // bound by the admission balance check.
    if (conversation === null) {
      return freeTierScopes();
    }
    // An owner-initiated solo turn is never member-capped, but the owner may
    // still be paying from their own free wallet (purchased ≤ 0) — then the
    // daily allowance applies. A guest is never the owner.
    if (!senderIsGuest && resolvedSenderUserId === conversation.ownerUserId) {
      return freeTierScopes();
    }
    // Personal fall-through: a USER sender self-funds on their own wallet — no
    // group scope applies. Their purchased balance (if positive) is gated by
    // the wallet itself; a spent-down sender pays the free wallet, capped by
    // the daily allowance. A guest turn is always owner-funded, so it never
    // reaches this arm.
    if (!scope.ownerFunded) {
      return freeTierScopes();
    }
    return resolveCallerMember(
      conversationsStores,
      context.conversationId,
      contextSenderCaller(context)
    ).andThen((member) => {
      /* v8 ignore next 3 -- turn-context asserted active membership before the run started; a null here is unreachable */
      if (member === null) {
        return okAsync<readonly BudgetScope[], DomainError>([]);
      }
      return resolveBudgetScopes(stores, deps.db, {
        now: scope.now,
        memberBudget: { memberId: member.id },
        conversationBudget: {
          conversationId: context.conversationId,
          capNanoUsd: conversation.conversationBudgetNanoUsd,
        },
      });
    });
  });
}

/** Admission's scope read, as `admitRun` takes it. */
type AdmissionScopeRead = Parameters<typeof admitRun>[1]['readScopes'];

/**
 * The payer wallet's sequence, then the budget scope rows. The sequence is read
 * FIRST: every charge at or below it is then in the rows, which is what
 * admission's sequence check relies on.
 */
function readAdmissionScopes(
  deps: ConversationRuntimeDeps,
  stores: BillingStores,
  context: PaidRunContext,
  scope: ScopeContext
): ReturnType<AdmissionScopeRead> {
  return stores.readWalletSnapshot(deps.db, context.walletId).andThen((wallet) =>
    wallet === null
      ? errAsync(notFoundError('admission: the payer wallet does not exist'))
      : resolveMemberBudgetScopes(deps, stores, context, scope).map((scopes) => ({
          scopes,
          walletSeq: wallet.ledgerSeq,
        }))
  );
}

/** The per-run admission inputs bundled to stay under the param cap. */
interface AdmissionRunContext {
  readonly clock: () => Date;
  readonly ownerFunded: boolean;
}

/**
 * One admission refusal's wire code, split by WHOSE action can remedy it —
 * the §Notices 2 test. Paying fixes an empty balance; only waiting fixes runs
 * already in flight; only tomorrow or credit fixes a spent daily allowance; only
 * the conversation owner widens a member or conversation ceiling. Telling a payer
 * with ample funds that their balance was short offered an action that cannot
 * help, and that is what one shared code did.
 *
 * The two group levels share one code on purpose: both ceilings are owner-set,
 * both remedies are the same person, and the copy would be the same sentence
 * twice. They stay separate REASONS because the telemetry line names which
 * ceiling bound.
 *
 * No refusal names an amount, threshold, or limit — §Notices 6 forbids
 * disclosing the binding constraint, and a condition is not an amount.
 */
function admissionRefusalCode(reason: AdmissionRefusalReason): ErrorCode {
  return match(reason)
    .with('run-cap', () => ERROR_CODES.RUN_CAPACITY_REACHED)
    .with('insufficient-balance', () => ERROR_CODES.INSUFFICIENT_ADMISSION)
    .with('allowance-exceeded', () => ERROR_CODES.DAILY_ALLOWANCE_EXHAUSTED)
    .with(
      'member-budget-exceeded',
      'conversation-budget-exceeded',
      () => ERROR_CODES.GROUP_ALLOCATION_EXHAUSTED
    )
    .exhaustive();
}

/** Maps a refusal or infra failure onto the engine's admission error codes. */
function createAdmissionHook(
  deps: ConversationRuntimeDeps,
  context: PaidRunContext,
  definition: WorkflowDefinition,
  run: AdmissionRunContext
): FlowHookBindings['admission'] {
  const stores = createBillingStores();
  const admissionDeps: AdmissionDeps = {
    redis: deps.redis,
    db: deps.db,
    stores,
  };
  return (request) => {
    const now = run.clock();
    const scope: ScopeContext = { now, ownerFunded: run.ownerFunded };
    return admitRun(admissionDeps, {
      walletId: context.walletId,
      holdId: context.runId,
      estimateNanoUsd: request.estimate,
      deadlineClass: definition.deadlineClass,
      concurrentRunCap: PER_WALLET_CONCURRENT_RUN_CAP,
      readScopes: () => readAdmissionScopes(deps, stores, context, scope),
      now,
    }).match(
      (decision) => {
        if (!decision.admitted) {
          // Each condition carries its OWN wire code, so the client renders
          // what actually bound rather than one sentence covering every
          // refusal (§Notices 2). The reason is finer-grained than the code —
          // it names WHICH group ceiling bound, where the code cannot — so it
          // still rides the log with content-free correlation ids: money stays
          // off the line, no field carries the nano-USD estimate, and
          // `errorCode` is the machine-readable reason, never content.
          const { runId, conversationId } = context;
          deps.telemetry.warn('chat admission refused', {
            errorCode: decision.reason,
            runId,
            conversationId,
          });
          return { admitted: false as const, code: admissionRefusalCode(decision.reason) };
        }
        return {
          admitted: true as const,
          holdRef: decision.hold.holdId,
          // The hold identity rides the grant to the run handle's
          // `admitted` promise, so the DO's terminal sink can release
          // the hold instead of waiting out its TTL.
          hold: {
            walletId: decision.hold.walletId,
            holdId: decision.hold.holdId,
            scopeIds: decision.hold.scopeIds,
          },
          circuit: {
            estimateNanoUsd: decision.hold.estimateNanoUsd,
            costCircuitMultiplier: decision.hold.costCircuitMultiplier,
            costCircuitLimitNanoUsd: decision.hold.costCircuitLimitNanoUsd,
          },
        };
      },
      // Redis-down is the one failure with an admission-specific answer (503,
      // fail-closed). Everything else here is infrastructure or a defect — a
      // missing wallet row — and projects through its own taxonomy code.
      // Wearing the money refusal told the user their balance was short when
      // nothing about their balance was wrong.
      (error) => ({
        admitted: false as const,
        code:
          error.code === 'unavailable' ? ERROR_CODES.ADMISSION_UNAVAILABLE : domainWireCode(error),
      })
    );
  };
}

/**
 * The put barrier a media run's settlement passes first: every ciphertext put
 * the mappers initiated must have landed before the fenced settlement runs. A
 * lost put rejects here, terminal-failing the run BEFORE anything commits — a
 * content row never points at a missing object, and an involuntary failure
 * bills nothing (saved ⟺ billed).
 */
export function withMediaPutBarrier(
  settle: SettlementHook,
  flushPuts: () => Promise<void>
): SettlementHook {
  return async (request) => {
    await flushPuts();
    return settle(request);
  };
}

/**
 * The settlement identity for one paid run. `mediaPlans` is the SAME map
 * instance the media mint filled — pre-mint and settlement can never see
 * different plans — and is absent (not empty) for a text run.
 */
export function chatSettlementIdentity(
  context: PaidRunContext,
  answerMessageIds: ReadonlyMap<string, string>,
  mediaPlans?: ReadonlyMap<string, MediaPersistPlan>
): ChatSettlementIdentity {
  return {
    conversationId: context.conversationId,
    epochNumber: context.epochNumber,
    walletId: context.walletId,
    payerUserId: context.payerUserId,
    // The resolved sender rides settlement so `messages.senderId`, the
    // member-keyed epoch gate, and per-member spend key on the guest (or
    // member), not the paying owner.
    sender: context.sender,
    runId: context.runId,
    userMessage: context.userMessage,
    answerMessageIds,
    ...(context.forkId == null ? {} : { forkId: context.forkId }),
    ...(context.regenerate == null ? {} : { regenerate: context.regenerate }),
    ...(mediaPlans === undefined ? {} : { mediaPlans }),
  };
}

/** The per-binder collaborators the chat policy closes over (clock, ids, stores). */
interface BinderContext {
  readonly clock: () => Date;
  readonly newId: () => string;
  readonly billingStores: ReturnType<typeof createBillingStores>;
}

/** The chat policy's admission (balance hold) + settlement (persist-then-charge). */
function bindChatHooks(
  deps: ConversationRuntimeDeps,
  context: PaidRunContext,
  definition: WorkflowDefinition,
  binder: BinderContext
): ChatHookBindings {
  // A MEDIA turn (deadline-classed 'media'; its modelCall nodes are the 1–5
  // media siblings) gets a media-persist run: pre-minted per-node identities
  // (minted on the start path, before executor.start) whose plans instance is
  // shared verbatim with the settlement identity, per-node encrypt-and-store
  // mappers, and the put barrier ahead of settlement. A text turn constructs
  // none of this: no storage and no epoch read. Every turn's answer ids are
  // minted here, one per answer node, and the media plans store under them.
  const answerIds = answerMessageIds(definition, binder.newId);
  const assistantMessageIds = [...answerIds.values()];
  const mediaNodes = mediaCallNodes(definition);
  const media: MediaPersistRun | undefined =
    mediaNodes.length === 0
      ? undefined
      : createMediaPersistRun(
          {
            storage: deps.storage,
            db: deps.db,
            readEpochPublicKey: deps.readEpochPublicKey,
            newId: binder.newId,
          },
          {
            conversationId: context.conversationId,
            epochNumber: context.epochNumber,
            answerMessageIds: answerIds,
          },
          mediaNodes
        );
  // The single funding decision, derived ONCE per run and threaded to BOTH
  // hooks, so scope emission and group-spend attribution can never disagree.
  const ownerFunded = isOwnerFunded(context);
  const settlementDeps: Parameters<typeof createChatSettlementCommit>[0] = {
    identity: chatSettlementIdentity(context, answerIds, media?.plans),
    stores: deps.chatStores,
    billingStores: binder.billingStores,
    ownerFunded,
    readEpochPublicKey: deps.readEpochPublicKey,
    now: binder.clock,
    newId: binder.newId,
  };
  const settlement = createFencedSettlementHook({
    db: deps.db,
    fence: context.fence,
    // The replayable response a succeeded key row returns on a resend: the
    // run and the message ids its run-start response named, so a client
    // whose first response was lost still learns them. The client
    // re-fetches the settled turn's final cost. A refused run flips the same
    // row, billed or absorbed, and replays the same body.
    complete: keyRowCompletion({
      runId: context.runId,
      userMessageId: context.userMessage.id,
      assistantMessageIds,
    }),
    commit: createChatSettlementCommit(settlementDeps),
    refusalCommit: createChatRefusalCommit(settlementDeps),
  });
  return {
    admission: createAdmissionHook(deps, context, definition, { clock: binder.clock, ownerFunded }),
    settlement: media === undefined ? settlement : withMediaPutBarrier(settlement, media.flushPuts),
    answerMessageIds: answerIds,
    assistantMessageIds,
    ...(media === undefined
      ? {}
      : { mediaPersist: { mint: media.mint, mapFilePartFor: media.mapFilePartFor } }),
  };
}

/**
 * The policy-hook binder — the anti-duplication seam. It dispatches on the
 * definition's DECLARED hook names, not on a hardcoded policy: `chat` binds the
 * balance-hold admission and the persist-then-charge settlement; `trial` binds
 * the quota admission and the no-op settlement. The turn pipeline is one; only
 * the bound policy differs. An unregistered hook name is a composition defect.
 */
function createHookBinder(
  deps: ConversationRuntimeDeps
): (context: RunContext, definition: WorkflowDefinition) => ChatHookBindings {
  const binder: BinderContext = {
    clock: deps.now ?? ((): Date => new Date()),
    newId: deps.newId ?? ((): string => crypto.randomUUID()),
    billingStores: createBillingStores(),
  };
  return (context, definition) => {
    if (definition.hooks.admission === CHAT_ADMISSION_HOOK) {
      return bindChatHooks(deps, requirePaidContext(context), definition, binder);
    }
    if (definition.hooks.admission === TRIAL_ADMISSION_HOOK) {
      return {
        ...bindTrialHooks(deps, requireTrialContext(context), binder.clock),
        answerMessageIds: new Map(),
        assistantMessageIds: [],
      };
    }
    throw new Error(
      `chat runtime: no policy registered for hooks admission="${definition.hooks.admission}" settlement="${definition.hooks.settlement}"`
    );
  };
}

function createClaimRun(deps: ConversationRuntimeDeps): ClaimRun {
  const newId = deps.newId ?? ((): string => crypto.randomUUID());
  return (request) => {
    const executorId = newId();
    // A link id and a trial session id are not user ids; the scope's uuid
    // column takes them because it carries no FK.
    //
    // The scope is deliberately NOT the payer. The payer is re-resolved from
    // live funding state on every POST of one client-minted key, so it moves
    // between attempts: an owner-funded turn resubmitted after the group
    // headroom crosses to ≤ 0 falls through to the sender's own funds. A
    // payer-scoped row would then be a DIFFERENT row for the same key — the
    // resubmit re-executes instead of replaying, and mid-run claims as a fresh
    // executor instead of attaching. Replay is a stability property, so it keys
    // on the one principal a retry cannot change.
    const scopeUserId =
      request.identity.mode === 'paid'
        ? senderPrincipalId(request.identity.sender)
        : request.identity.sessionId;
    return claimKeyRow(deps.db, {
      scope: { userId: scopeUserId, route: CHAT_TURN_ROUTE, key: request.runKey },
      kind: 'run',
      bodyHash: request.bodyHash,
      executorId,
      leaseSeconds: RUN_LEASE_SECONDS,
      runId: request.runId,
    }).match(
      (claim): RunClaim => {
        if (claim.outcome === 'executor') {
          return {
            outcome: 'executor',
            fence: { id: claim.row.id, executorId, claims: claim.row.claims },
          };
        }
        if (claim.outcome === 'replay') {
          return { outcome: 'replay', response: claim.response };
        }
        return { outcome: 'attach' };
      },
      (error): RunClaim => {
        // A reused key + different body is an EXPECTED conflict → 409 with the
        // body-mismatch code, never swallowed into "runtime unavailable". Any
        // other DomainError is an infra failure — rethrow so the DO's startRun
        // catch releases the in-memory claim and surfaces it.
        if (isIdempotencyConflict(error)) return { outcome: 'conflict', code: error.wireCode };
        throw new Error('chat runtime: run referee unavailable', { cause: error });
      }
    );
  };
}

/** The swallow arm of the best-effort duties (each mechanism's backstop recovers). */
function noop(): void {
  // Deliberately empty.
}

export function createConversationRuntime(deps: ConversationRuntimeDeps): ConversationRuntime {
  return {
    executor: createLazyExecutor(deps),
    bindHooks: createHookBinder(deps),
    claimRun: createClaimRun(deps),
    // The DO's terminal-sink capabilities, all best-effort by design: every
    // error is swallowed into the mechanism's own backstop (hold TTL, lease
    // lapse) because none of these may ever fail or stop a run.
    releaseHold: (hold: FlowHoldIdentity): Promise<void> =>
      releaseHold({ redis: deps.redis, db: deps.db, stores: createBillingStores() }, hold).match(
        noop,
        noop
      ),
    heartbeat: (fence: RunFence): Promise<'alive' | 'lost'> =>
      heartbeatKeyRow(deps.db, fence).match(
        (outcome) => outcome,
        // A transient store failure must never stop a healthy run; the fence
        // stays authoritative — a truly superseded run loses at settlement.
        () => 'alive' as const
      ),
    failRun: (fence: RunFence): Promise<void> => failKeyRow(deps.db, fence).match(noop, noop),
  };
}
