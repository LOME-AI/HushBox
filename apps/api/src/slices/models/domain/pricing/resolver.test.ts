import { describe, expect, it } from 'vitest';
import { ModelDescriptor } from '@hushbox/shared';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { snapshotResolver } from './resolver.js';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

function descriptor(id: string): ModelDescriptor {
  return ModelDescriptor.parse({
    id,
    provider: 'openai',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: { contextTokens: 400_000 },
    pricing: { kind: 'tokens', anchor: { base: { input: '500', output: '1500' }, tiers: [] } },
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  });
}

describe('snapshotResolver', () => {
  it('resolves a known model id to its descriptor, pricing carried', () => {
    const gpt = descriptor('openai/gpt-5');
    const resolve = snapshotResolver([gpt]);

    const found = resolve('openai/gpt-5');
    expect(found).toBe(gpt);
    expect(found?.pricing).toEqual(tokenPricingFixture({ input: 500n, output: 1500n }));
  });

  it('returns undefined for an unknown model id (fail-closed by omission)', () => {
    const resolve = snapshotResolver([descriptor('openai/gpt-5')]);

    expect(resolve('anthropic/claude')).toBeUndefined();
  });

  it('resolves over an empty snapshot to undefined for every id', () => {
    const resolve = snapshotResolver([]);

    expect(resolve('openai/gpt-5')).toBeUndefined();
  });
});
