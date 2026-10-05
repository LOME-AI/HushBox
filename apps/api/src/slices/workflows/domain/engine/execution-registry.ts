import type {
  ChatHistoryMessage,
  CompletionTokens,
  ErrorCode,
  FilePartMapper,
  FlowAbortReason,
  FlowStopReason,
  InferenceEvent,
  MediaGenerationFacts,
  Modality,
  ResolvedReasoningEffort,
  SettlementCharge,
} from '@hushbox/shared';
import type { ReservedCall } from '@hushbox/shared/affordability/price/reservation';
import type { Result } from '../../../../lib/result/index.js';
import type { ValueNode } from '../compile/context.js';
import type { ValueStore } from './value-store.js';

/**
 * The injectable node-execution seam the interpreter runs against. Concrete
 * node implementations register through this shape (the runtime counterpart
 * of the compile module's `NodeRegistryContext`); tests inject fakes.
 * `NodeRunContext` is closed: a node may touch exactly the fields
 * `NodeRunContext` declares. Raw `Date.now`/`Math.random` are banned in engine
 * and node code in favor of `ctx.clock`/`ctx.rng`.
 */

/** What closed a run's spend gate when no hard abort did. */
export type SpendGateCause = FlowStopReason | 'cost-circuit';

/**
 * One run's spend gate, as a node execution sees it. A closed gate starts no
 * value node, level or loop iteration, and cuts nothing already in flight.
 */
export interface SpendGate {
  isOpen(): boolean;
  /**
   * This node execution's running total, nano-USD. The circuit counts the
   * highest total reported, and the node's final cost replaces it at node end.
   */
  report(nodeTotalNanoUsd: bigint): void;
}

export interface EngineClock {
  now(): number;
}

export interface EngineRng {
  random(): number;
}

export interface NodeRunContext {
  readonly values: ValueStore;
  readonly clock: EngineClock;
  readonly rng: EngineRng;
  /** Aborted only by a hard abort, one of {@link FlowAbortReason}. */
  readonly signal: AbortSignal;
  /**
   * Present only on streaming executions: the engine allocates the
   * per-branch streamId and monotonic cursor; the node emits bare events.
   */
  readonly emit?: (event: InferenceEvent) => void;
  /**
   * Run-scoped, client-supplied prior conversation turns. An execution is
   * resolved from its node alone ({@link EngineExecutionRegistry}), so nothing
   * run-scoped can reach one at construction and this ctx field is the only
   * per-run channel to it — history is never a graph value and never baked into
   * a definition. Absent means the node was handed none: either the run carried
   * none, or the engine withheld it because this node's call is routing
   * internals rather than an answer (see {@link NodeRunContext.routingOnly}).
   */
  readonly history?: readonly ChatHistoryMessage[];
  /**
   * Run-scoped, client-supplied plaintext custom instructions, on the same
   * per-run channel as `history` — never a graph value, never baked into a
   * definition (the definition must stay free of user content). The language
   * adapter folds it into the base system prompt. Absent on the same two
   * grounds as `history`: the run carried none, or the engine withheld it from
   * a routing call.
   */
  readonly customInstructions?: string;
  /**
   * Injected opaque per-run closure, resolved per node id from the start
   * request's `mapFilePartFor(nodeKey)`. The engine and nodes never construct
   * or introspect it — they only carry it and forward it to the provider
   * call, keeping storage and crypto outside the engine. Absent when the run
   * carries no resolver or the resolver yields nothing for this node.
   * Resolution uses the body node's unsuffixed id, so all `fanOut` branches
   * of one body share a single mapper even though their charges are
   * branch-suffixed; per-branch media under `fanOut` would need branch-keyed
   * resolution first.
   */
  readonly mapFilePart?: FilePartMapper;
  /**
   * True when this node's call is ROUTING INTERNALS rather than an answer —
   * the turn's classifier. DERIVED by the interpreter from the graph (the
   * decision reducer reads this call's answer), never declared on the node, so
   * it cannot contradict what the definition already fixes. It travels because
   * its consequence is something a withheld ctx member cannot express: the
   * provider request suppresses the base system preamble, which the adapter
   * would otherwise add to a call whose reserve prices only the truncated
   * context and the classifier template.
   */
  readonly routingOnly?: true;
  /**
   * The run's spend gate. A user stop, the drain instant and the `hold × K` cost
   * circuit each close it. It is how an execution learns the gate has closed,
   * and how it reports its running total so the circuit counts spend before
   * the node ends.
   */
  readonly spend: SpendGate;
  /**
   * The id the caller minted for the run, which a node's own capture carries so
   * an operator can name the run; `undefined` when the caller minted none (an
   * in-process executor double). Never the client-supplied run key.
   */
  readonly runId: string | undefined;
  /**
   * The call the run's hold reserved for this node: the quantities a language
   * call's `max_price` bound is read from. The interpreter hands every node the
   * one admission priced; a language call sent without it is refused before it
   * reaches the gateway.
   */
  readonly reservation?: ReservedCall;
}

/**
 * The per-generation billing facts a `modelCall` execution decides: the
 * serving model and provider, the generation's modality, and the terminal
 * gateway generation id. The interpreter lifts these into a `SettlementCharge`.
 * Absent on transform/control executions, which produce no billable generation.
 */
