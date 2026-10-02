import {
  classifierEngineOf,
  getTurnOptions,
  modelId,
  nanoUSD,
  promptBasisFromTotal,
  smartSlotMinTurnCostNanoUsd,
} from '@hushbox/shared';
import { poolModelFromDescriptor } from '@hushbox/shared/affordability';
import { classifierWorstCaseNanoUsd } from '@hushbox/shared/affordability/estimate/smart-model-affordability';
import type {
  DimensionOption,
  ModelDescriptor,
  ModelEntry,
  PriceableModel,
  ReasoningEffortSelection,
  ResolvedReasoningEffort,
  TurnOptions,
  UserTier,
} from '@hushbox/shared';

/**
 * The Smart Model candidate menu for one send, on every arm: the ELIGIBLE subset
 * of the exposed text catalog for this payer, each entry carrying its OWN
 * affordable answer cap `cap(m)`, with the cheapest model PER TOKEN running the
 * classification. The trial arm reaches it through
 * `buildTrialSmartModelCandidates`, which supplies the trial tier and the fixed
 * per-message ceiling in place of a wallet.
 *
 * It is not derived here. The menu, the per-candidate caps and the hold all come
 * from the ONE turn producer the client's picker reads, over the ONE pool
 * projection both sides draw with — so the set the classifier may route among is
 * the set the payer was actually shown, at the tier they are actually on. Two
 * derivations is what let the server's menu become a strict superset of the
 * client's for a free payer, and a classifier route onto a premium model the
 * picker never presented.
 *
 * `balanceNanoUsd` is the payer's EFFECTIVE turn funding (cushion-inclusive) for
 * this send: the purchased-wallet spendable for a solo paid turn, the
 * owner-funded effective cap for a group turn, the remaining daily allowance for
 * a free-tier turn, or the fixed per-message ceiling for a trial one — the same
 * effective figure admission gates on.
 */

interface SmartModelCandidatesInput {
  /** The exposed catalog (`listDescriptors`' already-filtered set). */
  readonly descriptors: readonly ModelDescriptor[];
  /** The payer's effective turn funding in nano-USD (purchased balance,
   * owner-funded cap, or free allowance — the figure admission gates on). */
  readonly balanceNanoUsd: bigint;
  /**
   * The PAYER's tier. It is what makes this menu the payer's own: it fixes
   * whether a premium row is offerable at all, so a tier-blind build offers
   * models the payer cannot pick and reserves against rows they could never
   * have chosen.
   */
  readonly tier: UserTier;
  /** The prompt the send will carry, in characters — the input-token basis. */
  readonly promptChars: number;
  /**
   * The new user message inside {@link SmartModelCandidatesInput.promptChars} —
   * the storage basis. The menu grades candidates against the payer's funding,
   * so a menu reserving storage for the whole prompt stamps caps below what the
   * same turn's admission hold will in fact fund.
   */
  readonly inputChars: number;
  /**
   * The models the SAME turn pinned by name. The slot answers beside them, so
   * they are removed from the set it can resolve to: a candidate colliding with
   * a pinned sibling would produce two answers from one model — priced, held
   * and billed twice, under two different tile labels.
   *
   * Empty on a slot-only turn, rather than defaulted: this field decides the
   * candidate menu, so a caller that forgot it would silently offer the slot a
   * model the same turn already pinned — the double-billing leg — and no gate
   * would see it.
   */
  readonly pinnedModelIds: readonly string[];
  /**
   * Whether the send carries web search. It grades and caps this menu, because
   * the reservation is funding the answers cannot spend: a menu blind to it
   * stamps per-candidate caps the turn cannot afford, and a stamped `cap(m)`
   * overrides the node parameter in both the estimator and execution, so no
   * later answer fit can bring it back down.
   *
   * Required rather than defaulted for the same reason the pinned list is: a
   * caller that forgot the field would grade the menu against funding the
   * siblings' tool has already taken, silently.
   */
  readonly webSearch: boolean;
  /** The reference instant premium classification's recency leg is measured from. */
  readonly nowMs: number;
  /**
   * The reasoning level the sender pinned, when the turn pins one: a canonical
   * rung, or the off rung for a Min send. It grades the menu: a row that cannot
   * resolve the rung, or cannot fit its budget beside a minimum viable answer, is
   * not a candidate, so a pinned turn cannot route onto a model that would answer
   * at some other rung. Absent leaves the axis open.
   */
  readonly effortPin?: ResolvedReasoningEffort;
  /**
   * True when the send leaves its effort to the classifier. Only then can a
   * decision land on any rung the menu offers, so only then does a candidate carry
   * a cap per rung. Keyed on the send rather than on the pin's absence, which a
   * send selecting no effort at all shares.
   */
  readonly effortAuto?: boolean;
}

