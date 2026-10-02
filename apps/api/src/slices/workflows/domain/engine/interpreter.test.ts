import { describe, expect, it, vi } from 'vitest';
import {
  END_NODE_ID,
  ERROR_CODES,
  jsonTag,
  listTag,
  MAX_SELECTED_MODELS,
  mediaTag,
  nanoUSD,
  optionalTag,
  PolicyHooks,
  textTag,
  TURN_DECISION_REDUCER,
  VALUE_STORE_BYTE_BUDGET_BYTES,
  WEB_SEARCH_TOOL_NAME,
} from '@hushbox/shared';
import { inputTokensOf, toolCallChargeNanoUsd } from '@hushbox/shared/affordability';
import { ReplayBuffer } from '@hushbox/realtime/replay-buffer';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { err, ok } from '../../../../lib/result/index.js';
import { forbiddenError, notFoundError, validationError } from '../../../../lib/errors/index.js';
import {
  CLASSIFICATION_SCHEMA_NAME as CLASSIFICATION,
  makeFakeConstraints,
  makeFakeNodeRegistry,
} from '../compile/registry-fakes.js';
import { decisionDomainInput } from '../nodes/turn-decision.js';
import { portsAccepting } from './model-ports.js';
import { buildWorkflow } from '../builder/build-workflow.js';
import { branch } from '../builder/branch.js';
import { fanIn } from '../builder/fan-in.js';
import { fanOut } from '../builder/fan-out.js';
import { loop } from '../builder/loop.js';
import { modelCall } from '../builder/model-call.js';
import { smartModel } from '../builder/smart-model.js';
import { subWorkflow } from '../builder/sub-workflow.js';
import { transform } from '../builder/transform.js';
import { workflowInputs } from '../builder/workflow-inputs.js';
import {
  failWith,
  makeFakeExecutionRegistry,
  respondWith,
  streamThenHang,
  streamingEcho,
} from './execution-fakes.js';
import { createWorkflowExecutor } from './interpreter.js';
import {
  AbsorbedSettlementRefusal,
  AllBranchesFailedError,
  SettlementConflictError,
  InfrastructureUnavailableError,
} from './failures.js';
import type {
  AdmissionRequest,
  ChatHistoryMessage,
  FilePartMapper,
  FlowAbortReason,
  FlowAdmissionOutcome,
  FlowHoldIdentity,
  FlowInputs,
  FlowRunOutcome,
  FlowStartRequest,
  FlowStreamEvent,
  NanoUSD,
  SettlementRequest,
  TextTag,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { Result } from '../../../../lib/result/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { BuildRegistries } from '../builder/build-workflow.js';
import type { NodeBillingMetadata, NodeRunError, NodeRunSuccess } from './execution-registry.js';
import type { FakeBehavior, FakeExecutionOptions } from './execution-fakes.js';
import type { EngineAdmissionDecision } from './hooks.js';

const HOOKS = PolicyHooks.parse({ admission: 'chatAdmission', settlement: 'chatSettlement' });

// The client-supplied Idempotency-Key (printable-ASCII, attacker-controllable —
// never allowlist it as a Sentry tag) versus the server-minted run id.
const RUN_KEY = 'attacker@example.com controlled key';
const RUN_ID = testUuidV7(0);

/** The billing facts a fake `answer-model` modelCall threads to settlement. */
const ANSWER_BILLING = { modelId: 'answer-model', providerName: 'p', modality: 'text' } as const;

function registries(): BuildRegistries {
  return { nodes: makeFakeNodeRegistry(), constraints: makeFakeConstraints() };
}

function textInput(text: string): FlowInputs[string] {
  return { kind: 'text', text };
}

function grantWithLimit(limitNanoUsd: bigint, hold?: FlowHoldIdentity): EngineAdmissionDecision {
  return {
    admitted: true,
    holdRef: 'hold-1',
    ...(hold === undefined ? {} : { hold }),
    circuit: {
      estimateNanoUsd: limitNanoUsd / 5n,
      costCircuitMultiplier: 5n,
      costCircuitLimitNanoUsd: limitNanoUsd,
    },
  };
}

function makeTelemetry(): Telemetry {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    captureError: vi.fn(),
  };
}

interface HarnessOptions extends FakeExecutionOptions {
  readonly definition: WorkflowDefinition;
  readonly inputs?: FlowInputs;
  readonly history?: readonly ChatHistoryMessage[];
  readonly customInstructions?: string;
  readonly mapFilePartFor?: FlowStartRequest['mapFilePartFor'];
  readonly decision?: EngineAdmissionDecision | Promise<never>;
  readonly settle?: (request: SettlementRequest) => Promise<void>;
  readonly estimate?: NanoUSD;
  readonly estimateFails?: boolean;
  readonly valueBudgetBytes?: number;
  readonly startAtMs?: number;
  readonly registries?: BuildRegistries;
  /** Start without a minted run id, as an in-process executor double may. */
  readonly omitRunId?: boolean;
}

interface Harness {
  readonly done: Promise<FlowRunOutcome>;
  readonly admitted: Promise<FlowAdmissionOutcome>;
  readonly stop: (reason: 'user-stop' | 'deadline') => void;
  readonly abort: (reason: FlowAbortReason) => void;
  readonly emitted: FlowStreamEvent[];
  readonly settlements: SettlementRequest[];
  readonly admissionRequests: AdmissionRequest[];
  readonly telemetry: Telemetry;
  readonly clockState: { now: number };
}

/** The optional run-scoped context fields (history, custom instructions, file-part mapper resolver) a start request carries only when supplied. */
function optionalRunContext(
  options: HarnessOptions
): Partial<Pick<FlowStartRequest, 'history' | 'customInstructions' | 'mapFilePartFor'>> {
  return {
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.customInstructions === undefined
      ? {}
      : { customInstructions: options.customInstructions }),
    ...(options.mapFilePartFor === undefined ? {} : { mapFilePartFor: options.mapFilePartFor }),
  };
}

/** The run id a start carries, absent for the caller that mints none. */
function mintedRunId(options: HarnessOptions): { readonly runId?: string } {
  return options.omitRunId === true ? {} : { runId: RUN_ID };
}

function startRun(options: HarnessOptions): Harness {
  const emitted: FlowStreamEvent[] = [];
  const settlements: SettlementRequest[] = [];
  const admissionRequests: AdmissionRequest[] = [];
  const telemetry = makeTelemetry();
  const clockState = { now: options.startAtMs ?? 1000 };
  const decision = options.decision ?? grantWithLimit(1_000_000n);
  const estimate = options.estimate ?? nanoUSD(100n);
  const executor = createWorkflowExecutor({
    registries: options.registries ?? registries(),
    execution: makeFakeExecutionRegistry({
      behaviors: options.behaviors,
      ...(options.predicates === undefined ? {} : { predicates: options.predicates }),
      ...(options.reducers === undefined ? {} : { reducers: options.reducers }),
    }),
    estimateRun: () =>
      options.estimateFails === true
        ? err(validationError('no pricing'))
        : ok({ totalNanoUsd: estimate, calls: [] }),
    clock: { now: () => clockState.now },
    rng: { random: () => 0.5 },
    telemetry,
    ...(options.valueBudgetBytes === undefined
      ? {}
      : { valueBudgetBytes: options.valueBudgetBytes }),
  });
  const handle = executor.start({
    definition: options.definition,
    inputs: options.inputs ?? { prompt: textInput('hi') },
    ...optionalRunContext(options),
    hooks: {
      admission: (request) => {
        admissionRequests.push(request);
        return Promise.resolve(decision);
      },
      settlement:
        options.settle ??
        ((request): Promise<void> => {
          settlements.push(request);
          return Promise.resolve();
        }),
    },
    runKey: RUN_KEY,
    ...mintedRunId(options),
    emit: (event) => {
      emitted.push(event);
    },
  });
  return {
    done: handle.done,
    admitted: handle.admitted,
    stop: (reason) => {
      handle.stop(reason);
    },
    abort: (reason) => {
      handle.abort(reason);
    },
    emitted,
    settlements,
    admissionRequests,
    telemetry,
    clockState,
  };
}

