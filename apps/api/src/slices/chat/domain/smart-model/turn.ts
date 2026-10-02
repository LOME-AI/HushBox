import {
  REASONING_OFF,
  REASONING_OFF_WIRE,
  candidateAnsweringAt,
  jsonTag,
  smartModelClassifierDimensions,
  textTag,
} from '@hushbox/shared';
import {
  TURN_DECISION_SCHEMA_NAME,
  buildWorkflow,
  smartModel,
  workflowInputs,
} from '../../../workflows/index.js';
import {
  buildSmartModelCandidates,
  buildTrialSmartModelCandidates,
  listDescriptors,
  snapshotResolver,
} from '../../../models/index.js';
import { readBalance } from '../../../billing/index.js';
import { err, errAsync, ok, okAsync } from '../../../../lib/result/index.js';
import { validationError } from '../../../../lib/errors/index.js';
import {
  CHAT_TURN_HOOKS,
  CHAT_TURN_INPUT,
  CHAT_TURN_NODE_ID,
  TRIAL_TURN_HOOKS,
} from '../constants.js';
import {
  answerFitFor,
  assertModelsWebSearchCapable,
  compileFittedSingleTurn,
  createTurnCompileRegistries,
  menuFundingOf,
  payerSpendableNanoUsd,
  promptInputTokensFor,
  sharedAnswerCeiling,
  tierForFunding,
  turnAnswerSizing,
  turnClassifier,
  turnModelPricings,
  turnSiblingNodes,
  withStorageStamp,
} from '../turn/definition.js';
import { classifierStage, turnClassifies, turnEffortPlan } from '../turn/classifier.js';
import { resolveTurnReasoning } from '../turn/reasoning.js';
import { atLoop, effortRungsOf, settledRungOf, sizedTurnAnswers } from '../turn/rung-ceilings.js';
import type { MultiModelTurnBuild, TurnBudget, TurnSiblings } from '../turn/definition.js';
import type {
  EffortClassifierPlan,
  MenuFunding,
  TurnClassifierPrompt,
} from '../turn/classifier.js';
import type { FittedTurn, RungPlan } from '../turn/rung-ceilings.js';
import type { createConstraintRegistry, NodeRegistryContext } from '../../../workflows/index.js';
import type { SmartModelCandidateEntry, SmartModelCandidates } from '../../../models/index.js';
import type { BillingStores } from '../../../billing/index.js';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result, ResultAsync } from '../../../../lib/result/index.js';
import type {
  AssignableTag,
  NodeHandle,
  Port,
  WorkflowInputsHandle,
} from '../../../workflows/index.js';
import type {
  CanonicalReasoningEffort,
  DimensionOption,
  ReasoningEffortSelection,
  ModelDescriptor,
  Node,
  PolicyHooks,
  ResolvedReasoningEffort,
  TextTag,
  TypeTag,
  UserTier,
  WorkflowDefinition,
} from '@hushbox/shared';

type SmartModelNode = Extract<Node, { type: 'smartModel' }>;

/**
 * The Smart Model turn: a composite `smartModel` slot on the same executor,
 * hooks, and settlement as every other paid turn, preceded by the turn's
 * classifier call whenever a dimension is open. The candidate list is
 * derived here — the payer's affordable text models, graded at the level the
 * send pinned when it pinned one — rather than taken from the request, so no
 * part of it reaches the request body hash.
 */

interface SmartModelTurnParams {
  readonly classifierModelId: string;
  readonly candidates: readonly SmartModelCandidateEntry[];
  /**
   * The classifier dimensions to request. Absent = the legacy Smart
   * Model shape (model routing only).
   */
  readonly classify?: { readonly model: boolean; readonly effort: boolean };
  /**
   * The effort options this turn PRESENTS, when the effort axis is open. They
   * are the classifier's option lines and the reducer's resolution domain, so
   * an open axis with none presented simply asks nothing about effort.
   */
  readonly effortOptions?: readonly DimensionOption[];
  /**
   * The level the sender pinned, stamped on the slot so the execution applies
   * it to whichever candidate binds. Mutually exclusive with an open effort
   * axis: a pin is that axis's answer, so nothing is left to classify.
   */
  readonly pinnedEffort?: CanonicalReasoningEffort;
  /** The declared billing/idempotency policy; the paid chat hooks by default. */
  readonly hooks?: PolicyHooks;
  /**
   * The affordable output-token ceiling for the ANSWER generation, carried as
   * the node's params. Omitted = the answering model's own default.
   */
  readonly answerCapTokens?: number;
  /** The estimated prompt input-token count, stamped for the candidate answer
   * legs' admission bounding (the classifier reserve is truncated-context). */
  readonly promptInputTokens?: number;
  /**
   * True when the send selected `none`: the node params carry the explicit
   * `{ enabled: false }` wire (the hard-off ruling — never parameter
   * omission, so a `default_enabled` candidate truly stops reasoning). The
   * wire is shared node data; the execution applies it per resolved
   * candidate — a mandatory-reasoning candidate keeps reasoning (it cannot
   * disable, and one candidate cannot refuse the whole server-picked
   * composite) and a non-reasoning candidate has nothing to turn off, so
   * both drop it at the answer call. B = 0; the cap sizing is unchanged.
   */
  readonly reasoningOff?: boolean;
  /**
   * The models the SAME turn pinned by name, each answering beside the slot as
   * its own node. Empty is the slot-only turn.
   *
   * They are disjoint from {@link candidates} by construction — the producer
   * removes them — so the slot can never resolve onto a sibling and no answer
   * is priced or billed twice.
   */
  readonly siblings?: TurnSiblings;
  /**
   * Where the slot sits in the client's selected order. Node declaration order
   * IS the selected order: it decides which answer is the fork tip at
   * settlement, so a slot the user put last must not be emitted first.
   */
  readonly slotPosition?: number;
  readonly nodes: NodeRegistryContext;
  readonly constraints: ReturnType<typeof createConstraintRegistry>;
}

