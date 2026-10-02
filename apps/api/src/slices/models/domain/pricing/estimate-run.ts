import { match } from 'ts-pattern';
import {
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  ResolvedReasoningEffort,
  VALUE_STORE_BYTE_BUDGET_BYTES,
  callShapeFamilyFor,
  candidateAnsweringAt,
  consumedProducerIds,
  nanoUSD,
  smartModelClassifierDimensions,
} from '@hushbox/shared';
import {
  TOOL_CALL_CAP_MAX,
  carveToolLoopSteps,
  charStorageNanoUsd,
  isToolName,
  mediaOutputBytes,
  toolCallCapFor,
  toolCallsOfSteps,
  toolLoopBound,
  toolLoopStepsFor,
} from '@hushbox/shared/affordability';
import { callOutputCeilingTokens } from '@hushbox/shared/affordability/completion-cap';
import { classifierReserveCurve } from '@hushbox/shared/affordability/estimate/smart-model-affordability';
import { costAt, tiersAt } from '@hushbox/shared/affordability/price/curve';
import { tokenPricingOf } from '@hushbox/shared/affordability/price/wire';
import { declaredCeilingError, mediaCallUsageFor, reservedCallParts } from './estimate.js';
import { validationError } from '../../../../lib/errors/index.js';
import { Result, err, ok } from '../../../../lib/result/index.js';
import type {
  CallShapeFamily,
  ModelDescriptor,
  Node,
  StorageStamp,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { ToolLoopBound, ToolName } from '@hushbox/shared/affordability';
import type { ReservedCall, RunReservation } from '@hushbox/shared/affordability/price/reservation';
import type { CallUsage, DeclaredCeiling, NodeStorage } from './estimate.js';
import type { DomainError } from '../../../../lib/errors/index.js';

/**
 * The whole-definition admission ceiling. Admission places a hold for a
 * run's WORST-CASE cost before it starts and refuses the run if the wallet
 * cannot cover it, so this is a deliberate over-estimate: a low-balance user
 * is briefly blocked from a run that would have been cheaper, whereas
 * under-estimating under-reserves and takes on real exposure. This number is
 * NOT what the run is charged — settlement bills the provider's actual cost;
 * this is only the pre-authorization ceiling and the basis for the mid-run
 * runaway-cost circuit. Fail-closed on any unpriceable node: a `Result` error
 * makes admission refuse, never a low estimate.
 */

/** Resolves a model id to its catalog descriptor, or `undefined` if absent. */
export type ModelPricingResolver = (modelId: string) => ModelDescriptor | undefined;

/** The injected estimator the interpreter receives as a single-arg dep. */
type EstimateRun = (definition: WorkflowDefinition) => Result<RunReservation, DomainError>;

/**
 * The turn-level storage inputs a PERSISTING run adds to its admission ceiling
 * ride the definition's `storage` stamp — the shared {@link StorageStamp}
 * (`inputChars`), read PER-RUN from the `WorkflowDefinition`, never a per-caller
 * argument. A chat turn stamps it; a general or no-persist definition omits it,
 * so storage is zero and the ceiling is provider cost only. When present the
 * estimator adds input storage ONCE (the prompt, at the definition level) plus
 * output storage for each node whose value settlement can persist — at the one
 * stored-output ratio for text, byte-estimated for media. A node whose output
 * another node consumes is not one of those, and holds none. This is why the
 * estimator is no longer purely structural: a persisting turn's hold must cover
 * the storage it will be billed.
 */

/** A token node's output-storage inputs for the given persisting-turn context. */
function tokenNodeStorage(storageContext: StorageStamp | undefined): NodeStorage | undefined {
  if (storageContext === undefined) return undefined;
  return { mediaStorageBytes: 0 };
}

/**
 * A media node's output-storage bytes, from the one byte estimate the client's
 * cost display and the picker's affordability verdict also price against.
 */
function mediaNodeStorage(
  storageContext: StorageStamp | undefined,
  family: 'image' | 'video',
  usage: CallUsage
): NodeStorage | undefined {
  if (storageContext === undefined) return undefined;
  const units = usage.kind === 'media' ? usage.units : 0;
  return { mediaStorageBytes: mediaOutputBytes(family, units) };
}

/** The prompt's storage, charged once per turn; zero when nothing rests. */
function inputStorageNanoUsd(storageContext: StorageStamp | undefined): bigint {
  if (storageContext === undefined) return 0n;
  return charStorageNanoUsd(storageContext.inputChars);
}

/** Who a reserved call is: the node it prices and the model that answers it. */
interface CallIdentity {
  readonly nodeId: string;
  readonly descriptor: ModelDescriptor;
}

/**
 * A call's reserved parts as one {@link ReservedCall}. A zero hold is refused —
 * it would place a zero admission hold (free admission), which is always a
 * caller bug, never a legitimate run.
 */
function reservedCallOf(
  identity: CallIdentity,
  usage: CallUsage,
  ceiling: DeclaredCeiling,
  storage: NodeStorage | undefined
): Result<ReservedCall, DomainError> {
  return reservedCallParts(identity.descriptor.pricing, usage, ceiling, storage).andThen(
    (parts) => {
      const held = parts.providerNanoUsd + parts.storageNanoUsd;
      if (held === 0n) {
        return err(validationError('Estimate run ceiling must be a positive amount'));
      }
      return ok({
        nodeId: identity.nodeId,
        modelId: identity.descriptor.id,
        pricing: identity.descriptor.pricing,
        ...parts,
        heldNanoUsd: nanoUSD(held),
      });
    }
  );
}

/**
 * One media call's reservation: its deterministic per-unit price at the
 * requested units plus the bytes settlement will store for the artifact. Media
 * pricing has no usage variance, so this is exact rather than a worst case.
 */
function reservedMediaCall(
  identity: CallIdentity,
  call: { readonly family: 'image' | 'video'; readonly params: Record<string, unknown> },
  ceiling: DeclaredCeiling,
  storageContext: StorageStamp | undefined
): Result<ReservedCall, DomainError> {
  return mediaCallUsageFor(call.family, call.params).andThen((usage) =>
    reservedCallOf(identity, usage, ceiling, mediaNodeStorage(storageContext, call.family, usage))
  );
}

/** One call, unfanned and unlooped — a chat turn's media siblings are plain nodes. */
const SINGLE_CALL: DeclaredCeiling = { maxFanOutWidth: 1, maxIterations: 1 };

/**
 * A media turn's `minTurnCost`: the deterministic per-unit price of every sibling
 * generation, plus the artifact's stored bytes and the prompt's characters
 * (`docs/BILLING.md` §Storage Fees, the two nano rates).
 * A per-unit modality takes its own bound in place of the token ceiling
 * (§Extending the System, "Add a modality"), so §Math & Terms' token corner —
 * which is the only `minTurnCost` that section defines — is inert here: media
 * carries no token leg, the minimum IS the whole priced turn, and pricing it any
 * other way (a token approximation, or the provider leg without its bytes) leaves
 * a headroom band that clears the payer freeze and then fails admission.
 *
 * Priced through the same node pricing {@link createEstimateRun} walks, so the
 * freeze compares against exactly what admission will hold. Fail-closed on a
 * model that generates no media or prices no unit: the turn build refuses such a
 * selection on its own, so an error here is never a silent zero.
 */
export function mediaTurnMinCostNanoUsd(
  descriptors: readonly ModelDescriptor[],
  params: Record<string, unknown>,
  storageContext: StorageStamp
): Result<bigint, DomainError> {
  return Result.combine(
    descriptors.map((descriptor) => {
      const family = callShapeFamilyFor(descriptor.outputs);
      return family === 'image' || family === 'video'
        ? reservedMediaCall(
            { nodeId: descriptor.id, descriptor },
            { family, params },
            SINGLE_CALL,
            storageContext
          )
        : err(validationError(`Model '${descriptor.id}' generates no image or video to price`));
    })
  ).map((calls) =>
    calls.reduce((total, call) => total + call.heldNanoUsd, inputStorageNanoUsd(storageContext))
  );
}

const CONTEXT_LENGTH_LIMIT = 'contextLength';

type ModelCallNode = Extract<Node, { type: 'modelCall' }>;

type SmartModelNode = Extract<Node, { type: 'smartModel' }>;

/** Enclosing multipliers accumulated from a model node's ancestor containers. */
interface EnclosureFactors {
  readonly fanOut: number;
  readonly loop: number;
}

interface ParentLink {
  readonly parent: string;
  readonly fanOut: number;
  readonly loop: number;
}

/** One containment edge: a child node id and the enclosing container's link. */
interface ContainmentEdge {
  readonly child: string;
  readonly link: ParentLink;
}

/**
 * The containment edges a single node introduces. Containment is expressed by
 * `body`/`cases`/`else` references, not array nesting: a `fanOut`/`loop` names
 * its body head, a `branch` names its case targets. Node types that enclose no
 * node in THIS definition contribute nothing — enumerated exhaustively so a new
 * node type forces a containment decision here rather than silently defaulting.
 */
function containmentEdges(node: Node): readonly ContainmentEdge[] {
  return match(node)
    .with({ type: 'fanOut' }, (n) => [
      { child: n.body, link: { parent: n.id, fanOut: n.maxWidth, loop: 1 } },
    ])
    .with({ type: 'loop' }, (n) => [
      { child: n.body, link: { parent: n.id, fanOut: 1, loop: n.maxIterations } },
    ])
    .with({ type: 'branch' }, (n) =>
      // A branch selects one path; it multiplies nothing but still passes its
      // own enclosure down to its targets.
      [...Object.values(n.cases), n.else].map((child) => ({
        child,
        link: { parent: n.id, fanOut: 1, loop: 1 },
      }))
    )
    .with(
      { type: 'modelCall' },
      { type: 'transform' },
      { type: 'fanIn' },
      { type: 'subWorkflow' },
      { type: 'smartModel' },
      () => []
    )
    .exhaustive();
}

/**
 * Reverse containment index: child node id → the containers that enclose it,
 * each carrying that container's per-axis multiplier contribution. The `end`
 * sentinel is not a real node, so it is dropped.
 */
function buildParentIndex(nodes: readonly Node[]): Map<string, ParentLink[]> {
  const parents = new Map<string, ParentLink[]>();
  for (const node of nodes) {
    for (const edge of containmentEdges(node)) {
      if (edge.child === 'end') continue;
      const list = parents.get(edge.child) ?? [];
      list.push(edge.link);
      parents.set(edge.child, list);
    }
  }
  return parents;
}

/**
 * A node's enclosure = the product of every ancestor container's contribution
 * per axis. Container references form a DAG (validated acyclic before a
 * definition reaches admission), so the memoized recursion terminates; a node
 * with multiple enclosing paths takes the largest — never under-reserve.
 */
function enclosureFor(
  nodeId: string,
  parents: Map<string, ParentLink[]>,
  memo: Map<string, EnclosureFactors>
): EnclosureFactors {
  const cached = memo.get(nodeId);
  if (cached !== undefined) return cached;
  let best: EnclosureFactors = { fanOut: 1, loop: 1 };
  for (const link of parents.get(nodeId) ?? []) {
    const ancestor = enclosureFor(link.parent, parents, memo);
    const candidate: EnclosureFactors = {
      fanOut: ancestor.fanOut * link.fanOut,
      loop: ancestor.loop * link.loop,
    };
    if (candidate.fanOut * candidate.loop > best.fanOut * best.loop) best = candidate;
  }
  memo.set(nodeId, best);
  return best;
}

/**
 * One model node's ceiling. Language: its per-token cost at the input-leg
 * ceiling ({@link inputTokenCeiling}) and the output-leg ceiling
 * ({@link callOutputCeilingTokens}), neither wider than the model's context
 * window. A call that carries a tool is priced over every step of its loop. Image/video: the
 * DETERMINISTIC catalog price for the node's declared call params (per-image
 * rate × count; per-second-at-resolution rate × duration) — exact, not an
 * over-estimate, since media pricing has no usage variance. Either way scaled
 * by declared fan-out width and loop iterations. Fail-closed if the model is
 * unknown, unpriced, declares no context-token limit (language), or carries
 * unpriceable call params (media): any of those means no true ceiling can be
 * derived, so the run must be refused — never mid-run.
 */
interface ModelCeilingCall {
  /** The workflow node the call belongs to, carried onto its reserved call. */
  readonly nodeId: string;
  readonly modelId: string;
  readonly params: Record<string, unknown>;
  /** The call's tool loop, present exactly when it carries a tool. */
  readonly toolLoop?: ToolLoopBound;
  /**
   * The estimated prompt input-token count. When present it bounds the input
   * leg at `min(contextLength, promptInputTokens)` — the actual prompt, not the
   * full context window. Absent ⇒ the input leg is the full context window
   * (fail-closed over-reserve), which is the pre-stamp / trial behavior.
   */
  readonly promptInputTokens?: number;
}

/**
 * The minimum plausible video bitrate (bits/second) below which no realistic
 * codec produces usable video. Deliberately far under the ~5 MB/s realistic
 * estimate: the admission size gate rejects a media output ONLY when even the
 * most aggressive encoding cannot fit the in-memory ValueStore budget, so this
 * floor must never over-estimate and false-reject content that would actually
 * fit. Founder-tunable knob — raising it trips the gate on shorter/smaller
 * declarations. The true output size is enforced separately at generation time.
 */
const VIDEO_FLOOR_BITS_PER_SECOND = 250_000;

/**
 * The minimum plausible bytes-per-megapixel for a compressed still image — well
 * below any realistic JPEG/PNG encoding, so only a pathologically large image
 * declaration trips the gate. Founder-tunable knob (see the video floor).
 */
const IMAGE_FLOOR_BYTES_PER_MEGAPIXEL = 50_000;

/** 720p pixel area — the baseline the video floor's resolution scaling divides by. */
const VIDEO_BASELINE_AREA_PIXELS = 1280 * 720;

/**
 * Pixel area of each named video resolution tier. A Map (not a plain object) so
 * a hostile resolution like `'constructor'` resolves to `undefined` instead of
 * an inherited member. Kept local to the floor estimate — the shared catalog
 * carries the tier names, not their pixel dimensions.
 */
const VIDEO_RESOLUTION_AREA_PIXELS = new Map<string, number>([
  ['720p', 1280 * 720],
  ['1080p', 1920 * 1080],
  ['4k', 3840 * 2160],
]);

/**
 * Pixel area of a declared media resolution: a named video tier, or a literal
 * `<width>x<height>` string. An unrecognized value yields 0 so the caller can
 * treat it as "area unknown" — never inflate, which would risk a false reject.
 */
function resolutionAreaPixels(resolution: unknown): number {
  if (typeof resolution !== 'string') return 0;
  const named = VIDEO_RESOLUTION_AREA_PIXELS.get(resolution);
  if (named !== undefined) return named;
  const match = /^(\d+)x(\d+)$/i.exec(resolution);
  if (match === null) return 0;
  return Number(match[1]) * Number(match[2]);
}

function minVideoOutputBytes(params: Record<string, unknown>): number {
  const durationSeconds = params['durationSeconds'];
  if (
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return 0;
  }
  const area = resolutionAreaPixels(params['resolution']);
  // Unknown resolution → baseline factor: duration still governs and area is
  // never inflated (the safe direction — never false-reject an unknown tier).
  const areaFactor = area > 0 ? area / VIDEO_BASELINE_AREA_PIXELS : 1;
  const bytesPerSecond = VIDEO_FLOOR_BITS_PER_SECOND / 8;
  return Math.floor(bytesPerSecond * durationSeconds * areaFactor);
}

function minImageOutputBytes(params: Record<string, unknown>): number {
  const area = resolutionAreaPixels(params['resolution']);
  if (area <= 0) return 0;
  const megapixels = area / 1_000_000;
  const n = params['n'];
  const count = typeof n === 'number' && Number.isFinite(n) && n >= 1 ? n : 1;
  return Math.floor(IMAGE_FLOOR_BYTES_PER_MEGAPIXEL * megapixels * count);
}

/**
 * A conservative LOWER BOUND on a media call's output size in bytes — the
 * minimum any realistic encoding could plausibly produce for the declared
 * resolution/duration/count. Text calls have no size axis and return 0.
 * Admission rejects a run only when this floor exceeds the ValueStore budget,
 * i.e. when the output cannot possibly fit; the exact runtime size is enforced
 * separately during generation.
 */
export function estimateMinMediaOutputBytes(
  family: CallShapeFamily | undefined,
  params: Record<string, unknown>
): number {
  if (family === 'video') return minVideoOutputBytes(params);
  if (family === 'image') return minImageOutputBytes(params);
  return 0;
}

function modelCeiling(
  call: ModelCeilingCall,
  enclosure: EnclosureFactors,
  resolveModel: ModelPricingResolver,
  storageContext: StorageStamp | undefined
): Result<readonly ReservedCall[], DomainError> {
  const { nodeId, modelId, params } = call;
  const descriptor = resolveModel(modelId);
  if (descriptor === undefined) {
    return err(validationError(`Estimate references model '${modelId}' unknown to the catalog`));
  }
  const identity: CallIdentity = { nodeId, descriptor };
  const ceiling: DeclaredCeiling = {
    maxFanOutWidth: enclosure.fanOut,
    maxIterations: enclosure.loop,
  };
  const family = callShapeFamilyFor(descriptor.outputs);
  if (family === 'image' || family === 'video') {
    // Pre-run size gate: a media output whose minimum-plausible size cannot fit
    // the in-memory ValueStore is doomed to be killed mid-run, so refuse it at
    // admission — before any provider spend — via the same fail-closed VALIDATION
    // channel as any unpriceable node.
    const minOutputBytes = estimateMinMediaOutputBytes(family, params);
    if (minOutputBytes > VALUE_STORE_BYTE_BUDGET_BYTES) {
      return err(
        validationError(
          `Media call '${modelId}' declares an output whose minimum size (${String(minOutputBytes)} bytes) exceeds the ${String(VALUE_STORE_BYTE_BUDGET_BYTES)}-byte in-memory value-store budget`
        )
      );
    }
    return reservedMediaCall(identity, { family, params }, ceiling, storageContext).map(
      (reserved) => [reserved]
    );
  }
  const contextLength = descriptor.limits[CONTEXT_LENGTH_LIMIT];
  if (contextLength === undefined) {
    return err(
      validationError(`Model '${modelId}' declares no context-token limit to bound the estimate`)
    );
  }
  const usage: CallUsage = {
    kind: 'tokens',
    inputTokens: inputTokenCeiling(call.promptInputTokens, contextLength),
    outputTokens: callOutputCeilingTokens(params, descriptor),
    ...(call.toolLoop === undefined ? {} : { toolLoop: call.toolLoop }),
  };
  return reservedCallOf(identity, usage, ceiling, tokenNodeStorage(storageContext)).map(
    (reserved) => [reserved]
  );
}

/**
 * The input-leg ceiling for a language call: the stamped prompt input-token
 * count when present (the actual prompt), bounded by the context window;
 * otherwise the full context window. Only ever SHRINKS the hold below the
 * context window — the pre-stamp worst case remains the fail-closed default.
 */
function inputTokenCeiling(promptInputTokens: number | undefined, contextLength: number): number {
  if (promptInputTokens === undefined) return contextLength;
  return Math.min(contextLength, promptInputTokens);
}

/**
 * The storage context a node's OUTPUT leg prices against — absent for a node
 * whose value another node consumes.
 *
 * Settlement persists sink outputs, so a consumed value is never stored and no
 * storage can ever be billed for it. The rule is stated over the class rather
 * than over any one node: the turn's classifier is only the first consumed
 * call, and a reserve that special-cased it would have to be revisited for the
 * second. The definition-level input-storage term is unaffected — the prompt is
 * stored once per turn regardless of which nodes read it.
 */
function outputStorageContextFor(
  nodeId: string,
  storageContext: StorageStamp | undefined,
  consumed: ReadonlySet<string>
): StorageStamp | undefined {
  return consumed.has(nodeId) ? undefined : storageContext;
}

/**
 * The tools a node carries, each checked against the closed tool set. A name no
 * tool declares has no result bound and no fee to price, so it refuses.
 */
function declaredTools(node: ModelCallNode): Result<readonly ToolName[], DomainError> {
  const tools: ToolName[] = [];
  for (const name of node.tools) {
    if (!isToolName(name)) {
      return err(validationError(`Estimate references tool '${name}' that no tool declares`));
    }
    tools.push(name);
  }
  return ok(tools);
}

/**
 * The loop a tool-carrying node may run, as the call's `toolLoop` field: empty
 * for a node with no tools, which answers in one call however many steps it
 * declares. Refused when the declared steps allow no call or more calls than any
 * turn may make.
 */
function toolLoopOf(node: ModelCallNode): Result<Pick<ModelCeilingCall, 'toolLoop'>, DomainError> {
  return declaredTools(node).andThen((tools) => {
    if (tools.length === 0) return ok({});
    if (node.maxSteps < 2 || node.maxSteps > toolLoopStepsFor(TOOL_CALL_CAP_MAX)) {
      return err(
        validationError(
          `Estimate cannot bound the tool loop of '${node.id}': maxSteps ${String(node.maxSteps)} is outside 2 to ${String(toolLoopStepsFor(TOOL_CALL_CAP_MAX))}`
        )
      );
    }
    return ok({ toolLoop: toolLoopBound(tools, toolCallsOfSteps(node.maxSteps)) });
  });
}

/** The call a modelCall node declares, with its tool loop. */
function modelCallOf(node: ModelCallNode): Result<ModelCeilingCall, DomainError> {
  return toolLoopOf(node).map((toolLoop) => ({
    nodeId: node.id,
    modelId: node.model,
    params: node.params,
    ...toolLoop,
    ...(node.promptInputTokens === undefined ? {} : { promptInputTokens: node.promptInputTokens }),
  }));
}

/**
 * The classifier reserve for a smartModel node, priced through the shared core
 * as a call that stores nothing. Only the provider cost rides it, on every
 * tier: a classifier's prompt and answer are consumed rather than persisted. The
 * reserve is FIXED (nothing scales with the main turn's output), so the only
 * scaling left here is the enclosing fanOut/loop — the classifier runs once per
 * enclosing invocation.
 */
function classifierReserveCall(
  node: SmartModelNode,
  classifierDescriptor: ModelDescriptor,
  enclosure: EnclosureFactors,
  promptedModels: readonly SmartModelNode['candidates'][number][]
): Result<ReservedCall, DomainError> {
  const pricing = tokenPricingOf(classifierDescriptor.pricing);
  if (pricing === undefined) {
    return err(
      validationError(`smartModel classifier '${node.classifierModelId}' lacks a per-token rate`)
    );
  }
  // The classifier runs once per enclosing invocation, so only the fanOut/loop
  // product scales the reserve — and `workflow.ts`
  // bounds each container at `.int().min(1)` with no upper bound, so nested
  // same-axis containers accumulate a product that leaves safe-integer range
  // and, deep enough, overflows to Infinity. `BigInt(Infinity)` throws, and a
  // throw on the admission path is a defect rather than a refusal, so the
  // multipliers are checked before the multiplication — through the shared
  // core's own check, which is the same one the candidate legs price against.
  const ceilingError = declaredCeilingError({
    maxFanOutWidth: enclosure.fanOut,
    maxIterations: enclosure.loop,
  });
  if (ceilingError !== undefined) return err(ceilingError);
  const { quantities, curve } = classifierReserveCurve({ pricing }, promptedModels);
  const held = nanoUSD(
    costAt(curve, CLASSIFIER_OUTPUT_TOKEN_CAP) * BigInt(enclosure.fanOut) * BigInt(enclosure.loop)
  );
  return ok({
    nodeId: node.id,
    modelId: classifierDescriptor.id,
    pricing: classifierDescriptor.pricing,
    quantities,
    steps: 1,
    wireCapTokens: CLASSIFIER_OUTPUT_TOKEN_CAP,
    stepTiers: tiersAt(curve, CLASSIFIER_OUTPUT_TOKEN_CAP),
    providerNanoUsd: held,
    storageNanoUsd: nanoUSD(0n),
    heldNanoUsd: held,
  });
}

/** What a set of reserved calls holds together. */
function heldBy(calls: readonly ReservedCall[]): bigint {
  return calls.reduce((total, call) => total + call.heldNanoUsd, 0n);
}

/**
 * The dearest of several alternatives — exactly one of them runs, so summing
 * would over-hold N×. The first of equally dear alternatives is kept, and no
 * alternative at all holds nothing.
 */
function dearestOf(alternatives: readonly (readonly ReservedCall[])[]): readonly ReservedCall[] {
  let dearest: readonly ReservedCall[] = [];
  let dearestHeld = 0n;
  for (const calls of alternatives) {
    const held = heldBy(calls);
    if (held > dearestHeld) {
      dearest = calls;
      dearestHeld = held;
    }
  }
  return dearest;
}

/**
 * A smartModel node's reservation: the dearest candidate — exactly ONE candidate
 * answers, so summing candidates would over-hold N× — plus a classifier reserve
 * only when the slot classifies for ITSELF. A slot fed the turn's decision from
 * outside adds none: the classifier it consumes is a node of its own and is
 * priced as one. When the reserve does apply it is priced through the SAME
 * `classifierReserveCurve` the candidate builder's reserve reads (its real
 * truncated-context + output-cap reserve, NOT a full-context modelCall).
 * `node.candidates` is the ELIGIBLE subset the builder derived over the payer's
 * effective balance, each carrying its OWN affordable `cap(m)` — so each answer
 * leg is priced at that candidate's own cap (not a single shared one), and the
 * dearest over the subset is `≤ effBalance` by construction (the caps were sized
 * to make it so, storage included). Each candidate answer leg honors the stamped
 * prompt input-token count and its own `maxOutputTokens`. Fail-closed on any
 * unpriceable classifier or candidate (eligibility excludes them upstream, so an
 * unpriceable name here means the definition is wrong).
 */
function estimateSmartModelNode(
  node: SmartModelNode,
  enclosure: EnclosureFactors,
  resolveModel: ModelPricingResolver,
  storageContext: StorageStamp | undefined
): Result<readonly ReservedCall[], DomainError> {
  return slotReserveOf(node, enclosure, resolveModel).andThen((reserve) =>
    Result.combine([...candidateCeilings(node, enclosure, resolveModel, storageContext)]).map(
      (candidates) => [...reserve, ...dearestOf(candidates)]
    )
  );
}

/**
 * The classifier reserve a smartModel node holds for itself: none when the slot
 * is fed the turn's decision from outside, and otherwise the reserve of the one
 * call its open dimensions buy.
 */
function slotReserveOf(
  node: SmartModelNode,
  enclosure: EnclosureFactors,
  resolveModel: ModelPricingResolver
): Result<readonly ReservedCall[], DomainError> {
  const classifierDescriptor = resolveModel(node.classifierModelId);
  if (classifierDescriptor === undefined) {
    return err(
      validationError(
        `Estimate references model '${node.classifierModelId}' unknown to the catalog`
      )
    );
  }
  // A slot that declares an input schema is fed the turn's decision from
  // OUTSIDE — the same field the execution reads to tell an envelope from raw
  // text — so the classifier it consumes is a node of its own and is priced as
  // one. Holding a reserve here as well would hold twice for one call.
  if (node.inputSchema !== undefined) return ok([]);
  // A slot handed raw text has no decision node above it, so no classifier node
  // exists to carry the reserve and it is held here instead — iff a classifier
  // generation could happen at all, by the SAME shared dimension authority the
  // node execution reads (`Smart Model routing ∨ effort=auto`), so the reserve
  // and the decision can never come from different questions. A chat turn
  // reaches here only when it classifies nothing (one candidate, effort axis
  // settled), so its reserve is zero; the non-zero arm prices any other
  // definition declaring a slot over a plain prompt.
  const dimensions = smartModelClassifierDimensions(node);
  // The prompt names the candidates only when the MODEL dimension is open; an
  // effort-only classifier lists none, so pricing a model line here would put
  // this reserve below the shared producer's — the affordable-then-402 direction.
  // Same authority decides both, so the two lists cannot drift apart.
  const promptedModels = dimensions.model ? node.candidates : [];
  return dimensions.model || dimensions.effort
    ? classifierReserveCall(node, classifierDescriptor, enclosure, promptedModels).map((call) => [
        call,
      ])
    : ok([]);
}

/**
 * Each candidate answers at its OWN affordable cap — the reservation is the
 * dearest over the eligible subset of per-candidate cost, so a cheap model's
 * larger cap and a pricey model's smaller cap are each priced at that model's
 * own rate (never a single shared cap). The candidate cap overrides any
 * node-level `maxOutputTokens`; the reasoning-off wire (node.params) still rides
 * every answer leg. The classifier call never sees these params.
 */
function candidateCeilings(
  node: SmartModelNode,
  enclosure: EnclosureFactors,
  resolveModel: ModelPricingResolver,
  storageContext: StorageStamp | undefined
): readonly Result<readonly ReservedCall[], DomainError>[] {
  return node.candidates.map((candidate) =>
    modelCeiling(
      {
        nodeId: node.id,
        modelId: candidate.id,
        params:
          candidate.maxOutputTokens === undefined
            ? node.params
            : { ...node.params, maxOutputTokens: candidate.maxOutputTokens },
        ...(node.promptInputTokens === undefined
          ? {}
          : { promptInputTokens: node.promptInputTokens }),
      },
      enclosure,
      resolveModel,
      storageContext
    )
  );
}

/** An effort rung a node names a ceiling for. */
type Rung = ResolvedReasoningEffort;

/**
 * One per-rung node's reservation at each point the turn is priced at: each
 * rung the turn may decide, and the point where every node runs what it
 * declares.
 */
interface PerRungNode {
  /** The rungs this node's records name. */
  readonly named: readonly Rung[];
  /** The node's reserved calls at one rung. */
  readonly at: (rung: Rung) => Result<readonly ReservedCall[], DomainError>;
  /** The node's reserved calls at the declared point. */
  readonly declared: Result<readonly ReservedCall[], DomainError>;
}

/** The rungs a record of per-rung ceilings names, each with its ceiling. */
function rungEntries(
  ceilings: Readonly<Partial<Record<Rung, number>>>
): readonly (readonly [Rung, number])[] {
  return ResolvedReasoningEffort.options.flatMap((rung) => {
    const ceiling = ceilings[rung];
    return ceiling === undefined ? [] : [[rung, ceiling] as const];
  });
}

/**
 * A tool-carrying call at each rung: that rung's loop at that rung's ceiling where
 * its record names the rung, and what it declares where it names none, since a
 * pinned answer runs in every arrangement. A rung whose loop would take more steps
 * than the node declares, or a record on a node that carries no tool, has no loop
 * to price at the rung, so it refuses.
 */
function modelCallRungs(
  node: ModelCallNode,
  ceilings: Readonly<Partial<Record<Rung, number>>>,
  price: (call: ModelCallNode) => Result<readonly ReservedCall[], DomainError>
): PerRungNode {
  const declared = price(node);
  return {
    named: rungEntries(ceilings).map(([rung]) => rung),
    declared,
    at: (rung) => {
      const ceiling = ceilings[rung];
      if (ceiling === undefined) return declared;
      const steps = toolLoopStepsFor(toolCallCapFor(rung));
      if (node.tools.length === 0 || steps > node.maxSteps) {
        return err(
          validationError(
            `Estimate cannot price '${node.id}' at rung '${rung}': it needs ${String(steps)} steps of a tool loop and the node declares ${String(node.tools.length === 0 ? 0 : node.maxSteps)}`
          )
        );
      }
      return price({
        ...node,
        maxSteps: carveToolLoopSteps(node.maxSteps, rung),
        params: { ...node.params, maxOutputTokens: ceiling },
      });
    },
  };
}

/**
 * A Smart Model slot at each rung: its own reserve plus the dearest candidate that
 * can answer there. A candidate with per-rung caps answers at a rung it names, at
 * its cap there, and at no other, exactly as the browser leaves a candidate that
 * cannot run at a rung out of that rung's figure; its declared cap is no pricing
 * point. One with no record answers everywhere at its own cap. A rung no candidate
 * can answer at leaves the slot nothing to bind, so it refuses. At the declared
 * point only the candidates with no record answer.
 */
function smartModelRungs(
  node: SmartModelNode,
  enclosure: EnclosureFactors,
  resolveModel: ModelPricingResolver,
  storageContext: StorageStamp | undefined
): PerRungNode {
  const reserve = slotReserveOf(node, enclosure, resolveModel);
  const answeringWith = (
    answering: SmartModelNode['candidates']
  ): Result<readonly ReservedCall[], DomainError> =>
    reserve.andThen((held) =>
      Result.combine([
        ...candidateCeilings(
          { ...node, candidates: answering },
          enclosure,
          resolveModel,
          storageContext
        ),
      ]).map((candidates) => [...held, ...dearestOf(candidates)])
    );
  const unrecorded = node.candidates.filter((candidate) => candidate.rungCeilings === undefined);
  const recorded = node.candidates.filter((candidate) => candidate.rungCeilings !== undefined);
  return {
    named: ResolvedReasoningEffort.options.filter((rung) =>
      recorded.some((candidate) => candidateAnsweringAt(candidate, rung) !== undefined)
    ),
    declared: answeringWith(unrecorded),
    at: (rung) => {
      const answering = node.candidates.flatMap((candidate) => {
        const answers = candidateAnsweringAt(candidate, rung);
        return answers === undefined ? [] : [answers];
      });
      if (answering.length === 0) {
        return err(
          validationError(
            `Estimate cannot price '${node.id}' at rung '${rung}': no candidate answers there`
          )
        );
      }
      return answeringWith(answering);
    },
  };
}

/**
 * The turn's per-rung nodes priced together: one classifier decision serves the
 * whole turn, so every such node runs at the same rung, and the hold is the
 * dearest of those joint reservations rather than each node's own dearest rung
 * summed. The point where every node runs what it declares is one more
 * reservation, so no node is priced below its declared pair.
 */
function jointRungCeiling(
  nodes: readonly PerRungNode[]
): Result<readonly ReservedCall[], DomainError> {
  if (nodes.length === 0) return ok([]);
  const rungs = ResolvedReasoningEffort.options.filter((rung) =>
    nodes.some((node) => node.named.includes(rung))
  );
  const joint = (
    reservations: readonly Result<readonly ReservedCall[], DomainError>[]
  ): Result<readonly ReservedCall[], DomainError> =>
    Result.combine([...reservations]).map((calls) => calls.flat());
  return Result.combine([
    joint(nodes.map((node) => node.declared)),
    ...rungs.map((rung) => joint(nodes.map((node) => node.at(rung)))),
  ]).map((reservations) => dearestOf(reservations));
}

/** Whether any candidate of a slot carries a cap per rung. */
function carriesRungCeilings(node: SmartModelNode): boolean {
  return node.candidates.some((candidate) => candidate.rungCeilings !== undefined);
}

/**
 * The prompt's storage, reserved once per turn on the first reserved call and
 * outside any enclosure multiplier: the prompt is stored once however many
 * times the calls run. The call's quantities name the characters it stores.
 */
function withInputStorage(
  calls: readonly ReservedCall[],
  storageContext: StorageStamp | undefined
): readonly ReservedCall[] {
  const [first, ...rest] = calls;
  if (first === undefined || storageContext === undefined) return calls;
  const inputStorage = inputStorageNanoUsd(storageContext);
  return [
    {
      ...first,
      quantities: { ...first.quantities, newMessageChars: storageContext.inputChars },
      storageNanoUsd: nanoUSD(first.storageNanoUsd + inputStorage),
      heldNanoUsd: nanoUSD(first.heldNanoUsd + inputStorage),
    },
    ...rest,
  ];
}

/**
 * Reserves a definition's declared worst case: every model node's calls, each
 * at its ceiling. A single-model turn is one node; a data-driven `fanOut` is its
 * node at the declared max width. The per-call math (billable rates × the
 * ceiling multiplier) is the shared core's `reservedCallParts`, reused — never
 * re-derived here. No fee is applied on this path: catalog rates arrive already
 * billable from ingestion, which is the one seam that bakes the markup, so the
 * reservation carries it exactly once without this site applying any.
 *
 * The storage stamp rides the DEFINITION and is read per-run: absent (general
 * workflows, and every no-persist definition) the reservation is provider cost
 * only; a persisting chat turn stamps it (from the TurnBudget, via
 * `withStorageStamp`) and the reservation additionally covers input storage ONCE
 * (the prompt) plus the output storage of every node whose value settlement can
 * persist — matching what settlement bills, so admission never under-reserves.
 * Storage is pass-through and never marked up. One estimator instance serves
 * every run; the per-run storage difference is the stamp, not a closed-over
 * argument (the stamp cannot reach this factory — it is built once per DO from
 * env, before any turn is known).
 */
export function createEstimateRun(resolveModel: ModelPricingResolver): EstimateRun {
  return (definition) => {
    const storageContext: StorageStamp | undefined = definition.storage;
    const parents = buildParentIndex(definition.nodes);
    const consumed = consumedProducerIds(definition);
    const memo = new Map<string, EnclosureFactors>();
    const perNode: Result<readonly ReservedCall[], DomainError>[] = [];
    const perRung: PerRungNode[] = [];
    const priceCall = (n: ModelCallNode): Result<readonly ReservedCall[], DomainError> =>
      modelCallOf(n).andThen((call) =>
        modelCeiling(
          call,
          enclosureFor(n.id, parents, memo),
          resolveModel,
          outputStorageContextFor(n.id, storageContext, consumed)
        )
      );
    for (const node of definition.nodes) {
      if (node.type === 'modelCall' && node.rungCeilings !== undefined) {
        perRung.push(modelCallRungs(node, node.rungCeilings, priceCall));
        continue;
      }
      if (node.type === 'smartModel' && carriesRungCeilings(node)) {
        perRung.push(
          smartModelRungs(
            node,
            enclosureFor(node.id, parents, memo),
            resolveModel,
            outputStorageContextFor(node.id, storageContext, consumed)
          )
        );
        continue;
      }
      const contribution: Result<readonly ReservedCall[], DomainError> = match(node)
        .with({ type: 'modelCall' }, (n) => priceCall(n))
        // Fail-closed: a subWorkflow runs a nested definition whose modelCall
        // nodes incur real provider cost, but its `ref` cannot be resolved
        // here to price them. Omitting it would under-reserve the hold — an
        // unpriceable node must refuse the run, never contribute a silent 0.
        .with({ type: 'subWorkflow' }, (n) =>
          err(
            validationError(
              `Estimate cannot price subWorkflow '${n.ref}' — a nested definition is not resolvable here`
            )
          )
        )
        .with({ type: 'smartModel' }, (n) =>
          estimateSmartModelNode(
            n,
            enclosureFor(n.id, parents, memo),
            resolveModel,
            outputStorageContextFor(n.id, storageContext, consumed)
          )
        )
        // No direct inference cost; any enclosed modelCall nodes are already
        // priced through the enclosure walker. Enumerated exhaustively so a
        // new node type forces a pricing decision here rather than silently
        // contributing nothing.
        .with(
          { type: 'transform' },
          { type: 'fanIn' },
          { type: 'branch' },
          { type: 'loop' },
          { type: 'fanOut' },
          () => ok([])
        )
        .exhaustive();
      perNode.push(contribution);
    }
    perNode.push(jointRungCeiling(perRung));
    return Result.combine(perNode).map((reservations) => {
      const calls = withInputStorage(reservations.flat(), storageContext);
      // With no call to carry it, the input storage is the whole hold.
      const total = calls.length === 0 ? inputStorageNanoUsd(storageContext) : heldBy(calls);
      return { totalNanoUsd: nanoUSD(total), calls };
    });
  };
}