/** A single streaming modelCall over the prompt — the one-node chat shape. */
function answerDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const answer = modelCall({
    id: 'answer',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [answer],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** A single composite smartModel node over the prompt — the Smart Model turn shape. */
function smartModelNodeDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const answer = smartModel({
    id: 'answer',
    classifierModelId: 'answer-model',
    candidates: [{ id: 'answer-model', description: 'cheap' }, { id: 'hard-model' }],
    accepts: textTag(),
    in: inputs.ports.prompt,
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [answer],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** A single sink modelCall whose node id is a reserved prototype name. */
function protoSinkDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const answer = modelCall({
    id: '__proto__',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [answer],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** A one-node chat whose sole workflow input port is a reserved prototype name. */
function protoInputPortDefinition(): WorkflowDefinition {
  // Reference the port through a variable key: dot access would read the
  // prototype accessor, and a string-literal subscript trips dot-notation lint.
  const reservedPort = '__proto__';
  const inputs = workflowInputs({ [reservedPort]: textTag() });
  const answer = modelCall({
    id: 'answer',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports[reservedPort],
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [answer],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** classify → branch → answer, with distinct case and else targets. */
function smartDefinition(elseTarget?: 'end'): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const classify = modelCall({
    id: 'classify',
    model: 'classifier-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: jsonTag(CLASSIFICATION),
    optional: true,
    onError: 'skip',
  });
  const answerSimple = modelCall({
    id: 'answerSimple',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const answerHard = modelCall({
    id: 'answerHard',
    model: 'hard-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const route = branch({
    id: 'route',
    predicate: 'routeByLabel',
    accepts: optionalTag(jsonTag(CLASSIFICATION)),
    in: classify.out,
    cases: { simple: answerSimple, hard: answerHard },
    else: elseTarget === 'end' ? END_NODE_ID : answerHard,
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [classify, route, answerSimple, answerHard],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** Three chained modelCalls — boundary instrumentation for the circuit. */
function chainDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const first = modelCall({
    id: 'first',
    model: 'first-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const second = modelCall({
    id: 'second',
    model: 'second-model',
    accepts: textTag(),
    in: first.out,
    produces: textTag(),
  });
  const third = modelCall({
    id: 'third',
    model: 'third-model',
    accepts: textTag(),
    in: second.out,
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [first, second, third],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/**
 * Two levels, the first CONSUMED by the second: the first node bills but is no
 * sink, so it surfaces no run output of its own — the shape a turn-level
 * classifier has.
 */
function consumedFirstDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const first = modelCall({
    id: 'first',
    model: 'first-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const second = modelCall({
    id: 'second',
    model: 'second-model',
    accepts: textTag(),
    in: first.out,
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [first, second],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** A branch that routes every taken path to an untaken one's consumers. */
function deadKindsDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const classify = modelCall({
    id: 'classify',
    model: 'classifier-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: jsonTag(CLASSIFICATION),
  });
  const mid = modelCall({
    id: 'mid',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const other = modelCall({
    id: 'other',
    model: 'hard-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const classifyAlt = modelCall({
    id: 'classifyAlt',
    model: 'classifier-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: jsonTag(CLASSIFICATION),
  });
  const route = branch({
    id: 'route',
    predicate: 'routeByLabel',
    accepts: optionalTag(jsonTag(CLASSIFICATION)),
    in: classify.out,
    cases: { simple: mid, alt: classifyAlt },
    else: other,
  });
  const deadBranch = branch({
    id: 'deadBranch',
    predicate: 'textDone',
    accepts: textTag(),
    in: mid.out,
    cases: {},
    else: END_NODE_ID,
  });
  const deadJoin = fanIn({
    id: 'deadJoin',
    reducer: 'pairJoin',
    accepts: [textTag(), textTag()] as const,
    ins: [mid.out, mid.out],
    produces: textTag(),
  });
  const deadSplit = transform({
    id: 'deadSplit',
    transform: 'split',
    accepts: textTag(),
    in: mid.out,
    produces: listTag(textTag()),
  });
  const deadFan = fanOut<TextTag, TextTag>({
    id: 'deadFan',
    over: deadSplit.out,
    maxWidth: 2,
    body: (element) =>
      modelCall({
        id: 'deadDescribe',
        model: 'answer-model',
        accepts: textTag(),
        in: element,
        produces: textTag(),
      }),
  });
  const deadLoop = loop({
    id: 'deadLoop',
    until: 'textDone',
    maxIterations: 2,
    initial: mid.out,
    body: (state) =>
      transform({
        id: 'deadExtend',
        transform: 'echo',
        accepts: textTag(),
        in: state,
        produces: textTag(),
      }),
  });
  const lateRoute = branch({
    id: 'lateRoute',
    predicate: 'routeByLabel',
    accepts: optionalTag(jsonTag(CLASSIFICATION)),
    in: classifyAlt.out,
    cases: {},
    else: other,
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [
      classify,
      route,
      mid,
      other,
      classifyAlt,
      deadBranch,
      deadJoin,
      deadSplit,
      deadFan,
      deadLoop,
      lateRoute,
    ],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** A fanOut whose body branch always routes to the end sentinel. */
function fanOutEndDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const split = transform({
    id: 'split',
    transform: 'split',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: listTag(textTag()),
  });
  const spread = fanOut<TextTag, TextTag>({
    id: 'spread',
    over: split.out,
    maxWidth: 4,
    body: (element) =>
      branch({
        id: 'gate',
        predicate: 'textDone',
        accepts: textTag(),
        in: element,
        cases: {},
        else: END_NODE_ID,
      }),
  });
  const join = fanIn({
    id: 'join',
    reducer: 'captionsWithPrompt',
    accepts: [listTag(optionalTag(textTag())), textTag()] as const,
    ins: [spread.out, inputs.ports.prompt],
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [split, spread, join],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** split → fanOut(streaming body) → fanIn(captionsWithPrompt). */
function fanOutDefinition(maxWidth: number, bodyOnError?: 'fail'): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const split = transform({
    id: 'split',
    transform: 'split',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: listTag(textTag()),
  });
  const spread = fanOut<TextTag, TextTag>({
    id: 'spread',
    over: split.out,
    maxWidth,
    body: (element) =>
      modelCall({
        id: 'describe',
        model: 'answer-model',
        accepts: textTag(),
        in: element,
        produces: textTag(),
        ...(bodyOnError === 'fail'
          ? { onError: 'fail' as const }
          : { optional: true, onError: 'skip' as const }),
      }),
  });
  const join = fanIn({
    id: 'join',
    reducer: 'captionsWithPrompt',
    accepts: [listTag(optionalTag(textTag())), textTag()] as const,
    ins: [spread.out, inputs.ports.prompt],
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [split, spread, join],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** An independent streaming sink beside a fanOut — coincident stop+circuit. */
function sinkBesideFanDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const side = modelCall({
    id: 'side',
    model: 'first-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const split = transform({
    id: 'split',
    transform: 'split',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: listTag(textTag()),
  });
  const spread = fanOut<TextTag, TextTag>({
    id: 'spread',
    over: split.out,
    maxWidth: 4,
    body: (element) =>
      modelCall({
        id: 'describe',
        model: 'second-model',
        accepts: textTag(),
        in: element,
        produces: textTag(),
        onError: 'fail',
      }),
  });
  const join = fanIn({
    id: 'join',
    reducer: 'captionsWithPrompt',
    accepts: [listTag(optionalTag(textTag())), textTag()] as const,
    ins: [spread.out, inputs.ports.prompt],
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [side, split, spread, join],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

function loopDefinition(maxIterations: number, bodyOnError?: 'skip'): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const refine = loop({
    id: 'refine',
    until: 'textDone',
    maxIterations,
    initial: inputs.ports.prompt,
    body: (state) =>
      transform({
        id: 'extend',
        transform: 'echo',
        accepts: textTag(),
        in: state,
        produces: textTag(),
        ...(bodyOnError === undefined ? {} : { onError: bodyOnError }),
      }),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [refine],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

function subWorkflowDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag(), extra: textTag() });
  const summarize = subWorkflow({
    id: 'summarize',
    ref: 'summarize',
    ins: [inputs.ports.prompt, inputs.ports.extra],
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [summarize],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** classify → branch over two answers, with a transform chained off one. */
function deadPathDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const classify = modelCall({
    id: 'classify',
    model: 'classifier-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: jsonTag(CLASSIFICATION),
  });
  const mid = modelCall({
    id: 'mid',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const tail = transform({
    id: 'tail',
    transform: 'echo',
    accepts: textTag(),
    in: mid.out,
    produces: textTag(),
  });
  const other = modelCall({
    id: 'other',
    model: 'hard-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const route = branch({
    id: 'route',
    predicate: 'labelDone',
    accepts: jsonTag(CLASSIFICATION),
    in: classify.out,
    cases: { simple: mid, hard: other },
    else: other,
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [classify, route, mid, tail, other],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/**
 * The multi-model turn shape: N independent sibling `modelCall` nodes (ids
 * `m0`…), each `optional` + `onError: 'skip'`, all reading the one prompt and
 * each its own sink — the fan-out the engine walks as one topological level.
 */
function multiModelDefinition(models: readonly string[]): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const siblings = models.map((model, index) =>
    modelCall({
      id: `m${String(index)}`,
      model,
      accepts: textTag(),
      in: inputs.ports.prompt,
      produces: textTag(),
      optional: true,
      onError: 'skip',
    })
  );
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: siblings,
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/**
 * A branch routing straight to the end sentinel, declared beside an independent
 * sibling modelCall: both read the prompt, so both sit on the level the branch
 * ends the walk from.
 */
function endBesideSiblingDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const gate = branch({
    id: 'gate',
    predicate: 'textDone',
    accepts: textTag(),
    in: inputs.ports.prompt,
    cases: {},
    else: END_NODE_ID,
  });
  const sibling = modelCall({
    id: 'sibling',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [gate, sibling],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** A billing fact tagged with a distinct model id, so charges are told apart. */
function billingFor(modelId: string): FakeBehavior {
  return streamingEcho(0n, { modelId, providerName: 'p', modality: 'text' });
}

/** streamingEcho that resolves only after `delayMs`, to decouple completion order from declaration order. */
function delayedEcho(delayMs: number, costNanoUsd: bigint, modelId: string): FakeBehavior {
  return {
    streaming: true,
    run: async (input, ctx) => {
      const value = `echo:${String(input[0])}`;
      for (let index = 0; index < value.length; index += 1) {
        ctx.emit?.({ kind: 'text-delta', index, content: value.charAt(index) });
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return ok({ value, costNanoUsd, billing: { modelId, providerName: 'p', modality: 'text' } });
    },
  };
}

interface DrainingBehavior extends FakeBehavior {
  /** Resolves once a call is in flight, waiting for its release. */
  readonly inFlight: Promise<void>;
  /** Lets every in-flight call run on to its end. */
  readonly release: () => void;
  /** Whether any call's run signal had aborted when its call ended. */
  readonly sawAbort: () => boolean;
}

/**
 * A streaming call that, once in flight, waits for an explicit release rather
 * than for its signal, then settles with `outcome`: the shape of a provider
 * step that runs on to its end after the gate closes.
 */
function drainingBehavior(
  outcome: () => Result<NodeRunSuccess, NodeRunError>,
  partial?: string
): DrainingBehavior {
  let markInFlight!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    markInFlight = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const aborted: boolean[] = [];
  return {
    streaming: true,
    inFlight,
    release,
    sawAbort: () => aborted.includes(true),
    run: async (_input, ctx) => {
      if (partial !== undefined) ctx.emit?.({ kind: 'text-delta', index: 0, content: partial });
      markInFlight();
      await released;
      aborted.push(ctx.signal.aborted);
      return outcome();
    },
  };
}

/** Streams `partial`, waits for its release, then answers `value` at `costNanoUsd`. */
function streamThenFinish(
  value: string,
  costNanoUsd = 0n,
  billing?: NodeBillingMetadata
): DrainingBehavior {
  return drainingBehavior(
    () => ok({ value, costNanoUsd, ...(billing === undefined ? {} : { billing }) }),
    value.slice(0, 1)
  );
}

/** Waits for its release, then fails having produced nothing. */
function waitThenFail(): DrainingBehavior {
  return drainingBehavior(() => err({}));
}

const ROUTE_PREDICATES = {
  routeByLabel: (input: unknown): string =>
    (input as { label?: string } | undefined)?.label ?? 'fallback',
};

/**
 * classifier -> fanIn -> answer: the decision-envelope shape. The classifier's
 * output is consumed rather than displayed; the answer's is displayed.
 */
function consumedProducerDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const classify = modelCall({
    id: 'classify',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const decide = fanIn({
    id: 'decide',
    reducer: 'classifyText',
    accepts: [textTag()] as const,
    ins: [classify.out],
    produces: jsonTag(CLASSIFICATION),
  });
  const answer = modelCall({
    id: 'answer',
    model: 'answer-model',
    accepts: jsonTag(CLASSIFICATION),
    in: decide.out,
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [classify, decide, answer],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/**
 * The three inputs the shipped classifier graph carries: the answer's prompt,
 * the classifier's own rendered prompt, and the turn's decision domain. The
 * domain is encoded by the production encoder rather than written out, so this
 * fixture cannot speak a wire format the reducer does not.
 */
function classifierRunInputs(): FlowInputs {
  return {
    prompt: textInput('hi'),
    classifierPrompt: textInput('[CLASSIFY] hi'),
    decisionDomain: textInput(
      decisionDomainInput({ presentedEfforts: ['low', 'high'], candidates: [] })
    ),
  };
}

/**
 * The shipped decision shape: an ordinary `modelCall` classifies and the
 * REGISTERED decision reducer reads its answer at the optional-answer position,
 * which is what makes that call derivably the turn's classifier.
 */
function turnClassifierDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({
    prompt: textTag(),
    classifierPrompt: textTag(),
    decisionDomain: textTag(),
  });
  const classify = modelCall({
    id: 'classify',
    model: 'first-model',
    accepts: textTag(),
    in: inputs.ports.classifierPrompt,
    produces: textTag(),
    optional: true,
    onError: 'skip',
  });
  const decide = fanIn({
    id: 'decide',
    reducer: TURN_DECISION_REDUCER,
    accepts: [textTag(), optionalTag(textTag()), textTag()] as const,
    ins: [inputs.ports.prompt, classify.out, inputs.ports.decisionDomain],
    produces: jsonTag(CLASSIFICATION),
  });
  const answer = modelCall({
    id: 'answer',
    model: 'answer-model',
    accepts: jsonTag(CLASSIFICATION),
    in: decide.out,
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [classify, decide, answer],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

describe('createWorkflowExecutor — the turn classifier is handed no client context', () => {
  const HISTORY: readonly ChatHistoryMessage[] = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ];

  interface SeenContext {
    readonly history: readonly ChatHistoryMessage[] | undefined;
    readonly customInstructions: string | undefined;
  }

  function runWithClientContext(seen: Map<string, SeenContext>): ReturnType<typeof startRun> {
    const capture = (id: string): FakeExecutionOptions['behaviors'][string] => ({
      run: (_input, ctx) => {
        seen.set(id, {
          history: ctx.history,
          customInstructions: ctx.customInstructions,
        });
        return Promise.resolve(ok({ value: 'model: answer-model', costNanoUsd: 0n }));
      },
    });
    return startRun({
      definition: turnClassifierDefinition(),
      behaviors: { 'first-model': capture('classify'), 'answer-model': capture('answer') },
      reducers: { [TURN_DECISION_REDUCER]: (inputs) => ({ label: String(inputs[0]) }) },
      inputs: classifierRunInputs(),
      history: HISTORY,
      customInstructions: 'answer only in French',
    });
  }

  it('withholds the conversation history from the classifier call', async () => {
    const seen = new Map<string, SeenContext>();
    await expect(runWithClientContext(seen).done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seen.get('classify')?.history).toBeUndefined();
  });

  it('withholds the custom instructions from the classifier call', async () => {
    const seen = new Map<string, SeenContext>();
    await expect(runWithClientContext(seen).done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seen.get('classify')?.customInstructions).toBeUndefined();
  });

  it('still hands both to the answering sibling that consumes the decision', async () => {
    const seen = new Map<string, SeenContext>();
    await expect(runWithClientContext(seen).done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seen.get('answer')).toEqual({
      history: HISTORY,
      customInstructions: 'answer only in French',
    });
  });
});

/**
 * The shipped multi-model `auto` shape at its real width: one classifier, the
 * decision reducer, and THREE sibling answers that each read the decision.
 */
function threeSiblingClassifierDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({
    prompt: textTag(),
    classifierPrompt: textTag(),
    decisionDomain: textTag(),
  });
  const classify = modelCall({
    id: 'classify',
    model: 'first-model',
    accepts: textTag(),
    in: inputs.ports.classifierPrompt,
    produces: textTag(),
    optional: true,
    onError: 'skip',
  });
  const decide = fanIn({
    id: 'decide',
    reducer: TURN_DECISION_REDUCER,
    accepts: [textTag(), optionalTag(textTag()), textTag()] as const,
    ins: [inputs.ports.prompt, classify.out, inputs.ports.decisionDomain],
    produces: jsonTag(CLASSIFICATION),
  });
  const siblings = ['answer-model', 'hard-model', 'second-model'].map((model, index) =>
    modelCall({
      id: `answer${String(index)}`,
      model,
      accepts: jsonTag(CLASSIFICATION),
      in: decide.out,
      produces: textTag(),
      optional: true,
      onError: 'skip',
    })
  );
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [classify, decide, ...siblings],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

describe('createWorkflowExecutor — a classified multi-model turn bills its successful subset', () => {
  /** One sibling's outcome, keyed by the model its node runs. */
  type Outcome = 'succeeds' | 'fails';

  function threeSiblings(
    outcomes: Readonly<Record<string, Outcome>>,
    classifier: FakeExecutionOptions['behaviors'][string] = respondWith('effort: Low')
  ): ReturnType<typeof startRun> {
    const behaviors: Record<string, FakeBehavior> = { 'first-model': classifier };
    for (const [model, outcome] of Object.entries(outcomes)) {
      behaviors[model] = outcome === 'fails' ? failWith() : billingFor(model);
    }
    return startRun({
      definition: threeSiblingClassifierDefinition(),
      behaviors,
      reducers: { [TURN_DECISION_REDUCER]: (inputs) => ({ label: String(inputs[0]) }) },
      inputs: classifierRunInputs(),
    });
  }

  const ALL_THREE = {
    'answer-model': 'succeeds',
    'hard-model': 'succeeds',
    'second-model': 'succeeds',
  } as const;

  it('bills the successful subset when one sibling fails', async () => {
    const run = threeSiblings({ ...ALL_THREE, 'hard-model': 'fails' });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.charges.map((charge) => charge.modelId)).toEqual([
      'answer-model',
      'second-model',
    ]);
  });

  it('persists and bills nothing when every sibling fails', async () => {
    const run = threeSiblings({
      'answer-model': 'fails',
      'hard-model': 'fails',
      'second-model': 'fails',
    });
    await run.done;
    expect(run.settlements[0]?.charges ?? []).toEqual([]);
    expect(Object.keys(run.settlements[0]?.outputs ?? {})).toEqual([]);
  });

  it('makes the LAST successful sibling the fork tip', async () => {
    // Settlement persists sink outputs in declaration order and forks off the
    // last, so the ORDER of this record is the fork tip, not an incidental
    // detail of the walk.
    const run = threeSiblings({ ...ALL_THREE, 'second-model': 'fails' });
    await run.done;
    expect(Object.keys(run.settlements[0]?.outputs ?? {})).toEqual(['answer0', 'answer1']);
  });

  it('settles the partial when the user stops a classified turn mid-flight', async () => {
    // The third outcome §Multi-Model 4 names, and the one carve-out from
    // saved ⟺ billed: a user stop bills what was consumed.
    const draining = streamThenFinish('half an answer', 5n, {
      modelId: 'second-model',
      providerName: 'p',
      modality: 'text',
    });
    const run = startRun({
      definition: threeSiblingClassifierDefinition(),
      behaviors: {
        'first-model': respondWith('effort: Low'),
        'answer-model': billingFor('answer-model'),
        'hard-model': billingFor('hard-model'),
        'second-model': draining,
      },
      reducers: { [TURN_DECISION_REDUCER]: (inputs) => ({ label: String(inputs[0]) }) },
      inputs: classifierRunInputs(),
    });
    await draining.inFlight;
    run.stop('user-stop');
    draining.release();
    await run.done;
    expect(run.settlements[0]?.charges.map((charge) => charge.modelId)).toContain('answer-model');
  });

  it('keeps the classifier out of the persisted set — it has no content of its own', async () => {
    const run = threeSiblings(ALL_THREE);
    await run.done;
    expect(Object.keys(run.settlements[0]?.outputs ?? {})).toEqual([
      'answer0',
      'answer1',
      'answer2',
    ]);
  });
});

describe('createWorkflowExecutor — a failing classifier degrades, it does not kill the turn', () => {
  /** The three sibling ids the classifying multi-model shape declares. */
  function threeSiblingRun(classifier: FakeExecutionOptions['behaviors'][string]): {
    readonly run: ReturnType<typeof startRun>;
    readonly answered: string[];
  } {
    const answered: string[] = [];
    const run = startRun({
      definition: turnClassifierDefinition(),
      behaviors: {
        'first-model': classifier,
        'answer-model': {
          run: (input) => {
            answered.push(String((input[0] as { label?: string } | undefined)?.label));
            return Promise.resolve(
              ok({
                value: 'an answer',
                costNanoUsd: 7n,
                billing: { modelId: 'answer-model', providerName: 'p', modality: 'text' as const },
              })
            );
          },
        },
      },
      reducers: { [TURN_DECISION_REDUCER]: (inputs) => ({ label: String(inputs[0]) }) },
      inputs: classifierRunInputs(),
    });
    return { run, answered };
  }

  it('answers the turn when the classifier call fails outright', async () => {
    // The old internal path fell back to the cheapest candidate with no charge;
    // wired as an ordinary node, only `optional` + `onError: skip` keeps that
    // property — without them a routing hiccup is a dead paid turn.
    const { run, answered } = threeSiblingRun(failWith());
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(answered).toHaveLength(1);
  });

  it('bills only the sibling on a turn whose classifier failed', async () => {
    const { run } = threeSiblingRun(failWith());
    await run.done;
    expect(run.settlements[0]?.charges.map((charge) => charge.billableCostNanoUsd)).toEqual([7n]);
  });

  it("reaches the sibling with the reducer's fallback rather than no decision at all", async () => {
    // The skip leaves the reducer an ABSENT answer, which is the typed failure
    // path its optional second input exists for — so the sibling still receives
    // a decision, and the declared fallback is what fills it.
    const { run, answered } = threeSiblingRun(failWith());
    await run.done;
    expect(answered[0]).not.toBe('undefined');
  });
});

describe('createWorkflowExecutor — the streaming disposition', () => {
  it('withholds the stream from a node whose output is consumed rather than displayed', async () => {
    const run = startRun({
      definition: consumedProducerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      reducers: { classifyText: (inputs) => ({ label: String(inputs[0]) }) },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    const streamed = new Set(run.emitted.map((event) => event.streamId.split('#')[0]));
    expect(streamed).toEqual(new Set(['answer']));
  });
});

describe('createWorkflowExecutor — the streaming chat turn', () => {
  it('streams the terminal node through the run emit seam', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.emitted.length).toBeGreaterThan(1);
    expect(new Set(run.emitted.map((event) => event.streamId)).size).toBe(1);
    expect(run.emitted.map((event) => event.cursor)).toEqual(
      run.emitted.map((_, index) => index + 1)
    );
    expect(run.emitted[0]?.event).toEqual({ kind: 'text-delta', index: 0, content: 'e' });
  });

  // Composition against the real ReplayBuffer: the interpreter is the only
  // cursor allocator, and the buffer enforces the 1-based strictly-increasing
  // contract — a 0-based allocation throws on the very first token and a
  // fresh-client resume (lastEventId 0) would silently drop cursor-0 events.
  it('allocates cursors the real ReplayBuffer accepts and fully replays from a fresh resume', async () => {
    const buffer = new ReplayBuffer({ maxStreamBytes: 64 * 1024 });
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.emitted.length).toBeGreaterThan(1);
    for (const event of run.emitted) {
      expect(buffer.append(event)).toBe('buffered');
    }
    const streamId = run.emitted[0]?.streamId ?? '';
    expect(buffer.resume(streamId, 0)).toEqual({ kind: 'replay', events: run.emitted });
  });

  it('settles the terminal output and its per-generation charge under the producing node id', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho(1234n, ANSWER_BILLING) },
    });
    await run.done;
    expect(run.settlements).toEqual([
      {
        runKey: RUN_KEY,
        outputs: { answer: { kind: 'text', text: 'echo:hi' } },
        charges: [
          { key: 'answer', ...ANSWER_BILLING, billableCostNanoUsd: 1234n, isEstimated: false },
        ],
      },
    ]);
  });

  it('reports the idempotency run key on the run handle', () => {
    const executor = createWorkflowExecutor({
      registries: registries(),
      execution: makeFakeExecutionRegistry({
        behaviors: { 'answer-model': streamingEcho() },
      }),
      estimateRun: () => ok({ totalNanoUsd: nanoUSD(1n), calls: [] }),
      clock: { now: () => 0 },
      rng: { random: () => 0.5 },
      telemetry: makeTelemetry(),
    });
    const handle = executor.start({
      definition: answerDefinition(),
      inputs: { prompt: textInput('hi') },
      hooks: {
        admission: () => Promise.resolve(grantWithLimit(10n)),
        settlement: () => Promise.resolve(),
      },
      runKey: RUN_KEY,
      runId: RUN_ID,
      emit: () => {},
    });
    expect(handle.runKey).toBe(RUN_KEY);
    return handle.done;
  });
});

describe('createWorkflowExecutor — classify→branch→answer', () => {
  it('routes to the labeled case and skips the other target', async () => {
    const hard = vi.fn();
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'simple' }),
        'answer-model': streamingEcho(),
        'hard-model': {
          run: (input, ctx) => {
            hard();
            return streamingEcho().run(input, ctx);
          },
        },
      },
      predicates: ROUTE_PREDICATES,
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(hard).not.toHaveBeenCalled();
    expect(run.settlements[0]?.outputs).toEqual({
      answerSimple: { kind: 'text', text: 'echo:hi' },
    });
  });

  it('falls back to the else route when the optional classifier fails', async () => {
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': failWith(),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
      },
      predicates: ROUTE_PREDICATES,
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      answerHard: { kind: 'text', text: 'hard answer' },
    });
  });

  it('exits early when the branch routes to the end sentinel', async () => {
    const run = startRun({
      definition: smartDefinition('end'),
      behaviors: {
        'classifier-model': respondWith({ label: 'other' }),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
      },
      predicates: ROUTE_PREDICATES,
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements).toEqual([{ runKey: RUN_KEY, outputs: {}, charges: [] }]);
  });

  it('skips a node whose required feed comes from an untaken branch path', async () => {
    const run = startRun({
      definition: deadPathDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'hard' }),
        'answer-model': streamingEcho(),
        echo: respondWith('never'),
        'hard-model': respondWith('hard answer'),
      },
      predicates: { labelDone: (input) => (input as { label: string }).label },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      other: { kind: 'text', text: 'hard answer' },
    });
  });

  it('terminal-fails when a required node fails', async () => {
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'simple' }),
        'answer-model': failWith(),
        'hard-model': respondWith('hard answer'),
      },
      predicates: ROUTE_PREDICATES,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    expect(run.settlements).toEqual([]);
  });

  it('surfaces a failing node reason as the run outcome wire code', async () => {
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'simple' }),
        'answer-model': failWith(undefined, ERROR_CODES.CONTENT_POLICY),
        'hard-model': respondWith('hard answer'),
      },
      predicates: ROUTE_PREDICATES,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.CONTENT_POLICY,
    });
    expect(run.settlements).toEqual([]);
  });
});

describe('createWorkflowExecutor — branch verdict prototype safety', () => {
  it.each(['constructor', '__proto__', 'hasOwnProperty'])(
    'routes a %s verdict to the else target instead of dead-pathing',
    async (reserved) => {
      const run = startRun({
        definition: smartDefinition(),
        behaviors: {
          'classifier-model': respondWith({ label: 'x' }),
          'answer-model': streamingEcho(),
          'hard-model': respondWith('hard answer'),
        },
        predicates: { routeByLabel: () => reserved },
      });
      await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
      expect(run.settlements[0]?.outputs).toEqual({
        answerHard: { kind: 'text', text: 'hard answer' },
      });
    }
  );
});

describe('createWorkflowExecutor — ingress prototype safety', () => {
  it('processes an input whose port name is a reserved prototype name', async () => {
    const run = startRun({
      definition: protoInputPortDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: { ['__proto__']: textInput('hi') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      answer: { kind: 'text', text: 'echo:hi' },
    });
  });

  it('rejects a run missing a required input whose port name is a reserved prototype name', async () => {
    const run = startRun({
      definition: protoInputPortDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: {},
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.admissionRequests).toEqual([]);
  });
});

describe('createWorkflowExecutor — settlement output prototype safety', () => {
  it('settles the output of a sink node whose id is a reserved prototype name', async () => {
    const run = startRun({
      definition: protoSinkDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      ['__proto__']: { kind: 'text', text: 'echo:hi' },
    });
  });
});

describe('createWorkflowExecutor — admission', () => {
  it('hands the admission hook the server-computed estimate', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      estimate: nanoUSD(4200n),
    });
    await run.done;
    expect(run.admissionRequests).toHaveLength(1);
    expect(run.admissionRequests[0]?.estimate).toBe(4200n);
  });

  it('fails without executing anything when admission refuses', async () => {
    const executed = vi.fn();
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          run: (input, ctx) => {
            executed();
            return streamingEcho().run(input, ctx);
          },
        },
      },
      decision: { admitted: false, code: ERROR_CODES.INSUFFICIENT_ADMISSION },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
    expect(executed).not.toHaveBeenCalled();
    expect(run.settlements).toEqual([]);
  });

  it('treats a grant without a circuit readout as a defect', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      decision: { admitted: true, holdRef: 'hold-1' } as EngineAdmissionDecision,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('fails validation when the estimator cannot price the definition', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      estimateFails: true,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.admissionRequests).toEqual([]);
  });
});

describe('createWorkflowExecutor — the cost circuit', () => {
  it('refuses the next node once accrual crosses hold times K', async () => {
    const third = vi.fn();
    const run = startRun({
      definition: chainDefinition(),
      behaviors: {
        'first-model': respondWith('a', 200n),
        'second-model': respondWith('b', 400n),
        'third-model': {
          run: (input, ctx) => {
            third();
            return respondWith('c').run(input, ctx);
          },
        },
      },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(third).not.toHaveBeenCalled();
    // Both values that ran are consumed by the next node, so the run has no
    // output to settle.
    expect(run.settlements).toEqual([]);
  });

  it('counts the spend a failing optional node reports toward the circuit', async () => {
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': failWith(600n),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
      },
      predicates: ROUTE_PREDICATES,
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    const [error] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(error).toMatchObject({ accruedNanoUsd: '600' });
  });
});

describe('createWorkflowExecutor — the composite smartModel node', () => {
  it('dispatches a smartModel node as a streaming value node keyed by its classifier', async () => {
    const run = startRun({
      definition: smartModelNodeDefinition(),
      behaviors: { 'answer-model': streamingEcho(7n, ANSWER_BILLING) },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({ answer: { kind: 'text', text: 'echo:hi' } });
    expect(run.settlements[0]?.charges).toEqual([
      {
        key: 'answer',
        modelId: 'answer-model',
        providerName: 'p',
        modality: 'text',
        billableCostNanoUsd: 7n,
        isEstimated: false,
      },
    ]);
  });
});

/** A classifier generation's billing facts, distinct from the answer's. */
const AUX_BILLING = { modelId: 'cheap-model', providerName: 'p', modality: 'text' } as const;

describe('createWorkflowExecutor — auxiliary charges and mid-node reports', () => {
  it("collects an auxiliary generation's charge under the node key plus its suffix", async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          streaming: true,
          run: () =>
            Promise.resolve(
              ok({
                value: 'routed answer',
                costNanoUsd: 20n,
                isEstimated: false,
                billing: ANSWER_BILLING,
                auxiliaryCharges: [
                  {
                    keySuffix: 'classifier',
                    billing: { ...AUX_BILLING, generationId: 'gen-cls' },
                    billableCostNanoUsd: 7n,
                    isEstimated: false,
                  },
                ],
              })
            ),
        },
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.charges).toEqual([
      {
        key: 'answer',
        modelId: 'answer-model',
        providerName: 'p',
        modality: 'text',
        billableCostNanoUsd: 20n,
        isEstimated: false,
      },
      {
        key: 'answer#classifier',
        modelId: 'cheap-model',
        providerName: 'p',
        modality: 'text',
        generationId: 'gen-cls',
        billableCostNanoUsd: 7n,
        isEstimated: false,
      },
    ]);
  });

  it('lifts smartModelRan onto the primary charge only, never the auxiliary classifier charge', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          streaming: true,
          run: () =>
            Promise.resolve(
              ok({
                value: 'routed answer',
                costNanoUsd: 20n,
                isEstimated: false,
                smartModelRan: true,
                billing: ANSWER_BILLING,
                auxiliaryCharges: [
                  {
                    keySuffix: 'classifier',
                    billing: { ...AUX_BILLING, generationId: 'gen-cls' },
                    billableCostNanoUsd: 7n,
                    isEstimated: false,
                  },
                ],
              })
            ),
        },
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    const charges = run.settlements[0]?.charges ?? [];
    expect(charges[0]).toMatchObject({ key: 'answer', smartModelRan: true });
    // The classifier's own auxiliary charge never carries the chip signal.
    expect(charges[1]).not.toHaveProperty('smartModelRan');
  });

  it("counts an auxiliary generation's cost toward the circuit", async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          streaming: true,
          run: () =>
            Promise.resolve(
              ok({
                value: 'routed answer',
                costNanoUsd: 20n,
                billing: ANSWER_BILLING,
                auxiliaryCharges: [
                  {
                    keySuffix: 'classifier',
                    billing: AUX_BILLING,
                    billableCostNanoUsd: 7n,
                    isEstimated: false,
                  },
                ],
              })
            ),
        },
      },
      decision: grantWithLimit(26n),
    });
    await run.done;
    const [error, fingerprint] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(fingerprint).toBe('workflow_cost_circuit_tripped');
    expect(error).toMatchObject({ accruedNanoUsd: '27' });
  });

  it('captures exactly one Sentry event carrying the runId, the accrual and the limit when the circuit closes the gate', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          streaming: true,
          run: (_input, ctx) => {
            ctx.spend?.report(2000n);
            return Promise.resolve(err({ costNanoUsd: 2000n }));
          },
        },
      },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
    const [error, fingerprint] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(fingerprint).toBe('workflow_cost_circuit_tripped');
    expect(error).toBeInstanceOf(Error);
    // The DO-minted runId, the accrual and the limit ride the event so a human
    // can see which run overshot and by how much.
    expect(error.message).toContain(RUN_ID);
    expect(error.message).toContain('2000');
    // VALUE half: the tagged id is the run id the caller minted, never the
    // client-supplied Idempotency-Key (`runKey`), which is attacker-controllable;
    // the amounts are nano-USD bigints as strings (money is never
    // Number()-coerced).
    expect(Reflect.get(error, 'runId')).toBe(RUN_ID);
    expect(Reflect.get(error, 'accruedNanoUsd')).toBe('2000');
    expect(Reflect.get(error, 'limitNanoUsd')).toBe('500');
    // KEY-SET half: the whole own key set, not a lookup of the expected ones. A
    // subset match lets another own property arrive unseen.
    expect(Object.keys(error)).toEqual(['name', 'runId', 'accruedNanoUsd', 'limitNanoUsd']);
    expect(error.name).toBe('CostCircuitTripped');
    // The client key must reach neither the properties nor the message.
    expect(error.message).not.toContain(RUN_KEY);
  });

  it('bills a reply whose real tokenization outran its reserved input by more than the multiplier', async () => {
    // The output leg is wire-capped, so an output-token miss cannot exceed the
    // ceiling it was reserved at. The input leg carries no symmetric cap: a
    // prompt whose real tokenization is denser than the assumed input ratio can
    // bill more input than was reserved for it. The circuit closes the gate on
    // it, so nothing new starts, and the reply it already paid for still bills.
    // A miss inside the multiplier closes nothing; the density below runs well
    // past it.
    const RATE_NANO_PER_INPUT_TOKEN = 1000n;
    const PROMPT_CHARS = 20_000;
    // Rare-unicode text tokenizes at several tokens per character, against an
    // input ratio that assumes several characters per token.
    const REAL_TOKENS_PER_CHAR = 4n;
    // The multiplier `grantWithLimit` mints into its readout; the shipped K is
    // pinned by billing's own constants test.
    const CIRCUIT_MULTIPLIER = 5n;

    const reservedInputNanoUsd = BigInt(inputTokensOf(PROMPT_CHARS)) * RATE_NANO_PER_INPUT_TOKEN;
    const realInputNanoUsd =
      BigInt(PROMPT_CHARS) * REAL_TOKENS_PER_CHAR * RATE_NANO_PER_INPUT_TOKEN;

    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          streaming: true,
          run: (_input, ctx) => {
            ctx.spend?.report(realInputNanoUsd);
            return Promise.resolve(
              ok({ value: 'dense reply', costNanoUsd: realInputNanoUsd, billing: ANSWER_BILLING })
            );
          },
        },
      },
      decision: grantWithLimit(reservedInputNanoUsd * CIRCUIT_MULTIPLIER),
    });

    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements[0]?.charges.map((charge) => charge.billableCostNanoUsd)).toEqual([
      realInputNanoUsd,
    ]);
  });

  it('does not capture a routine node failure to Sentry', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': failWith() },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });
});

describe('createWorkflowExecutor — deadline and stop', () => {
  it('lets the in-flight node finish and bills it when the deadline closes the gate', async () => {
    const behavior = streamThenFinish('partial answer', 7n, ANSWER_BILLING);
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': behavior },
    });
    await behavior.inFlight;
    run.stop('deadline');
    behavior.release();
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(behavior.sawAbort()).toBe(false);
    // The drained answer rides the stopped settle path with its charge.
    expect(run.settlements).toEqual([
      {
        runKey: RUN_KEY,
        outputs: { answer: { kind: 'text', text: 'partial answer' } },
        charges: [
          { key: 'answer', ...ANSWER_BILLING, billableCostNanoUsd: 7n, isEstimated: false },
        ],
      },
    ]);
  });

  it('settles the streamed partial and its charge when the hard stop aborts the run', async () => {
    const behavior = streamThenHang('partial answer', 7n, ANSWER_BILLING);
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': behavior },
    });
    await behavior.hanging;
    run.abort('deadline-hard');
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements).toEqual([
      {
        runKey: RUN_KEY,
        outputs: { answer: { kind: 'text', text: 'partial answer' } },
        charges: [
          { key: 'answer', ...ANSWER_BILLING, billableCostNanoUsd: 7n, isEstimated: false },
        ],
      },
    ]);
  });

  it('cuts the in-flight node when a hard stop follows a stop that already closed the gate', async () => {
    const behavior = streamThenHang('partial answer', 7n, ANSWER_BILLING);
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': behavior },
    });
    await behavior.hanging;
    run.stop('user-stop');
    run.abort('deadline-hard');
    // The node finishes only on an aborted signal, so the run ending at all is
    // the proof the abort reached it through a gate the stop had closed.
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements[0]?.charges.map((charge) => charge.billableCostNanoUsd)).toEqual([7n]);
  });

  it('ends a superseded run as stopped', async () => {
    const behavior = streamThenHang('partial answer');
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': behavior },
    });
    await behavior.hanging;
    run.abort('superseded');
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
  });

  it('settles nothing when the deadline closes the gate on a node that then produces nothing', async () => {
    const behavior = waitThenFail();
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': behavior },
    });
    await behavior.inFlight;
    run.stop('deadline');
    behavior.release();
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements).toEqual([]);
  });

  it("carries an earlier level's consumed charge into a stopped partial's settlement", async () => {
    // The shape a turn-level classifier creates: an earlier node bills, its value
    // is CONSUMED (so it is no sink and surfaces no output), and a later node is
    // stopped mid-stream. The stop settles its billable partial, and the earlier
    // charge must ride it — otherwise that spend is absorbed. Which content the
    // classifier-shaped charge then anchors to is the settlement's rule.
    const behavior = streamThenFinish('partial answer', 7n, {
      modelId: 'second-model',
      providerName: 'p',
      modality: 'text',
    });
    const run = startRun({
      definition: consumedFirstDefinition(),
      behaviors: {
        'first-model': streamingEcho(3n, {
          modelId: 'first-model',
          providerName: 'p',
          modality: 'text',
        }),
        'second-model': behavior,
      },
    });
    await behavior.inFlight;
    run.stop('user-stop');
    behavior.release();
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    const settlement = run.settlements[0];
    expect(settlement?.charges.map((charge) => charge.key)).toEqual(['first', 'second']);
    // Only the stopped node's value is a sink; the consumed one surfaces nothing.
    expect(Object.keys(settlement?.outputs ?? {})).toEqual(['second']);
  });

  it('stops at a node boundary once the injected clock passes the deadline', async () => {
    const run = startRun({
      definition: chainDefinition(),
      behaviors: {
        'first-model': {
          run: (input, ctx) => {
            run.clockState.now += 6 * 60 * 1000;
            return respondWith('a').run(input, ctx);
          },
        },
        'second-model': respondWith('b'),
        'third-model': respondWith('c'),
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements).toEqual([]);
  });
});