export interface SmartModelCandidateEntry {
  readonly id: string;
  readonly description?: string;
  /** `cap(m)`: this candidate's own affordable answer-token ceiling (the most
   * tokens the reservation buys at its rate, bounded by its context and its
   * provider ceiling). The execution applies it for THIS model. */
  readonly maxOutputTokens?: number;
  /**
   * This candidate's own effort ceiling by user-facing LABEL — the highest rung
   * its funding holds, which the classifier prompt annotates the row with
   * (§Story 2.3) and which a classifier answer clamps onto. Absent for a model
   * that offers nothing on the axis.
   */
  readonly effortCeiling?: string;
  /**
   * The cap this candidate answers at for each rung the classifier may decide,
   * as its own budget solve at that rung buys it. Present only on an `auto` turn
   * whose pinned siblings search: their loop grows with the rung and takes
   * funding the candidate would otherwise answer with, while a turn with no loop
   * buys every rung the same cap.
   */
  readonly rungCeilings?: Readonly<Partial<Record<ResolvedReasoningEffort, number>>>;
}

export interface SmartModelCandidates {
  /** The cheapest text model per token — the model that RUNS the classification.
   * Not necessarily one of `candidates`: the two ride different orders, and an
   * enormous-capacity model can be both the cheapest per token and an outlier. */
  readonly classifierModelId: string;
  /** The ELIGIBLE subset (each affords its own minimum viable answer at the
   * cheapest effort rung it can run) minus the pool's outliers, each carrying
   * its own `maxOutputTokens = cap(m)`. The classifier can only route among
   * these, so no unaffordable and no unofferable model is ever reachable. */
  readonly candidates: readonly SmartModelCandidateEntry[];
  /**
   * The rungs the turn's own admissible menu marks available, ascending: the
   * effort options its classifier may decide. Empty when the turn offers no
   * rung or its funding holds none.
   */
  readonly effortOptions: readonly DimensionOption[];
  /**
   * The rung whose tool loop the turn's searching siblings declare: the highest
   * available rung, the lowest offered rung when none is available, and absent
   * with no ladder.
   */
  readonly toolLoopEffort?: ResolvedReasoningEffort;
  /**
   * The classifier reserve the menu's solves set aside that its hold does not
   * carry: present when one available rung settles an open effort axis with no
   * call left to buy. The siblings are sized against the funding less it.
   */
  readonly setAsideNanoUsd?: bigint;
}

/** What a classifier on a turn may decide, read off the turn's own admissible menu. */
interface EffortMenu {
  /** The rungs the menu marks available, ascending. */
  readonly effortOptions: readonly DimensionOption[];
  /** The rung whose tool loop the turn's searching answers declare. */
  readonly toolLoopEffort?: ResolvedReasoningEffort;
  /** The reserve the menu's solves set aside unheld, as {@link SmartModelCandidates.setAsideNanoUsd}. */
  readonly setAsideNanoUsd?: bigint;
}

/** The menu facts of a produced pair. */
function effortMenuOf(options: TurnOptions): EffortMenu {
  const set = options.admissible;
  return {
    effortOptions: set.turnDimensions
      .filter((dimension) => dimension.dimensionId === 'effort')
      .flatMap((dimension) =>
        dimension.options
          .filter((option) => option.availability.available)
          .map((option) => ({ optionId: option.optionId, label: option.label }))
      ),
    ...(set.toolLoopEffort === undefined ? {} : { toolLoopEffort: set.toolLoopEffort }),
    ...(options.setAsideNanoUsd === undefined
      ? {}
      : { setAsideNanoUsd: BigInt(options.setAsideNanoUsd) }),
  };
}

