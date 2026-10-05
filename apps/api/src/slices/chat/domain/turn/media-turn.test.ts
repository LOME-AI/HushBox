import { describe, expect, it } from 'vitest';
import { mediaParameterSpecs } from '@hushbox/shared/affordability';
import { perImagePricingFixture } from '@hushbox/shared/pricing-fixture';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { createTurnCompileRegistries } from './definition.js';
import { buildMediaTurn } from './media-turn.js';
import type { ModelPricingResolver } from '../../../models/index.js';
import type { ModelDescriptor, ParamSpec } from '@hushbox/shared';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

/** A text→image descriptor offering 1K and 2K, with `resolution` as given. */
function imageDescriptor(id: string, resolution: Partial<ParamSpec> = {}): ModelDescriptor {
  const parameters = mediaParameterSpecs({ aspectRatio: ['1:1'], resolution: ['1K', '2K'] });
  return {
    id,
    provider: 'p',
    version: '4',
    inputs: ['text'],
    outputs: ['image'],
    parameters: {
      ...parameters,
      resolution: { type: 'enum', values: ['1K', '2K'], ...resolution },
    },
    behaviors: [],
    limits: {},
    pricing: perImagePricingFixture({ anchor: 46_000_000n, dearest: 92_000_000n }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

const CATALOG: Readonly<Record<string, ModelDescriptor>> = {
  'variant-priced': imageDescriptor('variant-priced', { default: '1K' }),
  'single-priced': imageDescriptor('single-priced'),
};

const resolve: ModelPricingResolver = (id) => CATALOG[id];

/** The params each compiled modelCall node carries, in node order. */
function nodeParams(
  models: readonly string[],
  params: Readonly<Record<string, unknown>>
): unknown[] {
  const { nodes, constraints } = createTurnCompileRegistries(resolve);
  const definition = buildMediaTurn({
    models,
    modality: 'image',
    params,
    nodes,
    constraints,
    resolve,
  })._unsafeUnwrap();
  return definition.nodes.flatMap((node) => (node.type === 'modelCall' ? [node.params] : []));
}

describe('buildMediaTurn resolution default', () => {
  it("sends a model's declared resolution default when the request names none", () => {
    expect(nodeParams(['variant-priced'], { aspectRatio: '1:1' })).toEqual([
      { aspectRatio: '1:1', resolution: '1K' },
    ]);
  });

  it('keeps the resolution the request names', () => {
    expect(nodeParams(['variant-priced'], { aspectRatio: '1:1', resolution: '2K' })).toEqual([
      { aspectRatio: '1:1', resolution: '2K' },
    ]);
  });

  it('sends no resolution for a model that declares no default', () => {
    expect(nodeParams(['single-priced'], { aspectRatio: '1:1' })).toEqual([{ aspectRatio: '1:1' }]);
  });

  it("gives each model of a multi-model turn its own model's default", () => {
    expect(nodeParams(['variant-priced', 'single-priced'], { aspectRatio: '1:1' })).toEqual([
      { aspectRatio: '1:1', resolution: '1K' },
      { aspectRatio: '1:1' },
    ]);
  });
});