describe('createWorkflowExecutor — the spend gate', () => {
  it('a stop lets the in-flight node finish and bills it at its inline cost', async () => {
    const behavior = streamThenFinish('the whole answer', 700n, ANSWER_BILLING);
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': behavior },
    });
    await behavior.inFlight;
    run.stop('user-stop');
    behavior.release();
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(behavior.sawAbort()).toBe(false);
    expect(run.settlements[0]?.charges).toEqual([
      { key: 'answer', ...ANSWER_BILLING, billableCostNanoUsd: 700n, isEstimated: false },
    ]);
  });

  it('settles a finished run whose last node alone crossed the circuit', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': respondWith('the answer', 600n, ANSWER_BILLING) },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.charges).toEqual([
      { key: 'answer', ...ANSWER_BILLING, billableCostNanoUsd: 600n, isEstimated: false },
    ]);
  });

  it('settles the value of a node that saw its report close the gate, as a stopped run', async () => {
    const observed: { open?: boolean | undefined; aborted?: boolean } = {};
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          streaming: true,
          run: (_input, ctx) => {
            ctx.spend?.report(600n);
            observed.open = ctx.spend?.isOpen();
            observed.aborted = ctx.signal.aborted;
            return Promise.resolve(
              ok({ value: 'cut short', costNanoUsd: 600n, billing: ANSWER_BILLING })
            );
          },
        },
      },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(observed).toEqual({ open: false, aborted: false });
    expect(run.settlements[0]?.charges).toEqual([
      { key: 'answer', ...ANSWER_BILLING, billableCostNanoUsd: 600n, isEstimated: false },
    ]);
    const fingerprints = vi.mocked(run.telemetry.captureError).mock.calls.map((call) => call[1]);
    expect(fingerprints).toEqual(['workflow_cost_circuit_tripped']);
  });

  it('refuses the queued siblings of a level once a stop closes the gate', async () => {
    // Eight siblings, six streaming at once: the stop lands with six parked and
    // two queued behind them, so only the six already started may run and bill.
    let started = 0;
    let markSixParked!: () => void;
    const sixParked = new Promise<void>((resolve) => {
      markSixParked = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parked: FakeBehavior = {
      streaming: true,
      run: async () => {
        started += 1;
        if (started === 6) markSixParked();
        await released;
        return ok({ value: 'answer', costNanoUsd: 5n, billing: ANSWER_BILLING });
      },
    };
    const run = startRun({
      definition: multiModelDefinition(Array.from({ length: 8 }, () => 'answer-model')),
      behaviors: { 'answer-model': parked },
    });
    await sixParked;
    run.stop('user-stop');
    release();
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(started).toBe(6);
    expect(run.settlements[0]?.charges).toHaveLength(6);
  });

  it('ends stopped when a node in flight at a stop then throws', async () => {
    const behavior = drainingBehavior(() => {
      throw new Error('provider stream broke');
    });
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': behavior },
    });
    await behavior.inFlight;
    run.stop('user-stop');
    behavior.release();
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
  });

  it('ends a run stopped before its walk began as stopped, with nothing to walk', async () => {
    // A definition with no nodes walks no level, so only a check at the walk's
    // entry can see the stop.
    const empty = buildWorkflow({
      deadlineClass: 'text',
      hooks: HOOKS,
      inputs: workflowInputs({ prompt: textTag() }),
      nodes: [],
      registries: registries(),
    })._unsafeUnwrap().definition;
    const run = startRun({ definition: empty, behaviors: {} });
    run.stop('user-stop');
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
  });

  it("counts each node's highest reported total, not its latest, toward the circuit", async () => {
    // Both siblings report before either ends. Counting `first`'s highest total
    // gives 400n + 150n = 550n, past the 500n limit; counting its latest would
    // give 200n + 150n = 350n and close nothing.
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model']),
      behaviors: {
        'first-model': {
          run: (_input, ctx) => {
            ctx.spend?.report(400n);
            ctx.spend?.report(200n);
            return Promise.resolve(ok({ value: 'first', costNanoUsd: 200n }));
          },
        },
        'second-model': {
          run: (_input, ctx) => {
            ctx.spend?.report(150n);
            return Promise.resolve(ok({ value: 'second', costNanoUsd: 150n }));
          },
        },
      },
      decision: grantWithLimit(500n),
    });
    await run.done;
    const [error, fingerprint] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(fingerprint).toBe('workflow_cost_circuit_tripped');
    expect(error).toMatchObject({ accruedNanoUsd: '550' });
  });

  it("ends the run with the circuit's accrual equal to the sum of the node finals", async () => {
    // Each node reports a running total mid-run and then ends at its final cost:
    // `first` reports above its final, `second` and `third` below theirs. The
    // finals sum to 500n, one over the 499n limit, so the circuit closes on
    // `third`'s final and its event reads the accrual the run ends with.
    function reportingThenFinal(reports: readonly bigint[], final: bigint): FakeBehavior {
      return {
        run: (input, ctx) => {
          for (const total of reports) ctx.spend?.report(total);
          return respondWith(`${String(input[0])}.`, final).run(input, ctx);
        },
      };
    }
    const run = startRun({
      definition: chainDefinition(),
      behaviors: {
        'first-model': reportingThenFinal([400n, 200n], 300n),
        'second-model': reportingThenFinal([100n], 150n),
        'third-model': reportingThenFinal([40n], 50n),
      },
      decision: grantWithLimit(499n),
    });
    await run.done;
    const [error, fingerprint] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(fingerprint).toBe('workflow_cost_circuit_tripped');
    expect(Reflect.get(error, 'accruedNanoUsd')).toBe('500');
  });
});