/**
 * A turn whose models were pinned by name and whose effort is left to the
 * classifier: what its own admissible menu is graded against.
 */
interface PinnedAutoTurn {
  /** The models the turn pinned by name. */
  readonly models: readonly string[];
  /** The payer's effective turn funding, as {@link SmartModelCandidatesInput.balanceNanoUsd}. */
  readonly balanceNanoUsd: bigint;
  readonly tier: UserTier;
  readonly promptChars: number;
  readonly inputChars: number;
  readonly webSearch: boolean;
  readonly nowMs: number;
}

interface EffortClassifierPick {
  /** The cheapest pool model — the effort classifier. */
  readonly classifierModelId: string;
  /**
   * The classifier call's worst-case billable reserve, with the prompt overhead
   * rendered against NO model list — the same basis admission's smartModel
   * reserve prices an effort-only node at, and the same list the prompt will
   * actually carry.
   */
  readonly classifierWorstCaseNanoUsd: bigint;
}

/**
 * The classifier pick for a PINNED-model auto-effort turn: the model is the
 * user's own choice (a single candidate — no routing), so only the effort
 * dimension classifies, and the classifier is the cheapest member of the shared
 * text-turn pool. Both the pool and the "cheapest" order are the shared ones the
 * turn producer itself uses, so a row this pick classifies on is exactly a row
 * every other pool consumer — the client's included — can price. `null` when no
 * text model can price the call; the caller refuses the send with the typed
 * classifier-unavailable code rather than picking an effort itself.
 */
export function pickEffortClassifier(
  descriptors: readonly ModelDescriptor[]
): EffortClassifierPick | null;
/**
 * Handed the turn itself, the pick also reads what its classifier may decide off
 * that turn's own admissible menu, through the one producer the browser's picker
 * reads: the rungs the menu marks available, and the rung whose loop the turn's
 * searching answers declare.
 */
export function pickEffortClassifier(
  descriptors: readonly ModelDescriptor[],
  turn: PinnedAutoTurn
): (EffortClassifierPick & EffortMenu) | null;
export function pickEffortClassifier(
  descriptors: readonly ModelDescriptor[],
  turn?: PinnedAutoTurn
): (EffortClassifierPick & Partial<EffortMenu>) | null {
  const pool = smartModelPool(descriptors);
  const classifier = classifierEngineOf(pool);
  if (classifier === undefined) return null;
  // Effort-only: the model dimension is closed, so the classifier's prompt names
  // no model and the reserve prices none.
  const reserve = classifierWorstCaseNanoUsd(classifier, []);
  const pick = { classifierModelId: classifier.modelId, classifierWorstCaseNanoUsd: reserve };
  if (turn === undefined) return pick;
  const [first, ...rest] = turn.models;
  /* v8 ignore next -- unreachable: a turn names at least one model to classify for,
     and one that named none would offer no rung; kept so the menu is never graded
     over a selection the producer cannot read */
  if (first === undefined) return { ...pick, effortOptions: [] };
  const options = getTurnOptions(
    fundingOf(turn.balanceNanoUsd, turn.tier),
    promptBasisFromTotal(turn),
    {
      answerSources: {
        models: [modelId(first), ...rest.map((id) => modelId(id))],
        smartSlot: false,
      },
      modality: 'text',
      pinned: {},
      webSearch: turn.webSearch,
    },
    { models: pool, nowMs: turn.nowMs }
  );
  return { ...pick, ...effortMenuOf(options) };
}

/**
 * One frozen effective funding figure as the producer reads it: the cushion and
 * the holds are already in it, so there is no second number to subtract.
 */
function fundingOf(balanceNanoUsd: bigint, tier: UserTier): Parameters<typeof getTurnOptions>[0] {
  return {
    spendableNanoUsd: nanoUSD(balanceNanoUsd),
    heldNanoUsd: nanoUSD(0n),
    payerTier: tier,
    payer: 'self',
  };
}

