import { nanoUnitPriceUsd, shortenModelName } from '@hushbox/shared';
import { modelPriceDisplay, nanoRateCompactPer1k } from '@hushbox/shared/affordability';
import { modelSwatch } from '@/lib/utils/model-color';
import type { Model } from '@hushbox/shared';
import type { ModelPriceDisplay } from '@hushbox/shared/affordability';
import type { ModelSwatch } from '@hushbox/shared/design-tokens';

export interface ModelInfoRate {
  readonly kind: 'input' | 'output' | 'image';
  readonly value: string;
}

/** What the new chat's model readout says about the composer's model, in reading order. */
interface ModelInfoFacts {
  readonly swatch: ModelSwatch;
  readonly label: string;
  readonly maker?: string;
  readonly rates: readonly ModelInfoRate[];
}

/** The Smart Model's line wherever a model's maker would stand. */
export const SMART_MODEL_ROLE = 'Auto-picks the best model';

/**
 * The composer chip's label for a selection, which the readout repeats: the first model's
 * short name, then how many more are selected.
 */
export function modelSelectionLabel(firstModelName: string, selectionCount: number): string {
  const name = shortenModelName(firstModelName);
  return selectionCount > 1 ? `${name} + ${String(selectionCount - 1)}` : name;
}

/**
 * What a surface shows of a served row's price, from the shared display
 * producer this file publishes in `apps/web`. Reading a row's price here rather
 * than off its rate fields is what makes a row the catalog cannot price show,
 * sort and pick as unpriced instead of free.
 */
export function priceDisplayOf(model: Model): ModelPriceDisplay {
  return modelPriceDisplay(model);
}

function perThousand(rate: bigint | undefined): string | undefined {
  return rate === undefined ? undefined : nanoRateCompactPer1k(rate);
}

/** A pool range needs both bounds; a missing one is an unknown, never a rate of zero. */
function rangePerThousand(range: ModelPriceDisplay['inputRangeNanoUsd']): string | undefined {
  return range === undefined ? undefined : nanoRateCompactPer1k(range.min, range.max);
}

function tokenRates(input: string | undefined, output: string | undefined): ModelInfoRate[] {
  const rates: ModelInfoRate[] = [];
  if (input !== undefined) rates.push({ kind: 'input', value: input });
  if (output !== undefined) rates.push({ kind: 'output', value: output });
  return rates;
}

/** The Smart Model's rates run from its cheapest pool's to its dearest's. */
function smartModelRates(model: Model): ModelInfoRate[] {
  const { inputRangeNanoUsd, outputRangeNanoUsd } = priceDisplayOf(model);
  return tokenRates(rangePerThousand(inputRangeNanoUsd), rangePerThousand(outputRangeNanoUsd));
}

/**
 * The rates the catalog carries for the model; a rate it lacks is left out, never shown as
 * free. The readout prices text and image models only, so video and audio show their maker
 * alone.
 */
function ratesOf(model: Model): ModelInfoRate[] {
  if (model.isSmartModel === true) return smartModelRates(model);
  const display = priceDisplayOf(model);
  switch (model.modality) {
    case 'text': {
      return tokenRates(perThousand(display.inputNanoUsd), perThousand(display.outputNanoUsd));
    }
    case 'image': {
      const perImage = display.perImageNanoUsd;
      return perImage === undefined
        ? []
        : [{ kind: 'image', value: `${nanoUnitPriceUsd(perImage, 3)}/image` }];
    }
    case 'video':
    case 'audio': {
      return [];
    }
  }
}

/**
 * The composer's model as the readout under the greeting names it: the chip's swatch and
 * label, then its maker (or the Smart Model's role) and, for an account, its rates. Several
 * models read as the chip's label alone; a visitor sees no rates, because previews are free.
 */
export function modelInfoFacts(
  model: Model,
  selectionCount: number,
  signedIn: boolean
): ModelInfoFacts {
  const swatch = modelSwatch(model.id);
  const label = modelSelectionLabel(model.name, selectionCount);
  if (selectionCount > 1) return { swatch, label, rates: [] };
  return {
    swatch,
    label,
    maker: model.isSmartModel === true ? SMART_MODEL_ROLE : model.provider,
    rates: signedIn ? ratesOf(model) : [],
  };
}
