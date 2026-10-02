import { DEFAULT_COMPILE_LIMITS } from '../compile/context.js';
import type { ErrorCode, FlowRunOutcome, FlowStartRequest, Node } from '@hushbox/shared';
import type { Result } from '../../../../lib/result/index.js';
import type { CompiledNode, CompiledNodeInput } from '../compile/compile-definition.js';
import type { ValueNode } from '../compile/context.js';
import type {
  NodeRunContext,
  NodeRunError,
  NodeRunSuccess,
  SpendGate,
} from './execution-registry.js';
import type { RunFailure } from './failures.js';
import type { RunValueStore } from './value-store.js';

export type NodeStep =
  | { readonly kind: 'ok' }
  | { readonly kind: 'end' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'failed'; readonly failure: RunFailure };

export type LoopGate =
  | { readonly action: 'break' }
  | { readonly action: 'iterate' }
  | { readonly action: 'terminal'; readonly step: NodeStep };

export interface Scope {
  /** Channel writes land here; reads walk the parent chain. */
  readonly channels: Map<string, unknown>;
  /** Per-invocation virtual producer ports (fanOut element, loop state). */
  readonly virtual: ReadonlyMap<string, unknown>;
  readonly parent?: Scope;
}

export function virtualKey(nodeId: string, port: string): string {
  return JSON.stringify([nodeId, port]);
}

/**
 * Declared input feeds in positional order. A clean compile guarantees every
 * declared port is fed, so the feed map is complete; positional ports
 * ('in0'…) sort numerically, single-port nodes are order-free.
 */
export function feedsInPortOrder(compiledNode: CompiledNode): readonly CompiledNodeInput[] {
  return [...compiledNode.inputs.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right, 'en', { numeric: true }))
    .map(([, feed]) => feed);
}

export const FAILED_DEFECT: NodeStep = { kind: 'failed', failure: { kind: 'defect' } };

/**
 * The video adapter aborts an over-budget download by throwing an error with
 * this name (see `models/adapters/video-adapter.ts`). It is recognized
 * STRUCTURALLY here — a cross-slice name check, never a value import (the engine
 * must not depend on the models slice) — mirroring how the node layer recognizes
 * `InferenceError`.
 */
const DOWNLOAD_BYTE_CAP_EXCEEDED_NAME = 'DownloadByteCapExceeded';

export function isDownloadByteCapExceeded(error: unknown): boolean {
  return error instanceof Error && error.name === DOWNLOAD_BYTE_CAP_EXCEEDED_NAME;
}

/**
 * The bound on how many sibling nodes stream at once within one topological
 * level. It is the platform's 6-simultaneous-outbound-connections cap — the
 * same fact the compile fan-out-width default encodes (see its doc comment):
 * a wider level queues at the socket layer rather than open a 7th connection.
 */
export const LEVEL_STREAM_CONCURRENCY = DEFAULT_COMPILE_LIMITS.maxFanOutWidth;

export function isValueNode(node: Node): node is ValueNode {
  return (
    node.type === 'modelCall' ||
    node.type === 'transform' ||
    node.type === 'subWorkflow' ||
    node.type === 'smartModel'
  );
}

/**
 * Whether the value this node commits is a MODEL's reply rather than one our
 * own code produced — the question that decides whose fault a rejected value
 * names.
 *
 * It is a type list because nothing declares the answer: neither the node
 * schema, the compile-time registry (membership + ports) nor the execution
 * registry in `execution-registry.ts` (a node execution is `streaming` +
 * `run`) carries a property meaning "a provider authored this value". The
 * nearest fact, {@link NodeRunSuccess}'s `billing`, rides the RESULT and not
 * the node, and two of this gate's callers — the fanIn and fanOut joins — have
 * no result at all. So the list stands in for the predicate, and a NEW node
 * type belongs here iff a provider generation produces its committed value.
 */
export function commitsModelReply(node: Node): boolean {
  return node.type === 'modelCall' || node.type === 'smartModel';
}

/**
 * The width this id counts for: a fanOut counts its compiled cap's worth of
 * branches, each at its body's width, and every other node counts as one.
 */
function inFlightWidthOf(nodeId: string, compiledNode: (nodeId: string) => CompiledNode): number {
  const node = compiledNode(nodeId).node;
  return node.type === 'fanOut' ? node.maxWidth * inFlightWidthOf(node.body, compiledNode) : 1;
}

/**
 * A level's summed width, the divisor the ValueStore shares the run's free
 * budget by, so a media sibling's download cap is a slice rather than the lot.
 */
export function levelInFlightWidth(
  nodeIds: readonly string[],
  compiledNode: (nodeId: string) => CompiledNode
): number {
  return nodeIds.reduce((total, nodeId) => total + inFlightWidthOf(nodeId, compiledNode), 0);
}

/**
 * A succeeded node's final cost, the figure that replaces its reported running
 * total: its own generation's cost plus every auxiliary generation's.
 */
export function finalCostOf(success: NodeRunSuccess): bigint {
  return (success.auxiliaryCharges ?? []).reduce(
    (total, charge) => total + charge.billableCostNanoUsd,
    success.costNanoUsd
  );
}

