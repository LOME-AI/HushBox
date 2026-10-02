import { describe, it, expect } from 'vitest';
import { MAX_SELECTED_MODELS, modelSchema, type Model, type ChatModality } from '@hushbox/shared';
import {
  filterBySearch,
  resolveModality,
  sortModels,
  sortByPopularity,
  interlaceModels,
  modelSubtitle,
  expandedRowButtonLabel,
  buildModelResultList,
  getPinnedLabelForModel,
  toggleSortDirection,
  buildSelectedEntries,
  updateSelectedIds,
  initialFocusedId,
} from '@/components/chat/model-selector/model-selector-helpers';

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

describe('filterBySearch', () => {
  it('returns all models when query is blank', () => {
    const models = [makeModel({ id: 'a' }), makeModel({ id: 'b' })];
    expect(filterBySearch(models, '   ')).toEqual(models);
  });

  it('matches on model name case-insensitively', () => {
    const models = [makeModel({ id: 'a', name: 'GPT-4o' }), makeModel({ id: 'b', name: 'Claude' })];
    expect(filterBySearch(models, 'gpt')).toEqual([models[0]]);
  });

  it('matches on provider', () => {
    const models = [
      makeModel({ id: 'a', provider: 'OpenAI' }),
      makeModel({ id: 'b', provider: 'Anthropic' }),
    ];
    expect(filterBySearch(models, 'anthropic')).toEqual([models[1]]);
  });
});

describe('resolveModality', () => {
  it('defaults to text when modality is absent', () => {
    const absent: ChatModality | undefined = undefined;
    expect(resolveModality(absent)).toBe('text');
  });

  it('returns the provided modality', () => {
    expect(resolveModality('image')).toBe('image');
  });
});

