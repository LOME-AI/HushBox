import {
  ReasoningWire,
  isTurnClassifierNode,
  jsonTag,
  reasoningBudgetForWire,
  reasoningPlanModelFrom,
  textTag,
} from '@hushbox/shared';
import {
  answerRoomTokens,
  effortFitsAnswerRoom,
  inputTokensOf,
  priceableModelFrom,
  toolCallCapFor,
  toolLoopStepsFor,
  unpinnedEffortOf,
} from '@hushbox/shared/affordability';
import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';
import { classifierReserveChars } from '@hushbox/shared/affordability/estimate/smart-model-affordability';
import { buildClassifierSystemPrompt } from '@hushbox/shared';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  TURN_DECISION_SCHEMA_NAME,
  buildWorkflow,
  createConstraintRegistry,
  createModelResolver,
  createNodeRegistry,
  decisionDomainInput,
  modelCall,
  truncateForClassifier,
  workflowInputs,
} from '../../../workflows/index.js';
import { createServerTransformCompute } from '../../../media/index.js';
import {
  WEB_SEARCH_TOOL_NAME,
  createEstimateRun,
  createModelPricingResolver,
  listDescriptors,
  snapshotResolver,
} from '../../../models/index.js';
import { validationError } from '../../../../lib/errors/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import {
  CHAT_TURN_HOOKS,
  CHAT_TURN_INPUT,
  CHAT_TURN_NODE_ID,
  TRIAL_TURN_HOOKS,
} from '../constants.js';
import {
  CHAT_CLASSIFIER_INPUT,
  CHAT_DECISION_DOMAIN_INPUT,
  classifierStage,
  decisionDomainFor,
  turnEffortPlan,
} from './classifier.js';
import { requiredReasoningEntryFor, resolveTurnReasoning } from './reasoning.js';
import { atLoop, sizedTurnAnswers } from './rung-ceilings.js';
import type {
  ClassifyingInputs,
  EffortClassifierPlan,
  MenuFunding,
  TurnClassifier,
  TurnClassifierParams,
  TurnClassifierPrompt,
} from './classifier.js';
import type { TurnReasoningByModel, TurnReasoningEntry } from './reasoning.js';
import type { AnswerFit, FittedTurn } from './rung-ceilings.js';
import type { PayerFunding } from './context.js';
import type {
  AssignableTag,
  ModelCallOptions,
  ModelResolver,
  NodeHandle,
  NodeRegistryContext,
  Port,
} from '../../../workflows/index.js';
import type { TransformCompute } from '../../../media/index.js';
import type { ModelPricingResolver } from '../../../models/index.js';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result, ResultAsync } from '../../../../lib/result/index.js';
import type { PriceableModel } from '@hushbox/shared/affordability';
import type {
  ChatHistoryMessage,
  DimensionOption,
  FlowInputs,
  ModelDescriptor,
  Node,
  TextTag,
  TypeTag,
  PolicyHooks,
  ReasoningEffortSelection,
  ResolvedReasoningEffort,
  UserTier,
  WorkflowDefinition,
} from '@hushbox/shared';

/**
 * The web-search tool selection a modelCall carries when the turn enabled web
 * search: the closed registry name plus the loop's step ceiling at the rung the
 * turn declares, one step per call that rung allows and a final tool-free
 * answering step. No rung is the ceiling loop: a turn with no ladder has no
 * effort control at all.
 */
function webSearchTooling(loopEffort: ResolvedReasoningEffort | undefined): {
  readonly tools: readonly (typeof WEB_SEARCH_TOOL_NAME)[];
  readonly maxSteps: number;
} {
  return { tools: [WEB_SEARCH_TOOL_NAME], maxSteps: toolLoopStepsFor(toolCallCapFor(loopEffort)) };
}

/**
 * Web search runs as a server-side tool call, so the answering model must be
 * tool-capable. An incapable model is refused at BUILD with a typed validation
 * error (a client-facing 400), never sent to the provider to fail mid-run. An
 * unknown model (absent descriptor) falls through — the compile step refuses it
 * as an unknown model. A disabled turn is always fine.
 */
export function assertWebSearchCapable(
  descriptor: ModelDescriptor | undefined,
  webSearchEnabled: boolean
): Result<void, DomainError> {
  if (!webSearchEnabled) return ok();
  if (descriptor !== undefined && !descriptor.behaviors.includes('tools')) {
    return err(validationError('web search requires a tool-capable model'));
  }
  return ok();
}

/** The same capability gate across every model of a multi-model turn. */
export function assertModelsWebSearchCapable(
  models: readonly string[],
  resolve: ModelPricingResolver,
  webSearchEnabled: boolean
): Result<void, DomainError> {
  if (!webSearchEnabled) return ok();
  for (const model of models) {
    const capable = assertWebSearchCapable(resolve(model), true);
    if (capable.isErr()) return capable;
  }
  return ok();
}

/**
 * The turn's compile registries, built from one shared `ModelResolver` so
 * compile-time port derivation and runtime execution never diverge — the same
 * instance feeds `createNodeRegistry` here and the DO's live-execution
 * registry. Both the route (to build the definition) and the DO's executor
 * construction start from this; the executor additionally wires the provider.
 */
export interface TurnCompileRegistries {
  readonly models: ModelResolver;
  readonly compute: TransformCompute;
  readonly nodes: NodeRegistryContext;
  readonly constraints: ReturnType<typeof createConstraintRegistry>;
}

export function createTurnCompileRegistries(
  pricingResolver: ModelPricingResolver
): TurnCompileRegistries {
  const models = createModelResolver(pricingResolver);
  const compute = createServerTransformCompute();
  const nodes = createNodeRegistry({ models, compute });
  const constraints = createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES);
  return { models, compute, nodes, constraints };
}

/**
 * The per-turn inputs the output-token ceiling derives from: the characters
 * the model will see (the built system prompt + resent history + prompt,
 * measured by the ONE shared `promptCharacterCount` the composer preview also
 * uses) and the payer's spendable funds.
 *
 * The two character counts are not interchangeable and neither is derivable from
 * the other: {@link TurnBudget.promptCharacterCount} is what the PROVIDER
 * receives, {@link TurnBudget.inputCharacterCount} is what the turn STORES.
 */
export interface TurnBudget {
  readonly promptCharacterCount: number;
  /**
   * The new user message's own length — the only characters this turn will
   * newly persist, and so the only ones its storage fee may be reserved over.
   * The system prompt never rests, and each resent history character was stored
   * and charged by the turn that wrote it.
   */
  readonly inputCharacterCount: number;
  readonly funding: PayerFunding;
}

/**
 * The user tier the turn producer grades a turn's models at, from the payer's
 * funding kind: 'purchased' → paid, everything else → free.
 */
export function tierForFunding(funding: PayerFunding): UserTier {
  return funding.kind === 'purchased' ? 'paid' : 'free';
}

/**
 * The payer's spendable funds for a turn — the figure the funding decision
 * FROZE, read back rather than re-derived. Re-deriving it from the payer's
 * wallet is the defect this accessor exists to prevent: a group turn's frozen
 * figure is already a min of independent caps, and adding a wallet cushion to it
 * sized turns beyond the member allocation admission then refused.
 */
