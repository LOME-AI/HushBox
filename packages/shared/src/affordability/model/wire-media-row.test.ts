/**
 * The per-unit wire hop, pinned where it lives — the sibling of
 * `wire-pool-row.test.ts` for the projection the media producer consumes.
 */

import { describe, expect, it } from 'vitest';

import { modelId } from './model-id.ts';
import { mediaModelFromWire } from './wire-media-row.ts';
import { perImagePricingFixture, perSecondPricingFixture } from '../../testing/pricing-fixture.ts';
import { TEST_DAY_START, secondsAt } from '../../testing/test-time.ts';
import type { Model } from '../../schemas/api/models.ts';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

function wireRowFor(overrides: Partial<Model> = {}): Model {
  return {
    id: 'vendor/imager',
    name: 'Vendor Imager',
    provider: 'vendor',
    modality: 'image',
    contextLength: 0,
    pricing: { perImage: '40000000', dearestPerImage: '90000000' },
    description: 'an image model',
    supportedParameters: [],
    created: FIXTURE_STAMP_SECONDS,
    ...overrides,
  };
}

function videoRowFor(overrides: Partial<Model> = {}): Model {
  return wireRowFor({
    id: 'vendor/mover',
    modality: 'video',
    pricing: {
      perSecondByResolution: { '720p': '5000000', '1080p': '9000000' },
      dearestPerSecondByResolution: { '720p': '15000000', '1080p': '27000000' },
    },
    ...overrides,
  });
}

describe('mediaModelFromWire', () => {
  it('turns an image row into a per-image projection carrying both sides of its price', () => {
    expect(mediaModelFromWire(wireRowFor())).toEqual({
      modelId: modelId('vendor/imager'),
      pricing: perImagePricingFixture({ anchor: 40_000_000n, dearest: 90_000_000n }),
      parameters: {},
    });
  });

  it('turns a video row into a per-second projection carrying both matrices', () => {
    expect(mediaModelFromWire(videoRowFor())).toEqual({
      modelId: modelId('vendor/mover'),
      pricing: perSecondPricingFixture({
        anchor: { '720p': 5_000_000n, '1080p': 9_000_000n },
        dearest: { '720p': 15_000_000n, '1080p': 27_000_000n },
      }),
      parameters: {},
    });
  });

  it('mints the aspect-ratio domain the wire declares', () => {
    const projected = mediaModelFromWire(wireRowFor({ supportedAspectRatios: ['1:1', '16:9'] }));
    expect(projected?.parameters['aspectRatio']).toEqual({
      type: 'enum',
      values: ['1:1', '16:9'],
      wire: 'providerOptions',
    });
  });

  it('mints the video resolution and duration domains the wire declares', () => {
    const projected = mediaModelFromWire(
      videoRowFor({ supportedVideoResolutions: ['720p'], supportedVideoDurationsSeconds: [4, 8] })
    );
    expect(projected?.parameters['resolution']).toEqual({
      type: 'enum',
      values: ['720p'],
      wire: 'providerOptions',
    });
    expect(projected?.parameters['durationSeconds']).toEqual({
      type: 'enum',
      values: [4, 8],
      wire: 'providerOptions',
    });
  });

  it('refuses a row with no rate for its own modality rather than pricing it free', () => {
    expect(mediaModelFromWire(wireRowFor({ pricing: {} }))).toBeUndefined();
    expect(mediaModelFromWire(videoRowFor({ pricing: {} }))).toBeUndefined();
  });

  it('refuses a text row — the token projection already prices it', () => {
    const text = wireRowFor({
      modality: 'text',
      pricing: { inputPerToken: '300', outputPerToken: '1500' },
    });
    expect(mediaModelFromWire(text)).toBeUndefined();
  });

  it('refuses a rate the wire declares as zero, which no price can carry', () => {
    const zero = wireRowFor({ pricing: { perImage: '0', dearestPerImage: '0' } });
    expect(mediaModelFromWire(zero)).toBeUndefined();
  });
});
