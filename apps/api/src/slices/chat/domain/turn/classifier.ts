import {
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  ERROR_CODES,
  REASONING_EFFORT_LABELS,
  TURN_DECISION_REDUCER,
  candidateAnsweringAt,
  jsonTag,
  optionalTag,
  textTag,
} from '@hushbox/shared';
import {
  TURN_DECISION_SCHEMA_NAME,
  fanIn,
  modelCall,
  workflowInputs,
} from '../../../workflows/index.js';
import { pickEffortClassifier } from '../../../models/index.js';
import { unavailableError, validationError } from '../../../../lib/errors/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { CHAT_TURN_INPUT } from '../constants.js';
import { turnEffortChoices } from './reasoning.js';
import { effortRungsOf, settledRungOf } from './rung-ceilings.js';
import type { NodeHandle, decisionDomainInput } from '../../../workflows/index.js';
import type { RungPlan } from './rung-ceilings.js';
import type { ModelPricingResolver } from '../../../models/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result } from '../../../../lib/result/index.js';
import type {
  DimensionOption,
  JsonTag,
  ModelDescriptor,
  ReasoningEffortSelection,
  ResolvedReasoningEffort,
  TextTag,
  UserTier,
} from '@hushbox/shared';

/**
 * The turn's classifier call and the reducer that turns its answer into the
 * decision every sibling reads.
 *
 * The classifier is an ORDINARY `modelCall` (`docs/BILLING.md` §How the decision
 * reaches the answer). Nothing on the node says "classifier": the decision
 * reducer reading its answer is what makes it one, and both the engine (which
 * withholds the client's context from it) and admission (which prices it as
 * routing internals) derive that from the graph rather than from a flag.
 *
 * It is `optional` + `onError: 'skip'` so a routing hiccup degrades to the
 * declared fallback instead of failing the turn — the reducer's second input is
 * an optional text for exactly that reason, and the run still answers.
 */
export interface TurnClassifierParams {
  /** The cheapest priceable engine-text model — the classifier engine. */
  readonly modelId: string;
  /**
   * The classifier call's own input-token basis: the truncation budget plus the
   * rendered template, the SAME basis its reserve is priced on, so admission
   * holds the call at what it can actually cost rather than at the engine's
   * full context window.
   */
  readonly promptInputTokens: number;
}

/**
 * One turn's classifier, built once for every shape that grows one — the
 * multi-model graph and the Smart Model slot alike.
 *
 * The two halves travel together because they are one decision: the prompt
 * names exactly the models and options the reserve is priced against, so a
 * caller cannot render a prompt against one list and price it against another.
 * That is not hypothetical — pricing the model axis against an empty list while
 * the prompt named candidates is precisely the mispricing this seam removes.
 */
export interface TurnClassifierPrompt {
  /** The rendered template; the send path joins the conversation excerpt to it. */
  readonly prompt: string;
  /**
   * What the reducer resolves the answer within: the effort options the prompt
   * presented, empty when the axis is closed, and the candidates the turn's
   * slot may bind.
   */
  readonly decisionDomain: DecisionDomain;
}

/** The decision domain, as the reducer's input encoder takes it. */
type DecisionDomain = Parameters<typeof decisionDomainInput>[0];

/** What a slot candidate carries about the rungs it answers at. */
interface DomainCandidate {
  readonly id: string;
  readonly maxOutputTokens?: number | undefined;
  readonly rungCeilings?: Readonly<Partial<Record<ResolvedReasoningEffort, number>>> | undefined;
}

/**
 * A classifying turn's decision domain: the effort options its prompt presents,
 * and the candidates its Smart Model slot may bind, in the slot's own order, so
 * the reducer's declared fallback is the slot's first candidate. Each candidate
 * carries the presented rungs it answers at, read through the one shared
 * definition. The candidates are the very array the slot node is built from, so
 * the decision can bind no pair the slot does not hold.
 */