describe('createWorkflowExecutor — the byte budget', () => {
  it('rejects over-budget inputs at validation before admission', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: { prompt: textInput('x'.repeat(64)) },
      valueBudgetBytes: 32,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.admissionRequests).toEqual([]);
    expect(run.settlements).toEqual([]);
  });

  it('terminal-fails cleanly when a node output breaches the budget mid-run', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': respondWith('y'.repeat(64)) },
      valueBudgetBytes: 32,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.settlements).toEqual([]);
  });

  it('maps a video download that breaches the remaining budget to a VALIDATION failure without a Sentry capture', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          streaming: true,
          // The video adapter aborts an over-budget download by throwing an
          // error named 'DownloadByteCapExceeded'; the engine takes the node's
          // declared `onError` path with it rather than treating it as a defect,
          // and this node declares the default `fail`.
          run: () => {
            const error = new Error('video download exceeded the byte cap');
            error.name = 'DownloadByteCapExceeded';
            throw error;
          },
        },
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.settlements).toEqual([]);
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  // The four below meter a value the interpreter puts on a channel WITHOUT a
  // node having produced it: a branch's passthrough, a loop's carried state,
  // and the per-invocation seeds of the fanOut and loop container scopes. Each
  // budget below admits everything the run stores up to that one value and
  // refuses it, so the assertion discriminates that site alone.

  it('refuses a branch passthrough that breaches the remaining budget', async () => {
    const run = startRun({
      // 'hi' (4) + the classification object (36) fills the budget exactly; the
      // branch's own copy of that object needs another 36.
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'simple' }),
        'answer-model': respondWith(''),
        'hard-model': respondWith(''),
      },
      predicates: ROUTE_PREDICATES,
      valueBudgetBytes: 40,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.settlements).toEqual([]);
    // A budget refusal is an expected domain outcome, never a defect.
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  it('refuses a fan-out element seed that breaches the remaining budget', async () => {
    const run = startRun({
      // 'one two' (14) + the split list (12) leaves 4, and the first element
      // seeded into the branch scope needs 6.
      definition: fanOutDefinition(4),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': respondWith(''),
      },
      reducers: { captionsWithPrompt: () => '' },
      inputs: { prompt: textInput('one two') },
      valueBudgetBytes: 30,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.settlements).toEqual([]);
    // A budget refusal is an expected domain outcome, never a defect.
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  it('refuses a loop state seed that breaches the remaining budget', async () => {
    const run = startRun({
      // 'xxxx' (8) leaves 1, and seeding that same state into the iteration
      // scope needs 8 — the body's own output is free.
      definition: loopDefinition(1),
      behaviors: { echo: respondWith('') },
      predicates: { textDone: () => false },
      inputs: { prompt: textInput('xxxx') },
      valueBudgetBytes: 9,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.settlements).toEqual([]);
    // A budget refusal is an expected domain outcome, never a defect.
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  it('refuses a loop carrying its final state out when that breaches the remaining budget', async () => {
    const run = startRun({
      // 'x' (2) + the iteration seed (2) + the body's output (16) leaves 1, and
      // carrying that output out to the loop's own channel needs 16.
      definition: loopDefinition(1),
      behaviors: { echo: respondWith('yyyyyyyy') },
      predicates: { textDone: () => false },
      inputs: { prompt: textInput('x') },
      valueBudgetBytes: 21,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.settlements).toEqual([]);
    // A budget refusal is an expected domain outcome, never a defect.
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });
});

describe('createWorkflowExecutor — fanOut / fanIn', () => {
  it('fans branches out with one stream each and reduces the collected list', async () => {
    const run = startRun({
      definition: fanOutDefinition(4),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': streamingEcho(9n, ANSWER_BILLING),
      },
      reducers: {
        captionsWithPrompt: (inputs) => {
          const [captions, prompt] = inputs as [readonly (string | undefined)[], string];
          return [...captions.map((caption) => caption ?? '∅'), prompt].join('|');
        },
      },
      inputs: { prompt: textInput('one two') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    const streamIds = new Set(run.emitted.map((event) => event.streamId));
    expect(streamIds.size).toBe(2);
    for (const streamId of streamIds) {
      const cursors = run.emitted
        .filter((event) => event.streamId === streamId)
        .map((event) => event.cursor);
      expect(cursors).toEqual(cursors.map((_, index) => index + 1));
    }
    expect(run.settlements[0]?.outputs).toEqual({
      join: { kind: 'text', text: 'echo:one|echo:two|one two' },
    });
    // One charge per branch, keyed by the body node id + the branch element index.
    const charges = run.settlements[0]?.charges ?? [];
    expect(charges.toSorted((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'describe#0', ...ANSWER_BILLING, billableCostNanoUsd: 9n, isEstimated: false },
      { key: 'describe#1', ...ANSWER_BILLING, billableCostNanoUsd: 9n, isEstimated: false },
    ]);
  });

  it('reduces skipped optional branches as absent elements', async () => {
    const run = startRun({
      definition: fanOutDefinition(4),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': {
          run: (input, ctx) =>
            input[0] === 'bad' ? failWith().run(input, ctx) : streamingEcho().run(input, ctx),
        },
      },
      reducers: {
        captionsWithPrompt: (inputs) => {
          const [captions, prompt] = inputs as [readonly (string | undefined)[], string];
          return [...captions.map((caption) => caption ?? '∅'), prompt].join('|');
        },
      },
      inputs: { prompt: textInput('one bad') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      join: { kind: 'text', text: 'echo:one|∅|one bad' },
    });
  });

  it('fails the run when a fail-on-error branch body fails', async () => {
    const run = startRun({
      definition: fanOutDefinition(4, 'fail'),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': {
          run: (input, ctx) =>
            input[0] === 'bad' ? failWith().run(input, ctx) : streamingEcho().run(input, ctx),
        },
      },
      reducers: { captionsWithPrompt: (inputs) => String(inputs[1]) },
      inputs: { prompt: textInput('one bad') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    expect(run.settlements).toEqual([]);
  });

  it('refuses the join after a fan-out whose branch spend crossed the limit', async () => {
    const join = vi.fn((inputs: readonly unknown[]) => String(inputs[1]));
    const run = startRun({
      definition: fanOutDefinition(4),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': streamingEcho(300n),
      },
      reducers: { captionsWithPrompt: join },
      decision: grantWithLimit(500n),
      inputs: { prompt: textInput('one two') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(join).not.toHaveBeenCalled();
    expect(run.settlements).toEqual([]);
  });

  it('stops without settling when a stop lands mid-fan-out', async () => {
    const behavior = streamThenFinish('partial');
    const run = startRun({
      definition: fanOutDefinition(4),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': behavior,
      },
      reducers: { captionsWithPrompt: (inputs) => String(inputs[1]) },
      inputs: { prompt: textInput('one two') },
    });
    await behavior.inFlight;
    run.stop('user-stop');
    behavior.release();
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements).toEqual([]);
  });

  it('keeps the stop as the closer when the drained branches then cross the circuit', async () => {
    const behavior = streamThenFinish('partial', 400n);
    const run = startRun({
      definition: sinkBesideFanDefinition(),
      behaviors: {
        'first-model': streamingEcho(),
        split: respondWith(['a', 'b']),
        'second-model': behavior,
      },
      reducers: { captionsWithPrompt: (inputs) => String(inputs[1]) },
      decision: grantWithLimit(500n),
      inputs: { prompt: textInput('hi') },
    });
    await behavior.inFlight;
    run.stop('user-stop');
    behavior.release();
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements).toEqual([
      { runKey: RUN_KEY, outputs: { side: { kind: 'text', text: 'echo:hi' } }, charges: [] },
    ]);
    // The circuit crossed only after the stop closed the gate, so it raises nothing.
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  it("fails with the branch's failure when a circuit crossing coincides with it", async () => {
    const run = startRun({
      definition: fanOutDefinition(4, 'fail'),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': {
          run: (input, ctx) =>
            input[0] === 'bad'
              ? failWith(300n).run(input, ctx)
              : respondWith('ok', 300n).run(input, ctx),
        },
      },
      reducers: { captionsWithPrompt: (inputs) => String(inputs[1]) },
      decision: grantWithLimit(500n),
      inputs: { prompt: textInput('one bad') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    expect(run.settlements).toEqual([]);
  });

  it('ends a fan branch locally when its body routes to the end sentinel', async () => {
    const run = startRun({
      definition: fanOutEndDefinition(),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
      },
      predicates: { textDone: () => 'through' },
      reducers: {
        captionsWithPrompt: (inputs) => {
          const [elements, prompt] = inputs as [readonly string[], string];
          return [...elements, prompt].join('|');
        },
      },
      inputs: { prompt: textInput('one two') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      join: { kind: 'text', text: 'one|two|one two' },
    });
  });

  it('fails the run when the collection exceeds the declared width', async () => {
    const run = startRun({
      definition: fanOutDefinition(2),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': streamingEcho(),
      },
      reducers: { captionsWithPrompt: (inputs) => String(inputs[1]) },
      inputs: { prompt: textInput('a b c') },
    });
    // A collection wider than the compiled cap is our own definition's fault,
    // not the provider's, so it must not borrow the provider-unavailable code.
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.WORKFLOW_DEFINITION_INVALID,
    });
    expect(run.settlements).toEqual([]);
  });

  it('fails the run as a definition fault when the join reduces to a value failing its tag', async () => {
    const run = startRun({
      definition: fanOutDefinition(4),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': streamingEcho(),
      },
      // The join declares text and the reducer hands back a number. The value
      // that failed is our reducer's, so blaming the model's reply would be the
      // same mislabel as borrowing the provider-unavailable code.
      reducers: { captionsWithPrompt: () => 42 },
      inputs: { prompt: textInput('one two') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.WORKFLOW_DEFINITION_INVALID,
    });
  });
});

describe('createWorkflowExecutor — concurrent multi-model siblings', () => {
  it('streams the sibling modelCalls concurrently, interleaving their token streams', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const behavior: FakeBehavior = {
      streaming: true,
      run: async (input, ctx) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        ctx.emit?.({ kind: 'text-delta', index: 0, content: 'a' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        ctx.emit?.({ kind: 'text-delta', index: 1, content: 'b' });
        inFlight -= 1;
        return ok({ value: String(input[0]), costNanoUsd: 0n, billing: ANSWER_BILLING });
      },
    };
    const run = startRun({
      definition: multiModelDefinition(['answer-model', 'answer-model', 'answer-model']),
      behaviors: { 'answer-model': behavior },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    // All three ran together, not one-after-another.
    expect(maxInFlight).toBe(3);
    // Concurrency proof: every sibling emits its first token before any emits
    // its second — a sequential walk would group each stream's tokens together.
    expect(run.emitted.slice(0, 3).map((event) => event.event)).toEqual([
      { kind: 'text-delta', index: 0, content: 'a' },
      { kind: 'text-delta', index: 0, content: 'a' },
      { kind: 'text-delta', index: 0, content: 'a' },
    ]);
    expect(
      run.emitted
        .slice(3, 6)
        .every((event) => event.event.kind === 'text-delta' && event.event.content === 'b')
    ).toBe(true);
    expect(new Set(run.emitted.slice(0, 3).map((event) => event.streamId)).size).toBe(3);
  });

  it('bounds concurrency at six even with more independent siblings', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const behavior: FakeBehavior = {
      streaming: true,
      run: async (input) => {
        arrived += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
        return ok({ value: String(input[0]), costNanoUsd: 0n, billing: ANSWER_BILLING });
      },
    };
    const run = startRun({
      definition: multiModelDefinition(Array.from({ length: 8 }, () => 'answer-model')),
      behaviors: { 'answer-model': behavior },
    });
    // Let the bounded pool fill before releasing anything.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(arrived).toBe(6);
    expect(maxInFlight).toBe(6);
    release();
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    // All eight eventually ran, but never more than six at once.
    expect(arrived).toBe(8);
    expect(maxInFlight).toBe(6);
  });

  it('settles one charge per sibling keyed by node id in declaration order, completion order aside', async () => {
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model', 'third-model']),
      behaviors: {
        // The first-declared sibling finishes LAST — declaration order must win.
        'first-model': delayedEcho(30, 11n, 'first-model'),
        'second-model': delayedEcho(20, 22n, 'second-model'),
        'third-model': delayedEcho(10, 33n, 'third-model'),
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements).toHaveLength(1);
    expect(run.settlements[0]?.charges).toEqual([
      {
        key: 'm0',
        modelId: 'first-model',
        providerName: 'p',
        modality: 'text',
        billableCostNanoUsd: 11n,
        isEstimated: false,
      },
      {
        key: 'm1',
        modelId: 'second-model',
        providerName: 'p',
        modality: 'text',
        billableCostNanoUsd: 22n,
        isEstimated: false,
      },
      {
        key: 'm2',
        modelId: 'third-model',
        providerName: 'p',
        modality: 'text',
        billableCostNanoUsd: 33n,
        isEstimated: false,
      },
    ]);
    expect(run.settlements[0]?.outputs).toEqual({
      m0: { kind: 'text', text: 'echo:hi' },
      m1: { kind: 'text', text: 'echo:hi' },
      m2: { kind: 'text', text: 'echo:hi' },
    });
  });

  it('settles and bills only the successful subset when some siblings fail', async () => {
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model', 'third-model']),
      behaviors: {
        'first-model': billingFor('first-model'),
        'second-model': failWith(),
        'third-model': billingFor('third-model'),
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      m0: { kind: 'text', text: 'echo:hi' },
      m2: { kind: 'text', text: 'echo:hi' },
    });
    expect(run.settlements[0]?.charges).toEqual([
      {
        key: 'm0',
        modelId: 'first-model',
        providerName: 'p',
        modality: 'text',
        billableCostNanoUsd: 0n,
        isEstimated: false,
      },
      {
        key: 'm2',
        modelId: 'third-model',
        providerName: 'p',
        modality: 'text',
        billableCostNanoUsd: 0n,
        isEstimated: false,
      },
    ]);
  });

  it('bills nothing for a sibling whose value failed output validation, while a committed sibling bills', async () => {
    // The provider call SUCCEEDED and reported a cost, but the value fails the
    // runtime `zodFor(out)` gate (a number where the declared port is text).
    // Siblings are declared `onError: 'skip'`, so the run still succeeds — and
    // that is what makes an uncommitted generation's charge reachable at
    // settlement. It must be absorbed, not billed: BILLING.md §Multi-Model 4
    // bills the successful subset, and a validation-failed node is not in it.
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model']),
      behaviors: {
        'first-model': respondWith(42, 5000n, {
          modelId: 'first-model',
          providerName: 'p',
          modality: 'text',
        }),
        'second-model': respondWith('real answer', 7n, {
          modelId: 'second-model',
          providerName: 'p',
          modality: 'text',
        }),
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    const settlement = run.settlements[0];
    // One charge, the committed sibling's. The uncommitted one is absorbed.
    expect(settlement?.charges.map((charge) => charge.key)).toEqual(['m1']);
    expect(settlement?.charges[0]?.billableCostNanoUsd).toBe(7n);
    expect(Object.keys(settlement?.outputs ?? {})).toEqual(['m1']);
  });

  it("counts an uncommitted generation's spend toward the circuit even though it bills nothing", async () => {
    // The asymmetry that makes absorbed-but-counted safe, and the reason it is a
    // TEST rather than a comment: billing is gated on the commit, the ACCRUAL is
    // not. Moving the accrual below the commit to match would be a silent change
    // — a model returning malformed output would then spend real provider money
    // on every attempt while contributing nothing to the circuit that exists to
    // stop exactly that, so the platform's exposure would stop being bounded by
    // `hold × K`.
    //
    // `m0` succeeds at the provider and spends 5000n, but its value (a number
    // under a text port) never commits, so it bills nothing. That 5000n alone
    // must still cross the 500n circuit limit. The crossing comes at the last
    // node's end, with nothing left to start, so the run still succeeds.
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model']),
      behaviors: {
        'first-model': respondWith(42, 5000n, {
          modelId: 'first-model',
          providerName: 'p',
          modality: 'text',
        }),
        'second-model': respondWith('real answer', 0n, {
          modelId: 'second-model',
          providerName: 'p',
          modality: 'text',
        }),
      },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    // The circuit's accrual names the uncommitted generation's cost exactly,
    // which is the direct assertion that it counted: nothing else in this run
    // spent.
    const circuitEvent = vi
      .mocked(run.telemetry.captureError)
      .mock.calls.find((call) => call[1] === 'workflow_cost_circuit_tripped');
    expect(circuitEvent?.[0]).toMatchObject({ accruedNanoUsd: '5000' });
    expect(run.settlements[0]?.charges.map((charge) => charge.key)).toEqual(['m1']);
  });

  it('captures one Sentry event carrying the run id and the whole loss when several outputs are rejected', async () => {
    // Two provider calls SUCCEEDED and spent real money; both values fail the
    // declared text port, so neither commits and neither bills. That loss is
    // absorbed by the platform, and without a record no watcher exists for a
    // model or a schema systematically producing rejected output at our
    // expense. One record per RUN, never one per node.
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model', 'third-model']),
      behaviors: {
        'first-model': respondWith(42, 5000n, {
          modelId: 'first-model',
          providerName: 'p',
          modality: 'text',
        }),
        'second-model': respondWith(7, 3000n, {
          modelId: 'second-model',
          providerName: 'p',
          modality: 'text',
        }),
        'third-model': respondWith('real answer', 11n, {
          modelId: 'third-model',
          providerName: 'p',
          modality: 'text',
        }),
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
    const [error, fingerprint] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(fingerprint).toBe('workflow_rejected_output_absorbed');
    // The same two-halved proof the trip event carries, for the same reason:
    // both tags rest on a gate that cannot close its value space. VALUE half —
    // the two rejected generations summed, as the nano-USD string the scrub
    // lifts into a Sentry tag, never Number()-coerced; the committed sibling's
    // 11n billed, so it is not part of the loss.
    expect(Reflect.get(error, 'runId')).toBe(RUN_ID);
    expect(Reflect.get(error, 'absorbedNanoUsd')).toBe('8000');
    // KEY-SET half: a second own property arriving here would reach the tag
    // gate unseen, so the whole set is pinned rather than the two expected.
    expect(Object.keys(error)).toEqual(['name', 'runId', 'absorbedNanoUsd']);
    expect(error.name).toBe('RejectedOutputAbsorbed');
    expect(run.settlements[0]?.charges.map((charge) => charge.key)).toEqual(['m2']);
  });

  it('keeps the client-supplied run key off the absorbed-loss event', async () => {
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model']),
      behaviors: {
        'first-model': respondWith(42, 5000n, {
          modelId: 'first-model',
          providerName: 'p',
          modality: 'text',
        }),
        'second-model': respondWith('real answer', 11n, {
          modelId: 'second-model',
          providerName: 'p',
          modality: 'text',
        }),
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    const [error] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    // The tagged id is the DO-minted run id. The Idempotency-Key is
    // attacker-controllable, so an allowlisted tag carrying it would bypass the
    // scrub; it must reach neither the properties nor the message.
    expect(error).not.toMatchObject({ runId: RUN_KEY });
    expect(error.message).not.toContain(RUN_KEY);
  });

  it('captures nothing when a rejected output had no billable spend behind it', async () => {
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model']),
      behaviors: {
        'first-model': respondWith(42, 0n, {
          modelId: 'first-model',
          providerName: 'p',
          modality: 'text',
        }),
        'second-model': respondWith('real answer', 11n, {
          modelId: 'second-model',
          providerName: 'p',
          modality: 'text',
        }),
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  it('records the rejected output loss beside the cost circuit event', async () => {
    const run = startRun({
      definition: multiModelDefinition(['first-model']),
      behaviors: {
        'first-model': respondWith(42, 5000n, {
          modelId: 'first-model',
          providerName: 'p',
          modality: 'text',
        }),
      },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    // The circuit's event reports spend, not loss, so the rejected value's
    // absorbed spend has its own record.
    const events = vi
      .mocked(run.telemetry.captureError)
      .mock.calls.map(([error, fingerprint]) => ({ fingerprint, error }));
    expect(events).toEqual([
      {
        fingerprint: 'workflow_cost_circuit_tripped',
        error: expect.objectContaining({ accruedNanoUsd: '5000' }),
      },
      {
        fingerprint: 'workflow_rejected_output_absorbed',
        error: expect.objectContaining({ absorbedNanoUsd: '5000' }),
      },
    ]);
  });

  it('records the absorbed loss on a stopped run', async () => {
    // The record must survive every terminal route, not only the succeeding
    // one. A stop is where that is load-bearing: `first-model` was paid for and
    // rejected exactly as on a succeeding turn, so a record tied to successful
    // completion would drop this loss silently — the platform loss the record
    // exists to surface. `second-model` is in flight when the stop lands, and
    // produces nothing, so the stop settles nothing.
    const stalled = waitThenFail();
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model']),
      behaviors: {
        'first-model': respondWith(42, 5000n, {
          modelId: 'first-model',
          providerName: 'p',
          modality: 'text',
        }),
        'second-model': stalled,
      },
    });
    await stalled.inFlight;
    run.stop('user-stop');
    stalled.release();
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
    const [error, fingerprint] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(fingerprint).toBe('workflow_rejected_output_absorbed');
    expect(error).toMatchObject({ runId: RUN_ID, absorbedNanoUsd: '5000' });
  });

  it('leaves the in-flight siblings unaborted when one closes the gate mid-node', async () => {
    const observed: { open?: boolean; aborted?: boolean }[] = [];
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model']),
      behaviors: {
        // `first-model` closes the gate a tick after both siblings started, and
        // `second-model` looks a tick after that.
        'first-model': {
          streaming: true,
          run: async (_input, ctx) => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            ctx.spend?.report(2000n);
            return err({ costNanoUsd: 2000n });
          },
        },
        'second-model': {
          streaming: true,
          run: async (_input, ctx) => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));
            observed.push({ open: ctx.spend?.isOpen() ?? true, aborted: ctx.signal.aborted });
            return ok({ value: 'drained', costNanoUsd: 3n, billing: ANSWER_BILLING });
          },
        },
      },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(observed).toEqual([{ open: false, aborted: false }]);
    expect(run.settlements[0]?.charges.map((charge) => charge.key)).toEqual(['m1']);
  });

  it('reroutes an all-branches-failed settlement to UNAVAILABLE without capturing it', async () => {
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model']),
      behaviors: { 'first-model': failWith(), 'second-model': failWith() },
      settle: (request) => {
        if (request.charges.length === 0) {
          // The chat settlement hook throws the real typed sentinel; the engine
          // discriminates it via instanceof, so a rename fails typecheck here.
          return Promise.reject(new AllBranchesFailedError('no model produced content'));
        }
        return Promise.resolve();
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  it('reroutes an infrastructure-unavailable settlement throw to UNAVAILABLE and captures it', async () => {
    const thrown = new InfrastructureUnavailableError('storage put failed');
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      // The chat media put barrier and the settlement hook's precondition reads
      // both reject settlement with the real typed error; the engine
      // discriminates it via instanceof, so a rename fails typecheck here.
      settle: () => Promise.reject(thrown),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    // The user is told the dependency is down; the operator is told which one,
    // through the error the seam threw rather than a synthesized stand-in.
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
    expect(run.telemetry.captureError).toHaveBeenCalledWith(thrown, 'workflow_infra_unavailable');
  });

  it('reroutes an infrastructure-unavailable node throw to UNAVAILABLE and captures it', async () => {
    const thrown = new InfrastructureUnavailableError('storage put failed');
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          run: () => {
            throw thrown;
          },
        },
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    // One posture for the class, wherever the run reached it.
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
    expect(run.telemetry.captureError).toHaveBeenCalledWith(thrown, 'workflow_infra_unavailable');
  });

  it('reroutes a fork-tip settlement conflict to FORK_TIP_CONFLICT without capturing it', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      // The chat settlement hook throws the real typed sentinel when the fork
      // vanished mid-run or its tip moved; the engine discriminates it via
      // instanceof and projects the carried domain error's wire code.
      settle: () =>
        Promise.reject(
          new SettlementConflictError(
            notFoundError('fork gone', undefined, ERROR_CODES.FORK_TIP_CONFLICT),
            'chat settlement: fork-tip advancement failed'
          )
        ),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.FORK_TIP_CONFLICT,
    });
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  it('reroutes an epoch-wrap settlement conflict to CONFLICT without capturing it', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      // The sender is no longer a member of the wrapped epoch — a forbidden
      // domain error the settlement hook stamps with the CONFLICT wire-code
      // override; the engine's projection honors the override, never surfacing
      // FORBIDDEN, and never captures the race.
      settle: () =>
        Promise.reject(
          new SettlementConflictError(
            forbiddenError('sender no longer a member', undefined, ERROR_CODES.CONFLICT),
            'chat settlement: wrap-epoch assertion failed'
          )
        ),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.CONFLICT,
    });
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  it('reports an absorbed settlement refusal by its code and one absorbed-loss capture', async () => {
    let settled: SettlementRequest | undefined;
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model']),
      behaviors: {
        'first-model': respondWith('first answer', 5000n, {
          modelId: 'first-model',
          providerName: 'p',
          modality: 'text',
        }),
        'second-model': respondWith('second answer', 3000n, {
          modelId: 'second-model',
          providerName: 'p',
          modality: 'text',
        }),
      },
      // The fenced settlement hook rethrows a refusal nobody could be billed
      // for, the payer's account having gone mid-run, marked absorbed.
      settle: (request) => {
        settled = request;
        return Promise.reject(
          new AbsorbedSettlementRefusal(
            new SettlementConflictError(
              forbiddenError('sender no longer a member', undefined, ERROR_CODES.CONFLICT),
              'chat settlement: wrap-epoch assertion failed'
            )
          )
        );
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'failed', code: ERROR_CODES.CONFLICT });
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
    const [error, fingerprint] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(fingerprint).toBe('workflow_refusal_absorbed');
    // The same two-halved proof the other absorbed-loss events carry. VALUE
    // half: the run's collected charges summed, as the nano-USD string the
    // scrub lifts into a tag, under the run id the caller minted.
    const billable = (settled?.charges ?? []).reduce(
      (sum, charge) => sum + charge.billableCostNanoUsd,
      0n
    );
    expect(billable).toBeGreaterThan(0n);
    expect(Reflect.get(error, 'runId')).toBe(RUN_ID);
    expect(Reflect.get(error, 'absorbedNanoUsd')).toBe(billable.toString());
    // KEY-SET half: no second own property reaches the tag gate unseen.
    expect(Object.keys(error)).toEqual(['name', 'runId', 'absorbedNanoUsd']);
    expect(error.name).toBe('SettlementRefusalAbsorbed');
    expect(error.message).not.toContain(RUN_KEY);
  });

  it('still captures a genuine settlement defect as INTERNAL', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      // The fork-tip CAS zero-row (unreachable under the fork-row lock) throws a
      // plain Error, not the conflict sentinel — so a genuine settlement defect
      // still routes to INTERNAL + Sentry.
      settle: () => Promise.reject(new Error('db exploded')),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
    expect(run.telemetry.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      'workflow_settlement_defect'
    );
  });
});

describe('createWorkflowExecutor — a level applies every sibling before it resolves', () => {
  /**
   * Two siblings on one level: one finishes, the other is still streaming when
   * the user stops. `finishedAt` places the finished sibling at either
   * declaration position, which is the axis the outcome must not depend on.
   */
  function stoppedPair(finishedAt: 0 | 1): {
    readonly run: ReturnType<typeof startRun>;
    readonly stalled: DrainingBehavior;
  } {
    const stalled = waitThenFail();
    const models =
      finishedAt === 0 ? ['answer-model', 'hard-model'] : ['hard-model', 'answer-model'];
    const run = startRun({
      definition: multiModelDefinition(models),
      behaviors: { 'answer-model': streamingEcho(9n, ANSWER_BILLING), 'hard-model': stalled },
    });
    return { run, stalled };
  }

  /** The finished sibling's settled shape, keyed by the node id its position gives it. */
  function settledPair(nodeId: string): { readonly outputs: unknown; readonly charges: unknown } {
    return {
      outputs: { [nodeId]: { kind: 'text', text: 'echo:hi' } },
      charges: [{ key: nodeId, ...ANSWER_BILLING, billableCostNanoUsd: 9n, isEstimated: false }],
    };
  }

  it('settles the sibling that finished before a stop landed on an earlier-declared sibling', async () => {
    const { run, stalled } = stoppedPair(1);
    await stalled.inFlight;
    run.stop('user-stop');
    stalled.release();
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements).toEqual([{ runKey: RUN_KEY, ...settledPair('m1') }]);
  });

  it('settles the same partial whichever declaration position the finished sibling holds', async () => {
    const first = stoppedPair(0);
    await first.stalled.inFlight;
    first.run.stop('user-stop');
    first.stalled.release();
    await first.run.done;
    const last = stoppedPair(1);
    await last.stalled.inFlight;
    last.run.stop('user-stop');
    last.stalled.release();
    await last.run.done;
    expect(first.run.settlements).toEqual([{ runKey: RUN_KEY, ...settledPair('m0') }]);
    expect(last.run.settlements).toEqual([{ runKey: RUN_KEY, ...settledPair('m1') }]);
  });

  it('settles the sibling that finished beside a branch routing to the end sentinel', async () => {
    const run = startRun({
      definition: endBesideSiblingDefinition(),
      behaviors: { 'answer-model': streamingEcho(9n, ANSWER_BILLING) },
      predicates: { textDone: () => 'through' },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements).toEqual([{ runKey: RUN_KEY, ...settledPair('sibling') }]);
  });
});

describe('createWorkflowExecutor — untaken branch paths', () => {
  it('skips every structural node kind fed from an untaken path', async () => {
    const run = startRun({
      definition: deadKindsDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'hard' }),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
        echo: respondWith('never'),
        split: respondWith(['never']),
      },
      predicates: {
        ...ROUTE_PREDICATES,
        textDone: () => true,
      },
      reducers: { pairJoin: (inputs) => `${String(inputs[0])} ${String(inputs[1])}` },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      other: { kind: 'text', text: 'hard answer' },
    });
  });
});

describe('createWorkflowExecutor — loop', () => {
  it('iterates the body until the condition holds', async () => {
    const run = startRun({
      definition: loopDefinition(8),
      behaviors: {
        echo: {
          run: (input) => Promise.resolve(ok({ value: `${String(input[0])}.`, costNanoUsd: 0n })),
        },
      },
      predicates: { textDone: (state) => typeof state === 'string' && state.endsWith('...') },
      inputs: { prompt: textInput('x') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      refine: { kind: 'text', text: 'x...' },
    });
  });

  it('stops iterating once a stop lands on an iteration that still produced its value', async () => {
    const body = streamThenFinish('x.');
    const run = startRun({
      definition: loopDefinition(8),
      behaviors: { echo: body },
      predicates: { textDone: () => false },
      inputs: { prompt: textInput('x') },
    });
    await body.inFlight;
    run.stop('user-stop');
    body.release();
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements).toEqual([]);
  });

  it('keeps the previous state when a skip-on-error body iteration fails', async () => {
    const run = startRun({
      definition: loopDefinition(2, 'skip'),
      behaviors: { echo: failWith() },
      predicates: { textDone: () => false },
      inputs: { prompt: textInput('x') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      refine: { kind: 'text', text: 'x' },
    });
  });

  it('stops iterating at the declared bound when the condition never holds', async () => {
    const body = vi.fn(
      (input: readonly unknown[]): Promise<ReturnType<typeof ok<never, never>>> =>
        Promise.resolve(ok({ value: `${String(input[0])}.`, costNanoUsd: 0n })) as never
    );
    const run = startRun({
      definition: loopDefinition(3),
      behaviors: { echo: { run: body as never } },
      predicates: { textDone: () => false },
      inputs: { prompt: textInput('x') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(body).toHaveBeenCalledTimes(3);
    expect(run.settlements[0]?.outputs).toEqual({
      refine: { kind: 'text', text: 'x...' },
    });
  });

  it("refuses the next iteration once the iterations' spend crosses the limit", async () => {
    const body = vi.fn((input: readonly unknown[]) =>
      Promise.resolve(ok({ value: `${String(input[0])}.`, costNanoUsd: 300n }))
    );
    const run = startRun({
      definition: loopDefinition(8),
      behaviors: { echo: { run: body } },
      predicates: { textDone: () => false },
      decision: grantWithLimit(500n),
      inputs: { prompt: textInput('x') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(body).toHaveBeenCalledTimes(2);
  });
});

describe('createWorkflowExecutor — subWorkflow', () => {
  it('executes a registered sub-workflow over positional inputs', async () => {
    const run = startRun({
      definition: subWorkflowDefinition(),
      behaviors: {
        summarize: {
          run: (input) =>
            Promise.resolve(
              ok({ value: `${String(input[0])}+${String(input[1])}`, costNanoUsd: 0n })
            ),
        },
      },
      inputs: { prompt: textInput('hi'), extra: textInput('there') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      summarize: { kind: 'text', text: 'hi+there' },
    });
  });
});

describe('createWorkflowExecutor — ingress validation', () => {
  it('fails validation when a referenced workflow input is missing', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: {},
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.admissionRequests).toEqual([]);
  });

  it('fails validation when a supplied input is not a content value', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: { prompt: { kind: 'text', text: 42 } as unknown as FlowInputs[string] },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
  });

  it('rejects a byte payload claiming the text modality', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: {
        prompt: {
          kind: 'bytes',
          bytes: new Uint8Array(2),
          mimeType: 'text/plain',
          modality: 'text',
        },
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
  });

  it('rejects an inline byte payload whose shape no channel tag accepts', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: {
        prompt: {
          kind: 'bytes',
          bytes: new Uint8Array(2),
          mimeType: 'image/png',
          modality: 'image',
        },
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.admissionRequests).toEqual([]);
  });
});

describe('createWorkflowExecutor — defects', () => {
  it('contains a throwing node execution as an internal failure', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          run: () => {
            throw new Error('boom');
          },
        },
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('contains a settlement hook that throws on a stopped partial', async () => {
    const behavior = streamThenFinish('partial answer');
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': behavior },
      settle: () => Promise.reject(new Error('settle boom')),
    });
    await behavior.inFlight;
    run.stop('deadline');
    behavior.release();
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('contains a throwing admission hook as an internal failure', async () => {
    const telemetry = makeTelemetry();
    const executor = createWorkflowExecutor({
      registries: registries(),
      execution: makeFakeExecutionRegistry({
        behaviors: { 'answer-model': streamingEcho() },
      }),
      estimateRun: () => ok({ totalNanoUsd: nanoUSD(1n), calls: [] }),
      clock: { now: () => 0 },
      rng: { random: () => 0.5 },
      telemetry,
    });
    const handle = executor.start({
      definition: answerDefinition(),
      inputs: { prompt: textInput('hi') },
      hooks: {
        admission: () => Promise.reject(new Error('admission boom')),
        settlement: () => Promise.resolve(),
      },
      runKey: RUN_KEY,
      runId: RUN_ID,
      emit: () => {},
    });
    await expect(handle.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('contains a throwing settlement hook as an internal failure', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      settle: () => Promise.reject(new Error('settle boom')),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('treats a missing execution registration as a defect', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {},
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('treats a missing branch predicate registration as a defect', async () => {
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'simple' }),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('treats a non-string branch verdict as a defect', async () => {
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'simple' }),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
      },
      predicates: { routeByLabel: () => 42 },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('treats a missing reducer registration as a defect', async () => {
    const run = startRun({
      definition: fanOutDefinition(4),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': streamingEcho(),
      },
      inputs: { prompt: textInput('one two') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('treats a missing loop condition registration as a defect', async () => {
    const run = startRun({
      definition: loopDefinition(3),
      behaviors: { echo: respondWith('x.') },
      inputs: { prompt: textInput('x') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('treats a non-boolean loop condition verdict as a defect', async () => {
    const run = startRun({
      definition: loopDefinition(3),
      behaviors: { echo: respondWith('x.') },
      predicates: { textDone: () => 'yes' },
      inputs: { prompt: textInput('x') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('pages Sentry once when an admission grant carries no circuit readout', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      decision: { admitted: true, holdRef: 'hold-1' } as EngineAdmissionDecision,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
    // Only captureError feeds Sentry; the warn alone reaches no human.
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
    const [error, fingerprint] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(fingerprint).toBe('workflow_admission_grant_malformed');
    expect(error).toBeInstanceOf(Error);
    // Content-free compile-time literal: no runId, no amount, no PII.
    expect(error.message).toBe('workflow admission grant carried no circuit readout');
    expect(run.settlements).toEqual([]);
  });

  it('pages Sentry once when a branch verdict is not a case label', async () => {
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'simple' }),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
      },
      predicates: { routeByLabel: () => 42 },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
    const [error, fingerprint] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(fingerprint).toBe('workflow_predicate_contract_broken');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('workflow branch verdict was not a case label');
    expect(run.settlements).toEqual([]);
  });

  it('pages Sentry once when a loop condition is not a boolean', async () => {
    const run = startRun({
      definition: loopDefinition(3),
      behaviors: { echo: respondWith('x.') },
      predicates: { textDone: () => 'yes' },
      inputs: { prompt: textInput('x') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
    const [error, fingerprint] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    // One broken predicate contract, one Sentry group: a branch verdict and a
    // loop condition are the same failure with the same fix and the same owner.
    expect(fingerprint).toBe('workflow_predicate_contract_broken');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('workflow loop condition was not a boolean');
    expect(run.settlements).toEqual([]);
  });

  it('pages Sentry once when the definition names an unregistered implementation', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {},
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
    const [error, fingerprint] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(fingerprint).toBe('workflow_unregistered_implementation');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('workflow definition names an unregistered runtime implementation');
    expect(run.settlements).toEqual([]);
  });

  it('raises exactly ONE Sentry event when the circuit closes the gate inside a loop', async () => {
    const condition = vi.fn(() => false);
    const run = startRun({
      definition: loopDefinition(3),
      behaviors: {
        echo: {
          run: (input) =>
            Promise.resolve(ok({ value: `${String(input[0])}.`, costNanoUsd: 2000n })),
        },
      },
      predicates: { textDone: condition },
      inputs: { prompt: textInput('x') },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    // The gate is consulted BEFORE the loop condition, so the condition never
    // runs on the pass after the closing iteration, and the circuit's event is
    // the run's only Sentry event.
    expect(condition).toHaveBeenCalledOnce();
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
    const [, fingerprint] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(fingerprint).toBe('workflow_cost_circuit_tripped');
    expect(run.settlements).toEqual([]);
  });

  it('reports a node output violating its declared tag as a malformed model return', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': respondWith(42) },
    });
    // The provider answered; its VALUE failed the declared port's schema. The
    // provider-unavailable code told the user to retry against a provider that
    // is fine and hid the actual fault.
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.MODEL_OUTPUT_INVALID,
    });
  });

  it("reports a smartModel's output violating its declared tag as a malformed model return", async () => {
    const run = startRun({
      definition: smartModelNodeDefinition(),
      behaviors: { 'answer-model': respondWith(42) },
    });
    // A smartModel's committed value is a model's answer exactly as a
    // modelCall's is — the slot only decides WHICH model answers — so the same
    // rejection names the same fault. Blaming our definition here would be the
    // mislabel running the other way.
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.MODEL_OUTPUT_INVALID,
    });
  });
});

/** The `fields` object of every warn line a run wrote, in call order. */
function warnLines(telemetry: Telemetry): readonly Record<string, unknown>[] {
  const calls = (telemetry.warn as unknown as ReturnType<typeof vi.fn>).mock.calls;
  return calls.map((call) => (call[1] ?? {}) as Record<string, unknown>);
}

describe('createWorkflowExecutor — the run id a log line carries', () => {
  /**
   * Every defect path that writes a log line of its own. Each also finalizes
   * failed, which writes the run-failure line, so driving all four covers every
   * writer in the interpreter rather than one representative of them.
   */
  const defectRuns: readonly HarnessOptions[] = [
    {
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      decision: { admitted: true, holdRef: 'hold-1' } as EngineAdmissionDecision,
    },
    {
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'simple' }),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
      },
      predicates: { routeByLabel: () => 42 },
    },
    {
      definition: loopDefinition(3),
      behaviors: { echo: respondWith('x.') },
      predicates: { textDone: () => 'yes' },
      inputs: { prompt: textInput('x') },
    },
    { definition: answerDefinition(), behaviors: {} },
  ];

  it('names the run by the id the caller minted, never by the client key', async () => {
    // `runId` is an allowlisted structured-log field
    // (`lib/telemetry/safe-log-fields.ts`), and that allowlist is what makes
    // user content unrepresentable on the channel: the Idempotency-Key is
    // caller input, so a line carrying it under that name is a disclosure the
    // day the channel is retained. RUN_KEY is deliberately shaped like PII.
    for (const options of defectRuns) {
      const run = startRun(options);
      await run.done;
      const lines = warnLines(run.telemetry);
      expect(lines.length).toBeGreaterThan(1);
      for (const fields of lines) {
        expect(fields['runId']).toBe(RUN_ID);
      }
      expect(JSON.stringify(lines)).not.toContain(RUN_KEY);
    }
  });

  it('writes no run id at all when the caller minted none', async () => {
    // Dropping the field is the whole fallback: substituting the client key
    // for a missing minted id is the disclosure the field name forbids.
    const run = startRun({ definition: answerDefinition(), behaviors: {}, omitRunId: true });
    await run.done;
    const lines = warnLines(run.telemetry);
    expect(lines.length).toBeGreaterThan(1);
    for (const fields of lines) {
      expect(Object.hasOwn(fields, 'runId')).toBe(false);
    }
    expect(JSON.stringify(lines)).not.toContain(RUN_KEY);
  });
});

describe('createWorkflowExecutor — run-scoped history threading', () => {
  const HISTORY: readonly ChatHistoryMessage[] = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ];

  function captureHistories(
    seen: (readonly ChatHistoryMessage[] | undefined)[]
  ): FakeExecutionOptions['behaviors'][string] {
    return {
      run: (input, ctx) => {
        seen.push(ctx.history);
        return Promise.resolve(ok({ value: `echo:${String(input[0])}`, costNanoUsd: 0n }));
      },
    };
  }

  it('hands the start request history to every node execution context', async () => {
    const seen: (readonly ChatHistoryMessage[] | undefined)[] = [];
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': captureHistories(seen) },
      history: HISTORY,
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seen).toEqual([HISTORY]);
  });

  it('leaves the context history absent when the start request carries none', async () => {
    const seen: (readonly ChatHistoryMessage[] | undefined)[] = [];
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': captureHistories(seen) },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seen).toEqual([undefined]);
  });
});

describe('createWorkflowExecutor — run-scoped custom-instructions threading', () => {
  function captureInstructions(
    seen: (string | undefined)[]
  ): FakeExecutionOptions['behaviors'][string] {
    return {
      run: (input, ctx) => {
        seen.push(ctx.customInstructions);
        return Promise.resolve(ok({ value: `echo:${String(input[0])}`, costNanoUsd: 0n }));
      },
    };
  }

  it('hands the start request custom instructions to every node execution context', async () => {
    const seen: (string | undefined)[] = [];
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': captureInstructions(seen) },
      customInstructions: 'answer only in French',
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seen).toEqual(['answer only in French']);
  });

  it('leaves the context custom instructions absent when the start request carries none', async () => {
    const seen: (string | undefined)[] = [];
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': captureInstructions(seen) },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seen).toEqual([undefined]);
  });
});

describe('createWorkflowExecutor — per-node file-part mapper threading', () => {
  function neverInvokedMapper(): FilePartMapper {
    return () => {
      throw new Error('the engine carries the mapper opaquely and never invokes it');
    };
  }

  function captureMapper(
    seen: Map<string, FilePartMapper | undefined>,
    behaviorName: string
  ): FakeBehavior {
    return {
      run: (input, ctx) => {
        seen.set(behaviorName, ctx.mapFilePart);
        return Promise.resolve(ok({ value: `echo:${String(input[0])}`, costNanoUsd: 0n }));
      },
    };
  }

  it('resolves a distinct mapper per node id and hands each node its own', async () => {
    const mapperForM0 = neverInvokedMapper();
    const mapperForM1 = neverInvokedMapper();
    const byNodeId: Record<string, FilePartMapper> = { m0: mapperForM0, m1: mapperForM1 };
    const seen = new Map<string, FilePartMapper | undefined>();
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model']),
      behaviors: {
        'first-model': captureMapper(seen, 'first-model'),
        'second-model': captureMapper(seen, 'second-model'),
      },
      mapFilePartFor: (nodeKey) => byNodeId[nodeKey],
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seen.get('first-model')).toBe(mapperForM0);
    expect(seen.get('second-model')).toBe(mapperForM1);
  });

  it('omits the context mapper key when the start request carries no resolver', async () => {
    const seenKeys: boolean[] = [];
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          run: (input, ctx) => {
            seenKeys.push('mapFilePart' in ctx);
            return Promise.resolve(ok({ value: `echo:${String(input[0])}`, costNanoUsd: 0n }));
          },
        },
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seenKeys).toEqual([false]);
  });
});

describe('createWorkflowExecutor — the admitted seam', () => {
  const HOLD: FlowHoldIdentity = { walletId: 'w1', holdId: 'run-1', scopeIds: ['scope-1'] };

  it('resolves admitted with the grant hold identity when admission grants', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': { run: () => Promise.resolve(ok({ value: 'a', costNanoUsd: 0n })) },
      },
      decision: grantWithLimit(1_000_000n, HOLD),
    });
    await expect(run.admitted).resolves.toEqual({ admitted: true, hold: HOLD });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('resolves admitted without a hold when the grant carries none', async () => {
    const run = startRun({ definition: answerDefinition(), behaviors: {} });
    await expect(run.admitted).resolves.toEqual({ admitted: true });
  });

  it('resolves admitted false with the refusal code when admission refuses', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {},
      decision: { admitted: false, code: ERROR_CODES.INSUFFICIENT_ADMISSION },
    });
    await expect(run.admitted).resolves.toEqual({
      admitted: false,
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
  });

  it('resolves admitted false with the failure code when the run fails before admission', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {},
      inputs: { prompt: { kind: 'text', text: 42 } as unknown as FlowInputs[string] },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'failed', code: ERROR_CODES.VALIDATION });
    await expect(run.admitted).resolves.toEqual({
      admitted: false,
      code: ERROR_CODES.VALIDATION,
    });
  });

  it('resolves admitted false INTERNAL when a defect escapes before the decision', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {},
      decision: Promise.reject(new Error('admission boom')),
    });
    await expect(run.done).resolves.toEqual({ outcome: 'failed', code: ERROR_CODES.INTERNAL });
    await expect(run.admitted).resolves.toEqual({
      admitted: false,
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('resolves admitted true before the circuit-readout defect fails the run', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {},
      decision: { admitted: true, holdRef: 'hold-1', hold: HOLD } as EngineAdmissionDecision,
    });
    await expect(run.admitted).resolves.toEqual({ admitted: true, hold: HOLD });
    await expect(run.done).resolves.toEqual({ outcome: 'failed', code: ERROR_CODES.INTERNAL });
  });
});

