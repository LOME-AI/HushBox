import { describe, expect, it } from 'vitest';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { dispatchFamilyFor } from './dispatch.js';
import type { ModelDescriptor } from '@hushbox/shared';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

function descriptorWith(outputs: ModelDescriptor['outputs']): ModelDescriptor {
  return {
    id: 'test/model',
    provider: 'test',
    version: '1',
    inputs: ['text'],
    outputs,
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: tokenPricingFixture({ input: 1n, output: 1n }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

describe('dispatchFamilyFor', () => {
  it('classifies an embedding-output descriptor as embedding', () => {
    expect(dispatchFamilyFor(descriptorWith(['embedding']))).toBe('embedding');
  });

  it('classifies an image-only descriptor as image', () => {
    expect(dispatchFamilyFor(descriptorWith(['image']))).toBe('image');
  });

  it('classifies a video-only descriptor as video', () => {
    expect(dispatchFamilyFor(descriptorWith(['video']))).toBe('video');
  });

  it('classifies a text-output descriptor as language', () => {
    expect(dispatchFamilyFor(descriptorWith(['text']))).toBe('language');
  });

  it('classifies a multi-output descriptor with text as language', () => {
    expect(dispatchFamilyFor(descriptorWith(['text', 'image']))).toBe('language');
  });

  it('media-classifies an image+video descriptor as image (canonical derivation)', () => {
    // Classified language, this shape would skip the media ZDR exposure
    // gate while the adapter routes it to the image call-shape.
    expect(dispatchFamilyFor(descriptorWith(['image', 'video']))).toBe('image');
  });

  it('returns undefined for an audio-only descriptor (excluded with alert by callers)', () => {
    expect(dispatchFamilyFor(descriptorWith(['audio']))).toBeUndefined();
  });
});
