import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { modelCatalog } from '@hushbox/db';
import { ModelDescriptor } from '@hushbox/shared';
import { mediaParameterSpecs } from '@hushbox/shared/affordability';
import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from '@hushbox/shared/pricing-fixture';
import {
  MODEL,
  WEB_SEARCH_MODEL_PREFIX,
  db,
  seedGateModel,
  seedImageGateModel,
  seedModelId,
  seedToolCapableModelId,
  seedTrialDecoys,
  seedUnrepresentableGateModel,
  seedVideoGateModel,
  seededModelIds,
  trialDecoyModelIds,
} from './chat-routes.integration.setup.js';

/**
 * Parsed, so a fixture that stopped producing a legal descriptor fails here.
 * Parsing is also what turns the stored `NanoUSD` rate STRINGS into bigints,
 * which is the form the assertions below are written in.
 */
async function seededDescriptor(modelId: string): Promise<ModelDescriptor> {
  const rows = await db
    .select({ descriptor: modelCatalog.descriptor })
    .from(modelCatalog)
    .where(eq(modelCatalog.modelId, modelId));
  const descriptor = rows[0]?.descriptor;
  if (descriptor === undefined) throw new Error(`no catalog row for ${modelId}`);
  return ModelDescriptor.parse(descriptor);
}

function freshModelId(): string {
  return `chat-route/${crypto.randomUUID().slice(0, 8)}`;
}

/** Members as text, in a stable order — for comparing two collections as sets. */
function sortedText(values: readonly (string | number)[]): string[] {
  return values.map(String).toSorted((a, b) => a.localeCompare(b));
}

describe('seedModelId', () => {
  it('declares streaming, which is what ingestion emits for a language row', async () => {
    await seedModelId(MODEL);
    const descriptor = await seededDescriptor(MODEL);
    expect(descriptor.behaviors).toEqual(['streaming']);
  });
});

describe('seedTrialDecoys', () => {
  it('declares streaming on every decoy, which is what ingestion emits for a language row', async () => {
    await seedTrialDecoys();
    const descriptors = await Promise.all(
      trialDecoyModelIds.map((modelId) => seededDescriptor(modelId))
    );
    const behaviors = descriptors.map((descriptor) => descriptor.behaviors);
    // Non-empty first: the expected side is derived from this same array, so a
    // seeder that minted nothing would compare [] to [] and pass vacuously.
    expect(trialDecoyModelIds.length).toBeGreaterThan(0);
    // One expected entry per minted id rather than a literal triple: the decoy
    // count is a price-distribution detail this pin must not redden on.
    expect(behaviors).toEqual(trialDecoyModelIds.map(() => ['streaming']));
  });

  it('carries the rate ingestion charges for its declared gateway price, not that price', async () => {
    await seedTrialDecoys();
    const modelId = trialDecoyModelIds[0];
    if (modelId === undefined) throw new Error('no decoy was minted');
    const descriptor = await seededDescriptor(modelId);
    // A decoy declares 1 USD per token at the gateway. The catalog stores
    // billable rates, so the row carries that rate marked up and ceil-rounded —
    // a number no hand-written fixture lands on by accident.
    expect(descriptor.pricing).toEqual(
      tokenPricingFixture({ input: 1_150_000_000n, output: 1_150_000_000n })
    );
  });
});

describe('seedGateModel', () => {
  it('keeps the sibling rates when an override names one rate inside pricing', async () => {
    const modelId = freshModelId();
    await seedGateModel(modelId, { pricing: { anchor: { base: { output: '7' } } } });
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.pricing).toEqual(tokenPricingFixture({ input: 2n, output: 7n }));
  });

  it('keeps the context length when an override names another limit', async () => {
    const modelId = freshModelId();
    await seedGateModel(modelId, { limits: { maxOutputTokens: 4096 } });
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.limits).toEqual({ contextLength: 100_000, maxOutputTokens: 4096 });
  });

  it('replaces a scalar field outright', async () => {
    const modelId = freshModelId();
    await seedGateModel(modelId, { releasedAt: 42 });
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.releasedAt).toBe(42);
  });

  it('replaces an array field outright rather than concatenating it', async () => {
    const modelId = freshModelId();
    await seedGateModel(modelId, { behaviors: ['tools'] });
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.behaviors).toEqual(['tools']);
  });
});

