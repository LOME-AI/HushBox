import { match } from 'ts-pattern';
import {
  ERROR_CODES,
  MediaValue,
  callShapeFamilyFor,
  compileParamSpec,
  createAssistantStream,
  reasoningPlanModelFrom,
  reduceAssistantStream,
  serializeAssistantStream,
  settleAssistantStream,
  utcDayKeyAt,
} from '@hushbox/shared';
import {
  carveToolLoopSteps,
  isToolName,
  pickClassifiedEffortPlan,
  toolCallChargeNanoUsd,
  toolCallsOfSteps,
} from '@hushbox/shared/affordability';
import { validationError } from '../../../../lib/errors/index.js';
import { FINGERPRINT_CODES } from '../../../../lib/telemetry/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { validateNodeInput } from './node-input.js';
import { callInputOf, decisionOf } from './turn-decision.js';
import { portsAccepting } from '../engine/model-ports.js';
import type {
  AssistantStreamState,
  CallShapeFamily,
  CompletionTokens,
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  InputPart,
  MediaGenerationFacts,
  Modality,
  ModelDescriptor,
  Node,
  NodePortDeclaration,
  ProviderMetadata,
  ResolvedReasoningEffort,
  SchemaNameRegistry,
  Segment,
  Usage,
} from '@hushbox/shared';
import type { ToolName } from '@hushbox/shared/affordability';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result } from '../../../../lib/result/index.js';
import type {
  InferenceErrorCode,
  InferOptions,
  ModelProvider,
  ObservedTokenUsage,
  ToolLoopOptions,
} from '../../../models/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { TurnDecision } from './turn-decision.js';
import type {
  EngineClock,
  NodeBillingMetadata,
  NodeExecution,
  NodeRunContext,
  NodeRunError,
  NodeRunSuccess,
} from '../engine/execution-registry.js';

/**
 * The `modelCall` capability execution: one gateway generation (or an agentic
 * loop) over the `ModelProvider` port. It is streaming-terminal — when the
 * engine hands it an `emit` seam, every inference event rides the run's stream
 * to the client; otherwise the node resolves quietly to its value.
 *
 * Money never moves here, but the BILLABLE cost is decided here and carried up
 * for settlement to charge as-is. OpenRouter returns the authoritative inline
 * cost for text and video (summed across agentic steps on the terminal
 * finish); the injected port conversion turns it billable — the only markup
 * application on the money path — and it is charged directly
 * (`isEstimated=false`). Image carries no inline cost by design, so it always
 * bills the deterministic billable catalog estimate (`isEstimated=true`).
 * Text/video charge the inline figure only when it covers the whole run and
 * survives the sanity bound; otherwise they bill the billable estimate, flag
 * `isEstimated`, and fire a Sentry alert. That fallback is not always a
 * pathology — an ordinary multi-step run whose gateway loses one step's figure
 * takes it too, which is what keeps `isEstimated=false` meaning exact.
 */

type ModelCallNode = Extract<Node, { type: 'modelCall' }>;

/**
 * A provider cost more than this multiple of the catalog estimate is treated as
 * corrupt (e.g. a provider-side units bug) and rejected to the estimate path.
 * The bound is deliberately generous — the documented worst-case estimate
 * discrepancy is ~4.4×, so a legitimate cost never approaches this; only a
 * clearly-broken figure trips it. Only applied when an estimate exists.
 */
const PROVIDER_COST_SANITY_MULTIPLE = 1000n;

/** What a usage record names when no event of its call named the endpoint that served it. */
export const SERVED_BY_UNREPORTED = 'unreported';

/** A model resolved from the catalog: its descriptor, declared ports, and pricer. */
export interface ModelBinding {
  readonly descriptor: ModelDescriptor;
  readonly ports: NodePortDeclaration;
  /**
   * The catalog token estimate for observed language/embedding usage, in
   * billable nano-USD (catalog rates are billable). Used as the billed cost
   * whenever the inline provider cost is not usable as the whole run's figure;
   * settlement charges it directly, with no further fee application.
   */
  readonly price: (usage: ObservedTokenUsage) => Result<bigint, DomainError>;
  /**
   * Deterministic media price (billable nano-USD, from the billable catalog
   * rates) and the call's request parameters — image's billed amount, video's
   * fallback and sanity bound. Optional so language-only bindings (and their
   * test fakes) need not carry it; a media-family cost decision without it
   * fails closed.
   */
  readonly priceMedia?: (params: Record<string, unknown>) => Result<bigint, DomainError>;
}

/**
 * What one streamed provider call needs — the reusable core `smartModel`
 * shares for its classifier and answer generations.
 */
export interface ModelCallStreamDeps {
  readonly provider: ModelProvider;
  readonly binding: ModelBinding;
  /**
   * Injected port charge conversion (nodes stay pure — no slice-barrel value
   * imports). Converts the provider's inline USD cost to BILLABLE nano-USD —
   * the ModelProvider port seam, the only markup application on the money
   * path (BILLING.md §Fee Structure).
   */
  readonly usdToBillableNanoUsd: (usd: number) => bigint;
  /**
   * Best-effort alerting whenever a non-image family falls back to the
   * estimate, i.e. the inline cost was not usable as the whole run's figure
   * (never for image, whose estimate is expected). Optional so pure-logic
   * tests and unwired call sites run without it; production supplies it.
   */
  readonly telemetry?: Telemetry;
  /**
   * The agentic tool loop for this call: the resolved server-side tool registry
   * plus the step ceiling. Present only when the node declared tools (e.g. web
   * search); absent is a plain single-generation call. `smartModel` never sets
   * it, so its generations stay tool-free.
   */
  readonly tools?: ToolLoopOptions;
}