const IMAGE_MODEL = 'image-model';
const PNG = 'image/png';

/**
 * The shared compile fakes speak text only, and a media turn's siblings each
 * produce an image; this adds the one image-producing model they name.
 */
function mediaRegistries(): BuildRegistries {
  const base = makeFakeNodeRegistry();
  return {
    constraints: makeFakeConstraints(),
    nodes: {
      hasNode: (type, version) => base.hasNode(type, version),
      resolveValuePorts: (node) =>
        node.type === 'modelCall' && node.model === IMAGE_MODEL
          ? portsAccepting({ in: [textTag()], out: mediaTag('image', [PNG]) }, node.inputSchema)
          : base.resolveValuePorts(node),
    },
  };
}

/**
 * The media turn's shape: one media `modelCall` per selected model, every one
 * reading the single prompt, so the engine walks them as one level. A
 * multi-model turn declares every sibling `optional` + `onError: 'skip'`, as the
 * chat slice's media turn does, which is what makes one model's failure a
 * skipped branch rather than a failed run; a turn of one declares neither.
 */
function mediaTurnDefinition(models: number): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const sibling = models > 1 ? { optional: true, onError: 'skip' as const } : {};
  return buildWorkflow({
    deadlineClass: 'media',
    hooks: HOOKS,
    inputs,
    nodes: Array.from({ length: models }, (_unused, index) =>
      modelCall({
        id: `m${String(index)}`,
        model: IMAGE_MODEL,
        accepts: textTag(),
        in: inputs.ports.prompt,
        produces: mediaTag('image', [PNG]),
        ...sibling,
      })
    ),
    registries: mediaRegistries(),
  })._unsafeUnwrap().definition;
}

