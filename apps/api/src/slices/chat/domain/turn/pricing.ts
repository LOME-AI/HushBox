import {
  WEB_SEARCH_TOOL_NAME,
  minTurnCostNanoUsd,
  pinnedSourceIds,
  priceableModelFrom,
  smartSlotSelected,
} from '@hushbox/shared';
import {
  mediaTurnMinCostNanoUsd,
  pickEffortClassifier,
  smartModelMinimumNanoUsd,
  snapshotResolver,
} from '../../../models/index.js';
import { turnClassifies } from './classifier.js';
import type {
  ModelDescriptor,
  NonEmpty,
  PriceableModel,
  ReasoningEffortSelection,
  TurnSourceList,
} from '@hushbox/shared';
import type { ToolName } from '@hushbox/shared/affordability';

/** The turn's output modality (text is the chat turn; image/video are media). */
export type TurnModality = 'text' | 'image' | 'video';

/** The generation config a media turn carries, per modality. */
export interface MediaTurnBody {
  readonly turnSources: TurnSourceList;
  readonly imageConfig?: Readonly<Record<string, unknown>> | undefined;
  readonly videoConfig?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The node params a media turn's generation carries. One derivation, because the
 * payer freeze prices the turn from these and the build runs the turn on them:
 * two readings of the config would price one turn and run another.
 */
export function mediaTurnParams(
  body: MediaTurnBody,
  modality: 'image' | 'video'
): Record<string, unknown> {
  return (modality === 'video' ? body.videoConfig : body.imageConfig) ?? {};
}

/**
 * Everything a turn's price depends on, and nothing else: what the client
 * selected and how that selection is configured. The prompt's length is the
 * other half and rides as its own argument.
 *
 * The conversation and the branch a turn runs on are excluded as `never` rather
 * than merely left out, because leaving them out excludes nothing: a whole turn
 * request is structurally assignable to a type that simply lacks them, so a call
 * handing pricing the routing identity would still typecheck and the separation
 * would hold by convention alone. Those identifiers belong to context
 * resolution, which decides where a turn runs and which wallet funds it; the
 * `never` makes handing one to pricing a compile error instead.
 */
export interface TurnPricingSelection extends MediaTurnBody {
  readonly modality?: TurnModality | undefined;
  readonly webSearchEnabled?: boolean | undefined;
  readonly reasoningEffort?: ReasoningEffortSelection | undefined;
  readonly conversationId?: never;
  readonly forkId?: never;
}

/**
 * The two measured counts a turn's price reads: the assembled prompt the
 * provider receives, and the new user message inside it. They travel together
 * as one shape because the two legs read different halves — input TOKENS price
 * the whole prompt, input STORAGE prices only what the turn newly stores — and
 * two adjacent numbers on a signature are two numbers a caller can cross.
 *
 * The field names are the turn budget's own (`turn/definition.ts`), so the
 * freeze and the admission estimate name one quantity one way.
 */
export interface TurnPromptCounts {
  readonly promptCharacterCount: number;
  readonly inputCharacterCount: number;
}

/**
 * The money-layer projection of every pinned model, or `null` when any of them
 * cannot be priced (unknown, unexposed, or missing a rate or a context length).
 * All-or-nothing because a partial list would price a cheaper turn than the one
 * being sent; the build refuses such a selection anyway. Empty in, empty out —
 * a turn whose only answer source is the Smart slot pins nothing.
 */
function priceablePinned(
  exposedCatalog: readonly ModelDescriptor[],
  models: readonly string[]
): readonly PriceableModel[] | null {
  const priceable: PriceableModel[] = [];
  for (const id of models) {
    const descriptor = exposedCatalog.find((entry) => entry.id === id);
    const model = descriptor === undefined ? undefined : priceableModelFrom(descriptor);
    if (model === undefined) return null;
    priceable.push(model);
  }
  return priceable;
}

/** {@link priceablePinned} narrowed to the non-empty shape the sibling bound needs. */
function priceableSiblings(
  exposedCatalog: readonly ModelDescriptor[],
  models: readonly string[]
): NonEmpty<PriceableModel> | null {
  const priceable = priceablePinned(exposedCatalog, models);
  if (priceable === null) return null;
  const [first, ...rest] = priceable;
  return first === undefined ? null : [first, ...rest];
}

/**
 * The classifier reserve `minTurnCost` carries: the worst-case cost of the one
 * classifier call an `auto` selection may buy (§Reserve ⟺ classify — the
 * reserve rides on MAY run, not on did run). `0n` for any other selection and for
 * an `auto` selection offering fewer than two effort options, where no call can
 * be made. An `auto` selection offering two or more carries it even where the
 * turn's menu will fund one rung and the build buys no call: the solves deduct
 * the reserve whenever two or more rungs are offered, so the freeze bound stays
 * the send threshold.
 *
 * `undefined` is the third state and is not an amount: the turn DOES classify
 * and the catalog holds no priceable engine, so the reserve has no value to
 * carry. Such a send is refused downstream with the typed
 * classifier-unavailable error, and a zero standing in for the missing figure
 * would price the turn as if the call were free.
 */
function classifierReserveNanoUsd(
  exposedCatalog: readonly ModelDescriptor[],
  models: readonly string[],
  reasoningEffort: ReasoningEffortSelection | undefined
): bigint | undefined {
  if (reasoningEffort !== 'auto') return 0n;
  if (!turnClassifies(models, snapshotResolver(exposedCatalog))) return 0n;
  return pickEffortClassifier(exposedCatalog)?.classifierWorstCaseNanoUsd;
}

/**
 * A media turn's `minTurnCost`: its deterministic per-unit price, from the
 * producer that owns media pricing. A media call has no token leg, so the
 * summed-rate corner the text arm prices is inert against it — and the
 * artifact's stored bytes outweigh the generation itself on a cheap model, so
 * the provider leg alone would leave a headroom band that clears this freeze and
 * then fails admission. `undefined` when a selected model is unknown to the
 * catalog or generates no media; the turn build refuses such a send on its own.
 */
function mediaTurnMinCost(
  exposedCatalog: readonly ModelDescriptor[],
  body: MediaTurnBody,
  modality: 'image' | 'video',
  counts: TurnPromptCounts
): bigint | undefined {
  const pinned = pinnedSourceIds(body.turnSources);
  // The Smart slot names no model, so a media turn carrying it selects nothing
  // to generate with — no price, never a free turn, and the turn build refuses
  // it.
  if (pinned.length === 0) return undefined;
  const descriptors = pinned.flatMap((id) => {
    const descriptor = exposedCatalog.find((entry) => entry.id === id);
    return descriptor === undefined ? [] : [descriptor];
  });
  if (descriptors.length !== pinned.length) return undefined;
  // The same storage stamp the turn build writes onto the definition, so the
  // freeze reserves exactly the prompt storage admission will hold.
  const priced = mediaTurnMinCostNanoUsd(descriptors, mediaTurnParams(body, modality), {
    inputChars: counts.inputCharacterCount,
  });
  return priced.isOk() ? priced.value : undefined;
}

/**
 * The turn's `minTurnCost` for the payer freeze, priced from the catalog
 * snapshot the seam already holds so no additional read reaches the database.
 * Each of the three turn shapes prices through the producer that owns it — the
 * summed-rate corner for text, the per-unit price for media, §Smart Model 5's
 * balance-independent pool threshold for the slot — because a shape priced by an
 * approximation belonging to another shape is how a headroom band that clears
 * the freeze and then fails admission opens.
 *
 * `undefined` wherever a leg of the turn does not price: an unknown or
 * unexposed model, a catalog with no priceable candidate, or a classifying turn
 * with no priceable classifier engine to reserve against. Such a send is
 * refused by the turn build, so who would have paid never matters — it is the
 * absence of a price, never a shape exempted from the comparison.
 */
export function turnMinCost(
  exposedCatalog: readonly ModelDescriptor[],
  selection: TurnPricingSelection,
  counts: TurnPromptCounts
): bigint | undefined {
  if (selection.modality === 'image' || selection.modality === 'video') {
    return mediaTurnMinCost(exposedCatalog, selection, selection.modality, counts);
  }
  const pinnedIds = pinnedSourceIds(selection.turnSources);
  if (smartSlotSelected(selection.turnSources)) {
    // The mixed arrangement is priced through the SAME shared producer as the
    // slot alone, with the pinned siblings carried into every arrangement it
    // ranges over. Pricing the slot alone here would under-price a mixed turn
    // by exactly its pinned siblings, and freeze a payer against a number that
    // belongs to a different turn.
    const pinned = priceablePinned(exposedCatalog, pinnedIds);
    if (pinned === null) return undefined;
    return smartModelMinimumNanoUsd({
      descriptors: exposedCatalog,
      pinned,
      promptChars: counts.promptCharacterCount,
      inputChars: counts.inputCharacterCount,
      persists: true,
      webSearch: selection.webSearchEnabled === true,
      reasoningEffort: selection.reasoningEffort,
    });
  }
  const priceable = priceableSiblings(exposedCatalog, pinnedIds);
  if (priceable === null) return undefined;
  const classifierReserve = classifierReserveNanoUsd(
    exposedCatalog,
    pinnedIds,
    selection.reasoningEffort
  );
  if (classifierReserve === undefined) return undefined;
  // Every sibling here is a model the payer named, so every one of them runs on
  // a node that can hold the search tool.
  const tools: readonly ToolName[] =
    selection.webSearchEnabled === true ? [WEB_SEARCH_TOOL_NAME] : [];
  const [first, ...rest] = priceable;
  return minTurnCostNanoUsd({
    siblings: [{ model: first, tools }, ...rest.map((model) => ({ model, tools }))],
    promptChars: counts.promptCharacterCount,
    inputChars: counts.inputCharacterCount,
    // Every paid chat turn persists; only the trial does not, and it never
    // reaches this seam.
    persists: true,
    classifierReserveNanoUsd: classifierReserve,
    reasoningEffort: selection.reasoningEffort,
  });
}