/** The slice of NodeRunContext one streamed call consumes. */
interface ModelCallStreamContext {
  readonly signal: AbortSignal;
  /** The engine clock the call's reasoning time is read from. */
  readonly clock: EngineClock;
  readonly emit?: (event: InferenceEvent) => void;
  /**
   * Per-node mapper for provider-generated media files, injected by the engine
   * off `NodeRunContext`. Opaque here: the node forwards it to the provider
   * call untouched and never invokes or inspects it (engine purity).
   */
  readonly mapFilePart?: FilePartMapper;
  /**
   * This call's reserved slice of the run's ValueStore budget, forwarded to the
   * provider so a media download aborts before it materializes a blob the
   * ValueStore would reject. A plain value, never the ValueStore itself — the
   * download stays outside the engine. Absent on non-modelCall callers (e.g.
   * smartModel's text generations), which download nothing.
   */
  readonly downloadByteCap?: number;
  /**
   * The reasoning rung this call's wire was minted at, carried alongside the
   * request because the wire cannot be read back for it (two rungs can clamp to
   * one identical budget). Absent when the call sends no reasoning wire; it
   * becomes the level recorded against the generation.
   */
  readonly resolvedEffort?: ResolvedReasoningEffort;
}

interface ModelCallExecutionDeps extends ModelCallStreamDeps {
  readonly schemas: SchemaNameRegistry;
}

export function createModelCallExecution(deps: ModelCallExecutionDeps): NodeExecution {
  return {
    streaming: true,
    run: (node, input, ctx) => runModelCall(deps, node as ModelCallNode, input, ctx),
  };
}

/**
 * What this node sends and what level it sends it at, after applying the turn's
 * decision to itself.
 *
 * Only the effort axis is applied here: the classified level is carved INTO the
 * completion cap the node already carries, through the one shared wire
 * derivation, so a classified choice can never spend past what admission
 * reserved for this model. A node whose params already carry a reasoning wire
 * has a PINNED effort — the user fixed it, and a runtime decision never
 * rewrites a pinned dimension; its level rides the node, stamped there by the
 * build that resolved it. Without an integer cap there is nothing to carve out
 * of, and a reasoning budget never rides a call with no explicit cap.
 *
 * The level is returned alongside the parameters rather than derived from them:
 * the plan that mints a wire is the only thing that knows which rung it wired.
 *
 * The tool loop follows the same rule: a decided node narrows its declared
 * steps to the decided rung's call cap, and a pinned one keeps them. Admission
 * held the declared loop, so the carve can only shorten what was reserved.
 *
 * A node carrying per-rung ceilings is one searching answer of an Auto turn,
 * and it follows the decision whatever its wire: it runs the decided rung's
 * loop at the ceiling that rung's own solve bought, with the reasoning budget
 * carved out of that ceiling when its wire is not fixed. Admission priced the
 * turn with every such node at one rung, so a node left at its declared ceiling
 * beside a lower decided rung could spend past the hold.
 */
function callAtDecidedEffort(
  node: ModelCallNode,
  descriptor: ModelDescriptor,
  decision: TurnDecision | undefined
): {
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly level: ResolvedReasoningEffort | undefined;
  readonly maxSteps: number;
} {
  const pinned = { parameters: node.params, level: node.reasoningEffort, maxSteps: node.maxSteps };
  if (decision === undefined) return pinned;
  const entry = node.rungCeilings?.[decision.effort];
  const fixedWire = 'reasoning' in node.params;
  if (fixedWire && entry === undefined) return pinned;
  const parameters = entry === undefined ? node.params : { ...node.params, maxOutputTokens: entry };
  const decided = {
    parameters,
    level: node.reasoningEffort,
    maxSteps: carveToolLoopSteps(node.maxSteps, decision.effort),
  };
  if (fixedWire) return decided;
  const cap = parameters['maxOutputTokens'];
  if (typeof cap !== 'number') return decided;
  const plan = pickClassifiedEffortPlan(reasoningPlanModelFrom(descriptor), decision.effort, cap);
  if (plan === undefined) return decided;
  return {
    parameters: { ...parameters, reasoning: plan.wire, maxOutputTokens: plan.maxTokens },
    level: plan.level,
    maxSteps: decided.maxSteps,
  };
}

/** The node's stream deps with its tool loop, if it has one, run at the call's decided steps. */
function withDecidedLoop(
  deps: ModelCallExecutionDeps,
  call: { readonly maxSteps: number }
): ModelCallExecutionDeps {
  if (deps.tools === undefined) return deps;
  return { ...deps, tools: { registry: deps.tools.registry, maxSteps: call.maxSteps } };
}

/** The streamed-call context: the run seams this node forwards, plus the rung its wire was minted at. */
function streamContextOf(
  ctx: NodeRunContext,
  downloadByteCap: number,
  level: ResolvedReasoningEffort | undefined
): ModelCallStreamContext {
  return {
    signal: ctx.signal,
    clock: ctx.clock,
    downloadByteCap,
    ...(level === undefined ? {} : { resolvedEffort: level }),
    ...(ctx.emit === undefined ? {} : { emit: ctx.emit }),
    ...(ctx.mapFilePart === undefined ? {} : { mapFilePart: ctx.mapFilePart }),
  };
}

