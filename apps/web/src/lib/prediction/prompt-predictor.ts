import {
  predictWithSharedSession,
  predictionSessionOffered,
  subscribePredictionSessionReady,
} from './prediction-session';
import type { PromptPredictor } from './predictor';

/**
 * The predictor the chat composers run on: a thin adapter over the one session
 * the whole app shares, bound to how many rival continuations the asking
 * surface is able to put on screen.
 *
 * `undefined` is the whole answer, not a placeholder for one: a composer given
 * no predictor is exactly the composer that existed before sentence completion
 * did, which is the behaviour every surface falls back to whenever no model is
 * available to complete a sentence.
 *
 * This module is the one the end-to-end build swaps, at module-resolution time
 * in the apps/web Vite config, for a variant that hands back a deterministic
 * predictor instead. Moving or renaming it therefore has to move that
 * resolution entry with it.
 */
export function promptPredictor(alternativeCount: number): PromptPredictor | undefined {
  if (!predictionSessionOffered()) return undefined;
  return {
    predict: (text, signal, onCompletion) =>
      predictWithSharedSession(text, alternativeCount, signal, onCompletion),
    onReady: subscribePredictionSessionReady,
  };
}
