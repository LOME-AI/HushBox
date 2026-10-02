import fc from 'fast-check';
import { describe, it, expect } from 'vitest';
import { MODEL_SWATCH_COUNT } from '@hushbox/shared/design-tokens';

import { assignModelSwatches, modelSwatch } from './model-color';

describe('modelSwatch', () => {
  it('gives a model the same swatch every time', () => {
    expect(modelSwatch('anthropic/claude-sonnet-4.5')).toBe(
      modelSwatch('anthropic/claude-sonnet-4.5')
    );
  });
});

/** Finds two distinct ids whose own swatches are the same. */
function collidingPair(): [string, string] {
  const firstByswatch = new Map<number, string>();
  for (let index = 0; ; index++) {
    const id = `vendor/model-${String(index)}`;
    const earlier = firstByswatch.get(modelSwatch(id));
    if (earlier !== undefined) return [earlier, id];
    firstByswatch.set(modelSwatch(id), id);
  }
}

describe('assignModelSwatches', () => {
  it('gives a lone model its own swatch', () => {
    expect(assignModelSwatches(['openai/gpt-5']).get('openai/gpt-5')).toBe(
      modelSwatch('openai/gpt-5')
    );
  });

  it('moves a later model off a swatch an earlier model in the set holds', () => {
    const [first, second] = collidingPair();
    const assigned = assignModelSwatches([first, second]);
    expect(assigned.get(first)).toBe(modelSwatch(first));
    expect(assigned.get(second)).not.toBe(assigned.get(first));
  });

  it('gives a model repeated in the set one swatch', () => {
    const assigned = assignModelSwatches(['openai/gpt-5', 'openai/gpt-5']);
    expect([...assigned.keys()]).toEqual(['openai/gpt-5']);
  });

  it('still names a swatch for every model once the set outgrows the swatches', () => {
    const ids = Array.from({ length: MODEL_SWATCH_COUNT + 3 }, (_, index) => `m-${String(index)}`);
    const assigned = assignModelSwatches(ids);
    expect(ids.every((id) => assigned.get(id) !== undefined)).toBe(true);
  });

  describe('properties', () => {
    // Generator: lists of up to eight model ids drawn from a small pool, so
    // repeats and swatch collisions both occur often.
    const modelIdListArbitrary = fc.array(
      fc.constantFrom(...Array.from({ length: 24 }, (_, index) => `vendor/model-${String(index)}`)),
      { maxLength: MODEL_SWATCH_COUNT }
    );

    it('never repeats a swatch within a set', () => {
      fc.assert(
        fc.property(modelIdListArbitrary, (ids) => {
          const swatches = [...assignModelSwatches(ids).values()];
          expect(new Set(swatches).size).toBe(swatches.length);
        })
      );
    });

    it("keeps a model's own swatch unless an earlier model in the set already holds it", () => {
      fc.assert(
        fc.property(modelIdListArbitrary, (ids) => {
          const assigned = assignModelSwatches(ids);
          const held = new Set<number>();
          for (const id of new Set(ids)) {
            if (!held.has(modelSwatch(id))) expect(assigned.get(id)).toBe(modelSwatch(id));
            const swatch = assigned.get(id);
            if (swatch !== undefined) held.add(swatch);
          }
        })
      );
    });
  });
});
