import * as React from 'react';
import {
  SMART_MODEL_ID,
  getAffordableOptions,
  getTurnOptions,
  modelId,
  nanoUSD,
  poolModelFromWire,
  trialFundingSnapshot,
  type Availability,
  type CatalogSnapshot,
  type FundingSnapshot,
  type ModelId,
  type OptionSet,
  type PromptBasis,
  type ReasoningEffortSelection,
  type Selection,
  type TurnOptions,
  type UserTier,
} from '@hushbox/shared';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models/models';
import { useFundingRead } from '@/hooks/billing/use-spendable';
import { useWebSearch } from '@/hooks/chat/use-web-search';

/**
 * The `apps/web` PUBLISHER of the money layer's token verdict. One publisher per
 * produced verdict is what `web-prices-through-producers` enforces — not one
 * hook for the whole module, which is why `use-media-turn-options.ts` publishes
 * the per-unit one — so this file is the only one under `apps/web` that may
 * import `getTurnOptions`. Every surface reads the value this returns; none
 * computes a verdict, so none can disagree with another.
 *
 * The rule is written against CODE, not components, because a second verdict
 * engine is as easily a hook as a component — which is exactly what this hook
 * replaced.
 */

/**
 * The instant the catalog snapshot is taken at, captured ONCE per page load.
 *
 * Premium classification's recency leg is measured from this instant, and
 * `affordable` is documented keystroke-stable — so a per-render `Date.now()`
 * would churn the memo key of a set whose whole contract is that it does not
 * move while the user types. It is exported so a test can assert stability
 * rather than trusting the absence of a call.
 *
 * The client's instant is advisory in the only way that matters: the server
 * re-runs the producer against its own clock at admission, so a wrong client
 * clock mis-DISPLAYS availability and cannot move money.
 */
export const CATALOG_INSTANT_MS: number = Date.now();

interface UseTurnOptionsInput {
  /** Counts only — the money layer never receives content. */
  readonly basis: PromptBasis;
  readonly isAuthenticated: boolean;
  /**
   * The conversation being composed in, which is what names the PAYER: an
   * owner-funded group turn is priced from the owner's funds at the owner's
   * tier. Omit for a solo composer or a picker opened outside a conversation.
   */
  readonly conversationId?: string | null;
  /**
   * The turn's effort pin, or `undefined`/`auto` for an open one.
   *
   * It arrives as an argument rather than off the effort store because the hook
   * that owns that store CONSUMES what this one produces — the graded effort
   * dimension is what lowers a preference the payer can no longer fund — and a
   * store read here would make that a render-time cycle.
   */
  readonly effort?: ReasoningEffortSelection | undefined;
}

export interface UseTurnOptionsResult {
  /**
   * True while a funding or catalog input is still in flight. A surface must
   * render its neutral state while this holds — NOT a refusal. Treating an
   * absent funding read as `0n` is what greyed every affordable row for a
   * render, so this hook withholds the verdict entirely instead of producing a
   * poor one, and `options` is `undefined` for exactly as long.
   */
  readonly isPending: boolean;
  /**
   * True when the payer's funding read is EXHAUSTED rather than outstanding.
   * No verdict exists in that state either, but the surface owes the user a
   * different thing: a pending read resolves itself, so the neutral state is
   * honest for it, while this one never will, and rendering the same neutral
   * state for it is an indefinite silent wait.
   */
  readonly isFundingUnavailable: boolean;
  /** The produced pair, or `undefined` while `isPending`. */
  readonly options: TurnOptions | undefined;
  /**
   * The smart slot's own verdict, absent for exactly as long as `options` is.
   * The slot is not a catalog model, so no entry of `affordable.all` describes
   * it and a surface looking it up there finds nothing; it rides here so the
   * one row a picker cannot look up is still read off a produced value rather
   * than defaulted to.
   */
  readonly smartSlotAvailability: Availability | undefined;
  /**
   * What active holds took off the payer's spendable, from the same snapshot
   * that produced `options`. It is the ONLY evidence a hold exists: the two
   * option sets differ in funding AND basis, so their difference cannot
   * distinguish a hold from a long prompt.
   */
  readonly heldNanoUsd: bigint;
  /**
   * The payer's hold-aware spendable, from the same snapshot that produced
   * `options`. It rides beside the pair because a surface wording a money
   * refusal needs to know whether the payer has nothing or merely not enough —
   * two conditions the option sets alone cannot tell apart.
   */
  readonly payerSpendableNanoUsd: bigint;
  /**
   * WHO the served figures describe, straight from the wire. The server applied
   * §Group Funding 2 and named the payer; this is that answer, carried through
   * unchanged so a surface can say which wallet pays without deciding it.
   */
  readonly payer: 'self' | 'owner';
}