async function runModelCall(
  deps: ModelCallExecutionDeps,
  node: ModelCallNode,
  input: readonly unknown[],
  ctx: NodeRunContext
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const validated = validateNodeInput(
    portsAccepting(deps.binding.ports, node.inputSchema),
    deps.schemas,
    input
  );
  if (validated.isErr()) return err(validated.error);
  // A node fed the turn's decision reads its prompt off the envelope; a node fed
  // raw text reads the text. Both arrive on the same single input port.
  const decision = decisionOf(input[0]);
  const part = toInputPart(callInputOf(input[0]));
  if (part === undefined) return err({});
  // History and custom instructions are both run-scoped client context on the
  // ctx (the only per-run channel to DO-scoped executions), never baked into
  // the definition. Empty/absent normalizes so a bare run produces exactly the
  // pre-history request shape; custom instructions fold into the base system
  // prompt at the language adapter. The engine withholds BOTH from a routing
  // call, so this forwards whatever it was handed rather than deciding again.
  const history = ctx.history;
  const customInstructions = ctx.customInstructions;
  const call = callAtDecidedEffort(node, deps.binding.descriptor, decision);
  const request: InferenceRequest = {
    model: node.model,
    inputs: [part],
    parameters: call.parameters,
    outputs: deps.binding.descriptor.outputs,
    ...(history === undefined || history.length === 0 ? {} : { history: [...history] }),
    ...(customInstructions === undefined ? {} : { customInstructions }),
    // The one piece of the routing disposition a withheld ctx member cannot
    // express: the adapter ADDS the base preamble, so the request has to ask
    // it not to.
    ...(ctx.routingOnly === true ? { routingOnly: true } : {}),
    // The day the adapter renders into the base system prompt. It is decided
    // here, off the engine clock, so nothing below this point reads a wall
    // clock and one request always assembles the same bytes.
    utcDay: utcDayKeyAt(ctx.clock.now()),
  };
  // Per-model discrete video-duration pre-flight: a model that declares a
  // supported-duration set rejects an out-of-set requested duration here, before
  // any provider call — legacy's per-model UNSUPPORTED_DURATION. A model with no
  // declared set carries no such spec, so any duration passes (legacy's
  // "undefined ⇒ unconstrained"); only video declares it, so language/image are
  // never gated. smartModel's generations bypass this entry via streamModelCall.
  if (durationOutOfSupportedSet(deps.binding.descriptor, request.parameters)) {
    return err({ reason: ERROR_CODES.UNSUPPORTED_DURATION });
  }
  // Each concurrent sibling reserves its own slice of what the run's byte
  // budget has left, and that slice — not the whole remainder — is the
  // download's cap, so a level of media siblings cannot each be told the budget
  // is theirs. An oversized download still aborts mid-flight rather than at the
  // `store()` backstop.
  const reservation = ctx.values.reserve();
  try {
    return await streamModelCall(
      withDecidedLoop(deps, call),
      request,
      streamContextOf(ctx, reservation.allowanceBytes, call.level)
    );
  } finally {
    reservation.release();
  }
}

/**
 * True when the descriptor declares a discrete supported-duration set and the
 * requested `durationSeconds` falls outside it. Validated through the shared
 * ParamSpec compiler (the same enum-membership authority admission uses) against
 * the single duration field, so the check is scoped to duration alone — other
 * request params are left to the adapter. A descriptor with no `durationSeconds`
 * enum spec (a non-video model, or a video model that declared no durations)
 * returns false: the duration is unconstrained.
 */
function durationOutOfSupportedSet(
  descriptor: ModelDescriptor,
  params: Record<string, unknown>
): boolean {
  const spec = descriptor.parameters['durationSeconds'];
  if (spec?.type !== 'enum' || spec.values === undefined) return false;
  return !compileParamSpec({ durationSeconds: spec }).safeParse({
    durationSeconds: params['durationSeconds'],
  }).success;
}

/**
 * The provider `infer` options for one streamed call: the run signal, the
 * optional agentic tool loop, the per-node file mapper, and the download byte
 * cap (the slice the run's ValueStore reserved for this call). Each rides only
 * when present.
 */
function inferOptionsOf(deps: ModelCallStreamDeps, ctx: ModelCallStreamContext): InferOptions {
  return {
    signal: ctx.signal,
    ...(deps.tools === undefined ? {} : { tools: deps.tools }),
    ...(ctx.mapFilePart === undefined ? {} : { mapFilePart: ctx.mapFilePart }),
    ...(ctx.downloadByteCap === undefined ? {} : { downloadByteCap: ctx.downloadByteCap }),
  };
}