describe('seedUnrepresentableGateModel', () => {
  it('replaces the whole price when an override names pricing', async () => {
    const modelId = freshModelId();
    await seedUnrepresentableGateModel(modelId, {
      pricing: { kind: 'perImage', anchor: '7', dearest: '7' },
    });
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.pricing).toEqual(perImagePricingFixture({ anchor: 7n, dearest: 7n }));
  });

  it('leaves a model with no context length at all when given empty limits', async () => {
    const modelId = freshModelId();
    await seedUnrepresentableGateModel(modelId, { limits: {} });
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.limits).toEqual({});
  });
});

describe('seedImageGateModel', () => {
  it('prices an image model on perImage alone, never alongside token rates', async () => {
    const modelId = freshModelId();
    await seedImageGateModel(modelId);
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.outputs).toEqual(['image']);
    expect(descriptor.pricing).toEqual(
      perImagePricingFixture({ anchor: 40_000_000n, dearest: 40_000_000n })
    );
  });

  it('declares no context length, which is what ingestion emits for a media row', async () => {
    const modelId = freshModelId();
    await seedImageGateModel(modelId);
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.limits).toEqual({});
  });

  it('declares an aspect-ratio domain, without which ingestion excludes the row', async () => {
    const modelId = freshModelId();
    await seedImageGateModel(modelId);
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.parameters).toEqual(mediaParameterSpecs({ aspectRatio: ['1:1', '4:3'] }));
  });

  it('declares no behaviors, which is what ingestion emits for a media row', async () => {
    const modelId = freshModelId();
    await seedImageGateModel(modelId);
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.behaviors).toEqual([]);
  });
});

describe('seedVideoGateModel', () => {
  it('prices a video model on resolution SKUs alone, never alongside token rates', async () => {
    const modelId = freshModelId();
    await seedVideoGateModel(modelId);
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.outputs).toEqual(['video']);
    const skus = { '720p': 40_000_000n, '1080p': 80_000_000n };
    expect(descriptor.pricing).toEqual(perSecondPricingFixture({ anchor: skus, dearest: skus }));
  });

  it('declares no context length, which is what ingestion emits for a media row', async () => {
    const modelId = freshModelId();
    await seedVideoGateModel(modelId);
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.limits).toEqual({});
  });

  it('declares every media axis, without which ingestion excludes the row', async () => {
    const modelId = freshModelId();
    await seedVideoGateModel(modelId);
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.parameters).toEqual(
      mediaParameterSpecs({
        aspectRatio: ['16:9'],
        resolution: ['720p', '1080p'],
        durationSeconds: [6],
      })
    );
  });

  it('declares no behaviors, which is what ingestion emits for a media row', async () => {
    const modelId = freshModelId();
    await seedVideoGateModel(modelId);
    const descriptor = await seededDescriptor(modelId);
    expect(descriptor.behaviors).toEqual([]);
  });

  it('prices exactly the resolutions it declares, never a wider or narrower set', async () => {
    const modelId = freshModelId();
    await seedVideoGateModel(modelId);
    const descriptor = await seededDescriptor(modelId);
    const declared = descriptor.parameters['resolution'];
    const priced = descriptor.pricing.kind === 'perSecond' ? descriptor.pricing.anchor : undefined;
    if (declared?.type !== 'enum' || declared.values === undefined || priced === undefined) {
      throw new Error('expected an enum resolution spec and a per-resolution rate map');
    }
    // Set equality, not order: jsonb reorders an object's keys by length then
    // bytes, so an order-sensitive comparison would redden on ORDER alone the
    // moment a third resolution is added — a false coupling break.
    expect(sortedText(Object.keys(priced))).toEqual(sortedText(declared.values));
  });
});

/**
 * The seeders whose id comes from the caller. The cleanup cannot enumerate such
 * an id from a constant, so registration is the only thing that deletes it —
 * and the catalog these rows land in is one table per worker slot, shared with
 * every later test file that runs there.
 */
describe('cleanup registration', () => {
  it('registers a text model seeded under a caller-minted id', async () => {
    const modelId = freshModelId();
    await seedModelId(modelId);
    expect(seededModelIds).toContain(modelId);
  });

  it('registers a tool-capable model seeded under a caller-minted id', async () => {
    const modelId = `${WEB_SEARCH_MODEL_PREFIX}/${crypto.randomUUID().slice(0, 8)}`;
    await seedToolCapableModelId(modelId);
    expect(seededModelIds).toContain(modelId);
  });
});
