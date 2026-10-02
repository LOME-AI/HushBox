import { describe, expect, it } from 'vitest';

import { classifierEngineOf } from './classifier-engine.ts';
import { modelId } from './model/model-id.ts';
import { nanoUSD } from './money/nano-usd.ts';
import { TEST_DAY_START } from '../testing/test-time.ts';
import { tokenPricingFixture } from '../testing/pricing-fixture.ts';
import type { PriceableModel } from './model/priceable-model.ts';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_MS = TEST_DAY_START;

function modelFor(id: string, input: bigint, output: bigint): PriceableModel {
  return {
    modelId: modelId(id),
    pricing: tokenPricingFixture({ input: nanoUSD(input), output: nanoUSD(output) }),
    contextLength: 8000,
    providerCap: undefined,
    reasoning: undefined,
    releasedAtMs: FIXTURE_STAMP_MS,
  };
}

describe('classifierEngineOf', () => {
  it('picks the cheapest model by COMBINED per-token rate', () => {
    const cheapPrompt = modelFor('vendor/cheap-prompt', 1n, 100n);
    const cheapBoth = modelFor('vendor/cheap-both', 10n, 10n);
    expect(classifierEngineOf([cheapPrompt, cheapBoth])?.modelId).toBe(
      modelId('vendor/cheap-both')
    );
  });

  it('breaks a rate tie on the identifier, whichever order the pool arrives in', () => {
    const later = modelFor('vendor/b', 5n, 5n);
    const earlier = modelFor('vendor/a', 5n, 5n);
    expect(classifierEngineOf([later, earlier])?.modelId).toBe(modelId('vendor/a'));
    expect(classifierEngineOf([earlier, later])?.modelId).toBe(modelId('vendor/a'));
  });

  it('has no engine over an empty pool', () => {
    expect(classifierEngineOf([])).toBeUndefined();
  });
});