/**
 * The turn's answer nodes in the client's selected order: the siblings, with
 * the slot spliced in at the position the selection put it.
 */
function inSelectedOrder(
  slot: NodeHandle<TextTag>,
  siblings: readonly NodeHandle<TextTag>[],
  slotPosition: number
): readonly NodeHandle<TextTag>[] {
  return [...siblings.slice(0, slotPosition), slot, ...siblings.slice(slotPosition)];
}

/**
 * The payer's Smart Model funding: the spendable figure the funding decision
 * FROZE for this turn — the same figure the ceiling solve and the admission gate
 * consult, so the affordable-subset gate cannot admit a subset the client denies
 * (or refuse one it accepts). A purchased payer's figure carries the wallet's
 * $0.50 cushion, applied once at the freeze; a group payer's is a min of the
 * owner's spendable funds and both group caps, which no cushion may lift.
 * The budget-less defensive build falls back to the sender wallet's purchased
 * balance (no budget ⇒ no frozen figure to read). Re-deriving the figure here
 * (the prior bug) disagreed with the freeze in both directions.
 */
export function smartModelEffectiveBalanceNanoUsd(
  budget: TurnBudget | undefined,
  purchasedNanoUsd: bigint
): bigint {
  return budget === undefined ? purchasedNanoUsd : payerSpendableNanoUsd(budget);
}

/**
 * Who the candidate menu is drawn FOR: the payer's tier and the prompt they are
 * sending. Both come off the frozen budget, so the menu, the ceiling solve and
 * admission price the same payer sending the same prompt.
 *
 * The budget-less defensive build has neither, and inventing a paid payer there
 * would offer premium rows to a caller no funding decision ever placed. It reads
 * as the free tier with no prompt: the conservative corner on the leg the tier
 * fixes — premium rows withheld. No production path reaches it; the route
 * always freezes a budget first.
 */
function smartModelPayerFacts(budget: TurnBudget | undefined): {
  readonly tier: UserTier;
  readonly promptChars: number;
  readonly inputChars: number;
} {
  if (budget === undefined) return { tier: 'free', promptChars: 0, inputChars: 0 };
  return {
    tier: tierForFunding(budget.funding),
    promptChars: budget.promptCharacterCount,
    inputChars: budget.inputCharacterCount,
  };
}

/**
 * The compiled classifier prompt, spread only when the turn grew a classifier.
 * One shape for every arm, so no caller can carry the definition on without it.
 */
function classifierField(built: {
  readonly classifier?: TurnClassifierPrompt;
}): Pick<MultiModelTurnBuild, 'classifier'> {
  return built.classifier === undefined ? {} : { classifier: built.classifier };
}

/**
 * The Smart Model definition. The slot classifies nothing itself, so a turn with
 * an open dimension grows the same classify → decide stage the multi-model graph
 * grows, and the slot consumes the decision envelope it produces — which is what
 * makes the classifier reserve pay for a call that actually happens.
 *
 * A slot with no open dimension (one candidate, effort pinned) stays one node:
 * there is nothing to classify, the estimator holds no reserve for it, and
 * buying a call anyway would bill for a question already answered.
 *
 * Compile fails closed on any bad model.
 */
export function buildSmartModelTurn(
  params: SmartModelTurnParams
): Result<MultiModelTurnBuild, DomainError> {
  const built = smartModelGraph(params);
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: params.hooks ?? CHAT_TURN_HOOKS,
    inputs: built.inputs,
    nodes: built.nodes,
    registries: { nodes: params.nodes, constraints: params.constraints },
  })
    .map((compiled) => ({ definition: compiled.definition, ...classifierField(built) }))
    .mapErr((errors) =>
      validationError('chat smart-model turn definition could not be compiled', errors)
    );
}

/** The answer call's shared parameters: the affordable cap and the hard-off wire.
 * The off wire is the shared module's minted value — the branded wire type cannot
 * be hand-written here, so the shape can never drift from `planReasoningOff`'s
 * output. */
function answerNodeParams(params: SmartModelTurnParams): Record<string, unknown> {
  return {
    ...(params.answerCapTokens === undefined ? {} : { maxOutputTokens: params.answerCapTokens }),
    ...(params.reasoningOff === true ? { reasoning: REASONING_OFF_WIRE } : {}),
  };
}

/**
 * The slot's graph: one node when nothing is classified, and the classify →
 * decide → slot chain when something is.
 *
 * Which dimensions are open is asked of {@link smartModelClassifierDimensions},
 * the one authority the admission estimate and the node execution also read —
 * so the reserve, the call and the answer cannot come to disagree about whether
 * a classification happened. It takes a built node, which is why the slot is
 * built for the plain shape first and rebuilt against the envelope when the
 * answer comes back open.
 */