export function payerSpendableNanoUsd(budget: TurnBudget): bigint {
  return budget.funding.spendableNanoUsd;
}

/** The turn facts an `auto` turn's own admissible menu is graded against. */
export function menuFundingOf(budget: TurnBudget): MenuFunding {
  return {
    balanceNanoUsd: payerSpendableNanoUsd(budget),
    tier: tierForFunding(budget.funding),
    promptChars: budget.promptCharacterCount,
    inputChars: budget.inputCharacterCount,
  };
}

/**
 * Stamps a PERSISTING chat turn's definition with the admission-only
 * `{ inputChars }` the run estimator needs to hold the storage settlement will
 * bill (the new user message's storage once, then output storage for each node
 * whose value settlement can persist). `inputChars` is the new message's own
 * length rather than the assembled prompt's, because that is what settlement
 * charges: one new user message row is written per turn, and the history and
 * system prompt on the wire rest nowhere new.
 *
 * Only the persisting chat policy stores anything: a trial send carries a budget
 * with funding kind 'free' too, so the funding alone cannot distinguish it — the
 * hooks gate does. A trial (no-persist) turn, or a turn with no budget, is
 * returned unstamped, so its hold stays provider-cost-only. Media turns build
 * without a budget and are likewise unstamped here.
 */
export function withStorageStamp(
  definition: WorkflowDefinition,
  budget: TurnBudget | undefined,
  hooks: PolicyHooks
): WorkflowDefinition {
  if (budget === undefined || hooks.settlement !== CHAT_TURN_HOOKS.settlement) return definition;
  return {
    ...definition,
    storage: { inputChars: budget.inputCharacterCount },
  };
}

/**
 * The turn's estimated prompt input-token count — the same figure the answer
 * ceiling measures its context headroom against — stamped onto language nodes so
 * admission bounds the input leg at the actual prompt rather than the full
 * context window.
 */
export function promptInputTokensFor(budget: TurnBudget): number {
  return inputTokensOf(budget.promptCharacterCount);
}

/**
 * One model's PHYSICAL answer room, the composer's own `min(providerCap,
 * contextHeadroom)`, floored at one token so the answer fit always searches a
 * positive bound. A prompt that overruns the window never sends on the floor: a
 * budgeted compile refuses it on its room ({@link starvedAnswerRefusal}), and the
 * pinned-model auto-effort turn's menu grades it unaffordable.
 */
function flooredAnswerRoom(model: PriceableModel, inputTokens: number): number {
  return Math.max(1, answerRoomTokens(model, inputTokens));
}

/**
 * The WIDEST sibling's physical room — the upper bound of the fit's search on a
 * turn whose nodes each clamp themselves. It must be the widest, not the
 * tightest: a shared tightest-sibling bound would let a small-context sibling
 * truncate a large-context one, which §Multi-Model 3 forbids. Each node's own
 * room is applied by {@link withAnswerCap}, so nothing here caps one sibling by
 * another's limits.
 *
 * There is NO money term. The money bound is whatever the canonical admission
 * estimator accepts, applied by {@link fitAnswerCapToCeiling}, so there is
 * exactly one cost formula on the money path. A rate-bearing bound here would be
 * a second one, and at integer nano rates the two rounded differently — the drift
 * that caused live 402 refusals.
 *
 * Undefined for an empty model set: nothing to bound.
 */
export function physicalAnswerCeiling(
  budget: TurnBudget,
  models: readonly PriceableModel[]
): number | undefined {
  if (models.length === 0) return undefined;
  const inputTokens = promptInputTokensFor(budget);
  return Math.max(...models.map((model) => flooredAnswerRoom(model, inputTokens)));
}

/**
 * The TIGHTEST room across the models — the bound for one cap that must fit every
 * one of them. That is the Smart Model slot's shape: a single composite node
 * carries one answer cap that rides whichever candidate the classifier picks, so
 * it cannot exceed any candidate's own limits. Distinct from
 * {@link physicalAnswerCeiling}, whose consumers clamp per node.
 */
export function sharedAnswerCeiling(
  budget: TurnBudget,
  models: readonly PriceableModel[]
): number | undefined {
  if (models.length === 0) return undefined;
  const inputTokens = promptInputTokensFor(budget);
  return Math.min(...models.map((model) => flooredAnswerRoom(model, inputTokens)));
}

/**
 * A node's reasoning budget B, re-derived from its own `reasoning` wire param:
 * a budget-native wire carries B verbatim; the hard-off wire is 0; an effort
 * wire maps its native word back through the ONE shared positional ladder
 * (same inputs ⇒ same B — the derivation is headroom-independent). A node
 * with no reasoning param is 0, so every pre-reasoning caller (including the
 * smartModel answer leg) is unchanged.
 */
function nodeReasoningBudgetTokens(node: Node, resolveModel: ModelPricingResolver): number {
  if (node.type !== 'modelCall') return 0;
  const wire = ReasoningWire.safeParse(node.params['reasoning']);
  if (!wire.success) return 0;
  if ('max_tokens' in wire.data) return wire.data.max_tokens;
  if ('enabled' in wire.data) return 0;
  const descriptor = resolveModel(node.model);
  if (descriptor === undefined) return 0;
  return reasoningBudgetForWire(reasoningPlanModelFrom(descriptor), wire.data);
}

/**
 * Clones a turn definition with a new answer output-token cap on every ANSWER
 * node — the sizing probe's single mutation point, shared by the single-model,
 * multi-model, and Smart Model turns. Only the `maxOutputTokens` param changes;
 * every other node field and the definition's storage stamp are preserved, so
 * the probe prices exactly the run that will be admitted. A media turn (whose
 * modelCall nodes carry generation params, never an output-token cap) is never
 * fit — the fit runs only for the text single/multi and Smart turns.
 *
 * Which nodes those are is a question about the graph, not about the node type:
 * a turn's classifier is a `modelCall` too, and carries its own cap. See
 * {@link isAnswerNode}.
 *
 * The shared money-derived answer headroom lands on every answer node, but each
 * `modelCall` then CLAMPS it by its own physical room (§Multi-Model 3: a
 * tight-context sibling must not constrain a large-context one). A `smartModel`
 * node has no single model to clamp against — its one cap rides whichever
 * candidate the classifier picks — so its bound arrives already tightened to the
 * narrowest candidate (`sharedAnswerCeiling`).
 */
function withAnswerCap(
  definition: WorkflowDefinition,
  answerTokens: number,
  resolveModel: ModelPricingResolver
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) =>
      isAnswerNode(node, definition.nodes)
        ? {
            ...node,
            params: {
              ...node.params,
              maxOutputTokens: nodeAnswerCap(node, answerTokens, resolveModel),
            },
          }
        : node
    ),
  };
}

/**
 * Whether the shared ANSWER cap applies to this node.
 *
 * The turn's classifier is a `modelCall` and is not an answer node: it carries
 * its own output cap, the one its reserve is priced against, and the shared
 * answer headroom is a far larger number derived from a different question.
 * Overwriting it would let a routing call emit an answer's worth of tokens and
 * would inflate the hold by the difference — so the sweep asks what a node IS
 * rather than only what type it is.
 */
function isAnswerNode(
  node: Node,
  nodes: readonly Node[]
): node is Extract<Node, { type: 'modelCall' | 'smartModel' }> {
  if (node.type === 'smartModel') return true;
  return node.type === 'modelCall' && !isTurnClassifierNode(node, nodes);
}

