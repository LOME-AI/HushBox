import * as React from 'react';
import { mediaTurnCostNanoUsd } from '@hushbox/shared/affordability';
import type { ChatModality, Model } from '@hushbox/shared';
import type { MediaTurnCostInput } from '@hushbox/shared/affordability';

export interface UseMediaCostEstimateInput {
  modality: ChatModality;
  /**
   * The served rows of the selected models, or `undefined` when there is no row
   * set to price — nothing selected, or a selected model the catalog has not
   * delivered. Every rate those rows carry is billable: fees are baked once at
   * catalog ingestion, so a caller that "corrects" one by applying markup charges
   * the fee twice.
   */
  models: readonly Model[] | undefined;
  /** The resolution a video turn generates at, which keys each model's per-second rate. */
  videoResolution: string;
  /** Seconds generated: a video turn's fixed duration, an audio turn's worst-case cap. */
  durationSeconds: number;
}

/**
 * THE selection projection onto the live catalog: each selected model's served
 * row, in `selectedModels` order, or `undefined` when nothing is selected or the
 * catalog does not carry even one of them. Both media surfaces and the
 * composer's text budget read their rows from here, so they cannot disagree
 * about which turn is priced.
 *
 * A missing row is NOT dropped or priced at zero. That zero used to read as
 * "this model is free": the turn priced at storage alone, the funding resolver
 * compared it, and any headroom cleared it — a FUNDED verdict for a turn nobody
 * could price.
 */
export function selectedServedRows(
  selectedModels: readonly { id: string }[],
  modelCatalog: readonly Model[] | undefined
): readonly Model[] | undefined {
  if (selectedModels.length === 0) return undefined;
  const rows: Model[] = [];
  for (const selected of selectedModels) {
    const row = modelCatalog?.find((model) => model.id === selected.id);
    if (row === undefined) return undefined;
    rows.push(row);
  }
  return rows;
}

/** The producer's input for one media modality's turn. */
function turnOf(
  modality: Exclude<ChatModality, 'text'>,
  models: readonly Model[],
  videoResolution: string,
  durationSeconds: number
): MediaTurnCostInput {
  if (modality === 'image') return { modality, models };
  if (modality === 'video')
    return { modality, models, resolution: videoResolution, durationSeconds };
  return { modality, models, durationSeconds };
}

/**
 * Pre-inference cost estimate for a pending media request, asked of the shared
 * producer over the selected models' served rows. Image and video are exact
 * (every input fixes the cost) and reserve each model's dearest unit, matching
 * the server-side reservation for the same inputs, exact nano-USD. Dollars are
 * never produced here: a surface renders this figure through the shared
 * unit-price formatter, so the estimate and the per-unit rates beside it round
 * identically.
 *
 * `undefined` means there is NO price — a text turn (which prices per token, not
 * per unit), an audio turn (no price kind represents audio), rows the caller
 * could not supply, or a turn the shared producer refuses. It is never `0n` for
 * those: a zero is a price, and this figure reaches the funding resolver, where
 * any headroom clears a zero minimum.
 */
export function useMediaCostEstimate(input: UseMediaCostEstimateInput): bigint | undefined {
  const { modality, models, videoResolution, durationSeconds } = input;

  return React.useMemo(() => {
    if (modality === 'text' || models === undefined) return;
    const cost = mediaTurnCostNanoUsd(turnOf(modality, models, videoResolution, durationSeconds));
    return cost.ok ? cost.value : undefined;
  }, [modality, models, videoResolution, durationSeconds]);
}