export function decisionDomainFor(
  effortOptions: readonly DimensionOption[],
  candidates: readonly DomainCandidate[]
): DecisionDomain {
  const presentedEfforts = effortRungsOf(effortOptions);
  return {
    presentedEfforts,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      answerableRungs: presentedEfforts.filter(
        (rung) => candidateAnsweringAt(candidate, rung) !== undefined
      ),
    })),
  };
}

export interface TurnClassifier extends TurnClassifierPrompt {
  readonly params: TurnClassifierParams;
}

/** The workflow input carrying the rendered classifier prompt. */
export const CHAT_CLASSIFIER_INPUT = 'classifierPrompt';

/**
 * The workflow input carrying the turn's decision domain: the effort options the
 * classifier prompt presented and the candidates its slot may bind. The decision
 * reducer resolves the answer and its declared fallbacks against THIS domain
 * rather than the dimension's whole declared one (§Reasoning Effort 8: the
 * fallback is the cheapest PRESENTED option). It rides an input because a
 * registered reducer is handed its inputs and nothing else: it never sees the
 * node it runs on.
 */
export const CHAT_DECISION_DOMAIN_INPUT = 'decisionDomain';

/** The classifier call's node id — its own charge key, with no content of its own. */
export const CHAT_CLASSIFIER_NODE_ID = 'classify';

/** The decision reducer's node id. */
export const CHAT_DECISION_NODE_ID = 'decide';

/** The inputs a classifying turn declares: the prompt, the classifier's own
 * rendered prompt, and the decision domain. */
export type ClassifyingInputs = ReturnType<
  typeof workflowInputs<{
    prompt: TextTag;
    classifierPrompt: TextTag;
    decisionDomain: TextTag;
  }>
>;

/**
 * The turn's classify → decide pair: one ordinary `modelCall` and the registered
 * reducer that folds its answer into the decision envelope.
 *
 * Built once for every shape that classifies. The multi-model graph's siblings
 * and the Smart Model slot are different consumers of the SAME stage, and a
 * second copy of it would be a second answer to "what does the classifier cost
 * and what may it be sent".
 */
export function classifierStage(classifier: TurnClassifierParams): {
  readonly inputs: ClassifyingInputs;
  readonly nodes: readonly ReturnType<typeof modelCall>[];
  readonly decide: NodeHandle<JsonTag>;
} {
  const inputs = workflowInputs({
    [CHAT_TURN_INPUT]: textTag(),
    [CHAT_CLASSIFIER_INPUT]: textTag(),
    [CHAT_DECISION_DOMAIN_INPUT]: textTag(),
  });
  const classify = modelCall({
    id: CHAT_CLASSIFIER_NODE_ID,
    model: classifier.modelId,
    accepts: textTag(),
    in: inputs.ports[CHAT_CLASSIFIER_INPUT],
    produces: textTag(),
    // A routing hiccup must not kill a paid turn: the branch skips, the reducer
    // sees an absent answer, and the declared fallback applies.
    optional: true,
    onError: 'skip',
    // The output cap the reserve is priced against, applied to the request that
    // spends it rather than only to the figure that reserves it.
    params: { maxOutputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP },
    promptInputTokens: classifier.promptInputTokens,
  });
  const decide = fanIn({
    id: CHAT_DECISION_NODE_ID,
    reducer: TURN_DECISION_REDUCER,
    accepts: [textTag(), optionalTag(textTag()), textTag()] as const,
    ins: [inputs.ports[CHAT_TURN_INPUT], classify.out, inputs.ports[CHAT_DECISION_DOMAIN_INPUT]],
    produces: jsonTag(TURN_DECISION_SCHEMA_NAME),
  });
  return { inputs, nodes: [classify, decide], decide };
}