/**
 * One node's wire cap: its constant reasoning budget B plus the shared answer
 * headroom H, clamped by the node's own physical room. B is 0 on a reasoning-free
 * node, so the cap is the answer tokens alone there.
 */
function nodeAnswerCap(
  node: Node,
  answerTokens: number,
  resolveModel: ModelPricingResolver
): number {
  const requested = answerTokens + nodeReasoningBudgetTokens(node, resolveModel);
  if (node.type !== 'modelCall') return requested;
  // The node's own limits, read through the ONE catalog reader, so a clamp here
  // and a bound derived at build time cannot disagree. An unpriceable model has
  // no room to read — the estimator refuses that definition outright.
  const [pricing] = turnModelPricings([node.model], resolveModel) ?? [];
  if (pricing === undefined) return requested;
  return Math.min(requested, flooredAnswerRoom(pricing, node.promptInputTokens ?? 0));
}

/**
 * Shrinks a persisting turn's answer output-token cap until the CANONICAL
 * admission estimator (`createEstimateRun`) prices the whole definition at or
 * below the payer's spendable funds, returning the fitted definition. Shared by
 * the regular single/multi-model turns and the Smart Model turn — the ONE numeric
 * authority for answer sizing (there is no second turn cost formula).
 *
 * DURABLE COUPLING (do not remove without re-checking `estimate-run.ts`): the
 * supplied `guessCap` is a PHYSICAL bound only — what the models can emit and
 * what the prompt leaves free. It carries no rate, because a rate-bearing guess
 * prices the run a SECOND way, and two independent pricings drift: a cap the
 * payer "can afford" under the guess's own arithmetic could still push
 * admission's ceiling past the allowance (the drift that caused both the
 * Smart-Model and regular-turn 402s). The authoritative cap is
 * therefore whatever the ONE estimator admission uses accepts, which makes
 * "sized-to-fit" provably imply "ceiling ≤ funds" with no second cost formula to
 * keep aligned.
 * CLAMP ORDER, and it differs from the money module's on purpose. §Sharing one
 * budget across siblings solves `T` against the UNCLAMPED summed cost and clamps
 * each sibling afterwards, which is what `getTurnOptions` presents. This fit
 * prices the ALREADY-CLAMPED definition, so a sibling saturating its own room
 * releases its unused budget to the others and the wide sibling receives a
 * longer answer than the presented ceiling. It is bounded by the same spendable
 * figure either way, so the divergence can only lengthen an answer — never admit
 * a send the client refused. Both amounts are pinned, on one fixture, in
 * `turn/ceiling.clamp-order.test.ts`; do not close the gap without reading it.
 *
 * The ceiling is monotonic in the cap, so a binary search returns the largest
 * fitting cap. The search FLOOR is a minimum viable answer
 * (`MINIMUM_OUTPUT_TOKENS`, or the whole physical bound when that is smaller):
 * BILLING §Affordability 6 makes that floor THE minimum, so a shorter answer is
 * not a cheaper option the fit may take. When even the floor over-reserves the
 * definition carries it anyway and `withinFunds` is false — the caller's own gate
 * refuses (admission's balance gate on a paid turn, the per-message ceiling on a
 * trial one) rather than any silent under-reserve.
 *
 * REASONING TURNS: the searched cap is the ANSWER headroom H; each answer
 * node's wire cap is its own reasoning budget B plus H (`withAnswerCap`
 * re-derives B from the node's `reasoning` param through the shared plan). B
 * is a CONSTANT term — the level was the client's explicit ask, so the
 * fit never shrinks the thinking budget, only the answer — and the admission
 * estimator therefore prices the output leg at exactly B + H.
 */
interface AnswerCapFit {
  /**
   * The definition carrying the cap that was PRICED. Returning the priced one is
   * load-bearing: pricing one definition and returning another is only sound
   * while every caller happens to have built with the same cap, and it fails in
   * the under-reserving direction the moment a definition carries an uncapped
   * `modelCall`.
   */
  readonly definition: WorkflowDefinition;
  /** The answer-token headroom the returned definition is capped at. */
  readonly answerTokens: number;
  /** Whether the estimator prices that cap within the payer's funds. */
  readonly withinFunds: boolean;
}

export function fitAnswerCapToCeiling(
  definition: WorkflowDefinition,
  resolveModel: ModelPricingResolver,
  guessCap: number,
  spendableNanoUsd: bigint
): AnswerCapFit {
  const estimate = createEstimateRun(resolveModel);
  const fits = (cap: number): boolean => {
    const priced = estimate(withAnswerCap(definition, cap, resolveModel));
    return priced.isOk() && priced.value.totalNanoUsd <= spendableNanoUsd;
  };
  const at = (answerTokens: number, withinFunds: boolean): AnswerCapFit => ({
    definition: withAnswerCap(definition, answerTokens, resolveModel),
    answerTokens,
    withinFunds,
  });
  if (fits(guessCap)) return at(guessCap, true);
  const floor = Math.min(MINIMUM_OUTPUT_TOKENS, guessCap);
  if (!fits(floor)) return at(floor, false);
  let lo = floor;
  let hi = guessCap;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return at(lo, true);
}

/**
 * The one answer-cap fit of a turn against its payer's funding, searching below
 * `guessCap`, on EVERY tier; none where the turn has no budget or no bound to fit,
 * since there is nothing to price it against.
 *
 * The stamp is deliberately not a condition. A trial turn is quota-gated and
 * unstamped, so leaving it unfit left its wire cap with no money term at all —
 * and trial has no balance gate behind it, which made the physical bound the only
 * bound (measured at 126× the per-message ceiling). Pricing an unstamped
 * definition through the estimator carries no storage term by construction, which
 * is exactly §Math & Terms' `trialTurnCost`: the trial cap comes out storage-free
 * without a second formula computing it.
 */
export function answerFitFor(
  resolveModel: ModelPricingResolver,
  budget: TurnBudget | undefined,
  guessCap: number | undefined
): AnswerFit | undefined {
  if (budget === undefined || guessCap === undefined) return undefined;
  return {
    spendableNanoUsd: payerSpendableNanoUsd(budget),
    fit: (shaped, spendable) => fitAnswerCapToCeiling(shaped, resolveModel, guessCap, spendable),
  };
}

/**
 * The priceable projection of every model of a text turn, or undefined when ANY
 * model is unknown or lacks a plain per-token rate or a context length — no cap
 * is derivable, the param is omitted, and admission's full-context hold keeps
 * the worst case (fail-closed for low balances).
 */
export function turnModelPricings(
  models: readonly string[],
  resolve: ModelPricingResolver
): readonly PriceableModel[] | undefined {
  const pricings: PriceableModel[] = [];
  for (const model of models) {
    const descriptor = resolve(model);
    const priceable = descriptor === undefined ? undefined : priceableModelFrom(descriptor);
    if (priceable === undefined) return undefined;
    pricings.push(priceable);
  }
  return pricings;
}

/**
 * The derived cap as a modelCall `params` fragment: the key is present only
 * when a cap exists (legacy spread `...(safeMaxTokens !== undefined && {…})` —
 * an omitted key means the model's own default).
 */