/** Half of a sibling's fair share of the budget when the turn selects the maximum. */
const MEDIA_BYTES = VALUE_STORE_BYTE_BUDGET_BYTES / (2 * MAX_SELECTED_MODELS);

/**
 * A media sibling that reserves its download slice the way the real modelCall
 * execution does, holds it until every sibling has claimed — so the claims are
 * genuinely outstanding together — and then downloads its image, aborting the
 * way the provider adapter does when the slice cannot hold it.
 */
function reservingMediaSiblings(models: number): {
  readonly behavior: FakeBehavior;
  readonly allowances: number[];
} {
  const allowances: number[] = [];
  let release!: () => void;
  const allClaimed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    allowances,
    behavior: {
      run: async (_input, ctx) => {
        const reservation = ctx.values.reserve();
        allowances.push(reservation.allowanceBytes);
        if (allowances.length === models) release();
        await allClaimed;
        reservation.release();
        if (reservation.allowanceBytes < MEDIA_BYTES) {
          const aborted = new Error('download exceeded the byte cap');
          aborted.name = 'DownloadByteCapExceeded';
          throw aborted;
        }
        return ok({
          value: {
            ref: 'media/c/m/u',
            mimeType: PNG,
            modality: 'image',
            byteLength: MEDIA_BYTES,
            metadata: {},
          },
          costNanoUsd: 0n,
        });
      },
    },
  };
}