function smartModelGraph(params: SmartModelTurnParams): {
  readonly inputs: WorkflowInputsHandle<Readonly<Record<string, TypeTag>>>;
  readonly nodes: readonly NodeHandle[];
  readonly classifier?: TurnClassifierPrompt;
} {
  const siblings = params.siblings ?? { models: [] };
  const slotPosition = params.slotPosition ?? 0;
  const plainInputs = workflowInputs({ [CHAT_TURN_INPUT]: textTag() });
  const plain = smartModelNode(params, textTag(), plainInputs.ports[CHAT_TURN_INPUT]);
  // The handle was just minted by the slot builder, so its node parsed under the
  // `smartModel` literal — narrowing it any other way would add an arm no input
  // can reach.
  const dimensions = smartModelClassifierDimensions(plain.node as SmartModelNode);
  if (!dimensions.model && !dimensions.effort) {
    const pinned = turnSiblingNodes(siblings, textTag(), plainInputs.ports[CHAT_TURN_INPUT]);
    return { inputs: plainInputs, nodes: inSelectedOrder(plain, pinned, slotPosition) };
  }
  const classifier = turnClassifier({
    engineId: params.classifierModelId,
    // The prompt names the candidates only when the MODEL axis is open, and the
    // reserve is priced against that same list — the estimator's own rule.
    promptedModels: dimensions.model ? params.candidates : [],
    effortOptions: dimensions.effort ? (params.effortOptions ?? []) : [],
    // The decision binds one of the slot's candidates, so its domain is built
    // from the very array the slot node carries.
    slotCandidates: params.candidates,
  });
  const stage = classifierStage(classifier.params);
  const slot = smartModelNode(params, jsonTag(TURN_DECISION_SCHEMA_NAME), stage.decide.out);
  // The siblings read the SAME decision the slot reads WHEN the effort axis is
  // open — one classifier call answers for the whole turn, and a second stage
  // would double the reserve for a question already asked.
  //
  // With that axis closed they read the prompt instead, exactly as they do in a
  // pinned-effort fan-out. The stage still exists here (the MODEL axis opened
  // it), but its envelope then carries an effort nothing asked for — the schema
  // needs a value and mints the axis's cheapest — and a sibling reading it would
  // have that level applied at execution. Wire silence is an absence, not an
  // instruction.
  const pinned = dimensions.effort
    ? turnSiblingNodes(siblings, jsonTag(TURN_DECISION_SCHEMA_NAME), stage.decide.out)
    : turnSiblingNodes(siblings, textTag(), stage.inputs.ports[CHAT_TURN_INPUT]);
  return {
    inputs: stage.inputs,
    nodes: [...stage.nodes, ...inSelectedOrder(slot, pinned, slotPosition)],
    classifier,
  };
}

/** The slot node, reading whatever its turn's shape hands it. */
function smartModelNode<A extends TypeTag>(
  params: SmartModelTurnParams,
  accepts: A,
  from: Port<AssignableTag<A>>
): NodeHandle<TextTag> {
  const answerParams = answerNodeParams(params);
  return smartModel({
    id: CHAT_TURN_NODE_ID,
    classifierModelId: params.classifierModelId,
    candidates: params.candidates,
    ...(params.classify === undefined ? {} : { classify: params.classify }),
    ...(params.pinnedEffort === undefined ? {} : { pinnedEffort: params.pinnedEffort }),
    ...(Object.keys(answerParams).length === 0 ? {} : { params: answerParams }),
    ...(params.promptInputTokens === undefined
      ? {}
      : { promptInputTokens: params.promptInputTokens }),
    accepts,
    in: from,
  });
}

type SmartModelTurnBuild =
  | ({ readonly buildable: true } & MultiModelTurnBuild)
  /** No affordable candidate for this payer — the route refuses the send. */
  | { readonly buildable: false };

interface SmartModelTurnDeps {
  readonly db: Database;
  readonly telemetry: Telemetry;
  /** Billing's published stores — the read-only wallet balance query. */
  readonly billing: BillingStores;
}

/**
 * Compiles the definition from a derived candidate pick over the SAME catalog
 * snapshot the pick was derived from (compile ⟺ runtime never diverge) — the
 * shared tail of the paid and trial builders.
 *
 * Exported as the Smart Model sizing seam, for the same reason the regular turn's
 * compile is: the trial arm's wire cap has to be pinned on the definition a request
 * actually compiles, and reassembling that build in a test would re-derive the
 * sizing it is meant to check.
 */
interface CompileSmartModelOptions {
  readonly hooks?: PolicyHooks;
  readonly budget?: TurnBudget;
  readonly classify?: { readonly model: boolean; readonly effort: boolean };
  /** True when the send selected `none` — see {@link SmartModelTurnParams.reasoningOff}. */
  readonly reasoningOff?: boolean;
  /** The level the send pinned — see {@link SmartModelTurnParams.pinnedEffort}. */
  readonly pinnedEffort?: CanonicalReasoningEffort;
  /** The pinned siblings answering beside the slot — see {@link SmartModelTurnParams.siblings}. */
  readonly siblings?: TurnSiblings;
  /** Where the slot sits in the selection — see {@link SmartModelTurnParams.slotPosition}. */
  readonly slotPosition?: number;
}

/**
 * The effort options a slot presents, when its effort axis is open — the
 * classifier's option lines and the reducer's resolution domain. They are the
 * rungs the slot's own menu marks available, so the classifier can decide no
 * rung the turn's funding does not hold.
 */
function slotEffortOptions(
  classify: CompileSmartModelOptions['classify'],
  picked: SmartModelCandidates
): Partial<SmartModelTurnParams> {
  if (classify?.effort !== true) return {};
  return { effortOptions: picked.effortOptions };
}

/**
 * The rung whose tool loop the slot's searching siblings declare: the pin, the
 * hard-off rung when the send turned reasoning off, and otherwise the rung the
 * slot's own menu reads, the one its candidates were graded for.
 */
function siblingLoopEffort(
  picked: SmartModelCandidates,
  options: CompileSmartModelOptions
): ResolvedReasoningEffort | undefined {
  if (options.pinnedEffort !== undefined) return options.pinnedEffort;
  if (options.reasoningOff === true) return 'off';
  return picked.toolLoopEffort;
}

/**
 * The slot turn at one rung's loop, as the estimator prices one decision there:
 * the searching siblings declare that rung's steps, and the slot answers through
 * the candidates that answer at the rung, each as it answers there.
 */
function slotAtRung(
  definition: WorkflowDefinition,
  rung: ResolvedReasoningEffort
): WorkflowDefinition {
  const looped = atLoop(definition, rung);
  return {
    ...looped,
    nodes: looped.nodes.map((node) => {
      if (node.type !== 'smartModel') return node;
      return {
        ...node,
        candidates: node.candidates.flatMap((candidate) => {
          const answering = candidateAnsweringAt(candidate, rung);
          return answering === undefined ? [] : [answering];
        }),
      };
    }),
  };
}

