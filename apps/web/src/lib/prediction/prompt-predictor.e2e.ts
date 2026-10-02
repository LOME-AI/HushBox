import { PROMPT_PREDICTION_STUB_STORAGE_KEY } from '@hushbox/shared';
import type { Prediction, PromptPredictor } from './predictor';

/**
 * The predictor an end-to-end build runs on: fixed text, no model, no network,
 * no clock.
 *
 * Placement, geometry and gesture routing are the only things a rendered check
 * can see that a unit test cannot, and none of them depend on what the words
 * say — so the answer is a constant, and a spec derives everything it asserts
 * from the text it finds on screen rather than from anything written here.
 *
 * The build swaps this module in for the production one at module-resolution
 * time (apps/web Vite config), so nothing in the app ever names it and no
 * production bundle can carry it.
 */

/**
 * The continuation offered at the caret, and the rivals offered under the
 * composer. Each has to survive output shaping — which drops an answer of fewer
 * than two words and trims a trailing partial one — and the three rivals have
 * to stay distinct from each other and from the first, because shaping folds
 * duplicates out of the list.
 */
const COMPLETION = ' over the lazy dog.';
const ALTERNATIVES: readonly string[] = [
  ' under the old stone bridge.',
  ' across the frozen lake.',
  ' beside the quiet river.',
];

const DETERMINISTIC_PREDICTOR: PromptPredictor = {
  predict: (
    _text: string,
    signal: AbortSignal,
    onCompletion: (completion: string) => void
  ): Promise<Prediction> => {
    if (signal.aborted) return Promise.reject(new Error('prediction aborted'));
    onCompletion(COMPLETION);
    return Promise.resolve({ completion: COMPLETION, alternatives: ALTERNATIVES });
  },
};

/**
 * Read per call rather than once at load: a spec arms the key before its first
 * navigation, but reading it here keeps the answer a fact about the page rather
 * than about which module happened to be imported first.
 */
function armed(): boolean {
  return globalThis.localStorage.getItem(PROMPT_PREDICTION_STUB_STORAGE_KEY) !== null;
}

export function promptPredictor(_alternativeCount: number): PromptPredictor | undefined {
  return armed() ? DETERMINISTIC_PREDICTOR : undefined;
}