describe('sortModels', () => {
  it('returns input unchanged when no sort field', () => {
    const models = [makeModel({ id: 'a' }), makeModel({ id: 'b' })];
    expect(sortModels(models, null, 'asc', 'text')).toBe(models);
  });

  it('sorts by text price ascending', () => {
    const models = [
      makeModel({ id: 'a', pricing: { inputPerToken: '5000000000', outputPerToken: '1' } }),
      makeModel({ id: 'b', pricing: { inputPerToken: '1000000000', outputPerToken: '1' } }),
    ];
    expect(sortModels(models, 'price', 'asc', 'text').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('sorts text models by their input rate, not their combined rate', () => {
    const models = [
      makeModel({ id: 'a', pricing: { inputPerToken: '2000', outputPerToken: '3000' } }),
      makeModel({ id: 'b', pricing: { inputPerToken: '1000', outputPerToken: '9000' } }),
    ];

    expect(sortModels(models, 'price', 'asc', 'text').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('sorts by context descending', () => {
    const models = [
      makeModel({ id: 'a', contextLength: 100 }),
      makeModel({ id: 'b', contextLength: 900 }),
    ];
    expect(sortModels(models, 'context', 'desc', 'text').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('sorts image models by per-image price', () => {
    const models = [
      makeModel({
        id: 'a',
        modality: 'image',
        pricing: { perImage: '5000000000', dearestPerImage: '5000000000' },
      }),
      makeModel({
        id: 'b',
        modality: 'image',
        pricing: { perImage: '1000000000', dearestPerImage: '1000000000' },
      }),
    ];
    expect(sortModels(models, 'price', 'asc', 'image').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('sorts video models by their cheapest per-second price', () => {
    const models = [
      makeModel({
        id: 'a',
        modality: 'video',
        pricing: {
          perSecondByResolution: { '720p': '5000000000' },
          dearestPerSecondByResolution: { '720p': '5000000000' },
        },
      }),
      makeModel({
        id: 'b',
        modality: 'video',
        pricing: {
          perSecondByResolution: { '720p': '1000000000' },
          dearestPerSecondByResolution: { '720p': '1000000000' },
        },
      }),
    ];
    expect(sortModels(models, 'price', 'asc', 'video').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('sorts video models with no resolution prices last, not cheapest', () => {
    const models = [
      makeModel({
        id: 'a',
        modality: 'video',
        pricing: {
          perSecondByResolution: { '720p': '5000000000' },
          dearestPerSecondByResolution: { '720p': '5000000000' },
        },
      }),
      makeModel({ id: 'b', modality: 'video', pricing: {} }),
    ];
    // Parsing each row pins the premise this guard rests on: the wire contract
    // refuses a rate-less media row, so no endpoint can emit one and the code
    // below is being handed input only a bug could produce. Should the contract
    // ever admit such a row, this fails instead of the guard quietly going idle.
    expect(models.map((m) => modelSchema.safeParse(m).success)).toEqual([true, false]);
    expect(sortModels(models, 'price', 'asc', 'video').map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('leaves audio models in input order (no wire price dimension)', () => {
    const models = [
      makeModel({ id: 'a', modality: 'audio', pricing: {} }),
      makeModel({ id: 'b', modality: 'audio', pricing: {} }),
    ];
    // Audio carries no wire pricing, so every audio model sorts equal and the
    // stable sort preserves input order.
    expect(sortModels(models, 'price', 'asc', 'audio').map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('sorts a text model with no input rate last, not cheapest', () => {
    const models = [
      makeModel({ id: 'a', pricing: { outputPerToken: '2000000000' } }),
      makeModel({ id: 'b', pricing: { inputPerToken: '1000000000', outputPerToken: '1' } }),
    ];
    expect(sortModels(models, 'price', 'asc', 'text').map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('sorts an image model with no per-image rate last, not cheapest', () => {
    const models = [
      makeModel({
        id: 'a',
        modality: 'image',
        pricing: { perImage: '5000000000', dearestPerImage: '5000000000' },
      }),
      makeModel({ id: 'b', modality: 'image', pricing: {} }),
    ];
    expect(models.map((m) => modelSchema.safeParse(m).success)).toEqual([true, false]);
    expect(sortModels(models, 'price', 'asc', 'image').map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('keeps an unpriced model last when the direction is reversed', () => {
    const models = [
      makeModel({ id: 'a', modality: 'image', pricing: {} }),
      makeModel({
        id: 'b',
        modality: 'image',
        pricing: { perImage: '5000000000', dearestPerImage: '5000000000' },
      }),
      makeModel({
        id: 'c',
        modality: 'image',
        pricing: { perImage: '9000000000', dearestPerImage: '9000000000' },
      }),
    ];
    // Descending is "dearest first"; an absent rate is no more the dearest than
    // it is the cheapest, so it stays out of both ends of the order.
    expect(models.map((m) => modelSchema.safeParse(m).success)).toEqual([false, true, true]);
    expect(sortModels(models, 'price', 'desc', 'image').map((m) => m.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('sortByPopularity', () => {
  it('orders models ascending by popularityRank', () => {
    const models = [
      makeModel({ id: 'a', popularityRank: 2 }),
      makeModel({ id: 'b', popularityRank: 0 }),
      makeModel({ id: 'c', popularityRank: 1 }),
    ];
    expect(sortByPopularity(models).map((m) => m.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts undefined ranks last', () => {
    const models = [
      makeModel({ id: 'a', popularityRank: undefined }),
      makeModel({ id: 'b', popularityRank: 3 }),
    ];
    expect(sortByPopularity(models).map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('is stable among equal ranks', () => {
    const models = [
      makeModel({ id: 'a', popularityRank: 1 }),
      makeModel({ id: 'b', popularityRank: 1 }),
      makeModel({ id: 'c', popularityRank: 1 }),
    ];
    expect(sortByPopularity(models).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('is stable among both-undefined ranks', () => {
    const models = [makeModel({ id: 'a' }), makeModel({ id: 'b' }), makeModel({ id: 'c' })];
    expect(sortByPopularity(models).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const models = [
      makeModel({ id: 'a', popularityRank: 2 }),
      makeModel({ id: 'b', popularityRank: 0 }),
    ];
    const snapshot = models.map((m) => m.id);
    sortByPopularity(models);
    expect(models.map((m) => m.id)).toEqual(snapshot);
  });
});

describe('interlaceModels', () => {
  /** Greys exactly the ids named, whatever refused them. */
  const greying =
    (...greyed: string[]) =>
    (modelId: string): boolean =>
      !greyed.includes(modelId);

  it('splits on the availability verdict rather than on premium membership', () => {
    // g1 is greyed for a reason no tier expresses — an effort cap, say — so a
    // premium-membership split would leave it where it sits.
    const models = [makeModel({ id: 'a1' }), makeModel({ id: 'g1' }), makeModel({ id: 'a2' })];
    const result = interlaceModels(models, greying('g1'));
    expect(result.map((m) => m.id)).toEqual(['a2', 'a1', 'g1']);
  });

  it('pools the available surplus above the zipped pairs', () => {
    const models = [
      makeModel({ id: 'a1' }),
      makeModel({ id: 'a2' }),
      makeModel({ id: 'a3' }),
      makeModel({ id: 'a4' }),
      makeModel({ id: 'g1' }),
      makeModel({ id: 'g2' }),
    ];
    const result = interlaceModels(models, greying('g1', 'g2'));
    // a3/a4 have no greyed partner, so they surface above the two pairs.
    expect(result.map((m) => m.id)).toEqual(['a3', 'a4', 'a1', 'g1', 'a2', 'g2']);
  });

  it('drops the greyed surplus below the zipped pairs', () => {
    const models = [
      makeModel({ id: 'a1' }),
      makeModel({ id: 'g1' }),
      makeModel({ id: 'a2' }),
      makeModel({ id: 'g2' }),
      makeModel({ id: 'g3' }),
    ];
    const result = interlaceModels(models, greying('g1', 'g2', 'g3'));
    // g3 has no available partner, so it trails the two pairs.
    expect(result.map((m) => m.id)).toEqual(['a1', 'g1', 'a2', 'g2', 'g3']);
  });

  it('leaves the order untouched when every row is available', () => {
    const models = [makeModel({ id: 'a1' }), makeModel({ id: 'a2' }), makeModel({ id: 'a3' })];
    expect(interlaceModels(models, greying()).map((m) => m.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('leaves the order untouched when every row is greyed', () => {
    const models = [makeModel({ id: 'g1' }), makeModel({ id: 'g2' })];
    expect(interlaceModels(models, greying('g1', 'g2')).map((m) => m.id)).toEqual(['g1', 'g2']);
  });
});

describe('modelSubtitle', () => {
  it('describes the smart model', () => {
    expect(modelSubtitle(makeModel({ isSmartModel: true }))).toBe('Auto-picks the best model');
  });

  it('shows provider and capacity for text models', () => {
    expect(modelSubtitle(makeModel({ provider: 'Acme', contextLength: 1000 }))).toContain('Acme •');
  });

  it('shows per-image price for image models', () => {
    // Billable $0.020 per-image renders as-is (fees baked at ingestion).
    expect(
      modelSubtitle(
        makeModel({
          modality: 'image',
          pricing: { perImage: '20000000', dearestPerImage: '20000000' },
        })
      )
    ).toBe('Acme • $0.020/image');
  });

  it('shows provider only for an image model that omits its rate, never a zero price', () => {
    const ratelessImage = makeModel({ modality: 'image', pricing: {} });
    expect(modelSchema.safeParse(ratelessImage).success).toBe(false);
    expect(modelSubtitle(ratelessImage)).toBe('Acme');
  });

  it('returns provider only for video with no resolution prices', () => {
    const ratelessVideo = makeModel({ modality: 'video', pricing: {} });
    expect(modelSchema.safeParse(ratelessVideo).success).toBe(false);
    expect(modelSubtitle(ratelessVideo)).toBe('Acme');
  });

  it('shows cheapest per-second video price', () => {
    expect(
      modelSubtitle(
        makeModel({
          modality: 'video',
          pricing: {
            perSecondByResolution: { '720p': '500000000', '1080p': '900000000' },
            dearestPerSecondByResolution: { '720p': '500000000', '1080p': '900000000' },
          },
        })
      )
      // Billable $0.50 cheapest per-second renders as-is.
    ).toBe('Acme • $0.50/s');
  });

  it('shows provider only for audio models (no wire price dimension)', () => {
    expect(modelSubtitle(makeModel({ modality: 'audio', pricing: {} }))).toBe('Acme');
  });
});

describe('expandedRowButtonLabel', () => {
  it('uses the model name in single mode', () => {
    expect(expandedRowButtonLabel('single', false, 'GPT-4o')).toContain('Use');
  });

  it('offers removal when selected in multi mode', () => {
    expect(expandedRowButtonLabel('multi', true, 'GPT-4o')).toBe('Remove from selection');
  });

  it('offers addition when unselected in multi mode', () => {
    expect(expandedRowButtonLabel('multi', false, 'GPT-4o')).toBe('Add to selection');
  });
});

describe('buildModelResultList', () => {
  it('prefixes the smart model ahead of the pins', () => {
    const interlaced = [makeModel({ id: 'other' }), makeModel({ id: 'a' })];
    const smart = makeModel({ id: 'smart', isSmartModel: true });
    const result = buildModelResultList({
      interlaced,
      smartModel: smart,
      strongestId: 'a',
      valueId: 'a',
    });
    // Strongest and value collapse to one row when they are the same model.
    expect(result.map((m) => m.id)).toEqual(['smart', 'a', 'other']);
  });

  it('orders pinned models first', () => {
    const interlaced = [
      makeModel({ id: 'other' }),
      makeModel({ id: 'strong' }),
      makeModel({ id: 'value' }),
    ];
    const result = buildModelResultList({
      interlaced,
      smartModel: undefined,
      strongestId: 'strong',
      valueId: 'value',
    });
    expect(result.map((m) => m.id)).toEqual(['strong', 'value', 'other']);
  });
});

describe('getPinnedLabelForModel', () => {
  it('labels the strongest model', () => {
    expect(getPinnedLabelForModel('s', 's', 'v')).toBe('Strongest');
  });

  it('labels the value model', () => {
    expect(getPinnedLabelForModel('v', 's', 'v')).toBe('Best value');
  });

  it('returns undefined for unpinned models', () => {
    expect(getPinnedLabelForModel('x', 's', 'v')).toBeUndefined();
  });
});

describe('toggleSortDirection', () => {
  it('flips asc to desc', () => {
    expect(toggleSortDirection('asc')).toBe('desc');
  });

  it('flips desc to asc', () => {
    expect(toggleSortDirection('desc')).toBe('asc');
  });
});

describe('buildSelectedEntries', () => {
  it('maps selected ids to id/name entries, dropping unknown ids', () => {
    const models = [makeModel({ id: 'a', name: 'Alpha' })];
    expect(buildSelectedEntries(new Set(['a', 'missing']), models)).toEqual([
      { id: 'a', name: 'Alpha' },
    ]);
  });
});

describe('updateSelectedIds', () => {
  it('adds a missing id', () => {
    expect([...updateSelectedIds(new Set(), 'a')]).toEqual(['a']);
  });

  it('removes a present id', () => {
    expect([...updateSelectedIds(new Set(['a']), 'a')]).toEqual([]);
  });

  it('rejects additions past the max and returns the same reference', () => {
    const full = new Set(
      Array.from({ length: MAX_SELECTED_MODELS }, (_, index) => `m${String(index)}`)
    );
    expect(updateSelectedIds(full, 'overflow')).toBe(full);
  });
});

describe('initialFocusedId', () => {
  it('returns the first selected id when present', () => {
    expect(initialFocusedId(new Set(['sel']), [makeModel({ id: 'a' })])).toBe('sel');
  });

  it('falls back to the first model id', () => {
    expect(initialFocusedId(new Set(), [makeModel({ id: 'a' })])).toBe('a');
  });

  it('returns empty string when there are no models', () => {
    expect(initialFocusedId(new Set(), [])).toBe('');
  });
});