/**
 * The text-turn pool behind an exposed catalog, through the ONE shared
 * projection. Every membership rule — runnable shape, context length, release
 * date, per-token rates — is the projection's, so this side cannot draw a pool
 * the client's picker does not have.
 */
export function smartModelPool(descriptors: readonly ModelDescriptor[]): readonly PriceableModel[] {
  return descriptors.flatMap((descriptor) => {
    const model = poolModelFromDescriptor(descriptor);
    return model === undefined ? [] : [model];
  });
}

/** The turn facts §Smart Model 5's threshold is priced against. */
interface SmartModelMinimumInput {
  /** The exposed catalog (`listDescriptors`' already-filtered set). */
  readonly descriptors: readonly ModelDescriptor[];
  /** The prompt the send will carry, in characters — the input-token basis. */
  readonly promptChars: number;
  /**
   * The new user message inside {@link SmartModelMinimumInput.promptChars} — the
   * storage basis, because one new message row is all a turn newly stores.
   */
  readonly inputChars: number;
  /** Whether the turn's content will rest. A non-persisting turn stores nothing. */
  readonly persists: boolean;
  /**
   * The siblings the same turn pinned by name, already projected. They are
   * priced into every arrangement the slot could become and excluded from the
   * set it resolves over — the same disjointness the candidate menu carries.
   */
  readonly pinned: readonly PriceableModel[];
  /** Whether the send carries web search. */
  readonly webSearch: boolean;
  /**
   * The send's reasoning selection: it fixes the loop a searching sibling's
   * minimum is priced at. Required for the same reason `webSearch` is.
   */
  readonly reasoningEffort: ReasoningEffortSelection | undefined;
}

/**
 * §Smart Model 5's balance-INDEPENDENT minimum: the effective balance below
 * which {@link buildSmartModelCandidates} returns `null`. It is the Smart Model
 * slot's `minTurnCost` — what the payer freeze must compare group headroom
 * against, since headroom under it can only freeze a payer whose candidate set
 * is then empty. The figure comes from the shared §Math & Terms producer over
 * the SAME pool projection the candidate builder ranges over, and is pinned in
 * the money layer as the exact funding boundary the turn producer sends at.
 * `undefined` when nothing in the catalog prices a candidate — a send the turn
 * build refuses on its own.
 */
export function smartModelMinimumNanoUsd(input: SmartModelMinimumInput): bigint | undefined {
  return smartSlotMinTurnCostNanoUsd({
    pool: smartModelPool(input.descriptors),
    pinned: input.pinned,
    promptChars: input.promptChars,
    inputChars: input.inputChars,
    persists: input.persists,
    webSearch: input.webSearch,
    reasoningEffort: input.reasoningEffort,
  });
}

/**
 * `ceiling(m)` on the EFFORT axis: the highest rung this candidate's row marks
 * available, by label.
 *
 * Read off the row rather than derived from `cap(m)`. The producer already
 * grades every rung of every candidate against the arrangement it would create,
 * and the type that carries the result names itself as this story's per-candidate
 * effort ceiling — so a derivation here would be a second implementation of the
 * same feasibility rule, and not an equivalent one: the published grading leaves
 * room for a minimum viable answer, while a cap-based walk only needs one token,
 * so the two disagree over every rung in between and this side would print
 * ceilings above what the arrangement honours.
 *
 * The LAST available option is the ceiling because the axis is ordered and its
 * feasible set is a downward-closed prefix, which is the same property that
 * makes one printed rung a lossless rendering of the set.
 */
function effortCeilingOf(entry: ModelEntry): string | undefined {
  /* v8 ignore next -- unreachable: the caller filters the pinned ids out of
     `runnable` before mapping, and a row the selection did not pin is always a
     candidate; kept fail-closed so a change to that filter cannot print a pinned
     sibling's ceiling as a candidate's */
  if (entry.kind !== 'candidate') return undefined;
  const effort = entry.dimensions.find((dimension) => dimension.dimensionId === 'effort');
  return effort?.options.findLast((option) => option.availability.available)?.label;
}