interface CallAccumulator {
  /**
   * The message's segment tree, folded from every event through the shared
   * assistant-text reducer: answer text, reasoning and search rows in stream
   * order.
   */
  content: AssistantStreamState;
  media: MediaValue | undefined;
  usage: Usage | undefined;
  /** The usage of each step that reported one, in step order. */
  readonly stepUsages: Usage[];
  /** The endpoints the stream named as serving the call, in the order it named them. */
  readonly servedBy: string[];
  /**
   * The inline provider cost the terminal finish reports (USD). The adapter
   * has already summed it across the steps THAT REPORTED ONE — not necessarily
   * every step — so it is the run's whole cost only when the counters below
   * agree; `stepCostSumUsd` is the fallback if only per-step costs were
   * emitted.
   */
  terminalCostUsd: number | undefined;
  stepCostSumUsd: number;
  /**
   * Steps observed against steps that reported a cost. They disagree only when
   * the gateway lost a step's figure mid-run, which makes every inline total
   * derived from those steps — the terminal sum included — an undercount.
   */
  stepCount: number;
  costedStepCount: number;
  /**
   * The terminal gateway generation id: the last step-finish's id, or the
   * finish metadata's id when the provider carries one there (which wins). Keys
   * the settlement charge's per-generation record.
   */
  generationId: string | undefined;
  /** The tool calls the loop this call runs may make; zero when it runs no loop. */
  readonly toolCallBudget: number;
  /** Successful tool calls, by tool: each `tool-result` is one execution that returned. */
  readonly toolResults: Map<ToolName, number>;
  toolResultCount: number;
  /** Every tool call the stream has carried, by call id: still open, or answered. */
  readonly toolCalls: Map<string, 'open' | 'answered'>;
  readonly reasoningTime: ReasoningTime;
}

/**
 * The visible reasoning time on the engine clock. A span opens at the first
 * `reasoning-delta` and closes at the first event after it that is not one; a
 * span the stream ends or is stopped inside closes at its last delta, because
 * the silence after it is not reasoning the user saw. A call that showed no
 * reasoning (`sawReasoning` false) records none.
 */
interface ReasoningTime {
  sawReasoning: boolean;
  totalMs: number;
  spanStartMs: number | undefined;
  lastDeltaMs: number;
}

function timeReasoning(time: ReasoningTime, event: InferenceEvent, atMs: number): void {
  if (event.kind === 'reasoning-delta') {
    time.sawReasoning = true;
    time.spanStartMs ??= atMs;
    time.lastDeltaMs = atMs;
    return;
  }
  if (time.spanStartMs === undefined) return;
  time.totalMs += atMs - time.spanStartMs;
  time.spanStartMs = undefined;
}

/** The call's reasoning time in whole milliseconds, any open span closed at its last delta. */
function reasoningDurationMsOf(time: ReasoningTime): number | undefined {
  if (!time.sawReasoning) return undefined;
  const openSpanMs = time.spanStartMs === undefined ? 0 : time.lastDeltaMs - time.spanStartMs;
  return Math.round(time.totalMs + openSpanMs);
}

/**
 * One streamed generation over the ModelProvider port, from request to the
 * cost decision: events optionally ride `ctx.emit`, the resolved value and
 * base cost come back for the caller to lift. Shared by the `modelCall`
 * execution and both of `smartModel`'s generations.
 */
export async function streamModelCall(
  deps: ModelCallStreamDeps,
  request: InferenceRequest,
  ctx: ModelCallStreamContext
): Promise<Result<NodeRunSuccess, NodeRunError>> {
  const accumulator: CallAccumulator = {
    content: createAssistantStream(),
    media: undefined,
    usage: undefined,
    stepUsages: [],
    servedBy: [],
    terminalCostUsd: undefined,
    stepCostSumUsd: 0,
    stepCount: 0,
    costedStepCount: 0,
    generationId: undefined,
    // A call with no loop runs one step, which allows no tool call.
    toolCallBudget: toolCallsOfSteps(deps.tools?.maxSteps ?? 1),
    toolResults: new Map(),
    toolResultCount: 0,
    toolCalls: new Map(),
    reasoningTime: { sawReasoning: false, totalMs: 0, spanStartMs: undefined, lastDeltaMs: 0 },
  };
  // Every client-visible stream labels itself first: `request.model` is the
  // provider-facing id actually called (smartModel passes its RESOLVED
  // candidate here; its classifier runs with no emit and stays invisible).
  // Emitted, never absorbed — the label can't touch the accumulated value,
  // cost, or billing facts.
  ctx.emit?.(streamStartEvent(deps.binding.descriptor, request.model));
  try {
    for await (const event of deps.provider.infer(
      request,
      deps.binding.descriptor,
      inferOptionsOf(deps, ctx)
    )) {
      ctx.emit?.(withResolvedEffort(event, ctx.resolvedEffort));
      timeReasoning(accumulator.reasoningTime, event, ctx.clock.now());
      absorb(accumulator, event);
    }
  } catch (error) {
    // Doctrine: an explicit stop or a deadline breach with streamed partial
    // output settles like a normal partial and IS billed; only a run that
    // produced nothing bills nothing.
    if (isAborted(error)) return settleAbortedPartial(deps, request, accumulator, ctx);
    if (isInferenceError(error)) {
      return err({ ...inferenceNodeError(error), ...observedToolSpend(accumulator) });
    }
    throw error;
  }
  const value = accumulator.media ?? storedTextOf(deps, settleAssistantStream(accumulator.content));
  const billing = billingMetadataOf(deps.binding.descriptor, request, accumulator, ctx);
  return decideCost(deps, request, accumulator)
    .map((charge) => ({
      value,
      costNanoUsd: charge.costNanoUsd + toolChargeNanoUsd(accumulator),
      isEstimated: charge.isEstimated,
      billing,
    }))
    .mapErr((failure) => ({ ...failure, ...observedToolSpend(accumulator) }));
}