export interface NodeBillingMetadata {
  readonly modelId: string;
  readonly providerName: string;
  readonly modality: Modality;
  readonly generationId?: string;
  /** Language token dimension (feeds `llm_completions`); absent on media generations. */
  readonly tokens?: CompletionTokens;
  /** Media dimension (feeds `media_generations`); absent on language generations. */
  readonly media?: MediaGenerationFacts;
  /**
   * The reasoning level the generation ran at (feeds `llm_completions` beside
   * the reasoning tokens it spent). Absent when the call carried no reasoning
   * wire at all — a different fact from `off`, which records reasoning
   * deliberately disabled.
   */
  readonly reasoningEffort?: ResolvedReasoningEffort;
  /**
   * How long the generation showed reasoning, in whole milliseconds on the
   * engine clock (feeds `llm_completions` beside the reasoning tokens). Absent
   * when no reasoning streamed, including a model that bills reasoning without
   * showing it.
   */
  readonly reasoningDurationMs?: number;
  /**
   * Each provider step's usage and the tool fees inside the charge, present only
   * when every step reported its usage. Read after commit to name why a bill
   * exceeded its hold; never written.
   */
  readonly observed?: SettlementCharge['observed'];
}

/**
 * One additional billable generation a multi-generation execution produced
 * under its node. The interpreter lifts each into its own `SettlementCharge`,
 * keyed `<node key>#<keySuffix>` so its charge idempotency key never collides
 * with the node's own. Its cost is part of the node's final cost, which
 * replaces the node's reported total at node end.
 *
 * Nothing produces one today — the turn's classifier is its own node with its own
 * top-level charge key, not an auxiliary of the Smart Model slot.
 */
export interface NodeGenerationCharge {
  /** Distinguishes this generation's charge key from the node's own. */
  readonly keySuffix: string;
  readonly billing: NodeBillingMetadata;
  readonly billableCostNanoUsd: bigint;
  readonly isEstimated: boolean;
}

export interface NodeRunSuccess {
  readonly value: unknown;
  /**
   * The BILLABLE cost this generation is charged: its model cost plus its tool
   * calls' charges. The model cost is the port-converted inline provider cost
   * when it covers every step of the call, is finite and non-negative, and does
   * not exceed the sanity bound — 10× the generation price the hold reserved for an image
   * or video call, which refuses every cost when that price is unknown or zero,
   * and 1000× the estimate for any other, applied when the estimate is known and
   * positive (`decideCost`); else it is the billable estimate. Only a hard
   * abort cuts a call short; a user stop and the deadline let it finish and
   * bill as `decideCost` decides. `settleAbortedPartial` settles a cut call.
   * One whose abort landed mid-step bills only its completed steps' usable
   * inline cost, or nothing for the model when there is none, flagged
   * estimated, since the cut step bills nothing. One whose abort landed
   * between steps bills its completed steps' usable inline cost, flagged
   * estimated unless every completed step reported its figure; with no such
   * cost, a completed media artifact's estimate; else nothing for the model.
   * Also accrued toward the `hold × K` cost circuit. Settlement charges it
   * as-is — no further fee application.
   */
  readonly costNanoUsd: bigint;
  /**
   * True when the model cost is not the inline provider figure for the whole
   * call: an estimate; a cut call's completed steps, when the abort cut a step
   * mid-flight or a completed step reported no figure; or the nothing a
   * cut-short call bills when it observed no usable cost.
   * Absent on non-modelCall executions, which carry no billable generation.
   */
  readonly isEstimated?: boolean;
  /**
   * Present only on `modelCall` executions: the generation's billing facts the
   * settlement charge is built from. Absent on transform/control executions.
   */
  readonly billing?: NodeBillingMetadata;
  /**
   * Additional generations billed under this node beyond the primary one
   * (`billing` + `costNanoUsd`). Present only on multi-generation executions.
   */
  readonly auxiliaryCharges?: readonly NodeGenerationCharge[];
  /**
   * The smartModel routing pipeline ran for this generation, independent of what
   * any classifier did. The slot sets it from the turn's own declared shape — a
   * model-routing slot badges, a pinned-model slot does not — so an answer that
   * fell back to its declared candidate because no decision reached the slot
   * badges just the same. Legacy's `stagesRun`-driven "Smart Model" chip needs
   * exactly that: the interpreter lifts this onto the primary settlement charge
   * so the display chip reads "ran", never "billed".
   */
  readonly smartModelRan?: boolean;
}

export interface NodeRunError {
  /**
   * Spend observed before the failure, accrued toward the circuit; the node
   * charges none of it. A model-call failure carries the usable inline cost of
   * its model steps plus the per-call charges of the tool calls that returned
   * before it, so it holds everything the running total the node reported
   * held. Absent when no such spend was observed.
   */
  readonly costNanoUsd?: bigint;
  /**
   * The specific client wire code for a provider failure with a targeted next
   * action (content policy, context length, network). Absent leaves the
   * engine's generic node-failure code (`UNAVAILABLE`). Carries a code, never
   * content.
   */
  readonly reason?: ErrorCode;
}

export interface NodeExecution {
  /** Streaming-terminal capability flag the engine dispatches on. */
  readonly streaming: boolean;
  run(
    node: ValueNode,
    input: readonly unknown[],
    ctx: NodeRunContext
  ): Promise<Result<NodeRunSuccess, NodeRunError>>;
}

/** Branch predicates return a case label; loop conditions return a boolean. */
export type RegisteredPredicate = (input: unknown) => unknown;

export type RegisteredReducer = (inputs: readonly unknown[]) => unknown;

/**
 * Runtime lookups for everything the definition names: executable value
 * nodes plus the named-constraint registry's predicate and reducer code.
 * A clean compile guarantees the names exist as declarations; a missing
 * runtime registration here is a wiring defect, not a domain failure.
 */
export interface EngineExecutionRegistry {
  resolveExecution(node: ValueNode): NodeExecution | undefined;
  resolvePredicate(name: string): RegisteredPredicate | undefined;
  resolveReducer(name: string): RegisteredReducer | undefined;
}
