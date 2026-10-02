import type { Prediction } from './predictor';

/**
 * Turns raw model output into text that is safe to render at the caret, or
 * `null` for "show nothing".
 *
 * A shaped completion is concatenated onto the typed text verbatim, with no
 * separator inserted: a continuation may legitimately finish the word the user
 * is halfway through typing ("the cat sa" + "t on the"), so the leading
 * whitespace the model emitted is the only thing that may separate them.
 */

/**
 * Whitespace-delimited words the user must have typed before any prediction is
 * offered. Below a short clause there is no sentence to continue, so a hint
 * would appear, change and vanish across the opening keystrokes of every
 * message; this is the smallest count that reliably carries a subject and a
 * verb.
 */
export const MIN_TYPED_WORDS_TO_PREDICT = 3;

/** Words a shaped completion must retain to be worth the visual interruption. */
export const MIN_PREDICTED_WORDS = 2;

/**
 * Characters that can sit inside a word. A completion ending in one of these
 * has no proof its last word finished — generation stops on a token budget, not
 * a word boundary — so that word is dropped as partial.
 */
const WORD_CHARACTER = /[\p{L}\p{N}'’-]/u;

const TRAILING_NON_WHITESPACE = /\S+$/u;

function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
}

function dropUnfinishedTrailingWord(text: string): string {
  const lastCharacter = text.at(-1);
  if (lastCharacter === undefined || !WORD_CHARACTER.test(lastCharacter)) return text;
  return text.replace(TRAILING_NON_WHITESPACE, '');
}

/**
 * Shapes one raw completion against the text it continues. Pure: no clock, no
 * DOM, no randomness.
 */
export function shapeCompletion(typedText: string, rawCompletion: string): string | null {
  if (countWords(typedText) < MIN_TYPED_WORDS_TO_PREDICT) return null;

  const newlineIndex = rawCompletion.indexOf('\n');
  const firstLine = newlineIndex === -1 ? rawCompletion : rawCompletion.slice(0, newlineIndex);
  const shaped = dropUnfinishedTrailingWord(firstLine).replace(/\s+$/u, '');
  if (countWords(shaped) < MIN_PREDICTED_WORDS) return null;
  return shaped;
}

/** A shaped predictor answer: what to inline, and what the candidate list offers. */
export interface ShapedPrediction {
  /** The continuation rendered at the caret. */
  readonly completion: string;
  /**
   * Distinct rival continuations for the candidate list — never `completion`
   * itself, which is already visible inline. Two raw alternatives can shape to
   * the same text, and a list offering the same words twice reads as a bug.
   */
  readonly candidates: readonly string[];
}

/**
 * Shapes the rival continuations behind an already-shaped `completion`.
 * `completion` and duplicates among the alternatives are both dropped, so
 * every entry the list receives is distinct from the inline hint and from
 * each other.
 */
export function shapeAlternatives(
  typedText: string,
  completion: string,
  alternatives: readonly string[]
): readonly string[] {
  const candidates: string[] = [];
  for (const alternative of alternatives) {
    const shaped = shapeCompletion(typedText, alternative);
    if (shaped !== null && shaped !== completion && !candidates.includes(shaped)) {
      candidates.push(shaped);
    }
  }
  return candidates;
}

/**
 * Shapes a whole predictor answer. Returns `null` when the inline completion
 * does not survive shaping — there is then nothing to anchor the list to.
 */
export function shapePrediction(
  typedText: string,
  prediction: Prediction
): ShapedPrediction | null {
  const completion = shapeCompletion(typedText, prediction.completion);
  if (completion === null) return null;

  const candidates = shapeAlternatives(typedText, completion, prediction.alternatives);
  return { completion, candidates };
}