function maxOutputTokensParams(
  maxOutputTokens: number | undefined
): Readonly<Record<string, unknown>> {
  return maxOutputTokens === undefined ? {} : { maxOutputTokens };
}

/**
 * The resolved level as a node-field fragment, stamped beside — never inside —
 * the params the wire rides in. It travels because the wire is lossy: two rungs
 * whose budgets clamp to one ceiling mint the same `max_tokens`, so the level a
 * generation ran at could not be recovered downstream from what it sent. Absent
 * on a reasoning-free node, which ran at no level at all.
 */
function resolvedEffortField(reasoning: TurnReasoningEntry | undefined): {
  readonly reasoningEffort?: TurnReasoningEntry['effort'];
} {
  return reasoning === undefined ? {} : { reasoningEffort: reasoning.effort };
}

/**
 * One answer node's params fragment. Reasoning-free keeps today's shape (the
 * cap only when derivable). A reasoning node ALWAYS carries an explicit
 * completion cap (unset behavior is undocumented upstream) of B plus the
 * answer headroom; an underivable headroom falls back to the minimum answer
 * allocation, a cap admission then refuses when the payer cannot fund it
 * (mirroring the omitted-cap full-context refusal of the reasoning-free path).
 * The hard-off wire is the exception: B = 0 and no reasoning will run, so its
 * cap is exactly the reasoning-free derivation (present iff derivable — the
 * model default otherwise); the explicit-cap rule governs only calls with a
 * live reasoning budget.
 */
function answerNodeParams(
  answerTokens: number | undefined,
  reasoning: TurnReasoningEntry | undefined
): Readonly<Record<string, unknown>> {
  if (reasoning === undefined) return maxOutputTokensParams(answerTokens);
  if ('enabled' in reasoning.wire) {
    return { ...maxOutputTokensParams(answerTokens), reasoning: reasoning.wire };
  }
  return {
    maxOutputTokens: reasoning.reasoningBudgetTokens + (answerTokens ?? MINIMUM_OUTPUT_TOKENS),
    reasoning: reasoning.wire,
  };
}

interface SingleModelTurnParams {
  readonly model: string;
  readonly nodes: NodeRegistryContext;
  readonly constraints: ReturnType<typeof createConstraintRegistry>;
  /**
   * The turn's policy hooks. Defaults to the paid chat policy; the trial route
   * passes `TRIAL_TURN_HOOKS` to run the SAME single-model turn under the
   * no-persist / no-charge policy — one pipeline, two policies.
   */
  readonly hooks?: PolicyHooks;
  /** When true the answer node carries the web-search tool + its step ceiling. */
  readonly webSearchEnabled?: boolean;
  /** The rung whose tool loop a searching answer declares; absent is the ceiling loop. */
  readonly loopEffort?: ResolvedReasoningEffort;
  /**
   * The affordable ANSWER output-token cap; omitted = the model's own default
   * (reasoning-free) or the minimum answer allocation (reasoning). With no
   * reasoning the answer cap IS the completion cap; with reasoning the node's
   * wire cap is this plus the entry's constant reasoning budget (B + H).
   */
  readonly maxOutputTokens?: number;
  /** The estimated prompt input-token count, stamped for admission bounding. */
  readonly promptInputTokens?: number;
  /** The turn's resolved reasoning (wire + budget from the shared plan), if any. */
  readonly reasoning?: TurnReasoningEntry;
}

/**
 * The single-model text turn: one `modelCall` node consuming the prompt and
 * producing text. `buildWorkflow` runs the same graph-compile validation the
 * DO re-runs at ingest, so an unknown or mis-priced model is refused at build
 * with a typed error rather than failing mid-run.
 */
export function buildSingleModelTurn(
  params: SingleModelTurnParams
): Result<WorkflowDefinition, DomainError> {
  const inputs = workflowInputs({ [CHAT_TURN_INPUT]: textTag() });
  const answer = modelCall({
    id: CHAT_TURN_NODE_ID,
    model: params.model,
    accepts: textTag(),
    in: inputs.ports[CHAT_TURN_INPUT],
    produces: textTag(),
    params: answerNodeParams(params.maxOutputTokens, params.reasoning),
    ...resolvedEffortField(params.reasoning),
    ...(params.promptInputTokens === undefined
      ? {}
      : { promptInputTokens: params.promptInputTokens }),
    ...(params.webSearchEnabled === true ? webSearchTooling(params.loopEffort) : {}),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: params.hooks ?? CHAT_TURN_HOOKS,
    inputs,
    nodes: [answer],
    registries: { nodes: params.nodes, constraints: params.constraints },
  })
    .map((compiled) => compiled.definition)
    .mapErr((errors) =>
      // The turn shape is fixed; a compile error means the requested model is
      // unknown to the catalog or otherwise unusable — a client-facing 400.
      validationError('chat turn definition could not be compiled', errors)
    );
}

interface MultiModelTurnParams extends TurnSiblings {
  readonly nodes: NodeRegistryContext;
  readonly constraints: ReturnType<typeof createConstraintRegistry>;
  /**
   * Present when the EFFORT axis is open (`auto` with two or more distinct
   * resolved choices): the turn grows a classifier call and the decision
   * reducer, and every sibling takes its level from the answer. Absent keeps
   * the pinned-effort shape exactly as it was.
   */
  readonly classifier?: TurnClassifierParams;
}

/** The sibling node id for the model at `index` — its own charge key and assistant message. */
export function multiModelNodeId(index: number): string {
  return `${CHAT_TURN_NODE_ID}${String(index)}`;
}

/**
 * The multi-model text turn: one `modelCall` answer node per selected model,
 * each producing its own text. A chat turn's flagship fan-out is N *different*
 * models, which the engine's `fanOut` (a single static-model body) cannot
 * express — so it is N static sibling nodes instead. Each is `optional` +
 * `onError: 'skip'`, so one model failing skips its branch (leaving no output,
 * no charge, no message) without terminal-failing the run; the successful
 * subset persists and bills. One model collapses to the single non-optional
 * answer node instead (see {@link multiModelAnswerNodes}), the same width split
 * `buildMediaTurn` makes in `media-turn.ts`.
 *
 * What the answer nodes read depends on whether the effort axis is open: the turn's
 * prompt directly when it is pinned, the decision envelope when it is `auto`
 * (see {@link classifyingMultiModelGraph}). Either way the siblings are the only
 * nodes settlement persists — no reducer joins their outputs, because each
 * originating node's output becomes its own assistant message and the combined
 * text is never persisted. Declaration order is the selected order, which the
 * interpreter preserves, so the last sibling is the fork tip at settlement.
 * `buildWorkflow` runs the same graph-compile the DO re-runs at ingest, so any
 * unknown / unexposed / non-ZDR model is refused at build with a typed error.
 */
export function buildMultiModelTurn(
  params: MultiModelTurnParams
): Result<WorkflowDefinition, DomainError> {
  const built =
    params.classifier === undefined
      ? plainMultiModelGraph(params)
      : classifyingMultiModelGraph(params, params.classifier);
  return buildWorkflow({
    deadlineClass: 'text',
    // Multi-model is a paid-only fan-out (trial is single-model), so the paid
    // chat policy hooks always apply.
    hooks: CHAT_TURN_HOOKS,
    inputs: built.inputs,
    nodes: built.nodes,
    registries: { nodes: params.nodes, constraints: params.constraints },
  })
    .map((compiled) => compiled.definition)
    .mapErr((errors) =>
      validationError('chat multi-model turn definition could not be compiled', errors)
    );
}

