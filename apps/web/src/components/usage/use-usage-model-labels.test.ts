import * as React from 'react';
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MODEL_SWATCH_COUNT } from '@hushbox/shared/design-tokens';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { assignModelSwatches, modelSwatch } from '@/lib/utils/model-color';
import { UsageModelSet, useUsageModelLabels } from './use-usage-model-labels';
import type { Model } from '@hushbox/shared';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';

const { catalogRef } = vi.hoisted(() => {
  const catalog: { current: Model[] | undefined } = { current: undefined };
  return { catalogRef: catalog };
});

vi.mock('@/hooks/models/models', () => ({
  useModels: (): UseModelsStub => ({
    data:
      catalogRef.current === undefined
        ? undefined
        : { models: catalogRef.current, premiumIds: new Set<string>() },
  }),
}));

function catalogModel(id: string, name: string): Model {
  return {
    id,
    name,
    provider: 'Fictional',
    description: 'Text generation model.',
    modality: 'text',
    supportedParameters: [],
    contextLength: 128_000,
    created: OLD_RELEASE_SECONDS,
    maxOutputTokens: 4096,
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
  };
}

/** Model ids, generated until two of them share a swatch on their own. */
function collidingIds(): [string, string] {
  const byOwnSwatch = new Map<number, string>();
  for (let index = 0; ; index++) {
    const id = `fictional/model-${String(index)}`;
    const own = modelSwatch(id);
    const earlier = byOwnSwatch.get(own);
    if (earlier !== undefined) return [earlier, id];
    byOwnSwatch.set(own, id);
  }
}

beforeEach(() => {
  catalogRef.current = [catalogModel('fictional/alpha', 'Alpha Large')];
});

/** Renders the hook inside a page showing `pageModels`, or outside any page when omitted. */
function labelsOnPage(pageModels?: readonly string[]): ReturnType<typeof useUsageModelLabels> {
  const wrapper =
    pageModels === undefined
      ? undefined
      : ({ children }: { children: React.ReactNode }): React.JSX.Element =>
          React.createElement(UsageModelSet, { value: pageModels }, children);
  return renderHook(() => useUsageModelLabels(), wrapper === undefined ? {} : { wrapper }).result
    .current;
}

describe('useUsageModelLabels', () => {
  it('names a model by its catalog display name', () => {
    expect(labelsOnPage().name('fictional/alpha')).toBe('Alpha Large');
  });

  it('names a model the catalog lacks by its id', () => {
    expect(labelsOnPage().name('fictional/retired')).toBe('fictional/retired');
  });

  it('names every model by its id before the catalog loads', () => {
    catalogRef.current = undefined;
    expect(labelsOnPage().name('fictional/alpha')).toBe('fictional/alpha');
  });

  it('gives two of the page models that share a swatch on their own different swatches', () => {
    const [first, second] = collidingIds();
    const labels = labelsOnPage([first, second]);
    expect(labels.swatch(first)).not.toBe(labels.swatch(second));
  });

  it('repeats no swatch among the page models while the swatches last', () => {
    const ids = Array.from(
      { length: MODEL_SWATCH_COUNT },
      (_, index) => `fictional/m-${String(index)}`
    );
    const labels = labelsOnPage(ids);
    expect(new Set(ids.map((id) => labels.swatch(id))).size).toBe(MODEL_SWATCH_COUNT);
  });

  it('assigns the same swatches whatever order the page models arrive in', () => {
    const [a, b] = collidingIds();
    const [first, second] = a.localeCompare(b) < 0 ? [a, b] : [b, a];
    const labels = labelsOnPage([second, first]);
    const expected = assignModelSwatches([first, second]);
    expect(labels.swatch(first)).toBe(expected.get(first));
    expect(labels.swatch(second)).toBe(expected.get(second));
  });

  it("gives a model outside the page's set its own swatch", () => {
    expect(labelsOnPage(['fictional/alpha']).swatch('fictional/elsewhere')).toBe(
      modelSwatch('fictional/elsewhere')
    );
  });

  it('gives every model its own swatch outside a usage page', () => {
    expect(labelsOnPage().swatch('fictional/alpha')).toBe(modelSwatch('fictional/alpha'));
  });
});