/**
 * Whether this turn's offered rungs make a classification possible, the
 * question the freeze reserve and every build ask before any menu is read.
 *
 * Two or more offered options is what makes a classification possible; with one
 * or none the answer is already settled and no call is bought (§Reasoning
 * Effort 5). A funded build then asks its own menu the same question of the rungs
 * it marks available, so one available rung settles the choice without a call
 * ({@link turnEffortPlan}). A model the resolver cannot see offers nothing, so it
 * classifies nothing, the fail-closed direction. The `auto` selection itself is
 * not part of the question: the compiles that ask it are already on the `auto`
 * path.
 *
 * The option set comes from {@link turnEffortChoices}, the same derivation the
 * deterministic `auto` pick reads: this decision and that one are complements
 * over one list, and a second derivation would let them drift apart at the
 * one-option boundary while each stayed self-consistent.
 */
export function turnClassifies(models: readonly string[], resolve: ModelPricingResolver): boolean {
  return turnEffortChoices(models, resolve).length >= 2;
}

/**
 * The effort options the turn's models offer: the union across the selected
 * models, in the user's own labels.
 *
 * A classifier sees this list only where no funding grades a menu, which is a
 * budget-less build. A funded build presents the rungs its own menu marks
 * available instead ({@link turnEffortPlan}). Either way
 * the declared domain is the wrong list: a turn whose models offer four rungs
 * must not be offered six. The union comes from the one shared authority the menu
 * and the server validation already use, so a rung can never be offered here that
 * the resolver would not accept back.
 */
export function presentedEffortOptions(
  models: readonly string[],
  resolve: ModelPricingResolver
): readonly DimensionOption[] {
  return turnEffortChoices(models, resolve).map((choice) => ({
    optionId: choice,
    label: REASONING_EFFORT_LABELS[choice],
  }));
}

/** The engine and the options of the effort-only classifier a turn buys. */
export interface EffortClassifierPlan {
  readonly engineId: string;
  readonly effortOptions: readonly DimensionOption[];
}

/** An open effort axis its menu settles at one available rung, with no call left to buy. */
interface SettledEffort {
  /** The one rung the menu marks available: the turn runs it, as if pinned there. */
  readonly effort: ResolvedReasoningEffort;
  /** The reserve the menu's solves set aside unheld, if any; the answers are sized without it. */
  readonly setAsideNanoUsd: bigint | undefined;
}

/**
 * What a turn whose models were pinned makes of its effort selection, or the
 * refusal of an `auto` turn its funding holds no rung of.
 */
export type TurnEffortPlan =
  | {
      readonly kind: 'planned';
      /** The classifier the turn buys, if any. */
      readonly classifier: EffortClassifierPlan | null;
      /** The rung its searching answers declare their loop at. */
      readonly loopEffort: ResolvedReasoningEffort | undefined;
      readonly settled?: SettledEffort;
      /** Present when the searching answers carry a ceiling per rung. */
      readonly perRung?: RungPlan;
    }
  | { readonly kind: 'unaffordable' };

/** The payer facts a turn's own admissible menu is graded against. */
export interface MenuFunding {
  readonly balanceNanoUsd: bigint;
  readonly tier: UserTier;
  readonly promptChars: number;
  readonly inputChars: number;
}

interface TurnEffortPlanInput {
  readonly selection: ReasoningEffortSelection | undefined;
  /** The exposed catalog the engine and the menu's pool are drawn from. */
  readonly catalog: readonly ModelDescriptor[];
  readonly webSearch: boolean;
  /** Absent on a build with no budget, which has no funding to grade a menu at. */
  readonly funding: MenuFunding | undefined;
  /** The instant the menu's pool is read at. */
  readonly nowMs: number | undefined;
}

/** A plan that buys `classifier` and declares the loop of `loopEffort`. */
function planned(
  classifier: EffortClassifierPlan | null,
  loopEffort?: ResolvedReasoningEffort
): TurnEffortPlan {
  return { kind: 'planned', classifier, loopEffort };
}

