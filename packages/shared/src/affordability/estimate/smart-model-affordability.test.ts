import { describe, expect, it } from 'vitest';
import { CLASSIFIER_OUTPUT_TOKEN_CAP } from '../smart-model/eligible-models.ts';
import {
  buildClassifierSystemPrompt,
  computeClassifierPromptOverhead,
  MAX_CLASSIFIER_CONTEXT_CHARS,
} from '../smart-model/prompts.ts';
import { inputTokensOf } from '../price/quantities.ts';
import { classifierReserveChars, classifierWorstCaseNanoUsd } from './smart-model-affordability.ts';
import { tokenPricingFixture } from '../../testing/pricing-fixture.ts';

const CHEAP = {
  id: 'cheap',
  description: 'cheap and fast',
  pricing: tokenPricingFixture({ input: 1n, output: 2n }),
};

describe('classifierReserveChars', () => {
  const pool = [{ id: 'a/one' }, { id: 'b/two' }];

  it('is the truncation budget plus the worst-case rendered prompt overhead', () => {
    expect(classifierReserveChars(pool)).toBe(
      MAX_CLASSIFIER_CONTEXT_CHARS + computeClassifierPromptOverhead(pool)
    );
  });

  /**
   * The reserve's whole point: it bounds the classifier call the executor will
   * actually send. The excerpt leg is bounded on the emitting side (the
   * truncator emits no more than {@link MAX_CLASSIFIER_CONTEXT_CHARS}, pinned
   * where it lives); the template leg is bounded here, against a real render of
   * the same model list carrying descriptions of any length.
   */
  it('bounds a real render of the same pool, whatever its descriptions say', () => {
    const excerpt = 'e'.repeat(MAX_CLASSIFIER_CONTEXT_CHARS);
    for (const description of ['', 'short', 'x'.repeat(5000)]) {
      const sent =
        buildClassifierSystemPrompt({
          eligibleModels: pool.map((model) => ({ ...model, description })),
          classifyEffort: true,
        }).length + excerpt.length;
      expect(classifierReserveChars(pool)).toBeGreaterThanOrEqual(sent);
    }
  });

  /**
   * The reserve is a money input, so its arithmetic is pinned at exact figures
   * and not only by the relations above: a change that keeps every relation true
   * while moving the number still moves an admission hold.
   */
  it('reserves exactly the budget plus the rendered template, per pool size', () => {
    const pools = [[], [{ id: 'cheap' }], [{ id: 'a/one' }, { id: 'b/two' }]];
    expect(pools.map((entry) => classifierReserveChars(entry))).toEqual([4708, 4882, 5006]);
  });
});

describe('classifierWorstCaseNanoUsd', () => {
  it('answers the classifier reserve as one fixed nano-USD figure', () => {
    // The whole reserve is the provider call: the classifier's prompt and answer
    // never rest, so no storage leg is priced, and the figure is fixed — nothing
    // in it scales with the turn's output.
    const inputTokens = BigInt(inputTokensOf(classifierReserveChars([CHEAP])));
    expect(classifierWorstCaseNanoUsd(CHEAP, [{ id: 'cheap' }])).toBe(
      inputTokens * 1n + BigInt(CLASSIFIER_OUTPUT_TOKEN_CAP) * 2n
    );
  });

  it('reserves 1,570 input tokens for the 4,708 characters of an empty candidate list', () => {
    // ceil(4,708 / 3) = 1,570 input tokens and the 2,048-token output cap, both at 173 nano.
    const engine = { pricing: tokenPricingFixture({ input: 173n, output: 173n }) };
    expect(classifierReserveChars([])).toBe(4708);
    expect(classifierWorstCaseNanoUsd(engine, [])).toBe((1570n + 2048n) * 173n);
  });

  it('grows with the candidate list the classifier prompt will carry', () => {
    const alone = classifierWorstCaseNanoUsd(CHEAP, []);
    expect(classifierWorstCaseNanoUsd(CHEAP, [{ id: 'cheap' }, { id: 'big' }])).toBeGreaterThan(
      alone
    );
  });

  it('prices the reserve at the billable rates as given — no markup on top', () => {
    // Rates are billable at ingestion, so the reserve is exactly the folded line
    // items; a fee applied here would be a third seam.
    const doubled = {
      ...CHEAP,
      pricing: tokenPricingFixture({ input: 2n, output: 4n }),
    };
    expect(classifierWorstCaseNanoUsd(doubled, [{ id: 'cheap' }])).toBe(
      classifierWorstCaseNanoUsd(CHEAP, [{ id: 'cheap' }]) * 2n
    );
  });
});
