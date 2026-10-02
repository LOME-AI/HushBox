import { cutAtWordBoundary } from '@/lib/utils/word-boundary-cut';

/**
 * How many characters of typed text the prediction worker will tokenize.
 *
 * The KV cache costs ~46 KB per token, so an unbounded prompt reserves
 * hundreds of megabytes on top of the resident model — reachable simply by
 * pasting a long document into the composer and pausing. 2000 characters
 * keeps that reservation an order of magnitude smaller even at the model's
 * densest chars-to-tokens ratio, while leaving ordinary English input
 * untouched in practice.
 */
export const MAX_PREDICTION_INPUT_CHARS = 2000;

/**
 * Bounds `text` to {@link MAX_PREDICTION_INPUT_CHARS}, keeping the tail
 * nearest the caret — the part a completion attaches to — and cutting at a
 * word boundary so the model never opens on a fragment token.
 */
export function cappedPredictionInput(text: string): string {
  return cutAtWordBoundary(text, MAX_PREDICTION_INPUT_CHARS);
}