/**
 * One sibling's shared options, whatever its input port turns out to be.
 *
 * Typed as the builder's own options MINUS the ports, rather than as a bag of
 * unknowns: `Node` variants are `z.object`, so an unregistered or mistyped key
 * is silently STRIPPED at parse. A wrong `onError` would compile, parse, and
 * default to `'fail'` — turning a skipping sibling into a turn-killer with
 * nothing to see. The type is what refuses that, since no test can assert the
 * absence of a key nobody wrote.
 */
type SiblingOptions = Omit<ModelCallOptions<TypeTag, TextTag>, 'id' | 'accepts' | 'in'>;

/**
 * What one model's answer node carries whatever the turn's WIDTH is — the
 * model, its produced text, its answer params, its resolved effort and its
 * tooling. The failure branch is deliberately absent: a fan-out sibling skips,
 * a collapsed single answer fails the turn, and that is the only field the two
 * shapes disagree on.
 */
function answerOptions(
  params: TurnSiblings,
  model: string
): Omit<SiblingOptions, 'optional' | 'onError'> {
  return {
    model,
    produces: textTag(),
    params: answerNodeParams(params.maxOutputTokens, params.reasoning?.get(model)),
    ...resolvedEffortField(params.reasoning?.get(model)),
    ...(params.promptInputTokens === undefined
      ? {}
      : { promptInputTokens: params.promptInputTokens }),
    ...(params.webSearchEnabled === true ? webSearchTooling(params.loopEffort) : {}),
  };
}

function siblingOptions(params: TurnSiblings, model: string): SiblingOptions {
  return { ...answerOptions(params, model), optional: true, onError: 'skip' };
}

/**
 * The models a turn PINS by name and the shared answer parameters every one of
 * them carries — the multi-model fan-out's own siblings, and the same siblings a
 * Smart slot answers beside.
 */
export interface TurnSiblings {
  readonly models: readonly string[];
  /**
   * The ONE shared ANSWER output-token cap every sibling carries — legacy
   * derived a single value from the summed rates and injected it into every
   * slot. A reasoning sibling's wire cap adds its own per-model reasoning
   * budget on top (B_i + H, one shared H).
   */
  readonly maxOutputTokens?: number;
  /** The estimated prompt input-token count, stamped on every sibling. */
  readonly promptInputTokens?: number;
  /** Per-model resolved reasoning; a model absent from the map runs reasoning-free. */
  readonly reasoning?: TurnReasoningByModel;
  /** When true every sibling carries the web-search tool + its step ceiling. */
  readonly webSearchEnabled?: boolean;
  /** The rung whose tool loop every searching sibling declares; absent is the ceiling loop. */
  readonly loopEffort?: ResolvedReasoningEffort;
}

/**
 * One `modelCall` per pinned model, each reading whatever port its turn's shape
 * hands it — the prompt on a pinned-effort turn, the decision envelope on a
 * classifying one.
 *
 * Written once because the Smart slot's mixed turn emits exactly these nodes
 * beside its slot. A second copy would be a second answer to what a pinned
 * answer node carries, and the fields that differ silently (`onError`, the
 * resolved effort, the web-search tooling) are the ones no test can see missing.
 */
export function turnSiblingNodes<A extends TypeTag>(
  siblings: TurnSiblings,
  accepts: A,
  from: Port<AssignableTag<A>>
): readonly NodeHandle<TextTag>[] {
  return siblings.models.map((model, index) =>
    modelCall({
      id: multiModelNodeId(index),
      accepts,
      in: from,
      ...siblingOptions(siblings, model),
    })
  );
}

/**
 * The multi-model turn's answer nodes: ONE non-optional node under
 * `CHAT_TURN_NODE_ID` for a single model, one optional skip-on-error sibling
 * per model otherwise — the width split `buildMediaTurn` already compiles.
 *
 * A one-wide fan-out is not the single-model turn: it re-keys the charge and
 * the assistant message off the id settlement expects, and it turns a provider
 * failure into a skipped branch that leaves the run with no output at all,
 * where the collapsed node fails with its own error code.
 *
 * The Smart slot's `turnSiblingNodes` deliberately does NOT collapse: its
 * pinned models answer BESIDE the slot, so even one of them is a sibling.
 */
function multiModelAnswerNodes<A extends TypeTag>(
  siblings: TurnSiblings,
  accepts: A,
  from: Port<AssignableTag<A>>
): readonly NodeHandle<TextTag>[] {
  const [only] = siblings.models;
  if (siblings.models.length !== 1 || only === undefined) {
    return turnSiblingNodes(siblings, accepts, from);
  }
  return [
    modelCall({ id: CHAT_TURN_NODE_ID, accepts, in: from, ...answerOptions(siblings, only) }),
  ];
}

/** The pinned-effort shape: every answer node reads the prompt directly. */
function plainMultiModelGraph(params: MultiModelTurnParams): {
  readonly inputs: ReturnType<typeof workflowInputs<{ prompt: ReturnType<typeof textTag> }>>;
  readonly nodes: readonly ReturnType<typeof modelCall>[];
} {
  const inputs = workflowInputs({ [CHAT_TURN_INPUT]: textTag() });
  return { inputs, nodes: multiModelAnswerNodes(params, textTag(), inputs.ports[CHAT_TURN_INPUT]) };
}

/**
 * The `auto`-effort shape: the classifier answers once for the whole turn, the
 * reducer folds its answer into the decision envelope, and every answer node
 * reads that envelope through its ordinary single input port. One call decides
 * for N answers — a per-answer classifier would cost N× the reserve and change
 * who is allowed to send (§Mechanisms rejected).
 *
 * The classifier reads its OWN input rather than the turn's prompt: what it is
 * sent is the truncated excerpt plus the rendered option lines, which is what
 * its reserve prices — the turn's full prompt is neither.
 */
function classifyingMultiModelGraph(
  params: MultiModelTurnParams,
  classifier: TurnClassifierParams
): {
  readonly inputs: ClassifyingInputs;
  readonly nodes: readonly ReturnType<typeof modelCall>[];
} {
  const stage = classifierStage(classifier);
  const answers = multiModelAnswerNodes(
    params,
    jsonTag(TURN_DECISION_SCHEMA_NAME),
    stage.decide.out
  );
  return { inputs: stage.inputs, nodes: [...stage.nodes, ...answers] };
}

/**
 * Builds the turn definition end to end from the request's db: loads the
 * catalog pricing snapshot, derives the shared compile registries from it, and
 * compiles the single-model turn for the requested model. The snapshot read is
 * per-request (the resolver holds no cross-request state) — bounded by the
 * catalog's own size, and it fails closed on an unknown model.
 */
