import {
  suggestionRowId,
  PREDICTION_SUGGESTION_LISTBOX_ID,
} from '@/components/chat/input/use-prompt-prediction';
import type * as React from 'react';
import type { usePromptPrediction } from '@/components/chat/input/use-prompt-prediction';

export function isSubmitKeyEvent(e: React.KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey;
}

function suggestionListNoModifiers(e: React.KeyboardEvent): boolean {
  return !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
}

interface SuggestionListAriaProps {
  readonly 'aria-activedescendant': string | undefined;
  readonly 'aria-owns': string | undefined;
}

/**
 * The textarea's virtual-focus wiring for the active suggestion row: both
 * attributes appear together, since nothing needs announcing before a row is
 * active.
 */
export function suggestionListAriaProps(activeSuggestion: number | null): SuggestionListAriaProps {
  if (activeSuggestion === null) {
    return { 'aria-activedescendant': undefined, 'aria-owns': undefined };
  }
  return {
    'aria-activedescendant': suggestionRowId(activeSuggestion),
    'aria-owns': PREDICTION_SUGGESTION_LISTBOX_ID,
  };
}

/**
 * Whether ArrowDown claims the key: enters the list at its first row, or
 * walks one row further down while already navigating.
 *
 * Entry decides from a freshly re-read caret position: a caret that left the
 * end of the value with no intervening render leaves the committed candidate
 * list stale for this same handler. Once already navigating the caret cannot
 * have moved — every claimed key here calls `preventDefault` — so only entry
 * re-syncs.
 */
export function claimSuggestionArrowDown(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  prediction: ReturnType<typeof usePromptPrediction>
): boolean {
  if (e.key !== 'ArrowDown' || !suggestionListNoModifiers(e)) return false;
  if (prediction.activeSuggestion === null && prediction.syncSuppression() !== null) {
    return false;
  }
  if (!prediction.handleArrowDown()) return false;
  e.preventDefault();
  return true;
}

/** Whether ArrowUp claims the key: walks one row up, or leaves the list from its first row. */
export function claimSuggestionArrowUp(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  prediction: ReturnType<typeof usePromptPrediction>
): boolean {
  if (e.key !== 'ArrowUp' || !suggestionListNoModifiers(e)) return false;
  if (!prediction.handleArrowUp()) return false;
  e.preventDefault();
  return true;
}

/** Whether Tab, ArrowRight, or Enter claims the key to apply the active row. */
export function claimSuggestionApply(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  prediction: ReturnType<typeof usePromptPrediction>,
  onChange: (value: string) => void
): boolean {
  if (prediction.activeSuggestion === null) return false;
  const wantsApply =
    ((e.key === 'Tab' || e.key === 'ArrowRight') && suggestionListNoModifiers(e)) ||
    isSubmitKeyEvent(e);
  if (!wantsApply) return false;
  const applied = prediction.applyActiveSuggestion();
  if (applied === null) return false;
  e.preventDefault();
  onChange(applied);
  return true;
}