/** The run-level gate operations one node execution's ledger counts through. */
interface RunSpend {
  isOpen(): boolean;
  accrue(costNanoUsd: bigint): void;
}

/**
 * One node execution's view of the run's spend gate. The circuit counts the
 * highest running total the node reports, and the node's final cost replaces
 * that total at node end, so no spend is counted twice.
 */
export function openSpendLedger(run: RunSpend): {
  readonly gate: SpendGate;
  readonly settle: (finalNanoUsd: bigint) => void;
} {
  let counted = 0n;
  const countTo = (total: bigint): void => {
    run.accrue(total - counted);
    counted = total;
  };
  return {
    gate: {
      isOpen: () => run.isOpen(),
      report: (total) => {
        if (total > counted) countTo(total);
      },
    },
    settle: countTo,
  };
}

/** A value node's finished execution, as its ordered apply consumes it. */
export interface ExecutedValue {
  readonly result: Result<NodeRunSuccess, NodeRunError>;
  /**
   * The spend gate had closed by the time the execution returned: the node ran
   * on past a closer, so its step is `stopped` whatever its value. Read when
   * the execution returns, never at apply, because a sibling's final cost
   * applied earlier in the level must not decide this node's step.
   */
  readonly drained: boolean;
  /** Replaces the node's reported running total with its final cost. */
  readonly settleSpend: (finalNanoUsd: bigint) => void;
}

/** A node's produced work, split so value-node charges apply in level order. */
export type Produced =
  | { readonly kind: 'step'; readonly step: NodeStep }
  | {
      readonly kind: 'value';
      readonly compiledNode: CompiledNode;
      readonly node: ValueNode;
      readonly executed: ExecutedValue;
    };

export type ProducedValue =
  | { readonly kind: 'step'; readonly step: NodeStep }
  | { readonly kind: 'executed'; readonly executed: ExecutedValue };

/**
 * The outcome of committing a produced value: whether it reached its channel,
 * and the step that follows. The two are separate because they are separate
 * facts — a `skip`-declared node that failed validation continues the run (`ok`)
 * having committed nothing, and only `committed` distinguishes it.
 */
export interface CommitOutcome {
  readonly committed: boolean;
  readonly step: NodeStep;
}

/** Everything the ordered apply of a value node needs, bundled to keep params low. */
export interface ValueTarget {
  readonly compiledNode: CompiledNode;
  readonly node: ValueNode;
  readonly scope: Scope;
  readonly chargeKey?: string | undefined;
}

/** How a completed level resolves the walk: nothing (continue), end, or terminal. */
export type LevelResolution =
  | { readonly kind: 'end' }
  | { readonly kind: 'outcome'; readonly outcome: FlowRunOutcome };

/**
 * The engine's one channel write, and {@link readChannel} its one read.
 * Everything a run puts on a channel is admitted by `store()` and everything
 * it takes off one comes back through `resolve()` — including the values no
 * node produced: a branch's passthrough, a loop's carried state, and the
 * per-invocation seeds of the fanOut and loop container scopes. That is what
 * makes the ValueStore a seam rather than a convention: the byte meter sees
 * every value the run holds, and a durable implementation replaces this file
 * nowhere. `false` is the run's byte budget refusing the value; an omitted
 * value is a skipped node's channel, which meters zero and cannot be refused.
 */
export function storeInChannel(
  store: RunValueStore,
  scope: Scope,
  nodeId: string,
  value?: unknown
): boolean {
  const stored = store.store(value);
  if (stored.isErr()) return false;
  scope.channels.set(nodeId, stored.value);
  return true;
}

/** A channel's value; a durable ValueStore fetches its ref here. */
export function readChannel(store: RunValueStore, scope: Scope, nodeId: string): unknown {
  return store.resolve(scope.channels.get(nodeId));
}

export function applyNodeFailure(
  store: RunValueStore,
  node: Node,
  scope: Scope,
  code?: ErrorCode
): NodeStep {
  if (node.onError === 'skip') {
    // A skipped node's channel holds no value; it meters zero bytes, so the
    // budget has nothing to refuse.
    storeInChannel(store, scope, node.id);
    return { kind: 'ok' };
  }
  return {
    kind: 'failed',
    failure: { kind: 'node-failed', nodeId: node.id, ...(code === undefined ? {} : { code }) },
  };
}

/**
 * The run-scoped client context a node's execution is handed: the conversation
 * history and the custom instructions, plus the routing disposition itself.
 *
 * A ROUTING-ONLY node — the turn's classifier, derived from the graph — is
 * handed neither, so a routing call cannot bill input the classifier reserve
 * did not price. The disposition also travels as a value, because its third
 * consequence is one no withholding can express: the provider request must
 * suppress the base system preamble the adapter would otherwise add.
 */
export function clientContextFor(
  request: FlowStartRequest,
  routingOnly: boolean
): Partial<Pick<NodeRunContext, 'history' | 'customInstructions' | 'routingOnly'>> {
  if (routingOnly) return { routingOnly: true };
  return {
    ...(request.history === undefined ? {} : { history: request.history }),
    ...(request.customInstructions === undefined
      ? {}
      : { customInstructions: request.customInstructions }),
  };
}