/**
 * A media turn whose first sibling to claim is refused by the slice it reserved
 * — the abort the provider adapter raises when a download cannot fit — while
 * every other sibling produces its image. All of them hold their claims until
 * each has reserved, so the refusal lands with the siblings genuinely in flight
 * together.
 */
function refusedFirstMediaSibling(models: number): FakeBehavior {
  let claimed = 0;
  let release!: () => void;
  const allClaimed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    run: async (_input, ctx) => {
      const reservation = ctx.values.reserve();
      claimed += 1;
      const refused = claimed === 1;
      if (claimed === models) release();
      await allClaimed;
      reservation.release();
      if (refused) {
        const aborted = new Error('download exceeded the byte cap');
        aborted.name = 'DownloadByteCapExceeded';
        throw aborted;
      }
      return ok({
        value: {
          ref: 'media/c/m/u',
          mimeType: PNG,
          modality: 'image',
          byteLength: MEDIA_BYTES,
          metadata: {},
        },
        costNanoUsd: 0n,
        billing: { modelId: IMAGE_MODEL, providerName: 'fake-provider', modality: 'image' },
      });
    },
  };
}

describe('createWorkflowExecutor — concurrent siblings share the run byte budget', () => {
  it('gives no sibling of a media turn less than its equal share of the budget', async () => {
    const siblings = reservingMediaSiblings(MAX_SELECTED_MODELS);
    const run = startRun({
      definition: mediaTurnDefinition(MAX_SELECTED_MODELS),
      registries: mediaRegistries(),
      behaviors: { [IMAGE_MODEL]: siblings.behavior },
    });
    await run.done;
    // The two-character prompt is the only value metered before the level runs,
    // at the store's two-bytes-per-UTF-16-unit rate.
    const free = VALUE_STORE_BYTE_BUDGET_BYTES - 'hi'.length * 2;
    expect(siblings.allowances).toHaveLength(MAX_SELECTED_MODELS);
    expect(Math.min(...siblings.allowances)).toBeGreaterThanOrEqual(
      Math.floor(free / MAX_SELECTED_MODELS)
    );
  });

  it("shares the budget between a fanOut's concurrent branches", async () => {
    const allowances: number[] = [];
    const run = startRun({
      definition: fanOutDefinition(3),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': {
          run: (input, ctx) => {
            allowances.push(ctx.values.reserve().allowanceBytes);
            return Promise.resolve(ok({ value: String(input[0]), costNanoUsd: 0n }));
          },
        },
      },
      reducers: {
        captionsWithPrompt: (reduced) => (reduced[0] as readonly string[]).join('|'),
      },
      inputs: { prompt: textInput('one two three') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(allowances).toHaveLength(3);
    expect(Math.min(...allowances)).toBeGreaterThan(0);
    expect(Math.max(...allowances) * 3).toBeLessThanOrEqual(VALUE_STORE_BYTE_BUDGET_BYTES);
  });

  it('completes a media turn selecting the maximum number of models', async () => {
    const siblings = reservingMediaSiblings(MAX_SELECTED_MODELS);
    const run = startRun({
      definition: mediaTurnDefinition(MAX_SELECTED_MODELS),
      registries: mediaRegistries(),
      behaviors: { [IMAGE_MODEL]: siblings.behavior },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('completes a media turn whose sibling was refused by the slice it reserved', async () => {
    const run = startRun({
      definition: mediaTurnDefinition(MAX_SELECTED_MODELS),
      registries: mediaRegistries(),
      behaviors: { [IMAGE_MODEL]: refusedFirstMediaSibling(MAX_SELECTED_MODELS) },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('settles every sibling but the one the slice refused', async () => {
    const run = startRun({
      definition: mediaTurnDefinition(MAX_SELECTED_MODELS),
      registries: mediaRegistries(),
      behaviors: { [IMAGE_MODEL]: refusedFirstMediaSibling(MAX_SELECTED_MODELS) },
    });
    await run.done;
    expect(run.settlements).toHaveLength(1);
    expect(Object.keys(run.settlements[0]?.outputs ?? {})).toHaveLength(MAX_SELECTED_MODELS - 1);
    expect(run.settlements[0]?.charges).toHaveLength(MAX_SELECTED_MODELS - 1);
  });
});

describe('createWorkflowExecutor: web search spend on sibling modelCalls', () => {
  /** What `count` searches that returned charge on the node that made them. */
  function searches(count: number): bigint {
    return toolCallChargeNanoUsd(WEB_SEARCH_TOOL_NAME, count);
  }

  /** Each succeeding sibling's model cost, apart from its searches. */
  const MODEL_COST = 40n;

  function billingOf(modelId: string): NodeBillingMetadata {
    return { modelId, providerName: 'p', modality: 'text' };
  }

  /**
   * Three search siblings, as the modelCall node reports them: `m0` answers
   * after one search, `m1` fails after two searches with only their spend
   * observed, and `m2` answers after three searches.
   */
  function searchSiblings(): Record<string, FakeBehavior> {
    return {
      'first-model': respondWith(
        'first answer',
        MODEL_COST + searches(1),
        billingOf('first-model')
      ),
      'second-model': failWith(searches(2), ERROR_CODES.CONTENT_POLICY),
      'third-model': respondWith(
        'third answer',
        MODEL_COST + searches(3),
        billingOf('third-model')
      ),
    };
  }

  const SUCCEEDING_SPEND = MODEL_COST + searches(1) + MODEL_COST + searches(3);
  /** Every sibling's observed spend: the circuit reads it, whether or not the node charges. */
  const WHOLE_SPEND = SUCCEEDING_SPEND + searches(2);

  it('charges each succeeding sibling its own searches on its line', async () => {
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model', 'third-model']),
      behaviors: searchSiblings(),
      decision: grantWithLimit(WHOLE_SPEND),
    });

    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.charges).toEqual([
      {
        key: 'm0',
        ...billingOf('first-model'),
        billableCostNanoUsd: MODEL_COST + searches(1),
        isEstimated: false,
      },
      {
        key: 'm2',
        ...billingOf('third-model'),
        billableCostNanoUsd: MODEL_COST + searches(3),
        isEstimated: false,
      },
    ]);
  });

  it('bills nowhere the searches of the sibling that failed after two searches', async () => {
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model', 'third-model']),
      behaviors: searchSiblings(),
      decision: grantWithLimit(WHOLE_SPEND),
    });

    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    const billed = (run.settlements[0]?.charges ?? []).reduce(
      (sum, charge) => sum + charge.billableCostNanoUsd,
      0n
    );
    expect(billed).toBe(SUCCEEDING_SPEND);
  });

  it('counts the searches of the sibling that failed toward the cost circuit', async () => {
    // One nano below the whole spend: the succeeding siblings alone stay under
    // it, so the failed sibling's two searches are what cross it.
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model', 'third-model']),
      behaviors: searchSiblings(),
      decision: grantWithLimit(WHOLE_SPEND - 1n),
    });

    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    const [error] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(error).toMatchObject({ accruedNanoUsd: WHOLE_SPEND.toString() });
  });

  it('still charges the searches when the cost circuit closes the gate after them', async () => {
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'third-model']),
      behaviors: searchSiblings(),
      decision: grantWithLimit(SUCCEEDING_SPEND - 1n),
    });

    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.charges.map((charge) => charge.billableCostNanoUsd)).toEqual([
      MODEL_COST + searches(1),
      MODEL_COST + searches(3),
    ]);
  });
});