interface TurnDefinitionOptions {
  /** The declared billing/idempotency policy; the paid chat hooks by default. */
  readonly hooks?: PolicyHooks;
  readonly webSearchEnabled?: boolean;
  /** The payer's turn budget for the output-token ceiling; omitted = no cap (trial). */
  readonly budget?: TurnBudget;
  /**
   * The request's reasoning selection, resolved against the model via the ONE
   * shared plan (`resolveTurnReasoning`): an infeasible level refuses the
   * build with a typed 400, a feasible one rides the answer node as its
   * wire config plus a B+H completion cap.
   */
  readonly reasoningEffort?: ReasoningEffortSelection;
  /**
   * The classifier reserve an `auto` turn's menu set aside when one available
   * rung settled it: the turn runs that rung as this pin, sized without it.
   */
  readonly setAsideNanoUsd?: bigint | undefined;
}

/**
 * The answer sizing for a text turn build: the physical upper bound the nodes
 * carry and the answer fit starts from as its guess (one figure — the fit sizes
 * the authoritative cap against the ONE admission estimator).
 *
 * A reasoning turn's searched quantity is the answer headroom H, so its bound is
 * the physical room LESS the constant reasoning budget B, leaving the wire cap
 * B + H. It fails closed when the payer budget or any model's pricing basis is
 * missing — a reasoning call must always carry an explicit, affordably-derived
 * completion cap, so there is no capless reasoning build. On a turn with a
 * budget, any model whose own room cannot hold its B (0 when it does not reason)
 * plus a minimum viable answer refuses the build ({@link starvedAnswerRefusal})
 * rather than any silent effort downgrade. A turn with no budget has no prompt
 * size to measure a room against, and is not refused on its room.
 */
export function turnAnswerSizing(
  models: readonly string[],
  resolve: ModelPricingResolver,
  budget: TurnBudget | undefined,
  reasoning: TurnReasoningByModel
): Result<number | undefined, DomainError> {
  const pricings = budget === undefined ? undefined : turnModelPricings(models, resolve);
  const room =
    budget === undefined || pricings === undefined
      ? undefined
      : physicalAnswerCeiling(budget, pricings);
  if (budget !== undefined && pricings !== undefined) {
    const starved = starvedAnswerRefusal(models, pricings, reasoning, promptInputTokensFor(budget));
    if (starved !== undefined) return err(starved);
  }
  const maxReasoningBudget = Math.max(
    0,
    ...[...reasoning.values()].map((entry) => entry.reasoningBudgetTokens)
  );
  // No entry, or only off entries, reserves no thinking tokens: the answer sizes
  // exactly like a reasoning-free turn (B = 0 ⇒ the cap is H alone), so the
  // hard-off wire never changes what a payer or trial sender could run.
  if (maxReasoningBudget === 0) return ok(room);
  if (budget === undefined) {
    return err(validationError('a reasoning turn requires a payer budget'));
  }
  if (room === undefined) {
    return err(validationError('a reasoning turn requires priceable models'));
  }
  return ok(room - maxReasoningBudget);
}

/**
 * The refusal of the first model whose own room cannot hold its reasoning budget
 * plus a minimum viable answer, the send the composer's admissible pass refuses
 * as `model_output_cap_too_low`; undefined when every model has room. A model
 * with no resolved entry is held to the effort the composer grades an unpinned
 * send at: none or off reserves no budget, and a mandatory-reasoning model
 * reserves its cheapest rung's. Each model is held to its own room, as the
 * composer holds every sibling: the widest room alone would admit a turn whose
 * narrow sibling cannot answer.
 */
function starvedAnswerRefusal(
  models: readonly string[],
  pricings: readonly PriceableModel[],
  reasoning: TurnReasoningByModel,
  inputTokens: number
): DomainError | undefined {
  for (const [index, model] of models.entries()) {
    const pricing = pricings[index];
    /* v8 ignore next -- `pricings` holds one projection per model, so it is never short */
    if (pricing === undefined) continue;
    const effort = reasoning.get(model)?.effort ?? unpinnedEffortOf(pricing);
    if (effortFitsAnswerRoom(pricing, effort, inputTokens)) continue;
    return validationError(
      effort === undefined
        ? `model_output_cap_too_low: model '${model}' has no room for a minimum answer`
        : `model_output_cap_too_low: reasoning effort '${effort}' leaves model '${model}' no room for a minimum answer`
    );
  }
  return undefined;
}

export function buildTurnDefinition(
  deps: { readonly db: Database; readonly telemetry: Telemetry },
  model: string,
  options: TurnDefinitionOptions = {}
): ResultAsync<WorkflowDefinition, DomainError> {
  return createModelPricingResolver({ db: deps.db, telemetry: deps.telemetry }).andThen(
    (pricingResolver) => compileSingleTurn(pricingResolver, model, options)
  );
}

/**
 * The synchronous compile of a single-model turn against a loaded pricing snapshot.
 * Exported as the sizing seam: the answer-cap sweep prices exactly the definition
 * a request compiles, so nothing re-derives the build's own sizing to test it.
 */
export function compileSingleTurn(
  pricingResolver: ModelPricingResolver,
  model: string,
  options: TurnDefinitionOptions
): Result<WorkflowDefinition, DomainError> {
  return compileFittedSingleTurn(pricingResolver, model, options).map(
    (fitted) => fitted.definition
  );
}

/** {@link compileSingleTurn}, with whether its answer fit landed within the funding. */
export function compileFittedSingleTurn(
  pricingResolver: ModelPricingResolver,
  model: string,
  options: TurnDefinitionOptions
): Result<FittedTurn, DomainError> {
  const webSearchEnabled = options.webSearchEnabled === true;
  const registries = createTurnCompileRegistries(pricingResolver);
  const promptInputTokens =
    options.budget === undefined ? undefined : promptInputTokensFor(options.budget);
  const reasoning = resolveTurnReasoning([model], pricingResolver, options.reasoningEffort);
  if (reasoning.isErr()) return err(reasoning.error);
  const sized = turnAnswerSizing([model], pricingResolver, options.budget, reasoning.value);
  if (sized.isErr()) return err(sized.error);
  const answerCap = sized.value;
  const entry = reasoning.value.get(model);
  // This compile buys no classifier, so under `auto` the rung the model resolved
  // to, if any, is the one its loop runs at; a pin or no selection names its own.
  const loopEffort = options.reasoningEffort === 'auto' ? entry?.effort : options.reasoningEffort;
  return (
    assertWebSearchCapable(pricingResolver(model), webSearchEnabled)
      .andThen(() =>
        buildSingleModelTurn({
          model,
          nodes: registries.nodes,
          constraints: registries.constraints,
          webSearchEnabled,
          ...(loopEffort === undefined ? {} : { loopEffort }),
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
          ...(answerCap === undefined ? {} : { maxOutputTokens: answerCap }),
          ...(promptInputTokens === undefined ? {} : { promptInputTokens }),
          ...(entry === undefined ? {} : { reasoning: entry }),
        })
      )
      .map((definition) =>
        withStorageStamp(definition, options.budget, options.hooks ?? CHAT_TURN_HOOKS)
      )
      // The per-rate answer sizing is only an upper-bound guess; the ONE
      // canonical estimator sizes the authoritative cap, so a persisting turn's
      // admission ceiling fits the payer's funds by construction.
      .map((stamped) =>
        sizedTurnAnswers(stamped, answerFitFor(pricingResolver, options.budget, answerCap), {
          shapeAt: atLoop,
          setAsideNanoUsd: options.setAsideNanoUsd,
        })
      )
  );
}