/**
 * The terminal frame, stamped with the rung this call's wire was minted at.
 * `ctx.resolvedEffort` is the single resolution: the same value the billing
 * metadata records for settlement to persist, so a client watching its own turn
 * badges the level live rather than only after a reload, and the two can never
 * disagree. A call with no reasoning wire leaves the field off entirely, which
 * is what keeps "no level recorded" distinct from a recorded `off`. Every
 * non-terminal event passes through untouched.
 */
function withResolvedEffort(
  event: InferenceEvent,
  level: ResolvedReasoningEffort | undefined
): InferenceEvent {
  if (event.kind !== 'finish' || level === undefined) return event;
  return { ...event, reasoningEffort: level };
}

/**
 * The stop/deadline abort outcome: the accumulated partial resolves as a
 * normal node success so the run settles and bills it, together with every
 * tool call that returned before the stop; a call still running is stored
 * interrupted and billed nothing. With neither media nor model text the node
 * fails and reports its tool spend as observed, so a stopped run that produced
 * nothing stays "stopped, zero billed" whatever it searched. Model cost
 * precedence: a completed step's inline cost is exact (`isEstimated=false`); a
 * fully-accumulated media artifact with no inline cost bills its deterministic
 * catalog estimate (`isEstimated=true`), since the artifact is complete and the
 * deterministic price is the real cost. A text partial with no observed cost
 * bills 0n for the model flagged `isEstimated`: a deliberate tradeoff (no token
 * estimation is invented for an interrupted stream), and expected, so no alert
 * fires. A pricing failure never fails the abort settlement; it falls back to
 * the 0n path.
 */
function settleAbortedPartial(
  deps: ModelCallStreamDeps,
  request: InferenceRequest,
  accumulator: CallAccumulator,
  ctx: ModelCallStreamContext
): Result<NodeRunSuccess, NodeRunError> {
  const settled = settleAssistantStream(accumulator.content);
  if (accumulator.media === undefined && !carriesModelText(settled.tree)) {
    return err(observedToolSpend(accumulator));
  }
  const value = accumulator.media ?? storedTextOf(deps, settled);
  const billing = billingMetadataOf(deps.binding.descriptor, request, accumulator, ctx);
  const toolCharge = toolChargeNanoUsd(accumulator);
  const inlineUsd = usableAbortCostUsd(accumulator);
  if (inlineUsd !== undefined) {
    return ok({
      value,
      costNanoUsd: deps.usdToBillableNanoUsd(inlineUsd) + toolCharge,
      isEstimated: false,
      billing,
    });
  }
  if (accumulator.media !== undefined && deps.binding.priceMedia !== undefined) {
    const estimate = deps.binding.priceMedia(request.parameters);
    if (estimate.isOk()) {
      return ok({ value, costNanoUsd: estimate.value + toolCharge, isEstimated: true, billing });
    }
  }
  return ok({ value, costNanoUsd: toolCharge, isEstimated: true, billing });
}

/**
 * A stored search row that dropped sources to fit the rows' storage allowance.
 * It reports how many were dropped and nothing of what any search held.
 */
class SearchRowOversize extends Error {
  readonly droppedSourceCount: number;

  constructor(droppedSourceCount: number) {
    super('stored web search rows dropped sources to fit their allowance');
    this.name = 'SearchRowOversize';
    this.droppedSourceCount = droppedSourceCount;
  }
}

/**
 * The stored text of a settled generation, built only through the shared
 * assistant-text serializer, on the success and aborted-partial paths alike.
 */
function storedTextOf(deps: ModelCallStreamDeps, settled: AssistantStreamState): string {
  const serialized = serializeAssistantStream(settled);
  if (serialized.droppedSourceCount > 0) {
    deps.telemetry?.captureError(
      new SearchRowOversize(serialized.droppedSourceCount),
      FINGERPRINT_CODES.searchRowOversize
    );
  }
  return serialized.text;
}

/**
 * Whether the model wrote any text, answer or reasoning, anywhere in the tree.
 * Search rows and framing are HushBox's, so alone they never make a message.
 */
function carriesModelText(tree: readonly Segment[]): boolean {
  return tree.some((node) =>
    match(node)
      .with({ kind: 'text' }, (text) => text.text !== '')
      .with({ kind: 'reasoning' }, (span) => carriesModelText(span.children))
      .with({ kind: 'webSearch' }, () => false)
      .exhaustive()
  );
}

/** The observed cost an aborted partial may bill: finite and non-negative. */
function usableAbortCostUsd(accumulator: CallAccumulator): number | undefined {
  const inlineUsd = inlineCostUsdOf(accumulator);
  if (inlineUsd === undefined || !Number.isFinite(inlineUsd) || inlineUsd < 0) return undefined;
  return inlineUsd;
}

/**
 * The generation's billing facts: the model and the endpoints that served it, the terminal
 * generation id, the billing modality — the first declared non-text output
 * (the media/embedding artifact drives the billing category), else text — and
 * the dimension the charge records: token counts for a language generation, the
 * declared image/video dimensions for a media one. A concrete modality every
 * time, derived from the descriptor's declared outputs.
 *
 * The reasoning level rides the caller's context rather than being read off the
 * request: the level is what was asked of the model, the reasoning token count
 * beside it is what the model did with it, and only the caller that minted the
 * wire knows which rung it named.
 */
