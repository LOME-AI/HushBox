/**
 * The trial turn's price: one provider-only call over the prompt, answering
 * {@link TRIAL_AFFORDABILITY_MULTIPLIER} minimum answers. A trial turn never
 * persists, so no storage is reserved. The shared turn producer's trial check
 * and the server's trial send gate both read this one figure.
 */

import { MINIMUM_OUTPUT_TOKENS } from '../constants.ts';
import { costAt, textCallCurve } from './curve.ts';
import { inputTokensOf } from './quantities.ts';
import type { NanoUSD } from '../money/nano-usd.ts';
import type { TokenPricing } from './schedule.ts';

/** A trial-eligible model must afford at least this multiple of the minimum answer. */
export const TRIAL_AFFORDABILITY_MULTIPLIER = 2;

const TRIAL_ANSWER_TOKENS = TRIAL_AFFORDABILITY_MULTIPLIER * MINIMUM_OUTPUT_TOKENS;

export function trialTurnCostNanoUsd(pricing: TokenPricing, promptChars: number): NanoUSD {
  const curve = textCallCurve(
    pricing,
    'reserve',
    { promptTokens: inputTokensOf(promptChars), persists: false, newMessageChars: 0 },
    TRIAL_ANSWER_TOKENS
  );
  return costAt(curve, TRIAL_ANSWER_TOKENS);
}