interface MultiModelTurnDefinitionOptions {
  /**
   * The exposed catalog snapshot the classifier engine is picked from — the
   * SAME snapshot the pricing resolver reads, so the engine and the sizing can
   * never come from two different reads.
   *
   * ABSENT IS AN EMPTY CATALOG, NOT AN OPT-OUT. A classifiable `auto` turn —
   * two or more presented rungs — then finds no priceable engine and is
   * REFUSED with the typed classifier code, exactly as it would be against a
   * real catalog holding no priceable text model (§Reasoning Effort 5(d)). A
   * turn with a pinned effort, or with fewer than two rungs, never asks and is
   * unaffected.
   *
   * That is deliberate and is the fail-closed direction: if omission quietly
   * meant "do not classify", a caller that forgot to pass the snapshot would
   * ship silently unclassified `auto` turns — the exact regression this path
   * exists to remove, and invisible. A caller that genuinely wants an
   * unclassified turn says so by not selecting `auto`, which is a statement
   * about the turn rather than about an argument it left out.
   *
   * Both arms are pinned; the sentence above is checkable, not a promise.
   */
  readonly catalog?: readonly ModelDescriptor[];
  readonly webSearchEnabled?: boolean;
  /** payer's turn budget for the shared output-token ceiling; omitted = no cap. */
  readonly budget?: TurnBudget;
  /** The request's reasoning selection, applied to every sibling (see {@link TurnDefinitionOptions}). */
  readonly reasoningEffort?: ReasoningEffortSelection;
  /**
   * The instant the classifier's menu is graded at: the pool's premium reading
   * is measured from it. A classifying `auto` turn with a budget refuses to
   * compile without it rather than grading the menu at an invented instant.
   */
  readonly nowMs?: number;
}

/**
 * Builds the multi-model turn end to end from the request's db, mirroring
 * `buildTurnDefinition`: one catalog snapshot read feeds the compile registries,
 * and `buildMultiModelTurn` compiles one sibling per selected model. Every model
 * is validated against the exposed catalog (unknown / unexposed / non-ZDR are
 * absent from the snapshot), so any bad model in the list fails the build closed.
 */
export function buildMultiModelTurnDefinition(
  deps: { readonly db: Database; readonly telemetry: Telemetry },
  models: readonly string[],
  options: Omit<MultiModelTurnDefinitionOptions, 'catalog' | 'nowMs'> & {
    /** The instant the send arrived, which the classifier's menu is graded at. */
    readonly now: Date;
  }
): ResultAsync<MultiModelTurnOutcome, DomainError> {
  const { now, ...compile } = options;
  // The LIST, not just a resolver: the classifier engine is the cheapest
  // priceable model in the exposed catalog, which is a question about the whole
  // snapshot. Both the engine pick and the per-model sizing then read that one
  // snapshot, so compile and runtime cannot diverge.
  return listDescriptors({ db: deps.db, telemetry: deps.telemetry }).andThen((catalog) =>
    compileMultiModelTurnOutcome(snapshotResolver(catalog), models, {
      ...compile,
      catalog,
      nowMs: now.getTime(),
    })
  );
}

/**
 * A compiled turn — multi-model or Smart Model slot: the definition, plus the
 * classifier's own prompt when the turn classifies.
 *
 * The prompt travels beside the definition rather than inside it because it is
 * two halves with different natures. The half built here — the marker, the
 * option lines, the answer instruction — is content-free and derived from the
 * catalog this compile already read. The other half is the conversation
 * excerpt, which only the send path holds, and content never enters a
 * definition. The send path joins them.
 */
export interface MultiModelTurnBuild {
  readonly definition: WorkflowDefinition;
  /** Absent when the turn classifies nothing — there is no call to prompt. */
  readonly classifier?: TurnClassifierPrompt;
}

/**
 * The run's workflow inputs for a compiled turn.
 *
 * A turn that classifies declares TWO further text inputs, and this is where the
 * prompt's two halves meet: the content-free template the compile rendered (the
 * marker, the turn's own effort options, the answer instruction) joined to the
 * conversation excerpt, truncated to the budget the classifier reserve prices.
 * The excerpt is content, so it never enters the definition; the option lines
 * are identifiers and labels, so they are not content and the compile can
 * render them. The third input carries the turn's decision domain on to the
 * reducer: the effort options the prompt presented and the candidates the
 * turn's Smart Model slot may bind, against which it resolves the answer.
 */
export function turnInputs(
  build: MultiModelTurnBuild,
  userMessage: string,
  history: readonly ChatHistoryMessage[]
): FlowInputs {
  const prompt = { [CHAT_TURN_INPUT]: { kind: 'text' as const, text: userMessage } };
  const classifier = build.classifier;
  if (classifier === undefined) return prompt;
  return {
    ...prompt,
    [CHAT_CLASSIFIER_INPUT]: {
      kind: 'text' as const,
      text: `${classifier.prompt}\n\n${truncateForClassifier({
        latestUserMessage: userMessage,
        latestAssistantMessage: latestAssistantMessage(history),
      })}`,
    },
    [CHAT_DECISION_DOMAIN_INPUT]: {
      kind: 'text' as const,
      text: decisionDomainInput(classifier.decisionDomain),
    },
  };
}

/** The last assistant turn in the resent history, or '' on a first turn. */
function latestAssistantMessage(history: readonly ChatHistoryMessage[]): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role === 'assistant') return message.content;
  }
  return '';
}

/**
 * A compiled multi-model turn, or the refusal of an `auto` turn its funding holds
 * no rung of: the paid route answers that one with 402 before a run is claimed,
 * which a {@link DomainError} could not carry.
 */
export type MultiModelTurnOutcome =
  | ({ readonly kind: 'built' } & MultiModelTurnBuild)
  | { readonly kind: 'unaffordable' };

/**
 * The synchronous compile of a multi-model turn against a loaded pricing snapshot
 * (the multi-model half of the sizing seam, beside {@link compileSingleTurn}). An
 * `auto` turn its funding holds no rung of is its own outcome, which the paid
 * route refuses with 402.
 */