/**
 * The fitted slot turn with every candidate carried as the compile stamped it:
 * a per-rung fit prices the slot at each rung ({@link slotAtRung}), and the
 * candidates keep their own per-rung caps, from the same producer the siblings'
 * fits are graded against.
 */
function withSlotCandidates(
  fitted: WorkflowDefinition,
  stamped: WorkflowDefinition
): WorkflowDefinition {
  return {
    ...fitted,
    nodes: fitted.nodes.map((node) => {
      if (node.type !== 'smartModel') return node;
      const slot = stamped.nodes.find((original) => original.id === node.id);
      return slot?.type === 'smartModel' ? { ...node, candidates: slot.candidates } : node;
    }),
  };
}

/** The effort answer and the slot's position, each spread only when present. */
function effortAndSiblingParams(options: CompileSmartModelOptions): Partial<SmartModelTurnParams> {
  return {
    ...(options.reasoningOff === true ? { reasoningOff: true } : {}),
    ...(options.pinnedEffort === undefined ? {} : { pinnedEffort: options.pinnedEffort }),
    ...(options.slotPosition === undefined ? {} : { slotPosition: options.slotPosition }),
  };
}

/** The optional smartModel turn params, each spread only when present. */
function optionalTurnParams(
  classify: CompileSmartModelOptions['classify'],
  hooks: PolicyHooks | undefined,
  promptInputTokens: number | undefined
): Partial<SmartModelTurnParams> {
  return {
    ...(classify === undefined ? {} : { classify }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(promptInputTokens === undefined ? {} : { promptInputTokens }),
  };
}

export function compileSmartModelBuild(
  catalog: readonly ModelDescriptor[],
  picked: SmartModelCandidates | null,
  options: CompileSmartModelOptions
): ResultAsync<SmartModelTurnBuild, DomainError> {
  const { hooks, budget, classify } = options;
  if (picked === null) return okAsync<SmartModelTurnBuild, DomainError>({ buildable: false });
  const registries = createTurnCompileRegistries(snapshotResolver(catalog));
  // The derivation stamps a PER-CANDIDATE cap on each eligible candidate
  // (`cap(m)`); the node then reserves and runs each at its own cap, so there is
  // NO single node-level answer cap for the answer fit to size.
  //
  // A mixed turn's answer-fit guess is the SIBLINGS' physical bound, because the
  // slot's own cap already rides its candidates. The fit then stamps that bound
  // on every answer node including the slot, where it is inert: a candidate's
  // `maxOutputTokens` overrides the node param in both the estimator and the
  // execution, so the slot still runs at `cap(m)` for whichever model binds. A
  // slot-only turn has no siblings, so it has no guess and the fit reads the
  // definition's own caps ({@link fittedSlotDefinition}).
  const promptInputTokens = budget === undefined ? undefined : promptInputTokensFor(budget);
  const built = buildSmartModelTurn({
    classifierModelId: picked.classifierModelId,
    candidates: picked.candidates,
    ...optionalTurnParams(classify, hooks, promptInputTokens),
    ...slotEffortOptions(classify, picked),
    ...effortAndSiblingParams(options),
    ...siblingsAtLoop(options.siblings, siblingLoopEffort(picked, options)),
    nodes: registries.nodes,
    constraints: registries.constraints,
  });
  /* v8 ignore next -- defensive: candidates are filtered to engine-runnable
     text→text models over the SAME catalog snapshot the compile registries
     read, so a compile failure here means the two derivations drifted — a
     defect path kept fail-closed rather than assumed impossible */
  if (built.isErr()) return errAsync<SmartModelTurnBuild, DomainError>(built.error);
  // A paid Smart turn persists (default chat hooks) and is stamped with the
  // payer's storage context; the trial variant passes TRIAL_TURN_HOOKS and is
  // left unstamped (no-persist → no storage held).
  const stamped = withStorageStamp(built.value.definition, budget, hooks ?? CHAT_TURN_HOOKS);
  return okAsync<SmartModelTurnBuild, DomainError>({
    buildable: true,
    // The guess is only an upper bound; the shared answer fit sizes it against
    // the ONE canonical admission estimator (see `fitAnswerCapToCeiling`).
    definition: fittedSlotDefinition(stamped, snapshotResolver(catalog), picked, options),
    ...classifierField(built.value),
  });
}

/** The slot's searching siblings declaring the loop of `loopEffort`, spread only when present. */
function siblingsAtLoop(
  siblings: TurnSiblings | undefined,
  loopEffort: ResolvedReasoningEffort | undefined
): Partial<SmartModelTurnParams> {
  if (siblings === undefined) return {};
  return { siblings: loopEffort === undefined ? siblings : { ...siblings, loopEffort } };
}

/**
 * The slot definition with its answer caps fitted against the one estimator.
 *
 * A decision can land on any rung the menu offers, so an `auto` slot whose
 * siblings search carries each rung's own ceiling on them; the candidates
 * already carry theirs, from the same producer. A slot its menu settled at one
 * rung with no call left sizes its siblings without the reserve the menu set
 * aside. Every other slot takes the one answer fit, its guess being the
 * siblings' physical bound.
 */
function fittedSlotDefinition(
  stamped: WorkflowDefinition,
  resolveModel: ReturnType<typeof snapshotResolver>,
  picked: SmartModelCandidates,
  options: CompileSmartModelOptions
): WorkflowDefinition {
  const answerFit = answerFitFor(resolveModel, options.budget, options.siblings?.maxOutputTokens);
  const sized = sizedTurnAnswers(stamped, answerFit, {
    shapeAt: slotAtRung,
    perRung: slotRungPlan(picked, options),
    setAsideNanoUsd: picked.setAsideNanoUsd,
  });
  return withSlotCandidates(sized.definition, stamped);
}

/**
 * The rungs an `auto` slot's searching siblings carry a ceiling for, and the loop
 * they declare; a slot whose candidates carry no per-rung caps has none.
 */
function slotRungPlan(
  picked: SmartModelCandidates,
  options: CompileSmartModelOptions
): RungPlan | undefined {
  const loop = siblingLoopEffort(picked, options);
  const perRung =
    options.classify?.effort === true &&
    options.siblings?.webSearchEnabled === true &&
    picked.candidates.some((candidate) => candidate.rungCeilings !== undefined);
  return perRung && loop !== undefined
    ? { loop, rungs: effortRungsOf(picked.effortOptions) }
    : undefined;
}

/**
 * Builds the Smart Model turn end to end for one paid send: derives the
 * affordable candidate list from one exposed-catalog read and compiles the
 * definition over that same snapshot. No affordable candidate yields
 * `buildable: false` — the route refuses the send before admission runs, so
 * the affordability filter is a pre-admission gate for the empty case and
 * must use the PAYER's effective funding (`budget.funding.spendableNanoUsd`:
 * owner wallet ∧ budget remainders for group turns, remaining daily allowance
 * for free tier), not the sender's own purchased balance — a $0-purchased
 * group member or free-tier sender is otherwise wrongly refused (402). The
 * sender-wallet read remains only the defensive fallback for the budget-less
 * path.
 */
export function buildSmartModelTurnDefinition(
  deps: SmartModelTurnDeps,
  args: SmartModelSendArgs & {
    readonly userId: string;
    readonly now: Date;
  }
): ResultAsync<SmartModelTurnBuild, DomainError> {
  return readBalance(deps.billing, deps.db, args.userId, args.now).andThen((balance) =>
    listDescriptors({ db: deps.db, telemetry: deps.telemetry }).andThen((catalog) =>
      compileSmartModelSend(catalog, {
        ...args,
        // The frozen spendable figure — the SAME one admission and the client
        // gate on — never a figure re-derived here (see
        // `smartModelEffectiveBalanceNanoUsd`).
        balanceNanoUsd: smartModelEffectiveBalanceNanoUsd(args.budget, balance.purchasedNanoUsd),
        nowMs: args.now.getTime(),
      })
    )
  );
}

/** What one paid Smart Model send asks of its slot and its pinned siblings. */
interface SmartModelSendArgs {
  /**
   * The payer's turn budget for the ANSWER output-token ceiling; an omitted
   * budget builds without a cap.
   */
  readonly budget?: TurnBudget;
  /**
   * True when the request selected `auto` effort: the slot declares the EFFORT
   * axis open alongside the model axis, so the turn's one classifier answers
   * both and one reserve covers both. Gated on the menu marking two or more
   * effort rungs available: with one, that rung settles the axis; with none, the
   * axis closes.
   */
  readonly classifyEffort?: boolean;
  /** True when the send selected `none` — see {@link SmartModelTurnParams.reasoningOff}. */
  readonly reasoningOff?: boolean;
  /**
   * The level the send pinned. It grades the candidate menu as well as
   * riding the slot: the derivation must run at the rung the answer will
   * run at, or the turn could bind a model that cannot honour it.
   */
  readonly pinnedEffort?: CanonicalReasoningEffort;
  /**
   * The models the same turn pinned by name, in the client's selected order.
   * They become the slot's answering siblings AND the set the candidate menu
   * excludes — one input, so the graph and the menu cannot disagree about who
   * is pinned. Empty is the slot-only turn.
   */
  readonly pinnedModels?: readonly string[];
  /** The slot's index in the selection — see {@link SmartModelTurnParams.slotPosition}. */
  readonly slotPosition?: number;
  /** Opt into the web-search tool loop on the pinned siblings (the slot carries none). */
  readonly webSearchEnabled?: boolean;
}

/**
 * One paid Smart Model send compiled over a catalog snapshot, at the payer's
 * effective funding and the send's instant: the candidate menu, graded at the
 * send's own effort (a Min send is a pin at the off rung), then the slot and its
 * pinned siblings. Exported as the send's sizing seam, so a test prices the
 * definition a request compiles rather than a reassembly of it.
 */
export function compileSmartModelSend(
  catalog: readonly ModelDescriptor[],
  args: SmartModelSendArgs & { readonly balanceNanoUsd: bigint; readonly nowMs: number }
): ResultAsync<SmartModelTurnBuild, DomainError> {
  const pinnedModels = args.pinnedModels ?? [];
  const picked = buildSmartModelCandidates({
    descriptors: catalog,
    balanceNanoUsd: args.balanceNanoUsd,
    pinnedModelIds: pinnedModels,
    // The siblings carry the tool the slot's node cannot, so the menu is
    // graded against funding their search has already taken.
    webSearch: args.webSearchEnabled === true,
    ...smartModelPayerFacts(args.budget),
    nowMs: args.nowMs,
    ...menuEffort(args),
  });
  const effort = settledEffortArgs(args, picked);
  const slotOptions = slotCompileOptions(catalog, picked, effort);
  if (pinnedModels.length === 0) return compileSmartModelBuild(catalog, picked, slotOptions);
  const siblings = turnSiblings(catalog, pinnedModels, effort);
  if (siblings.isErr()) return errAsync<SmartModelTurnBuild, DomainError>(siblings.error);
  return compileSmartModelBuild(catalog, picked, {
    ...slotOptions,
    siblings: siblings.value,
    ...(args.slotPosition === undefined ? {} : { slotPosition: args.slotPosition }),
  });
}

/**
 * The effort the candidate menu is graded at: the pinned rung, the off rung for
 * a Min send, and an open axis for an `auto` send, which alone carries a cap per
 * candidate and rung.
 */
function menuEffort(args: SmartModelSendArgs): {
  readonly effortPin?: ResolvedReasoningEffort;
  readonly effortAuto?: boolean;
} {
  if (args.pinnedEffort !== undefined) return { effortPin: args.pinnedEffort };
  if (args.reasoningOff === true) return { effortPin: 'off' };
  return args.classifyEffort === true ? { effortAuto: true } : {};
}

/**
 * The send's effort once its own menu has answered. An `auto` send whose menu
 * marks exactly one rung available runs that rung, as a pin there would: it is
 * the single choice §Reasoning Effort 5 settles without a call, so the effort
 * axis closes and the slot and its siblings resolve that rung.
 */
function settledEffortArgs(
  args: SmartModelSendArgs,
  picked: SmartModelCandidates | null
): SmartModelSendArgs {
  if (args.classifyEffort !== true) return args;
  const settled = settledRungOf(picked?.effortOptions ?? []);
  if (settled === undefined) return args;
  return settled === REASONING_OFF
    ? { ...args, classifyEffort: false, reasoningOff: true }
    : { ...args, classifyEffort: false, pinnedEffort: settled };
}

/** The slot's own compile options — everything a slot-only turn already needed. */
function slotCompileOptions(
  catalog: readonly ModelDescriptor[],
  picked: SmartModelCandidates | null,
  args: {
    readonly budget?: TurnBudget;
    readonly classifyEffort?: boolean;
    readonly reasoningOff?: boolean;
    readonly pinnedEffort?: CanonicalReasoningEffort;
  }
): CompileSmartModelOptions {
  const classify =
    args.classifyEffort === true && picked !== null
      ? effortDimensionForCandidates(catalog, picked)
      : undefined;
  return {
    ...(args.budget === undefined ? {} : { budget: args.budget }),
    ...(classify === undefined ? {} : { classify }),
    ...(args.reasoningOff === true ? { reasoningOff: true } : {}),
    ...(args.pinnedEffort === undefined ? {} : { pinnedEffort: args.pinnedEffort }),
  };
}

/**
 * The reasoning selection the SIBLINGS resolve, reconstructed from the three
 * facts the slot already carries rather than taken as a fourth argument: the
 * selection and those three are one fact, and a caller passing both could pass
 * them disagreeing.
 */
function siblingEffortSelection(args: {
  readonly classifyEffort?: boolean;
  readonly reasoningOff?: boolean;
  readonly pinnedEffort?: CanonicalReasoningEffort;
}): ReasoningEffortSelection | undefined {
  if (args.reasoningOff === true) return 'off';
  if (args.pinnedEffort !== undefined) return args.pinnedEffort;
  return args.classifyEffort === true ? 'auto' : undefined;
}

/**
 * The pinned siblings of a mixed turn, sized and reasoning-resolved exactly as
 * the pure multi-model fan-out sizes its own — the same resolver, the same
 * sizing function — so a model answers identically whether or not a Smart slot
 * happens to sit beside it. Called only for a non-empty selection: an empty one
 * has no pricing basis to size against.
 */
export function turnSiblings(
  catalog: readonly ModelDescriptor[],
  models: readonly string[],
  args: {
    readonly budget?: TurnBudget;
    readonly classifyEffort?: boolean;
    readonly reasoningOff?: boolean;
    readonly pinnedEffort?: CanonicalReasoningEffort;
    readonly webSearchEnabled?: boolean;
  }
): Result<TurnSiblings, DomainError> {
  const resolve = snapshotResolver(catalog);
  const webSearchEnabled = args.webSearchEnabled === true;
  // Every sibling here answers BESIDE the slot — this function exists only for
  // the mixed turn — so none of them is the turn's sole answer source, whatever
  // the list length.
  const reasoning = resolveTurnReasoning(models, resolve, siblingEffortSelection(args), {
    smartSlot: true,
  });
  if (reasoning.isErr()) return err(reasoning.error);
  const sized = turnAnswerSizing(models, resolve, args.budget, reasoning.value);
  if (sized.isErr()) return err(sized.error);
  return assertModelsWebSearchCapable(models, resolve, webSearchEnabled).map(() => ({
    models,
    ...(sized.value === undefined ? {} : { maxOutputTokens: sized.value }),
    ...(args.budget === undefined ? {} : { promptInputTokens: promptInputTokensFor(args.budget) }),
    ...(reasoning.value.size === 0 ? {} : { reasoning: reasoning.value }),
    ...(webSearchEnabled ? { webSearchEnabled } : {}),
  }));
}

/**
 * The Smart Model + auto classify set: both dimensions when the pool actually
 * presents an effort choice, otherwise undefined — a pool with nothing to tune
 * runs the model-only classification (no extra dimension, no reserve change).
 *
 * Two or more presented rungs is what makes an effort classification exist; one
 * or none is a settled question, so no call is bought and no reserve is held
 * (§Reasoning Effort 5, 10(c)) — the same gate the multi-model and pinned+auto
 * paths apply. A mandatory-reasoning model offers exactly one rung (§Reasoning
 * Effort 2), so "can reason" is the wrong predicate here: it opened the axis on
 * a pool whose only answer was already known.
 *
 * A menu that marks no rung available closes the axis too: an open axis with no
 * option makes the decision mint the axis's cheapest rung, and the siblings
 * would then run a rung the menu greyed.
 */
export function effortDimensionForCandidates(
  catalog: readonly ModelDescriptor[],
  picked: SmartModelCandidates
): { readonly model: boolean; readonly effort: boolean } | undefined {
  return picked.effortOptions.length > 0 &&
    turnClassifies(
      picked.candidates.map((candidate) => candidate.id),
      snapshotResolver(catalog)
    )
    ? { model: true, effort: true }
    : undefined;
}

export type AutoEffortTurnBuild =
  | ({ readonly kind: 'built' } & MultiModelTurnBuild)
  /**
   * Not classifier-eligible: nothing is left to choose. The turn has at most
   * ONE real effort choice (unknown/non-reasoning model, single-level mandatory
   * ladder, Min-only model) or no pricing basis. The regular single-model path owns the turn — its
   * `auto` resolution is the deterministic pick or reasoning-free, with no
   * classifier call, charge, or reserve.
   */
  | { readonly kind: 'fallback' }
  /**
   * Classifier-eligible, but the payer's funds buy no rung: the turn's own menu
   * marks none available, because the funds cover no rung's budget and a minimum
   * answer beside the classifier's reserve, or the answer fit misses its floor.
   *
   * Separate from `fallback` because the two mean opposite things to a caller.
   * `fallback` says the effort question is already settled, so an unclassified
   * turn is the honest answer; this says nothing is settled and the money is
   * absent. Collapsing them is a money defect and not a UX one: the regular
   * turn resolves `auto` reasoning-free and therefore prices BELOW the
   * classified turn the payer could not afford, so no gate downstream of this
   * compile refuses it — admission admits it and settlement bills a turn nobody
   * asked for.
   *
   * Both callers therefore refuse rather than defer — the paid route with a 402
   * `INSUFFICIENT_ADMISSION`, the trial route with a 402
   * `TRIAL_MESSAGE_TOO_EXPENSIVE`, each before a run is claimed. That is a
   * property of those call sites and is pinned at each route; this type cannot
   * enforce it. A paid payer can add funds and a trial one cannot, but neither
   * is served by a classified turn their funds cannot buy.
   */
  | { readonly kind: 'unaffordable' };

/**
 * The pinned-model + auto-effort turn: the user chose the model, so only the
 * EFFORT axis is open, and what it may decide is read off the turn's own
 * admissible menu, graded at the turn's instant. With two or more rungs available it compiles
 * a single-candidate `smartModel` slot declaring `classify: { model: false,
 * effort: true }`, offered exactly those rungs; the model axis stays closed, so
 * the slot binds the user's own pick and is NOT badged Smart Model, and the
 * turn's one classifier call is a node of its own ahead of the slot. With one
 * rung available the turn runs that rung as a pin there, buys no call, and is
 * sized without the reserve the menu set aside. With none it is unaffordable.
 *
 * The classified answer cap holds the strongest offered rung's budget on top of
 * the answer headroom, so whichever rung the classifier decides carves its
 * budget out of an already-held cap with a minimum answer beside it. The
 * classifier engine is the cheapest priceable engine-text model (the Smart Model
 * derivation, reused); when the catalog holds no priceable engine the send is
 * REFUSED with the typed classifier code (BILLING §Effort 5), never a silent
 * static pick, and explicit levels stay usable.
 *
 * `hooks` decides the turn's billing policy, and it is a parameter rather than
 * the paid default because the two policies differ in what the definition may
 * carry: the paid policy persists, so the definition is storage-stamped and
 * admission holds the storage settlement will bill; the trial policy persists
 * nothing, so a stamp would reserve storage no settlement can ever charge
 * against. {@link withStorageStamp} reads the hooks to decide, so passing them
 * through is the whole mechanism.
 */
export function compileAutoEffortTurn(
  catalog: readonly ModelDescriptor[],
  model: string,
  turn: { readonly budget: TurnBudget; readonly hooks: PolicyHooks; readonly now: Date }
): Result<AutoEffortTurnBuild, DomainError> {
  const { budget, hooks, now } = turn;
  const resolve = snapshotResolver(catalog);
  const target = catalog.find((descriptor) => descriptor.id === model);
  if (target === undefined || !turnClassifies([model], resolve)) return ok({ kind: 'fallback' });
  // The menu is read before the pricing basis is checked, so a catalog with no
  // priceable engine refuses with the typed classifier code even when the
  // pinned model itself has no basis to price.
  return turnEffortPlan([model], resolve, {
    selection: 'auto',
    catalog,
    webSearch: false,
    funding: autoMenuFunding(budget, hooks),
    nowMs: now.getTime(),
  }).andThen((plan): Result<AutoEffortTurnBuild, DomainError> => {
    const pricings = turnModelPricings([model], resolve);
    if (pricings === undefined) return ok({ kind: 'fallback' });
    const room = sharedAnswerCeiling(budget, pricings);
    /* v8 ignore next -- `pricings` is a one-element list here, so a room always resolves */
    if (room === undefined) return ok({ kind: 'fallback' });
    if (plan.kind === 'unaffordable') return ok({ kind: 'unaffordable' });
    if (plan.settled !== undefined) {
      // One available rung settles the axis: the turn runs it as a pin there,
      // buys no call, and sizes its answer without the reserve the menu set aside.
      return compileFittedSingleTurn(resolve, model, {
        budget,
        hooks,
        reasoningEffort: plan.settled.effort,
        setAsideNanoUsd: plan.settled.setAsideNanoUsd,
      }).map((fitted) => fundedAutoEffortTurn(fitted, {}));
    }
    /* v8 ignore next -- a funded classifying plan names its classifier whenever it settles nothing */
    if (plan.classifier === null) return ok({ kind: 'fallback' });
    return ok(classifiedAutoEffortTurn(catalog, target, plan.classifier, { budget, hooks, room }));
  });
}

/**
 * The funding a pinned-model auto turn's menu is graded against: the payer's own,
 * at the trial tier when the turn runs on the trial policy, whose ceiling stands
 * in for a wallet.
 */
function autoMenuFunding(budget: TurnBudget, hooks: PolicyHooks): MenuFunding {
  const funding = menuFundingOf(budget);
  return hooks.admission === TRIAL_TURN_HOOKS.admission ? { ...funding, tier: 'trial' } : funding;
}

/**
 * The classified pinned-model turn: a single-candidate slot whose one open axis is
 * effort, offered exactly the rungs its menu marks available, with its answer
 * fitted by the rule every build shares.
 */
function classifiedAutoEffortTurn(
  catalog: readonly ModelDescriptor[],
  target: ModelDescriptor,
  classifier: EffortClassifierPlan,
  turn: { readonly budget: TurnBudget; readonly hooks: PolicyHooks; readonly room: number }
): AutoEffortTurnBuild {
  const resolve = snapshotResolver(catalog);
  const registries = createTurnCompileRegistries(resolve);
  const built = buildSmartModelTurn({
    classifierModelId: classifier.engineId,
    candidates: [
      {
        id: target.id,
        ...(target.description === undefined ? {} : { description: target.description }),
      },
    ],
    classify: { model: false, effort: true },
    effortOptions: classifier.effortOptions,
    answerCapTokens: turn.room,
    promptInputTokens: promptInputTokensFor(turn.budget),
    hooks: turn.hooks,
    nodes: registries.nodes,
    constraints: registries.constraints,
  });
  /* v8 ignore next -- defensive: the pinned model was found in the SAME
     catalog snapshot the compile registries read, so a compile failure means
     the two reads drifted — kept fail-closed rather than assumed impossible */
  if (built.isErr()) return { kind: 'fallback' };
  const stamped = withStorageStamp(built.value.definition, turn.budget, turn.hooks);
  // The physical room is only the upper bound; the ONE canonical admission
  // estimator sizes the cap the classifier's strongest offered rung has to fit
  // inside, and its own price includes the classifier reserve.
  const fitted = sizedTurnAnswers(stamped, answerFitFor(resolve, turn.budget, turn.room), {
    shapeAt: atLoop,
  });
  return fundedAutoEffortTurn(fitted, classifierField(built.value));
}

/**
 * The built pinned-model turn, or its refusal when the answer fit missed the
 * answer floor. The menu is the first gate and marks only rungs the funding
 * covers; this one catches the menu and the fit drifting apart, since the trial
 * route has no balance gate after the build and would otherwise run a turn over
 * its fixed ceiling.
 */
function fundedAutoEffortTurn(
  fitted: FittedTurn,
  classifier: ReturnType<typeof classifierField>
): AutoEffortTurnBuild {
  /* v8 ignore next -- reached only if the menu marks a rung the one estimator's
     fit cannot fund, the menu-and-fit drift this refusal exists to catch */
  if (!fitted.withinFunds) return { kind: 'unaffordable' };
  return { kind: 'built', definition: fitted.definition, ...classifier };
}

/**
 * Builds the pinned+auto turn end to end from the request's db — one exposed
 * catalog read feeds the classifier pick, the cap sizing, and the compile
 * registries (compile ⟺ runtime never diverge). `fallback` tells the route
 * to build the regular single-model turn instead; `unaffordable` refuses the
 * send on whichever tier asked and never falls back, for the reason recorded on
 * the arm's own declaration; a typed error refuses the send outright (no
 * priceable classifier engine).
 */
export function buildAutoEffortTurnDefinition(
  deps: TrialSmartModelTurnDeps,
  model: string,
  args: { readonly budget: TurnBudget; readonly hooks: PolicyHooks; readonly now: Date }
): ResultAsync<AutoEffortTurnBuild, DomainError> {
  return listDescriptors({ db: deps.db, telemetry: deps.telemetry }).andThen((catalog) =>
    compileAutoEffortTurn(catalog, model, args)
  );
}

interface TrialSmartModelTurnDeps {
  readonly db: Database;
  readonly telemetry: Telemetry;
}

/**
 * Builds the Smart Model turn for one TRIAL send: no wallet and no balance
 * read — the fixed per-message ceiling funds the same producer the paid arm
 * derives its menu from, at the trial tier (see
 * `buildTrialSmartModelCandidates`), compiled under the trial hooks
 * (no-persist / no-charge). No eligible candidate yields `buildable: false` —
 * the route refuses the send as too expensive, the same refusal class as a
 * concrete over-cap model.
 */
export function buildTrialSmartModelTurnDefinition(
  deps: TrialSmartModelTurnDeps,
  args: {
    readonly now: Date;
    /**
     * The 1¢-derived budget. REQUIRED on this arm, unlike the paid one: a trial
     * send is defined by its per-message ceiling (§Trial Usage), and the ceiling
     * is also the basis the candidate gate prices against. A trial build with no
     * budget would have no cap to compile AND no character count to gate on, so
     * the shape does not permit one.
     */
    readonly budget: TurnBudget;
    /** True when the trial request selected `auto` effort (same gate as paid). */
    readonly classifyEffort?: boolean;
    /** True when the send selected `none` — see {@link SmartModelTurnParams.reasoningOff}. */
    readonly reasoningOff?: boolean;
    /**
     * The level the send pinned. It grades the candidate menu as well as riding
     * the slot, exactly as on the paid arm and through the same resolver: the
     * derivation must run at the rung the answer will run at, or the turn could
     * bind a model that answers at some other rung — or, for a model with no
     * ladder, at none.
     */
    readonly pinnedEffort?: CanonicalReasoningEffort;
  }
): ResultAsync<SmartModelTurnBuild, DomainError> {
  return listDescriptors({ db: deps.db, telemetry: deps.telemetry }).andThen((catalog) => {
    // The candidate gate prices the SAME character count the definition is
    // compiled against, forwarded from the budget rather than recounted here, so
    // the two cannot measure different prompts. Recounting locally is what let a
    // send with custom instructions past the 1¢ gate: this file can see the
    // prompt and the history, but only the route sees the instructions.
    const picked = buildTrialSmartModelCandidates({
      descriptors: catalog,
      nowMs: args.now.getTime(),
      promptCharacterCount: args.budget.promptCharacterCount,
      ...(args.pinnedEffort === undefined ? {} : { effortPin: args.pinnedEffort }),
    });
    const classify =
      args.classifyEffort === true && picked !== null
        ? effortDimensionForCandidates(catalog, picked)
        : undefined;
    return compileSmartModelBuild(catalog, picked, {
      hooks: TRIAL_TURN_HOOKS,
      budget: args.budget,
      ...(classify === undefined ? {} : { classify }),
      ...(args.reasoningOff === true ? { reasoningOff: true } : {}),
      ...(args.pinnedEffort === undefined ? {} : { pinnedEffort: args.pinnedEffort }),
    });
  });
}
