/**
 * More tokens is never cheaper: raising either token count raises a call's
 * priced total or leaves it where it was, for every rate pair and every tool
 * loop the call may carry.
 *
 * The rates are generated alongside the counts. A property that fixed one pair
 * and moved only the counts would prove that pair's arithmetic and say nothing
 * about the rate pairs the catalog actually carries, which is where a sign error
 * or a subtracted leg would live.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { nanoUSD } from '../money/nano-usd.ts';
import { TOOL_CALL_CAP_MAX, toolLoopBound } from '../tool-loop.ts';
import { steppedCallLineItems } from './price-request.ts';
import { evaluateManifest } from './reducers.ts';
import type { StepTokenRates } from './price-request.ts';
import type { ToolLoopBound } from '../tool-loop.ts';

/** A catalog rate in nano-USD per token. A row prices; it never credits. */
const rate = fc.bigInt({ min: 0n }).map((value) => nanoUSD(value));

/** The two token legs of a catalog row. */
const ratePair: fc.Arbitrary<StepTokenRates> = fc
  .tuple(rate, rate)
  .map(([input, output]) => ({ input, output }));

/**
 * A token count — a bigint throughout the money path, and never negative —
 * drawn so the boundaries carry weight: zero and one together come up as often
 * as the non-negative half of the library's own default width. A "never
 * cheaper" claim gives way at the floor and at the step, not in the middle of
 * a range, and that holds for the increment between two counts as much as for
 * the counts themselves.
 */
const tokenCount = fc.oneof(fc.constantFrom(0n, 1n), fc.bigInt({ min: 0n }));

interface PricedTurn {
  readonly rates: StepTokenRates;
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  readonly moreInputTokens: bigint;
  readonly moreOutputTokens: bigint;
  readonly inputChars: number;
  /** A tool loop the model carries, or none. */
  readonly toolLoop: ToolLoopBound | undefined;
}

/** A tool loop at any call budget a turn can declare, or no loop at all. */
const toolLoops: fc.Arbitrary<ToolLoopBound | undefined> = fc.option(
  fc
    .integer({ min: 1, max: TOOL_CALL_CAP_MAX })
    .map((calls) => toolLoopBound(['webSearch'], calls)),
  { nil: undefined }
);

const pricedTurns: fc.Arbitrary<PricedTurn> = fc.record({
  rates: ratePair,
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  moreInputTokens: tokenCount,
  moreOutputTokens: tokenCount,
  inputChars: fc.maxSafeNat(),
  toolLoop: toolLoops,
});

/**
 * The call's total at a pair of token counts. Storage is inside the total: it is
 * money the payer owes on the call, so a law about what a call costs covers it.
 */
function totalNanoUsd(turn: PricedTurn, inputTokens: bigint, outputTokens: bigint): bigint {
  const stepRates = Array.from({ length: turn.toolLoop?.steps ?? 1 }, () => turn.rates);
  const items = steppedCallLineItems(
    [turn.toolLoop === undefined ? { stepRates } : { stepRates, toolLoop: turn.toolLoop }],
    inputTokens,
    turn.inputChars
  );
  return evaluateManifest({ items }, outputTokens, { scope: 'all-in' });
}

describe('the stepped line items', () => {
  it('never prices more tokens cheaper, for any rate pair', () => {
    fc.assert(
      fc.property(pricedTurns, (turn) => {
        const fewer = totalNanoUsd(turn, turn.inputTokens, turn.outputTokens);
        const more = totalNanoUsd(
          turn,
          turn.inputTokens + turn.moreInputTokens,
          turn.outputTokens + turn.moreOutputTokens
        );
        expect(more).toBeGreaterThanOrEqual(fewer);
      })
    );
  });
});