export function buildSmartModelCandidates(
  input: SmartModelCandidatesInput
): SmartModelCandidates | null {
  const pool = smartModelPool(input.descriptors);
  const options = getTurnOptions(
    fundingOf(input.balanceNanoUsd, input.tier),
    promptBasisFromTotal(input),
    {
      // The pinned siblings ride the SAME selection the money layer prices, so
      // the core's own candidate derivation removes them from the slot's set
      // and prices every candidate as `pinned + itself`.
      answerSources: {
        models: input.pinnedModelIds.map((id) => modelId(id)),
        smartSlot: true,
      },
      modality: 'text',
      // An unpinned turn leaves effort open for the same reason the picker
      // does on an `auto` turn: the slot's own classifier answers it, and
      // grading the menu at a rung nothing has chosen yet would cull
      // candidates the turn can in fact run. A pinned turn has that answer
      // already, so the menu is graded at it.
      pinned: input.effortPin === undefined ? {} : { effort: input.effortPin },
      webSearch: input.webSearch,
    },
    { models: pool, nowMs: input.nowMs }
  );
  // `admissible` is the send gate AND the classifier's options — the same set,
  // by construction, rather than two answers that happen to agree.
  const set = options.admissible;
  const engine = classifierEngineOf(pool);
  // The core publishes `holdNanoUsd` only when the admissible pass produced a
  // total, so an absent one means the turn could not be priced at all. No hold
  // is derived from it here: the one a send places is the run estimator's, over
  // the definition the turn compiles.
  if (!set.sendable || engine === undefined || options.holdNanoUsd === undefined) return null;
  const describedBy = new Map(
    input.descriptors.map((descriptor) => [descriptor.id, descriptor.description])
  );
  // A pinned sibling keeps its own runnable row — the payer selected it — but it
  // is not something the slot may resolve to, so it is not a candidate. The
  // funding was already graded over the core's own candidate arrangements, which
  // exclude it, so this narrows the menu without moving the money.
  const pinnedIds = new Set(input.pinnedModelIds);
  const menu = effortMenuOf(options);
  // Caps differ by rung only where a decision can land on two or more rungs and a
  // pinned sibling's loop grows with the rung; one available rung settles effort.
  const perRung =
    input.effortAuto === true &&
    input.webSearch &&
    input.pinnedModelIds.length > 0 &&
    menu.effortOptions.length >= 2
      ? new Set(menu.effortOptions.map((option) => option.optionId))
      : new Set<string>();
  const candidates = set.runnable
    .filter((entry) => !pinnedIds.has(entry.modelId))
    .map((entry): SmartModelCandidateEntry => {
      const description = describedBy.get(entry.modelId);
      const effortCeiling = effortCeilingOf(entry);
      const rungs = entry.rungCeilings.filter((rung) => perRung.has(rung.effort));
      return {
        id: entry.modelId,
        ...(description === undefined ? {} : { description }),
        ...(effortCeiling === undefined ? {} : { effortCeiling }),
        ...(rungs.length === 0
          ? { maxOutputTokens: entry.ceilingTokens }
          : {
              rungCeilings: Object.fromEntries(
                rungs.map((rung) => [rung.effort, rung.ceilingTokens])
              ),
              // A higher rung's loop leaves less to answer with, so the least of
              // the caps is the one at the highest rung this candidate names: the
              // loop the siblings declare whenever the candidate can fund it.
              maxOutputTokens: Math.min(...rungs.map((rung) => rung.ceilingTokens)),
            }),
      };
    });
  // Every affordable model already pinned leaves the slot nothing to resolve to
  // — the same empty-menu refusal an unaffordable catalog produces.
  /* v8 ignore next -- unreachable: a slot that can resolve to nothing makes the
     turn unsendable (executed: an all-pinned catalog answers `sendable: false`
     with `model_not_priceable`), so the guard above returns first; kept
     fail-closed rather than trusting that coupling */
  if (candidates.length === 0) return null;
  return { classifierModelId: engine.modelId, candidates, ...menu };
}