function billingMetadataOf(
  descriptor: ModelDescriptor,
  request: InferenceRequest,
  accumulator: CallAccumulator,
  ctx: ModelCallStreamContext
): NodeBillingMetadata {
  const modality = billingModalityOf(descriptor.outputs);
  const tokens = modality === 'text' ? tokensOf(accumulator.usage) : undefined;
  const media = mediaFactsOf(modality, request.parameters);
  const reasoningDurationMs = reasoningDurationMsOf(accumulator.reasoningTime);
  return {
    modelId: descriptor.id,
    providerName: servedByNameOf(accumulator),
    modality,
    ...(accumulator.generationId === undefined ? {} : { generationId: accumulator.generationId }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(media === undefined ? {} : { media }),
    ...(ctx.resolvedEffort === undefined ? {} : { reasoningEffort: ctx.resolvedEffort }),
    ...(reasoningDurationMs === undefined ? {} : { reasoningDurationMs }),
  };
}

/**
 * The endpoints that served the call, each named once in the order the stream
 * first named it, or {@link SERVED_BY_UNREPORTED} when it named none. Never the
 * model's author: the column means the serving endpoint.
 */
function servedByNameOf(accumulator: CallAccumulator): string {
  const names = [...new Set(accumulator.servedBy)];
  return names.length === 0 ? SERVED_BY_UNREPORTED : names.join(', ');
}

/**
 * The stream label. A media-family (image/video) call additionally carries its
 * output modality — the EARLY per-node media signal (the provider call is one
 * long non-streaming await, so nothing else reaches the client until
 * completion; clients swap the tile to "Generating…" on it, and the chat
 * runtime's video progress sweep keys on it). Language/embedding stream-starts
 * stay modality-free.
 */
function streamStartEvent(descriptor: ModelDescriptor, modelId: string): InferenceEvent {
  const family = callShapeFamilyFor(descriptor.outputs);
  const outputModality =
    family === 'image' || family === 'video' ? billingModalityOf(descriptor.outputs) : undefined;
  return {
    kind: 'stream-start',
    modelId,
    ...(outputModality === undefined ? {} : { outputModality }),
  };
}

function billingModalityOf(outputs: readonly Modality[]): Modality {
  return outputs.find((modality) => modality !== 'text') ?? 'text';
}

/** The observed token dimension of a language generation, absent when none was reported. */
function tokensOf(usage: Usage | undefined): CompletionTokens | undefined {
  if (usage === undefined) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
  };
}

/**
 * The media dimension read off the call's declared parameters — image count +
 * size for an image generation, resolution + duration for a video one (the same
 * parameter names the image/video adapters consume). Only defined for the media
 * families; language/embedding generations carry no media dimension.
 */
function mediaFactsOf(
  modality: Modality,
  params: Record<string, unknown>
): MediaGenerationFacts | undefined {
  if (modality === 'image') {
    const n = numberParameter(params['n']);
    const size = stringParameter(params['size']);
    return {
      imageCount: n ?? 1,
      ...(size === undefined ? {} : { resolution: size }),
    };
  }
  if (modality === 'video') {
    const durationSeconds = numberParameter(params['durationSeconds']);
    const resolution = stringParameter(params['resolution']);
    const facts: MediaGenerationFacts = {
      ...(durationSeconds === undefined ? {} : { durationMs: Math.round(durationSeconds * 1000) }),
      ...(resolution === undefined ? {} : { resolution }),
    };
    // No declared dimensions → carry none (the media_generations row still lands
    // on modality alone). Image always carries a count, so it never reaches here.
    return Object.keys(facts).length === 0 ? undefined : facts;
  }
  return undefined;
}