export function compileMultiModelTurnOutcome(
  pricingResolver: ModelPricingResolver,
  models: readonly string[],
  options: MultiModelTurnDefinitionOptions
): Result<MultiModelTurnOutcome, DomainError> {
  const webSearchEnabled = options.webSearchEnabled === true;
  const plan = turnEffortPlan(models, pricingResolver, {
    selection: options.reasoningEffort,
    catalog: options.catalog ?? [],
    webSearch: webSearchEnabled,
    funding: options.budget === undefined ? undefined : menuFundingOf(options.budget),
    nowMs: options.nowMs,
  });
  if (plan.isErr()) return err(plan.error);
  if (plan.value.kind === 'unaffordable') return ok({ kind: 'unaffordable' });
  const { loopEffort, perRung, settled } = plan.value;
  const registries = createTurnCompileRegistries(pricingResolver);
  const promptInputTokens =
    options.budget === undefined ? undefined : promptInputTokensFor(options.budget);
  // A settled axis runs its one rung, resolved exactly as a pin at that rung is.
  const reasoning = resolveTurnReasoning(
    models,
    pricingResolver,
    settled?.effort ?? options.reasoningEffort
  );
  if (reasoning.isErr()) return err(reasoning.error);
  const sized = turnAnswerSizing(models, pricingResolver, options.budget, reasoning.value);
  if (sized.isErr()) return err(sized.error);
  const answerCap = sized.value;
  const classified = effortClassifier(plan.value.classifier);
  return (
    assertModelsWebSearchCapable(models, pricingResolver, webSearchEnabled)
      .andThen(() =>
        buildMultiModelTurn({
          models,
          nodes: registries.nodes,
          constraints: registries.constraints,
          webSearchEnabled,
          ...(loopEffort === undefined ? {} : { loopEffort }),
          ...(answerCap === undefined ? {} : { maxOutputTokens: answerCap }),
          ...(promptInputTokens === undefined ? {} : { promptInputTokens }),
          ...(reasoning.value.size === 0 ? {} : { reasoning: reasoning.value }),
          ...(classified === null ? {} : { classifier: classified.params }),
        })
      )
      // A multi-model turn is paid-only and always uses the persisting chat hooks.
      .map((definition) => withStorageStamp(definition, options.budget, CHAT_TURN_HOOKS))
      // The per-rate answer sizing is only an upper-bound guess; the ONE
      // canonical estimator sizes the authoritative shared sibling cap, so the
      // admission ceiling fits the payer's funds by construction.
      .map(
        (stamped) =>
          sizedTurnAnswers(stamped, answerFitFor(pricingResolver, options.budget, answerCap), {
            shapeAt: atLoop,
            perRung,
            setAsideNanoUsd: settled?.setAsideNanoUsd,
          }).definition
      )
      .map(
        (definition): MultiModelTurnOutcome => ({
          kind: 'built',
          definition,
          ...(classified === null ? {} : { classifier: classified }),
        })
      )
  );
}

/**
 * The trial route's reasoning acceptance: a trial send may run only
 * effort levels whose cost fits the fixed trial ceiling — decided by
 * COMPILE-THEN-PRICE through the same canonical estimator every other money
 * decision uses, never a second cost formula and never a hardcoded level list.
 * An explicit level that does not fit is refused (`accepted: false` → the trial's
 * over-cap 402); `none` passes through so the build owns the mandatory-reasoning
 * refusal.
 *
 * `auto` is deliberately outside this function's domain, and the parameter type
 * enforces it. An auto trial turn goes to the classifier, exactly as a paid one
 * does — the trial arm's compiler answers it, and its deterministic
 * single-choice case is the shared `resolveTurnReasoning` resolution the paid
 * path already uses. Resolving auto here could only mean choosing a level with
 * no classifier, which §Reasoning Effort 5 forbids by name.
 */
type TrialReasoningDecision =
  | { readonly accepted: true; readonly selection: ReasoningEffortSelection | undefined }
  | { readonly accepted: false };

/**
 * Whether one reasoning level's smallest useful trial turn fits the per-message
 * ceiling: compile the turn at that level, price it UNSTAMPED (a trial turn
 * persists nothing, so §Trial Usage gives it no storage term — the unstamped
 * definition carries none by construction), and ask whether `B + a minimum viable
 * answer` is within the ceiling.
 *
 * The build has to happen before the price because there is nothing else to price;
 * that ordering is what lets this decision share `createEstimateRun` with every
 * other money decision instead of re-deriving a cost from rates.
 */
function trialLevelFits(
  descriptor: ModelDescriptor,
  budget: TurnBudget,
  entry: TurnReasoningEntry
): boolean {
  const resolve: ModelPricingResolver = () => descriptor;
  const registries = createTurnCompileRegistries(resolve);
  const built = buildSingleModelTurn({
    model: descriptor.id,
    nodes: registries.nodes,
    constraints: registries.constraints,
    hooks: TRIAL_TURN_HOOKS,
    promptInputTokens: promptInputTokensFor(budget),
    reasoning: entry,
    maxOutputTokens: MINIMUM_OUTPUT_TOKENS,
  });
  /* v8 ignore next -- the descriptor resolves by construction (it IS the
     resolver), so the graph compile cannot fail on an unknown model here */
  if (built.isErr()) return false;
  return fitAnswerCapToCeiling(
    built.value,
    resolve,
    MINIMUM_OUTPUT_TOKENS,
    payerSpendableNanoUsd(budget)
  ).withinFunds;
}

export function trialReasoningSelection(
  descriptor: ModelDescriptor,
  budget: TurnBudget,
  selection: Exclude<ReasoningEffortSelection, 'auto'>
): Result<TrialReasoningDecision, DomainError> {
  if (selection === 'off') return ok({ accepted: true, selection });
  return requiredReasoningEntryFor(descriptor, selection).map((entry) =>
    trialLevelFits(descriptor, budget, entry) ? { accepted: true, selection } : { accepted: false }
  );
}

interface TurnClassifierInput {
  /** The cheapest priceable engine-text model — the classifier engine. */
  readonly engineId: string;
  /**
   * The candidates the prompt names; empty closes the model axis. Each may
   * carry its own effort ceiling — the highest rung its funding holds, which
   * the derivation publishes per candidate rather than this layer deriving.
   */
  readonly promptedModels: readonly {
    readonly id: string;
    readonly description?: string;
    readonly effortCeiling?: string;
  }[];
  /** The effort options the prompt presents; empty closes the effort axis. */
  readonly effortOptions: readonly DimensionOption[];
  /**
   * The candidates of the turn's Smart Model slot, the array its node is built
   * from, whichever axes the prompt opens: the decision binds one of them.
   * Absent on a turn with no slot.
   */
  readonly slotCandidates?: Parameters<typeof decisionDomainFor>[1];
}

/**
 * The classifier's node params and its rendered prompt, from the one template
 * `computeClassifierPromptOverhead` in
 * `packages/shared/src/affordability/smart-model/prompts.ts` prices. Rendering
 * through any second composer would produce a prompt the reserve does not
 * cover.
 */
export function turnClassifier(input: TurnClassifierInput): TurnClassifier {
  const classifyEffort = input.effortOptions.length > 0;
  return {
    params: {
      modelId: input.engineId,
      promptInputTokens: inputTokensOf(classifierReserveChars(input.promptedModels)),
    },
    prompt: buildClassifierSystemPrompt({
      ...(input.promptedModels.length === 0
        ? {}
        : {
            eligibleModels: input.promptedModels.map((model) => ({
              id: model.id,
              description: model.description ?? '',
              // A ceiling answers the effort question, so it is presented only
              // when the prompt asks it: a pinned-effort turn carries no effort
              // labels (§Story 1.4). The reserve prices the annotated render
              // either way, so suppressing it can only leave slack.
              ...(classifyEffort && model.effortCeiling !== undefined
                ? { effortCeiling: model.effortCeiling }
                : {}),
            })),
          }),
      ...(classifyEffort ? { classifyEffort: true, effortOptions: input.effortOptions } : {}),
    }),
    decisionDomain: decisionDomainFor(input.effortOptions, input.slotCandidates ?? []),
  };
}

/**
 * The effort-only classifier of a turn whose models were pinned. Its model axis
 * is CLOSED, since the user pinned the models, so its prompt names none, and the
 * shared builder prices its reserve against the same empty list.
 */
function effortClassifier(plan: EffortClassifierPlan | null): TurnClassifier | null {
  return plan === null ? null : turnClassifier({ ...plan, promptedModels: [] });
}