/**
 * The turn's {@link TurnEffortPlan}.
 *
 * A pin, or no selection, names its loop and buys nothing. An `auto` turn with
 * fewer than two real choices buys nothing either, and its sole choice, if any,
 * is the rung its answers run at. A classifying `auto` turn reads its menu off
 * the producer the browser's picker reads ({@link classifyingPlan}). A
 * budget-less build has no funding to grade a menu against: it presents every
 * rung the models offer and declares the ceiling loop, the most any decision
 * could take. A classifiable turn with no priceable engine is refused outright:
 * auto is the server's choice, and a static fallback is exactly what §Effort 5
 * forbids.
 */
export function turnEffortPlan(
  models: readonly string[],
  resolve: ModelPricingResolver,
  input: TurnEffortPlanInput
): Result<TurnEffortPlan, DomainError> {
  if (input.selection !== 'auto') return ok(planned(null, input.selection));
  if (!turnClassifies(models, resolve)) {
    // Fewer than two choices: the sole one, if any, is the rung the answers run at.
    const [sole] = turnEffortChoices(models, resolve);
    return ok(planned(null, sole));
  }
  if (input.funding === undefined) {
    const engine = pickEffortClassifier(input.catalog);
    if (engine === null) return err(classifierUnavailable());
    return ok(
      planned({
        engineId: engine.classifierModelId,
        effortOptions: presentedEffortOptions(models, resolve),
      })
    );
  }
  if (input.nowMs === undefined) {
    return err(
      validationError('a classifying auto turn requires the instant its menu is graded at')
    );
  }
  const pick = pickEffortClassifier(input.catalog, {
    models,
    ...input.funding,
    webSearch: input.webSearch,
    nowMs: input.nowMs,
  });
  if (pick === null) return err(classifierUnavailable());
  return ok(classifyingPlan(pick, input.webSearch));
}

/**
 * A classifying `auto` turn's plan, read off its own admissible menu over its own
 * funding. The classifier is offered exactly the rungs that menu marks available;
 * the answers declare the loop of the highest of them; and each searching answer
 * carries its own ceiling at every one of them, since one decision can land on
 * any. One available rung is the single choice §Reasoning Effort 5 settles
 * without a call: the turn runs that rung and holds no reserve for a call it does
 * not make. No available rung is a turn the funding cannot run at all, refused
 * like the browser's send gate refuses it.
 */
function classifyingPlan(
  pick: {
    readonly classifierModelId: string;
    readonly effortOptions: readonly DimensionOption[];
    readonly setAsideNanoUsd?: bigint;
  },
  webSearch: boolean
): TurnEffortPlan {
  const settled = settledRungOf(pick.effortOptions);
  if (settled !== undefined) {
    return {
      kind: 'planned',
      classifier: null,
      loopEffort: settled,
      settled: { effort: settled, setAsideNanoUsd: pick.setAsideNanoUsd },
    };
  }
  const [lowest, ...higher] = effortRungsOf(pick.effortOptions);
  if (lowest === undefined) return { kind: 'unaffordable' };
  const classifier = { engineId: pick.classifierModelId, effortOptions: pick.effortOptions };
  // The highest available rung, the loop the menu declares.
  let loop = lowest;
  for (const rung of higher) loop = rung;
  if (!webSearch) return { kind: 'planned', classifier, loopEffort: loop };
  return {
    kind: 'planned',
    classifier,
    loopEffort: loop,
    perRung: { loop, rungs: [lowest, ...higher] },
  };
}

/**
 * The typed refusal of a classifiable turn the catalog holds no priceable engine
 * for: auto is the server's choice, and a static fallback is exactly what
 * §Effort 5 forbids.
 */
function classifierUnavailable(): DomainError {
  return unavailableError(
    'no priceable classifier engine in the catalog',
    undefined,
    ERROR_CODES.CLASSIFIER_UNAVAILABLE
  );
}
