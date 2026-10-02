import { describe, it, expect } from 'vitest';
import { renderHook, type RenderHookResult } from '@testing-library/react';
import { type Model } from '@hushbox/shared';
import {
  useFilteredModels,
  type FilteredModels,
} from '@/components/chat/model-selector/use-filtered-models';

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'm1',
    name: 'Model One',
    description: 'Model One',
    provider: 'Acme',
    modality: 'text',
    contextLength: 1000,
    supportedParameters: [],
    pricing: { inputPerToken: '1000000000', outputPerToken: '2000000000' },
    ...overrides,
  };
}

/** Greys exactly the ids named, whatever refused them. */
const greying =
  (...greyed: string[]) =>
  (modelId: string): boolean =>
    !greyed.includes(modelId);

// available rows b1..b3, greyed row g1; strongest = b1, value = b2.
const trialModels = [
  makeModel({ id: 'b1', name: 'Basic One' }),
  makeModel({ id: 'b2', name: 'Basic Two' }),
  makeModel({ id: 'b3', name: 'Basic Three' }),
  makeModel({ id: 'g1', name: 'Greyed One' }),
];

describe('useFilteredModels — verdict ordering', () => {
  it('orders the default view: pins, then available-only, then interleaved pairs', () => {
    const { result } = renderHook(() =>
      useFilteredModels({
        models: trialModels,
        searchQuery: '',
        sortField: null,
        sortDirection: 'asc',
        isModelAvailable: greying('g1'),
        strongestId: 'b1',
        valueId: 'b2',
      })
    );
    // Strongest (b1) + Value (b2) pinned first, then leftover-available (b3),
    // then the interleaved pair remainder (g1). b1/b2 are not duplicated.
    expect(result.current.models.map((m) => m.id)).toEqual(['b1', 'b2', 'b3', 'g1']);
  });

  it('handles greyed rows outnumbering available ones without an available surplus', () => {
    const models = [makeModel({ id: 'b1' }), makeModel({ id: 'g1' }), makeModel({ id: 'g2' })];
    const { result } = renderHook(() =>
      useFilteredModels({
        models,
        searchQuery: '',
        sortField: null,
        sortDirection: 'asc',
        isModelAvailable: greying('g1', 'g2'),
        strongestId: 'b1',
        valueId: 'g1',
      })
    );
    // b1 (strongest) + g1 (value) pinned, then the trailing greyed g2. No dupes.
    expect(result.current.models.map((m) => m.id)).toEqual(['b1', 'g1', 'g2']);
  });

  it('leaves the order identical to the un-interlaced list when no row is greyed', () => {
    const { result } = renderHook(() =>
      useFilteredModels({
        models: trialModels,
        searchQuery: '',
        sortField: null,
        sortDirection: 'asc',
        isModelAvailable: greying(),
        strongestId: 'b1',
        valueId: 'b2',
      })
    );
    // Pins first, then remaining in original order — no reorder from the zip.
    expect(result.current.models.map((m) => m.id)).toEqual(['b1', 'b2', 'b3', 'g1']);
  });

  it('orders the non-pinned remainder by popularityRank in the default view', () => {
    // strongest = s, value = v (both pinned first); remainder r1/r2/r3 have
    // distinct ranks that invert their input order.
    const models = [
      makeModel({ id: 's', name: 'Strongest', popularityRank: 9 }),
      makeModel({ id: 'v', name: 'Value', popularityRank: 8 }),
      makeModel({ id: 'r1', name: 'Rank Two', popularityRank: 2 }),
      makeModel({ id: 'r2', name: 'Rank Zero', popularityRank: 0 }),
      makeModel({ id: 'r3', name: 'Rank One', popularityRank: 1 }),
    ];
    const { result } = renderHook(() =>
      useFilteredModels({
        models,
        searchQuery: '',
        sortField: null,
        sortDirection: 'asc',
        isModelAvailable: greying(),
        strongestId: 's',
        valueId: 'v',
      })
    );
    // Pins (s, v) first, then remainder by popularity asc (r2=0, r3=1, r1=2).
    expect(result.current.models.map((m) => m.id)).toEqual(['s', 'v', 'r2', 'r3', 'r1']);
  });

  it('pools the available surplus above the greyed row in a search view too', () => {
    const { result } = renderHook(() =>
      useFilteredModels({
        models: trialModels,
        searchQuery: 'acme',
        sortField: null,
        sortDirection: 'asc',
        isModelAvailable: greying('g1'),
        strongestId: 'b1',
        valueId: 'b2',
      })
    );
    // Pins (b1, b2) lead, then the un-paired available b3, then the greyed g1.
    expect(result.current.models.map((m) => m.id)).toEqual(['b1', 'b2', 'b3', 'g1']);
  });
});