function numberParameter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringParameter(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The inline-cost decision. Image always bills the estimate (no inline cost by
 * design), no alert. Every other family bills the inline figure only when it
 * covers the whole run and passes the sanity bound; otherwise the estimate
 * stands, flagged `isEstimated` with a Sentry alert.
 */
function decideCost(
  deps: ModelCallStreamDeps,
  request: InferenceRequest,
  accumulator: CallAccumulator
): Result<{ costNanoUsd: bigint; isEstimated: boolean }, NodeRunError> {
  const family = callShapeFamilyFor(deps.binding.descriptor.outputs);
  const estimate = estimateOf(deps, request, accumulator, family);

  // Image never carries an inline cost by design; it always bills the estimate,
  // and that is expected — no alert. Every other family should carry an inline
  // cost covering the whole run; use it when it does and it is valid.
  if (family !== 'image') {
    const inlineBillable = everyStepReportedCost(accumulator)
      ? validInlineBillable(inlineCostUsdOf(accumulator), estimate, deps.usdToBillableNanoUsd)
      : undefined;
    if (inlineBillable !== undefined) {
      return ok({ costNanoUsd: inlineBillable, isEstimated: false });
    }
    // No inline figure that covers the whole run. Alert (model id only, never
    // content), then bill the estimate: never charge 0, never skip.
    deps.telemetry?.warn('inference provider cost unavailable; billing catalog estimate', {
      modelName: request.model,
    });
    deps.telemetry?.captureError(
      new Error('inference provider cost unavailable; settlement billed the catalog estimate'),
      FINGERPRINT_CODES.inferenceProviderCostUnavailable
    );
  }

  // The estimate path — image, or a family with no usable whole-run figure. A
  // pricing failure leaves no priceable amount — the error carries none (see
  // the NodeRunError.costNanoUsd contract).
  if (estimate.isErr()) return err({});
  return ok({ costNanoUsd: estimate.value, isEstimated: true });
}

/**
 * The estimate feeding the cost decision. Media families (image/video) price
 * DETERMINISTICALLY from catalog rates + the call's request parameters —
 * observed token usage cannot price them; language/embedding price observed
 * usage at catalog token rates. A media binding without a media pricer fails
 * closed (production bindings always carry one).
 */
function estimateOf(
  deps: ModelCallStreamDeps,
  request: InferenceRequest,
  accumulator: CallAccumulator,
  family: CallShapeFamily | undefined
): Result<bigint, DomainError> {
  if (family === 'image' || family === 'video') {
    return deps.binding.priceMedia === undefined
      ? err(validationError('Model binding carries no media pricer for a media-family call'))
      : deps.binding.priceMedia(request.parameters);
  }
  if (accumulator.stepCount > 0 && accumulator.stepUsages.length === accumulator.stepCount) {
    return deps.binding.price({ kind: 'perStep', steps: accumulator.stepUsages });
  }
  return accumulator.usage === undefined
    ? ok(0n)
    : deps.binding.price({ kind: 'summed', usage: accumulator.usage });
}

/**
 * Whether the inline total can be trusted as the whole run's cost. A run whose
 * steps all reported a cost is authoritative, and so is one that reported no
 * steps at all (the media families emit none, and have nothing to disagree
 * with their terminal figure). A run that reported some but
 * not all is an undercount: the terminal sum the gateway hands back covers only
 * the steps that reported, so charging it as exact silently bills less than the
 * run cost and suppresses the alert written for a lost figure.
 */
function everyStepReportedCost(accumulator: CallAccumulator): boolean {
  return accumulator.costedStepCount === accumulator.stepCount;
}

/** The authoritative inline cost: the terminal sum, else the per-step fallback. */
function inlineCostUsdOf(accumulator: CallAccumulator): number | undefined {
  if (accumulator.terminalCostUsd !== undefined) return accumulator.terminalCostUsd;
  if (accumulator.costedStepCount > 0) return accumulator.stepCostSumUsd;
  return undefined;
}

/**
 * The billable nano-USD to charge for a valid inline cost, or undefined when
 * it is missing, negative/non-finite, or absurdly large relative to the
 * billable catalog estimate (each routed to the estimate+alert fallback). The
 * sanity bound compares billable to billable — both sides carry the same
 * baked fee, so the ratio is fee-free.
 */
function validInlineBillable(
  inlineUsd: number | undefined,
  estimate: Result<bigint, DomainError>,
  usdToBillableNanoUsd: (usd: number) => bigint
): bigint | undefined {
  if (inlineUsd === undefined || !Number.isFinite(inlineUsd) || inlineUsd < 0) return undefined;
  const billable = usdToBillableNanoUsd(inlineUsd);
  if (
    estimate.isOk() &&
    estimate.value > 0n &&
    billable > estimate.value * PROVIDER_COST_SANITY_MULTIPLE
  ) {
    return undefined;
  }
  return billable;
}

/**
 * What the node's successful tool calls charge: each tool's calls at that
 * tool's per-call rate. It is added after the inline-or-estimate decision,
 * never inside it: compared against a token estimate, a search charge would
 * trip the sanity bound, push the model cost onto the estimate and drop the
 * search from the charge with it.
 */
function toolChargeNanoUsd(accumulator: CallAccumulator): bigint {
  let charge = 0n;
  for (const [tool, calls] of accumulator.toolResults) charge += toolCallChargeNanoUsd(tool, calls);
  return charge;
}

/**
 * A failed node's tool spend, reported as observed cost so the circuit counts
 * it; the node charges nothing. Absent when no tool call returned.
 */
function observedToolSpend(accumulator: CallAccumulator): Pick<NodeRunError, 'costNanoUsd'> {
  const spend = toolChargeNanoUsd(accumulator);
  return spend === 0n ? {} : { costNanoUsd: spend };
}

/** A tool result naming a tool the closed registry does not declare. */
class UndeclaredToolResult extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super('modelCall: a tool result names no declared tool');
    this.name = 'UndeclaredToolResult';
    this.toolName = toolName;
  }
}

/**
 * A tool result answering no open call of the node's stream: a call it never
 * carried (`unseen`), or one a result or an error already answered.
 */
class UnmatchedToolResult extends Error {
  readonly toolName: ToolName;
  readonly callState: 'unseen' | 'answered';

  constructor(toolName: ToolName, callState: 'unseen' | 'answered') {
    super('modelCall: a tool result answers no open tool call');
    this.name = 'UnmatchedToolResult';
    this.toolName = toolName;
    this.callState = callState;
  }
}

/** More successful tool calls than the loop the call ran with admits. */
class ToolCallBudgetExceeded extends Error {
  readonly budget: number;
  readonly count: number;

  constructor(budget: number, count: number) {
    super('modelCall: tool results exceed the call budget');
    this.name = 'ToolCallBudgetExceeded';
    this.budget = budget;
    this.count = count;
  }
}

