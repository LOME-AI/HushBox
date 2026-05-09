import { isZdrModel, type RawModel } from '@hushbox/shared/models';
import { parseTokenPrice, assertNever } from '@hushbox/shared';
import type { ModelInfo, ModelPricing } from './types.js';

/**
 * Map a fully-merged RawModel (output of shared `fetchModels`, which merges
 * the SDK `/config` endpoint with the public `/v1/models` endpoint for media
 * pricing) to the AIClient-layer ModelInfo shape.
 *
 * Lives in its own module so both `real.ts` and `mock.ts` derive ModelInfo
 * the same way, keeping one source of truth for the raw → info translation.
 * Pulling it through `real.ts` would force `mock.ts` to transitively load the
 * AI SDK at module-eval time.
 */
export function rawModelToModelInfo(raw: RawModel): ModelInfo {
  // `String.split('/')[0]` always returns a string at runtime, so `??` would
  // never fire. The explicit length check also catches rogue models with an
  // empty id, surfacing them as `'unknown'` instead of an empty provider.
  const segment = raw.id.split('/')[0];
  const provider = segment !== undefined && segment.length > 0 ? segment : 'unknown';
  return {
    id: raw.id,
    name: raw.name,
    provider,
    modality: raw.modality,
    description: raw.description,
    contextLength: raw.context_length,
    pricing: pricingFromRawModel(raw),
    capabilities: [],
    isZdr: isZdrModel(raw.id, raw.modality),
  };
}

function pricingFromRawModel(raw: RawModel): ModelPricing {
  switch (raw.modality) {
    case 'text': {
      const ws = raw.pricing.web_search;
      const webSearchPerCall = ws === undefined ? undefined : parseTokenPrice(ws);
      return {
        kind: 'token',
        inputPerToken: parseTokenPrice(raw.pricing.prompt),
        outputPerToken: parseTokenPrice(raw.pricing.completion),
        ...(webSearchPerCall === undefined ? {} : { webSearchPerCall }),
      };
    }
    case 'image': {
      const rawPerImage = raw.pricing.per_image;
      return {
        kind: 'image',
        perImage: rawPerImage === undefined ? 0 : parseTokenPrice(rawPerImage),
      };
    }
    case 'video': {
      const rawMap = raw.pricing.per_second_by_resolution ?? {};
      const perSecondByResolution = Object.fromEntries(
        Object.entries(rawMap).map(([res, price]) => [res, parseTokenPrice(price)])
      );
      return { kind: 'video', perSecondByResolution };
    }
    case 'audio': {
      // The shared `fetchModels` doesn't extract audio per-second pricing
      // from the public `/v1/models` endpoint yet. Hardcoding 0 here mirrors
      // the gap; mocks override this on the ModelInfo where they need a
      // non-zero price for billing math.
      return { kind: 'audio', perSecond: 0 };
    }
    default: {
      return assertNever(raw.modality);
    }
  }
}
