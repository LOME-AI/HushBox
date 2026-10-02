import { MODEL_SWATCH_COUNT } from '@hushbox/shared/design-tokens';
import type { ModelSwatch } from '@hushbox/shared/design-tokens';

function modelIdHash(modelId: string): number {
  let hash = 0;
  for (let index = 0; index < modelId.length; index++) {
    /* v8 ignore next -- `index` is always < modelId.length here, so codePointAt never returns undefined; the `?? 0` fallback is unreachable. */
    hash = ((hash << 5) - hash + (modelId.codePointAt(index) ?? 0)) | 0; // eslint-disable-line unicorn/prefer-math-trunc -- | 0 is 32-bit integer coercion, not floor
  }
  return Math.abs(hash);
}

function isModelSwatch(value: number): value is ModelSwatch {
  return Number.isInteger(value) && value >= 1 && value <= MODEL_SWATCH_COUNT;
}

function swatchAt(index: number): ModelSwatch {
  const swatch = (index % MODEL_SWATCH_COUNT) + 1;
  /* v8 ignore start -- a non-negative index modulo the count, plus one, is always a swatch, so this guard is unreachable. */
  if (!isModelSwatch(swatch)) {
    throw new Error('model swatch out of range');
  }
  /* v8 ignore stop */
  return swatch;
}

/** A model's own swatch, the same wherever it shows alone. */
export function modelSwatch(modelId: string): ModelSwatch {
  return swatchAt(modelIdHash(modelId));
}

/**
 * The swatches for models shown together (a compare turn, a multi-selection, a
 * chart). Each keeps its own swatch unless an earlier model in the set already
 * holds it; then it takes the next free one. A bare hash would give a
 * three-model set a shared colour about a third of the time. Once a set holds
 * all {@link MODEL_SWATCH_COUNT} swatches, each later model keeps its own.
 */
export function assignModelSwatches(modelIds: readonly string[]): ReadonlyMap<string, ModelSwatch> {
  const assigned = new Map<string, ModelSwatch>();
  const held = new Set<ModelSwatch>();
  for (const modelId of modelIds) {
    if (assigned.has(modelId)) continue;
    const own = modelIdHash(modelId);
    let offset = 0;
    while (held.size < MODEL_SWATCH_COUNT && held.has(swatchAt(own + offset))) offset += 1;
    const swatch = swatchAt(own + offset);
    assigned.set(modelId, swatch);
    held.add(swatch);
  }
  return assigned;
}