/** Which models the turn draws on, with the sentinel resolved to the smart slot. */
function answerSourcesOf(
  selected: readonly { id: string }[]
): Selection['answerSources'] | undefined {
  const smartSlot = selected.some((entry) => entry.id === SMART_MODEL_ID);
  const pinned = selected
    .filter((entry) => entry.id !== SMART_MODEL_ID)
    .map((entry): ModelId => modelId(entry.id));
  const [first, ...rest] = pinned;
  if (first !== undefined) return { models: [first, ...rest], smartSlot };
  // At least one answer source is required by the type, so a selection that is
  // neither a pinned model nor the smart slot has no turn to price.
  return smartSlot ? { models: [], smartSlot: true } : undefined;
}

/**
 * The payer's funding snapshot: ONE served number for every caller with a
 * funding door, and the fixed client-side ceiling only for the trial, which has
 * none. The served snapshot also names the PAYER's tier, which is why an
 * owner-funded turn — a group member's or a link guest's alike — sizes as the
 * owner's would rather than the sender's.
 *
 * The fallback belongs to the trial alone. A caller that HAS a door is gated
 * until its snapshot is in hand — still loading and failed alike — so the trial
 * ceiling never stands in for another payer's figure.
 */
function fundingSnapshotOf(served: ServedFunding): FundingSnapshot {
  if (served === undefined) {
    return trialFundingSnapshot();
  }
  return {
    spendableNanoUsd: nanoUSD(BigInt(served.spendableNanoUsd)),
    heldNanoUsd: nanoUSD(BigInt(served.heldNanoUsd)),
    payerTier: served.payerTier,
    payer: served.payer,
  };
}

/** One served funding read, as the wire carries it. */
type ServedFunding =
  | { spendableNanoUsd: string; heldNanoUsd: string; payerTier: UserTier; payer: 'self' | 'owner' }
  | undefined;

/** Everything the token producer needs except the prompt, or nothing. */
interface ProducerInputs {
  readonly isPending: boolean;
  readonly isFundingUnavailable: boolean;
  /** Undefined for exactly as long as no verdict exists. */
  readonly ready:
    | {
        readonly funding: FundingSnapshot;
        readonly selection: Selection;
        readonly catalog: CatalogSnapshot;
      }
    | undefined;
}

/**
 * The producer's non-prompt arguments, composed once for both reads below. The
 * two hooks differ only in WHICH producer they hand these to, so composing them
 * twice would let a picker and a composer disagree about the payer, the catalog
 * or the selection while agreeing about the money.
 */
function useProducerInputs(input: {
  readonly isAuthenticated: boolean;
  readonly conversationId?: string | null;
  readonly effort?: ReasoningEffortSelection | undefined;
}): ProducerInputs {
  const activeModality = useModelStore((state) => state.activeModality);
  const selected = useModelStore((state) => state.selections[state.activeModality]);
  const { active: webSearch } = useWebSearch();
  const effort = input.effort;
  const { data: modelsData } = useModels();
  const conversationId = input.conversationId ?? null;
  // ONE read. The conversation NAMES the payer, and the server has already
  // applied §Group Funding 2 — it returns the winning wallet's figures plus
  // `payer` and `payerTier`. Re-resolving that client-side was a second authority
  // for a decision the wire already carries, and it disagreed with the server
  // inside the settle-then-release window.
  //
  // The read answers ABSENCE, not query pendingness, and it splits absence into
  // its two halves: a caller with no funding door (the trial) is never gated,
  // a door-holder is gated until the snapshot is in hand, and an exhausted read
  // is reported as such rather than waited on. Falling through to the trial
  // ceiling on any of them is the tier conflation the guest's own door exists
  // to remove.
  const fundingRead = useFundingRead(input.isAuthenticated, conversationId);
  const served = fundingRead.snapshot;

  const isFundingUnavailable = fundingRead.status === 'unavailable';
  const isPending = fundingRead.status === 'awaiting' || modelsData === undefined;

  const catalog = modelsData?.models;
  const selectedIds = selected.map((entry) => entry.id).join('\u0000');

  return React.useMemo((): ProducerInputs => {
    const withoutVerdict = (pending: boolean): ProducerInputs => ({
      isPending: pending,
      isFundingUnavailable,
      ready: undefined,
    });

    if (isPending || catalog === undefined) return withoutVerdict(true);
    // An exhausted funding read reaches the trial fallback below otherwise,
    // which would size a door-holder's turn against the 1¢ trial ceiling.
    if (isFundingUnavailable) return withoutVerdict(false);

    const answerSources = answerSourcesOf(selected);
    if (answerSources === undefined) return withoutVerdict(false);

    const models = catalog.flatMap((model) => {
      const priceable = poolModelFromWire(model);
      return priceable === undefined ? [] : [priceable];
    });

    return {
      isPending: false,
      isFundingUnavailable: false,
      ready: {
        funding: fundingSnapshotOf(served),
        selection: {
          answerSources,
          modality: activeModality,
          pinned: effort === undefined || effort === 'auto' ? {} : { effort },
          webSearch,
        },
        catalog: { models, nowMs: CATALOG_INSTANT_MS },
      },
    };
    // `selected` is a fresh array identity on every store read, so the memo
    // keys on the joined ids instead — a keystroke must not re-run the
    // producer, and an unchanged selection must not look changed.
  }, [
    isPending,
    isFundingUnavailable,
    catalog,
    selectedIds,
    served,
    activeModality,
    effort,
    webSearch,
  ]);
}