describe('useFilteredModels — modality emptiness', () => {
  function run(
    overrides: { searchQuery?: string; activeModality?: Model['modality'] } = {}
  ): RenderHookResult<FilteredModels, unknown> {
    return renderHook(() =>
      useFilteredModels({
        models: trialModels,
        searchQuery: '',
        sortField: null,
        sortDirection: 'asc',
        isModelAvailable: greying(),
        strongestId: 'b1',
        valueId: 'b2',
        ...overrides,
      })
    );
  }

  it('reports the modality empty when no model carries it', () => {
    const { result } = run({ activeModality: 'video' });
    expect(result.current.modalityIsEmpty).toBe(true);
  });

  it('reports the modality populated when only the search narrows it to nothing', () => {
    const { result } = run({ searchQuery: 'no-model-is-named-this' });
    expect(result.current.models).toEqual([]);
    expect(result.current.modalityIsEmpty).toBe(false);
  });
});

// Distinct input rates so the natural order (b1, b2, b3) differs from the pin
// order (b3, b2), which is what makes a hoist visible under a price sort.
const pinFixture = [
  makeModel({
    id: 'b1',
    name: 'Basic One',
    pricing: { inputPerToken: '1000', outputPerToken: '2000' },
  }),
  makeModel({
    id: 'b2',
    name: 'Basic Two',
    pricing: { inputPerToken: '2000', outputPerToken: '4000' },
  }),
  makeModel({
    id: 'b3',
    name: 'Basic Three',
    pricing: { inputPerToken: '3000', outputPerToken: '6000' },
  }),
];

describe('useFilteredModels — pinning applies in every view', () => {
  function run(
    overrides: {
      models?: Model[];
      searchQuery?: string;
      sortField?: 'price' | 'context' | null;
    } = {}
  ): RenderHookResult<FilteredModels, unknown> {
    return renderHook(() =>
      useFilteredModels({
        models: pinFixture,
        searchQuery: '',
        sortField: null,
        sortDirection: 'asc',
        isModelAvailable: greying(),
        strongestId: 'b3',
        valueId: 'b2',
        ...overrides,
      })
    );
  }

  it('hoists the pinned models above an active price sort', () => {
    const { result } = run({ sortField: 'price' });
    expect(result.current.models.map((m) => m.id)).toEqual(['b3', 'b2', 'b1']);
  });

  it('hoists the pinned models to the top of a search-filtered list', () => {
    const { result } = run({ searchQuery: 'basic' });
    expect(result.current.models.map((m) => m.id)).toEqual(['b3', 'b2', 'b1']);
  });

  it('omits a pinned model the search query excludes', () => {
    const { result } = run({ searchQuery: 'one' });
    expect(result.current.models.map((m) => m.id)).toEqual(['b1']);
  });

  it('keeps the smart model ahead of the pins under an active sort', () => {
    const smart = makeModel({ id: 'smart', name: 'Smart Model', isSmartModel: true });
    const { result } = run({ models: [smart, ...pinFixture], sortField: 'price' });
    expect(result.current.models.map((m) => m.id)).toEqual(['smart', 'b3', 'b2', 'b1']);
  });

  it('keeps the smart model ahead of the pins under a search query', () => {
    const smart = makeModel({ id: 'smart', name: 'Smart Basic', isSmartModel: true });
    const { result } = run({ models: [smart, ...pinFixture], searchQuery: 'basic' });
    expect(result.current.models.map((m) => m.id)).toEqual(['smart', 'b3', 'b2', 'b1']);
  });
});
