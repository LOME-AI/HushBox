/**
 * A trailing space or tab tokenizes as a standalone token whose learned
 * successors are digits and newlines, so a prompt ending on one produces
 * digit-led junk on every cache history. A trailing newline is left alone: it
 * is a boundary the model has seen constantly in training and predicts
 * sensibly from, unlike a bare space.
 */
const TRAILING_SPACE_OR_TAB = /[ \t]+$/u;

const LEADING_WHITESPACE = /^\s/u;

export interface HealedPrompt {
  readonly text: string;
  readonly healedTrailingSpace: boolean;
}

/**
 * Strips every trailing space/tab from `text` so the tokenizer's last token is
 * the boundary itself, never a bare space — see the module doc for why.
 */
export function healPromptBoundary(text: string): HealedPrompt {
  const match = TRAILING_SPACE_OR_TAB.exec(text);
  if (match === null) return { text, healedTrailingSpace: false };
  return { text: text.slice(0, match.index), healedTrailingSpace: true };
}

/**
 * Reconciles a raw model continuation against a healed prompt. When the typed
 * text ended in a space or tab, the continuation must reopen with whitespace
 * of its own; anything else means the model extended the last word (`sat` →
 * `urday`) rather than starting a new one, and posting it would corrupt a word
 * the user already finished. Exactly one leading whitespace character comes
 * off — the single boundary token healing removed from the prompt, not
 * however many the model chose to emit.
 */
export function healCompletion(completion: string, healedTrailingSpace: boolean): string {
  if (!healedTrailingSpace) return completion;
  if (!LEADING_WHITESPACE.test(completion)) return '';
  return completion.slice(1);
}