export function useTurnOptions(input: UseTurnOptionsInput): UseTurnOptionsResult {
  const inputs = useProducerInputs(input);

  return React.useMemo((): UseTurnOptionsResult => {
    // No verdict, and no fabricated figure standing in for one: every arm that
    // cannot produce the pair withholds the numbers with it.
    if (inputs.ready === undefined) {
      return {
        isPending: inputs.isPending,
        isFundingUnavailable: inputs.isFundingUnavailable,
        options: undefined,
        smartSlotAvailability: undefined,
        heldNanoUsd: 0n,
        payerSpendableNanoUsd: 0n,
        payer: 'self',
      };
    }

    const { funding, selection, catalog } = inputs.ready;
    // Greying reads `affordable`, so the slot's verdict is taken over the same
    // set every other row's is — a slot graded against the send gate would grey
    // while a hold is out and no other row moved.
    const options = getTurnOptions(funding, input.basis, selection, catalog);

    return {
      isPending: false,
      isFundingUnavailable: false,
      heldNanoUsd: BigInt(funding.heldNanoUsd),
      payerSpendableNanoUsd: BigInt(funding.spendableNanoUsd),
      payer: funding.payer,
      options,
      smartSlotAvailability: options.smartSlot,
    };
  }, [inputs, input.basis]);
}

interface UsePickerOptionsInput {
  readonly isAuthenticated: boolean;
  /** The conversation the picker was opened from, which NAMES the payer. */
  readonly conversationId?: string | null;
  /** The turn's effort pin, for the same reason the pair takes one. */
  readonly effort?: ReasoningEffortSelection | undefined;
}

interface UsePickerOptionsResult {
  /** True while a funding or catalog input is in flight; the set is absent for exactly as long. */
  readonly isPending: boolean;
  /** What this payer may pick at all, hold-aware and prompt-independent. */
  readonly affordable: OptionSet | undefined;
  /** The smart slot's own verdict — the one row `affordable` holds no entry for. */
  readonly smartSlotAvailability: Availability | undefined;
}

/**
 * The narrow read, for a surface that grades rows before a prompt exists.
 *
 * It carries no `admissible` and no hold, and that is the point rather than an
 * omission: a caller with no basis could only be shown a send gate computed
 * from a zero prompt, which is strictly more permissive than the real one — it
 * prices the composed prompt against `spendable` alone. Withholding the verdict
 * is what makes offering a send this payer cannot make unobtainable here, so
 * the picker asks its own question and nothing more.
 */
export function usePickerOptions(input: UsePickerOptionsInput): UsePickerOptionsResult {
  const inputs = useProducerInputs(input);

  return React.useMemo((): UsePickerOptionsResult => {
    if (inputs.ready === undefined) {
      return {
        isPending: inputs.isPending,
        affordable: undefined,
        smartSlotAvailability: undefined,
      };
    }

    const { funding, selection, catalog } = inputs.ready;
    const picked = getAffordableOptions(funding, selection, catalog);

    return {
      isPending: false,
      affordable: picked.affordable,
      smartSlotAvailability: picked.smartSlot,
    };
  }, [inputs]);
}
