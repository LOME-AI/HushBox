import { describe, expect, it } from 'vitest';

import { mediaModelFrom } from './media-model.ts';
import { modelId } from '../model/model-id.ts';
import { SECOND_MS, TEST_DAY_START, secondsAt } from '../../testing/test-time.ts';
import { priceableModelFrom } from '../model/priceable-model.ts';
import {
  perImagePricingFixture,
  perSecondPricingFixture,
  tokenPricingFixture,
} from '../../testing/pricing-fixture.ts';
import type { ModelDescriptor } from '../model/model-descriptor.ts';

/**
 * A release date and the catalog fetch that saw it, 100 seconds later. Nothing
 * in this file reads either against a clock; only their order is meaningful.
 */
const RELEASED_AT_SECONDS = secondsAt(TEST_DAY_START);
const FETCHED_AT_SECONDS = secondsAt(TEST_DAY_START + 100 * SECOND_MS);

type MediaRow = Parameters<typeof mediaModelFrom>[0];

const IMAGE_PARAMETERS = {
  aspectRatio: { type: 'enum', values: ['1:1', '16:9'], wire: 'providerOptions' },
  n: { type: 'integer', min: 1, max: 4, wire: 'providerOptions' },
} as const satisfies ModelDescriptor['parameters'];

const VIDEO_PARAMETERS = {
  resolution: { type: 'enum', values: ['720p', '1080p'], wire: 'providerOptions' },
  aspectRatio: { type: 'enum', values: ['16:9', '9:16'], wire: 'providerOptions' },
  durationSeconds: { type: 'enum', values: [4, 8], wire: 'providerOptions' },
} as const satisfies ModelDescriptor['parameters'];

const IMAGE_PRICING = perImagePricingFixture({ anchor: 40_000_000n, dearest: 90_000_000n });

const VIDEO_PRICING = perSecondPricingFixture({
  anchor: { '720p': 150_000_000n, '1080p': 400_000_000n },
  dearest: { '720p': 300_000_000n, '1080p': 800_000_000n },
});

function imageRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: 'vendor/imagen',
    outputs: ['image'],
    parameters: IMAGE_PARAMETERS,
    pricing: IMAGE_PRICING,
    ...overrides,
  };
}

function videoRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: 'vendor/veo',
    outputs: ['video'],
    parameters: VIDEO_PARAMETERS,
    pricing: VIDEO_PRICING,
    ...overrides,
  };
}

function descriptorOf(row: MediaRow): ModelDescriptor {
  return {
    id: row.id,
    provider: 'vendor',
    version: '3',
    inputs: ['text'],
    outputs: [...row.outputs],
    parameters: { ...row.parameters },
    behaviors: [],
    limits: {},
    pricing: row.pricing,
    zdrReachable: true,
    releasedAt: RELEASED_AT_SECONDS,
    fetchedAt: FETCHED_AT_SECONDS,
  };
}

const LANGUAGE_PRICING = tokenPricingFixture({ input: 300n, output: 1500n });

function languageDescriptor(): ModelDescriptor {
  return {
    id: 'vendor/model',
    provider: 'vendor',
    version: '3',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: { contextLength: 200_000, maxOutputTokens: 64_000 },
    pricing: LANGUAGE_PRICING,
    zdrReachable: true,
    releasedAt: RELEASED_AT_SECONDS,
    fetchedAt: FETCHED_AT_SECONDS,
  };
}

function languageRow(): MediaRow {
  return { id: 'vendor/model', outputs: ['text'], parameters: {}, pricing: LANGUAGE_PRICING };
}

describe('mediaModelFrom', () => {
  it('projects an image row onto its per-image price and its own catalog domains', () => {
    expect(mediaModelFrom(imageRow())).toEqual({
      modelId: modelId('vendor/imagen'),
      pricing: IMAGE_PRICING,
      parameters: IMAGE_PARAMETERS,
    });
  });

  it('projects a video row onto its per-second price', () => {
    expect(mediaModelFrom(videoRow())?.pricing).toEqual(VIDEO_PRICING);
  });

  it('refuses an image row priced per second, a unit its call shape never bills', () => {
    expect(mediaModelFrom(imageRow({ pricing: VIDEO_PRICING }))).toBeUndefined();
  });

  it('refuses a video row priced per image', () => {
    expect(mediaModelFrom(videoRow({ pricing: IMAGE_PRICING }))).toBeUndefined();
  });

  it('refuses a language row, so the two projections partition the catalog', () => {
    expect(mediaModelFrom(languageRow())).toBeUndefined();
  });

  it('refuses a merged text+image row, which the token path already prices', () => {
    expect(mediaModelFrom(imageRow({ outputs: ['text', 'image'] }))).toBeUndefined();
  });

  it('does not widen when the carrier grows a field', () => {
    const grown = { ...imageRow(), popularityRank: 3, name: 'Imagen' };
    const projected = mediaModelFrom(grown);
    expect(Object.keys(projected ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'modelId',
      'parameters',
      'pricing',
    ]);
  });
});

describe('the media and priceable projections are disjoint', () => {
  // The structural half of "no media row reaches `CatalogSnapshot.models`": every
  // row the media projection accepts is one the priceable constructor's own
  // fail-closed gates already refuse, so the three money verdicts taken over
  // that pool (the outlier median, the premium threshold, the classifier engine)
  // cannot see a media row however the media dimensions grow.
  it.each([
    ['image', imageRow(), descriptorOf(imageRow())],
    ['video', videoRow(), descriptorOf(videoRow())],
  ])(
    'refuses a %s row from the priceable pool it projects into media',
    (_family, row, descriptor) => {
      expect(mediaModelFrom(row)).toBeDefined();
      expect(priceableModelFrom(descriptor)).toBeUndefined();
    }
  );

  it('keeps a language row out of the media pool it prices in the token pool', () => {
    expect(priceableModelFrom(languageDescriptor())).toBeDefined();
    expect(mediaModelFrom(languageRow())).toBeUndefined();
  });
});
