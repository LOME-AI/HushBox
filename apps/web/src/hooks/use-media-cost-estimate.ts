import * as React from 'react';
import type { Modality } from '@hushbox/shared';
import { computeImageWorstCaseCents, estimateVideoWorstCaseCents } from '@hushbox/shared';

export interface ImagePricing {
  /** Pre-fee USD per image. */
  perImage: number;
}

export interface VideoPricing {
  /** Pre-fee USD per second. */
  perSecond: number;
  durationSeconds: number;
}

export interface UseMediaCostEstimateInput {
  modality: Modality;
  modelCount: number;
  imagePricing?: ImagePricing;
  videoPricing?: VideoPricing;
}

export interface MediaCostEstimate {
  estimatedCents: number;
  estimatedDollars: number;
}

/**
 * Worst-case pre-inference cost estimate for a pending media request.
 * Agnostic to how pricing is sourced — the caller passes numbers in directly.
 * Returns 0 for modalities without a per-unit price (text) or when pricing
 * isn't yet available. Computed via the same helpers the backend uses for
 * reservation, so the UI estimate matches the server-side worst case exactly.
 */
export function useMediaCostEstimate(input: UseMediaCostEstimateInput): MediaCostEstimate {
  const { modality, modelCount, imagePricing, videoPricing } = input;

  return React.useMemo(() => {
    if (modelCount === 0) return { estimatedCents: 0, estimatedDollars: 0 };

    let cents = 0;
    if (modality === 'image' && imagePricing) {
      cents = computeImageWorstCaseCents(imagePricing.perImage, modelCount);
    } else if (modality === 'video' && videoPricing) {
      cents = estimateVideoWorstCaseCents({
        perSecond: videoPricing.perSecond,
        durationSeconds: videoPricing.durationSeconds,
        modelCount,
      });
    }

    return { estimatedCents: cents, estimatedDollars: cents / 100 };
  }, [modality, modelCount, imagePricing, videoPricing]);
}