/**
 * Counts one successful tool call. The adapter builds only the tools the
 * closed registry declares, answers each call once, and refuses every call past
 * the loop's budget, so any other result is a defect: it throws, and the
 * interpreter contains it, rather than going unbilled or overbilled. The charge
 * counts results by tool while the stored tree matches them to calls by id, so
 * holding every result to an open call is what keeps the billed count and the
 * stored `done` entries equal.
 */
function countToolResult(accumulator: CallAccumulator, id: string, name: string): void {
  if (!isToolName(name)) throw new UndeclaredToolResult(name);
  const call = accumulator.toolCalls.get(id);
  if (call !== 'open') {
    throw new UnmatchedToolResult(name, call === undefined ? 'unseen' : 'answered');
  }
  accumulator.toolCalls.set(id, 'answered');
  if (accumulator.toolResultCount >= accumulator.toolCallBudget) {
    throw new ToolCallBudgetExceeded(accumulator.toolCallBudget, accumulator.toolResultCount + 1);
  }
  accumulator.toolResultCount += 1;
  accumulator.toolResults.set(name, (accumulator.toolResults.get(name) ?? 0) + 1);
}

function absorb(accumulator: CallAccumulator, event: InferenceEvent): void {
  accumulator.content = reduceAssistantStream(accumulator.content, event);
  if (event.kind === 'tool-call') {
    accumulator.toolCalls.set(event.id, 'open');
    return;
  }
  if (event.kind === 'tool-error') {
    accumulator.toolCalls.set(event.id, 'answered');
    return;
  }
  if (event.kind === 'tool-result') {
    countToolResult(accumulator, event.id, event.name);
    return;
  }
  if (event.kind === 'media-done') {
    accumulator.media = event.value;
    return;
  }
  if (event.kind === 'step-finish') {
    absorbStepFinish(accumulator, event);
    return;
  }
  if (event.kind === 'finish') absorbFinish(accumulator, event.metadata);
}

function absorbStepFinish(
  accumulator: CallAccumulator,
  event: Extract<InferenceEvent, { kind: 'step-finish' }>
): void {
  // Last step wins: an agentic run's terminal generation is its final step.
  accumulator.generationId = event.generationId;
  accumulator.stepCount += 1;
  if (event.usage !== undefined) accumulator.stepUsages.push(event.usage);
  if (event.servedBy !== undefined) accumulator.servedBy.push(event.servedBy);
  if (event.providerCostUsd !== undefined) {
    accumulator.stepCostSumUsd += event.providerCostUsd;
    accumulator.costedStepCount += 1;
  }
}

function absorbFinish(accumulator: CallAccumulator, metadata: ProviderMetadata): void {
  accumulator.usage = metadata.usage;
  accumulator.terminalCostUsd = metadata.providerCostUsd;
  if (metadata.servedBy !== undefined) accumulator.servedBy.push(metadata.servedBy);
  // A generation id on the terminal finish is the authoritative terminal id;
  // it wins over the last step-finish's.
  if (metadata.generationId !== undefined) {
    accumulator.generationId = metadata.generationId;
  }
}

const REF_MODALITIES: ReadonlySet<string> = new Set(['image', 'audio', 'video']);

function toInputPart(value: unknown): InputPart | undefined {
  if (typeof value === 'string') return { modality: 'text', text: value };
  const media = MediaValue.safeParse(value);
  if (media.success && REF_MODALITIES.has(media.data.modality)) {
    return {
      modality: media.data.modality as 'image' | 'audio' | 'video',
      ref: {
        ref: media.data.ref,
        mimeType: media.data.mimeType,
        byteLength: media.data.byteLength,
      },
    };
  }
  return undefined;
}

/**
 * Expected inference failures surface as thrown `InferenceError`s (the port's
 * stream has no error variant). Recognized structurally so node code stays
 * free of a slice-barrel value import; anything else rethrows to the
 * interpreter's defect path.
 */
function isInferenceError(error: unknown): boolean {
  return error instanceof Error && error.name === 'InferenceError';
}

/** A user-stop/deadline abort: the InferenceError the adapters code 'aborted'. */
function isAborted(error: unknown): boolean {
  return isInferenceError(error) && (error as { code?: unknown }).code === 'aborted';
}

/**
 * The node's failure result for a thrown `InferenceError`. A reason with a
 * targeted client next action (content policy, context length, network) is
 * carried as the run's wire code; every other reason leaves it absent so the
 * engine keeps its generic node-failure code (`UNAVAILABLE`). The reason is a
 * code, never content — this stays inside node purity (no slice-barrel value
 * import; the InferenceError code is read structurally).
 */
function inferenceNodeError(error: unknown): NodeRunError {
  const code = (error as { code?: InferenceErrorCode }).code;
  if (code === 'content_policy') return { reason: ERROR_CODES.CONTENT_POLICY };
  if (code === 'context_length') return { reason: ERROR_CODES.CONTEXT_LENGTH_EXCEEDED };
  if (code === 'network') return { reason: ERROR_CODES.NETWORK_ERROR };
  if (code === 'no_reasoning_endpoints') return { reason: ERROR_CODES.NO_REASONING_ENDPOINTS };
  if (code === 'no_providers_available') return { reason: ERROR_CODES.NO_ELIGIBLE_ENDPOINT };
  return {};
}
