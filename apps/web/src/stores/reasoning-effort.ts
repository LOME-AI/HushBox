import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { EffortChoice, ReasoningEffortSelection } from '@hushbox/shared';

/**
 * Store-local persist key (no cross-package consumer yet; promote to
 * `packages/shared/src/platform/storage-keys.ts` when e2e needs to seed it).
 */
export const REASONING_EFFORT_STORAGE_KEY = 'hushbox-reasoning-effort-storage';

interface ReasoningEffortState {
  /**
   * The user's raw persisted choice (default `auto`). Consumers never send
   * this directly: `useReasoningEffort` clamps it per model AND lowers it to
   * what the payer can currently fund, so a preference kept across a model
   * switch or a balance drop can never produce a request the server would
   * refuse. It is never written back over — the preference returns the moment
   * the level it names is enabled again.
   */
  preferredReasoningEffort: ReasoningEffortSelection;
  setReasoningEffort: (selection: ReasoningEffortSelection) => void;
  /**
   * The choices the produced effort dimension currently ENABLES — the same
   * graded set the menu greys from, undefined until the payer's funding and the
   * catalog are both in hand.
   *
   * The sole writer is `useEffortAvailabilityPublisher`, called only by the
   * composer's effort menu. Publishing from a budget hook instead would write
   * whichever payer that instance happens to be scoped to, and the instances are
   * NOT all scoped to the same one.
   *
   * It travels through the store rather than an argument because the value the
   * SEND carries is read from `useReasoningEffort()` by callers that hold no
   * funding scope of their own; routing the graded set to the one producer is
   * what keeps the menu's answer and the request's answer a single answer.
   */
  enabledEffortChoices: readonly EffortChoice[] | undefined;
  setEnabledEffortChoices: (choices: readonly EffortChoice[] | undefined) => void;
}

/** Same members in the same order, so a republish of an unchanged grading is a no-op. */
function sameChoices(
  a: readonly EffortChoice[] | undefined,
  b: readonly EffortChoice[] | undefined
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((choice, index) => choice === b[index]);
}

export const useReasoningEffortStore = create<ReasoningEffortState>()(
  persist(
    (set, get) => ({
      preferredReasoningEffort: 'auto',
      setReasoningEffort: (selection) => set({ preferredReasoningEffort: selection }),
      enabledEffortChoices: undefined,
      setEnabledEffortChoices: (choices) => {
        // A churn guard, not a correctness one: the publisher re-runs on every
        // regrade and mostly reproduces the same set, and writing an equal set
        // would wake every subscriber and re-run the producer that fed it. It is
        // no defence against a second writer — two publishers that DISAGREE are
        // never equal here, so only the single call site keeps them from
        // alternating.
        if (sameChoices(get().enabledEffortChoices, choices)) return;
        set({ enabledEffortChoices: choices });
      },
    }),
    {
      name: REASONING_EFFORT_STORAGE_KEY,
      // The preference is the user's; the graded set is a verdict about money
      // as of a moment, and a rehydrated one would grey rungs against a balance
      // that no longer exists.
      partialize: (state) => ({ preferredReasoningEffort: state.preferredReasoningEffort }),
    }
  )
);
