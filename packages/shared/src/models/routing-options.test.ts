import { describe, expect, it } from 'vitest';
import {
  imageRoutingOptions,
  languageRoutingOptions,
  mediaRoutingOptions,
} from './routing-options.ts';

/** Claude Sonnet 4.5's call cap: its own dearest tier's ceiling, un-baked. */
const SONNET_MAX_PRICE = { prompt: '7.500000', completion: '28.125217' };

describe('languageRoutingOptions', () => {
  it('routes cheapest-first with fallbacks under the call max_price, ZDR and no collection', () => {
    const options = languageRoutingOptions({
      reasoning: false,
      maxPrice: { prompt: '3.750434', completion: '18.750434' },
    });

    expect(options.provider).toEqual({
      zdr: true,
      data_collection: 'deny',
      allow_fallbacks: true,
      sort: 'price',
      max_price: { prompt: '3.750434', completion: '18.750434' },
    });
  });

  it('enables inline usage/cost accounting', () => {
    expect(languageRoutingOptions({ reasoning: false, maxPrice: SONNET_MAX_PRICE }).usage).toEqual({
      include: true,
    });
  });

  it('disables prompt transforms via extraBody, not provider', () => {
    const options = languageRoutingOptions({ reasoning: false, maxPrice: SONNET_MAX_PRICE });

    // transforms rides extraBody so it cannot clobber the typed provider block.
    expect(options.extraBody).toEqual({ transforms: [] });
    expect('provider' in options.extraBody).toBe(false);
  });

  it('produces a fresh object each call', () => {
    const variant = { reasoning: false, maxPrice: SONNET_MAX_PRICE };
    expect(languageRoutingOptions(variant)).not.toBe(languageRoutingOptions(variant));
  });

  it('sets require_parameters on the provider block when the call carries reasoning', () => {
    const options = languageRoutingOptions({ reasoning: true, maxPrice: SONNET_MAX_PRICE });

    expect(options.provider).toEqual({
      zdr: true,
      data_collection: 'deny',
      allow_fallbacks: true,
      sort: 'price',
      max_price: SONNET_MAX_PRICE,
      require_parameters: true,
    });
  });

  it('omits require_parameters entirely when the call carries no reasoning', () => {
    const options = languageRoutingOptions({ reasoning: false, maxPrice: SONNET_MAX_PRICE });

    expect('require_parameters' in options.provider).toBe(false);
  });
});

describe('mediaRoutingOptions', () => {
  it('carries the ZDR provider block without fallbacks, sort or max_price inside extraBody', () => {
    const options = mediaRoutingOptions();

    // Video settings expose no typed provider, so the whole block rides
    // extraBody.provider (which replaces settings.provider on the wire).
    expect(options.extraBody.provider).toEqual({
      zdr: true,
      data_collection: 'deny',
      allow_fallbacks: false,
    });
  });

  it('disables prompt transforms alongside the provider block', () => {
    expect(mediaRoutingOptions().extraBody.transforms).toEqual([]);
  });

  it('sets no typed top-level provider (nothing for extraBody to replace)', () => {
    expect('provider' in mediaRoutingOptions()).toBe(false);
  });

  it('produces a fresh object each call', () => {
    expect(mediaRoutingOptions()).not.toBe(mediaRoutingOptions());
  });
});

describe('imageRoutingOptions', () => {
  it('allows only the pinned endpoint tags', () => {
    const options = imageRoutingOptions(['google-vertex/global', 'seed']);

    expect(options.provider.only).toEqual(['google-vertex/global', 'seed']);
  });

  it('turns fallbacks off', () => {
    expect(imageRoutingOptions(['seed']).provider.allow_fallbacks).toBe(false);
  });

  it('sends only the two routing fields the Images API documents', () => {
    expect(imageRoutingOptions(['seed']).provider).toEqual({
      only: ['seed'],
      allow_fallbacks: false,
    });
  });

  it('carries no extraBody, so nothing can replace the typed provider', () => {
    expect('extraBody' in imageRoutingOptions(['seed'])).toBe(false);
  });

  it('copies the pin, so the settings never alias the descriptor', () => {
    const pin: readonly [string, ...string[]] = ['seed'];

    expect(imageRoutingOptions(pin).provider.only).not.toBe(pin);
  });

  it('refuses an empty tag list', () => {
    const empty: readonly string[] = [];

    // The cast is the case under test: the builder's runtime refusal of an
    // empty pin, which the non-empty tuple type already forbids at compile time.
    expect(() => imageRoutingOptions(empty as readonly [string, ...string[]])).toThrow(
      /no ZDR endpoint/
    );
  });
});
