import { describe, expect, it } from 'vitest';
import {
  ROUTING_SUBJECTS,
  anchorListedMaxPrice,
  cheapestServingEndpoints,
  fixtureRoutingCatalog,
  foreignZdrTag,
  listedOutputImagePrice,
  routingCatalogFrom,
  servedByOf,
} from './integration.setup.js';
import {
  TEST_GATEWAY_BASE_URL,
  catalogFetch,
  imageModelFixture,
  modelEntryFixture,
} from '../domain/catalog/gateway-fixtures.js';
import type { InferenceEvent } from '@hushbox/shared';
import type { RoutingCatalog } from './integration.setup.js';
import type { CatalogFixture } from '../domain/catalog/gateway-fixtures.js';

/** A `/models` entry priced as listed, sending `parameters`. */
function textEntry(
  id: string,
  prompt: string,
  completion: string,
  parameters: readonly string[] = ['max_tokens']
): Record<string, unknown> {
  return modelEntryFixture({
    id,
    pricing: { prompt, completion },
    supported_parameters: parameters,
  });
}

interface RowSpec {
  readonly modelId: string;
  readonly providerName: string;
  readonly tag: string;
  readonly prompt: string;
  readonly completion: string;
  readonly parameters?: readonly string[];
}

/** One `/endpoints/zdr` row, standard limits, priced as given. */
function zdrRow(spec: RowSpec): Record<string, unknown> {
  return {
    model_id: spec.modelId,
    provider_name: spec.providerName,
    tag: spec.tag,
    pricing: { prompt: spec.prompt, completion: spec.completion },
    supported_parameters: spec.parameters ?? ['max_tokens'],
    supports_implicit_caching: false,
    max_completion_tokens: 16_384,
    context_length: 128_000,
  };
}

/** An `/images/models` entry whose endpoint detail lives at its own id. */
function imageEntry(id: string): Record<string, unknown> {
  return imageModelFixture({
    id,
    endpoints: `${TEST_GATEWAY_BASE_URL}/images/models/${id}/endpoints`,
  });
}

interface ImageEndpointSpec {
  readonly tag: string;
  readonly rows: readonly { readonly billable: string; readonly cost: number }[];
}

/** The image-endpoint detail route over a per-model endpoint table. */
function imageEndpointsOf(
  table: Readonly<Record<string, readonly ImageEndpointSpec[]>>
): (id: string) => unknown {
  return (id) => ({
    id,
    endpoints: (table[id] ?? []).map((endpoint) => ({
      provider_tag: endpoint.tag,
      pricing: endpoint.rows.map((row) => ({
        billable: row.billable,
        unit: 'image',
        cost_usd: row.cost,
      })),
    })),
  });
}

/** A ZDR row naming an image endpoint's tag: the image pin reads only the tag. */
function imageZdrRow(modelId: string, tag: string): Record<string, unknown> {
  return zdrRow({ modelId, providerName: tag, tag, prompt: '0', completion: '0' });
}

function catalogOf(fixture: CatalogFixture): Promise<RoutingCatalog> {
  return routingCatalogFrom(catalogFetch(fixture), TEST_GATEWAY_BASE_URL);
}

const CHEAP = { prompt: '0.000001', completion: '0.000002' } as const;
const DEAR = { prompt: '0.000003', completion: '0.000015' } as const;

describe('the ceiling subject', () => {
  it('is the cheapest exposed text model, wherever the listing places it', async () => {
    const catalog = await catalogOf({
      models: [
        textEntry('vendor/dear', DEAR.prompt, DEAR.completion),
        textEntry('vendor/cheap', CHEAP.prompt, CHEAP.completion),
        textEntry('vendor/middling', '0.000002', '0.000004'),
      ],
      zdrModelIds: ['vendor/dear', 'vendor/cheap', 'vendor/middling'],
    });

    expect(ROUTING_SUBJECTS.ceiling(catalog)?.id).toBe('vendor/cheap');
  });

  it('breaks a price tie by the lower id, so the subject does not follow listing order', async () => {
    const catalog = await catalogOf({
      models: [
        textEntry('vendor/second', CHEAP.prompt, CHEAP.completion),
        textEntry('vendor/first', CHEAP.prompt, CHEAP.completion),
      ],
      zdrModelIds: ['vendor/second', 'vendor/first'],
    });

    expect(ROUTING_SUBJECTS.ceiling(catalog)?.id).toBe('vendor/first');
  });

  it('passes over a cheaper text model the catalog does not expose', async () => {
    const listed = await catalogOf({
      models: [
        textEntry('vendor/dear', DEAR.prompt, DEAR.completion),
        textEntry('vendor/cheap', CHEAP.prompt, CHEAP.completion),
      ],
      zdrModelIds: ['vendor/dear', 'vendor/cheap'],
    });
    const catalog: RoutingCatalog = {
      ...listed,
      descriptors: listed.descriptors.map((descriptor) =>
        descriptor.id === 'vendor/cheap' ? { ...descriptor, zdrReachable: false } : descriptor
      ),
    };

    expect(ROUTING_SUBJECTS.ceiling(catalog)?.id).toBe('vendor/dear');
  });

  it('passes over a cheaper token-priced model whose output is not text', async () => {
    const catalog = await catalogOf({
      models: [
        textEntry('vendor/dear', DEAR.prompt, DEAR.completion),
        modelEntryFixture({
          id: 'vendor/film',
          pricing: CHEAP,
          architecture: { input_modalities: ['text'], output_modalities: ['video'] },
        }),
      ],
      zdrModelIds: ['vendor/dear', 'vendor/film'],
    });

    expect(catalog.descriptors.map((descriptor) => descriptor.id)).toContain('vendor/film');
    expect(ROUTING_SUBJECTS.ceiling(catalog)?.id).toBe('vendor/dear');
  });

  it('is absent from a listing with no text model', async () => {
    const catalog = await catalogOf({
      images: [imageEntry('vendor/picture')],
      imageEndpoints: imageEndpointsOf({
        'vendor/picture': [{ tag: 'painter', rows: [{ billable: 'output_image', cost: 0.04 }] }],
      }),
      zdrRows: [imageZdrRow('vendor/picture', 'painter')],
    });

    expect(ROUTING_SUBJECTS.ceiling(catalog)).toBeUndefined();
  });
});

/** A text model served by the given endpoints, beside a cheaper one-endpoint model that never qualifies. */
function sortFixture(
  rows: readonly Omit<RowSpec, 'modelId'>[],
  parameters: readonly string[] = ['max_tokens']
): CatalogFixture {
  return {
    models: [
      textEntry('vendor/routed', '0.000001', '0.000002', parameters),
      textEntry('vendor/single', '0.0000001', '0.0000002'),
    ],
    zdrRows: [
      ...rows.map((row) => zdrRow({ ...row, modelId: 'vendor/routed' })),
      zdrRow({
        modelId: 'vendor/single',
        providerName: 'Solo',
        tag: 'solo',
        prompt: '0.0000001',
        completion: '0.0000002',
      }),
    ],
  };
}

const ALPHA = { providerName: 'Alpha', tag: 'alpha', prompt: '0.000001', completion: '0.000002' };

describe('the cheapest-endpoint subject', () => {
  it('is a model whose dearer endpoints are each at least 10% dearer under other provider names', async () => {
    const catalog = await catalogOf(
      sortFixture([
        ALPHA,
        { providerName: 'Beta', tag: 'beta', prompt: '0.000002', completion: '0.000002' },
      ])
    );

    expect(ROUTING_SUBJECTS.sortCheapest(catalog)?.id).toBe('vendor/routed');
  });

  it('is the cheapest such model, wherever the listing places it', async () => {
    const twoEndpoints = (modelId: string, prompt: string): Record<string, unknown>[] => [
      zdrRow({ ...ALPHA, modelId, prompt }),
      zdrRow({
        modelId,
        providerName: 'Beta',
        tag: 'beta',
        prompt: '0.00001',
        completion: '0.00001',
      }),
    ];
    const catalog = await catalogOf({
      models: [
        textEntry('vendor/routed-dear', '0.000003', '0.000002'),
        textEntry('vendor/routed-cheap', '0.000001', '0.000002'),
        textEntry('vendor/routed-middling', '0.000002', '0.000002'),
      ],
      zdrRows: [
        ...twoEndpoints('vendor/routed-dear', '0.000003'),
        ...twoEndpoints('vendor/routed-cheap', '0.000001'),
        ...twoEndpoints('vendor/routed-middling', '0.000002'),
      ],
    });

    expect(ROUTING_SUBJECTS.sortCheapest(catalog)?.id).toBe('vendor/routed-cheap');
  });

  it('admits a dearer endpoint exactly 10% dearer', async () => {
    const catalog = await catalogOf(
      sortFixture([
        ALPHA,
        { providerName: 'Beta', tag: 'beta', prompt: '0.0000013', completion: '0.000002' },
      ])
    );

    expect(ROUTING_SUBJECTS.sortCheapest(catalog)?.id).toBe('vendor/routed');
  });

  it('is absent when a dearer endpoint is less than 10% dearer', async () => {
    const catalog = await catalogOf(
      sortFixture([
        ALPHA,
        { providerName: 'Beta', tag: 'beta', prompt: '0.0000012', completion: '0.000002' },
      ])
    );

    expect(ROUTING_SUBJECTS.sortCheapest(catalog)).toBeUndefined();
  });

  it('is absent when a dearer endpoint shares the cheapest endpoint provider name', async () => {
    const catalog = await catalogOf(
      sortFixture([
        ALPHA,
        { providerName: 'Alpha', tag: 'alpha/eu', prompt: '0.000002', completion: '0.000002' },
      ])
    );

    expect(ROUTING_SUBJECTS.sortCheapest(catalog)).toBeUndefined();
  });

  it('is absent when the model has a single servable endpoint', async () => {
    const catalog = await catalogOf(sortFixture([ALPHA]));

    expect(ROUTING_SUBJECTS.sortCheapest(catalog)).toBeUndefined();
  });

  it('does not count a service-tier endpoint as a dearer endpoint', async () => {
    const catalog = await catalogOf(
      sortFixture([
        ALPHA,
        { providerName: 'Beta', tag: 'beta/flex', prompt: '0.000002', completion: '0.000002' },
      ])
    );

    expect(ROUTING_SUBJECTS.sortCheapest(catalog)).toBeUndefined();
  });

  it('is absent when the cheapest endpoint lacks a parameter the model may be sent', async () => {
    const catalog = await catalogOf(
      sortFixture(
        [
          { ...ALPHA, parameters: ['max_tokens'] },
          {
            providerName: 'Beta',
            tag: 'beta',
            prompt: '0.000002',
            completion: '0.000002',
            parameters: ['max_tokens', 'tools'],
          },
        ],
        ['max_tokens', 'tools']
      )
    );

    expect(ROUTING_SUBJECTS.sortCheapest(catalog)).toBeUndefined();
  });

  it('counts a dearer endpoint lacking a parameter the model may be sent', async () => {
    const catalog = await catalogOf(
      sortFixture(
        [
          { ...ALPHA, providerName: 'Alpha', parameters: ['max_tokens', 'tools'] },
          {
            providerName: 'Beta',
            tag: 'beta',
            prompt: '0.000002',
            completion: '0.000002',
            parameters: ['max_tokens'],
          },
        ],
        ['max_tokens', 'tools']
      )
    );

    expect(ROUTING_SUBJECTS.sortCheapest(catalog)?.id).toBe('vendor/routed');
  });
});

describe('the cheapest serving endpoints', () => {
  it('are the servable endpoints at the lowest prompt + completion', async () => {
    const catalog = await catalogOf(
      sortFixture([
        { providerName: 'Beta', tag: 'beta', prompt: '0.000002', completion: '0.000002' },
        ALPHA,
        { providerName: 'Gamma', tag: 'gamma', prompt: '0.0000015', completion: '0.0000015' },
      ])
    );
    const subject = ROUTING_SUBJECTS.sortCheapest(catalog);
    if (subject === undefined) throw new Error('expected a subject');

    expect(
      cheapestServingEndpoints(catalog, subject).map((endpoint) => endpoint.providerName)
    ).toEqual(['Alpha', 'Gamma']);
  });
});

/**
 * One image model per table key, each endpoint ZDR-listed under its own tag
 * except an endpoint whose tag starts with `open`, which gets no ZDR row and so
 * stays outside the model's pin.
 */
function imageFixture(
  table: Readonly<Record<string, readonly ImageEndpointSpec[]>>
): CatalogFixture {
  return {
    images: Object.keys(table).map((id) => imageEntry(id)),
    imageEndpoints: imageEndpointsOf(table),
    zdrRows: Object.entries(table).flatMap(([id, endpoints]) =>
      endpoints
        .filter((endpoint) => !endpoint.tag.startsWith('open'))
        .map((endpoint) => imageZdrRow(id, endpoint.tag))
    ),
  };
}

const TWO_ROWS: ImageEndpointSpec = {
  tag: 'painter',
  rows: [
    { billable: 'output_image', cost: 0.01 },
    { billable: 'output_image', cost: 0.02 },
  ],
};

describe('the flat image subject', () => {
  it('is the cheapest exposed image model priced by one output row', async () => {
    const catalog = await catalogOf(
      imageFixture({
        'vendor/varied': [TWO_ROWS],
        'vendor/flat': [{ tag: 'drawer', rows: [{ billable: 'output_image', cost: 0.03 }] }],
      })
    );

    expect(ROUTING_SUBJECTS.imageFlat(catalog)?.id).toBe('vendor/flat');
  });

  it('is the cheapest flat-priced model, wherever the listing places it', async () => {
    const flat = (tag: string, cost: number): ImageEndpointSpec[] => [
      { tag, rows: [{ billable: 'output_image', cost }] },
    ];
    const catalog = await catalogOf(
      imageFixture({
        'vendor/flat-dear': flat('drawer', 0.06),
        'vendor/flat-cheap': flat('painter', 0.03),
        'vendor/flat-middling': flat('sketcher', 0.045),
      })
    );

    expect(ROUTING_SUBJECTS.imageFlat(catalog)?.id).toBe('vendor/flat-cheap');
  });

  it('reads only output rows', async () => {
    const catalog = await catalogOf(
      imageFixture({
        'vendor/flat': [
          {
            tag: 'drawer',
            rows: [
              { billable: 'output_image', cost: 0.03 },
              { billable: 'input_image', cost: 0.001 },
            ],
          },
        ],
      })
    );

    expect(ROUTING_SUBJECTS.imageFlat(catalog)?.id).toBe('vendor/flat');
  });

  it('reads only the pinned endpoints', async () => {
    const catalog = await catalogOf(
      imageFixture({
        'vendor/flat': [
          { tag: 'drawer', rows: [{ billable: 'output_image', cost: 0.03 }] },
          { tag: 'open-studio', rows: [{ billable: 'output_image', cost: 0.05 }] },
        ],
      })
    );

    expect(ROUTING_SUBJECTS.imageFlat(catalog)?.id).toBe('vendor/flat');
  });

  it('is absent when every image model is priced by more than one output row', async () => {
    const catalog = await catalogOf(imageFixture({ 'vendor/varied': [TWO_ROWS] }));

    expect(ROUTING_SUBJECTS.imageFlat(catalog)).toBeUndefined();
  });

  it('lists the one output row price', async () => {
    const catalog = await catalogOf(
      imageFixture({
        'vendor/flat': [{ tag: 'drawer', rows: [{ billable: 'output_image', cost: 0.03 }] }],
      })
    );
    const subject = ROUTING_SUBJECTS.imageFlat(catalog);
    if (subject === undefined) throw new Error('expected a subject');

    expect(listedOutputImagePrice(catalog, subject)).toBe('0.03');
  });
});

describe('the pinned image subject', () => {
  it('is the cheapest exposed image model, wherever the listing places it', async () => {
    const catalog = await catalogOf(
      imageFixture({
        'vendor/dear': [{ tag: 'drawer', rows: [{ billable: 'output_image', cost: 0.08 }] }],
        'vendor/cheap': [{ tag: 'painter', rows: [{ billable: 'output_image', cost: 0.02 }] }],
        'vendor/middling': [{ tag: 'sketcher', rows: [{ billable: 'output_image', cost: 0.05 }] }],
      })
    );

    expect(ROUTING_SUBJECTS.imagePin(catalog)?.id).toBe('vendor/cheap');
  });

  it('is absent from a listing with no image model', async () => {
    const catalog = await catalogOf({
      models: [textEntry('vendor/cheap', CHEAP.prompt, CHEAP.completion)],
      zdrModelIds: ['vendor/cheap'],
    });

    expect(ROUTING_SUBJECTS.imagePin(catalog)).toBeUndefined();
  });
});

describe('a foreign ZDR tag', () => {
  it('is a listed ZDR tag whose base slug names none of the model endpoints', async () => {
    const catalog = await catalogOf({
      ...imageFixture({
        'vendor/picture': [
          { tag: 'vertex/global', rows: [{ billable: 'output_image', cost: 0.04 }] },
        ],
      }),
      models: [textEntry('vendor/cheap', CHEAP.prompt, CHEAP.completion)],
      zdrRows: [
        imageZdrRow('vendor/picture', 'vertex/global'),
        zdrRow({ ...ALPHA, modelId: 'vendor/cheap', tag: 'vertex' }),
        zdrRow({ ...ALPHA, modelId: 'vendor/cheap', providerName: 'Zeta', tag: 'zeta' }),
      ],
    });
    const subject = ROUTING_SUBJECTS.imagePin(catalog);
    if (subject === undefined) throw new Error('expected a subject');

    expect(foreignZdrTag(catalog, subject)).toBe('zeta');
  });

  it('is absent when every listed ZDR tag shares a base slug with the model endpoints', async () => {
    const catalog = await catalogOf(
      imageFixture({
        'vendor/picture': [
          { tag: 'vertex/global', rows: [{ billable: 'output_image', cost: 0.04 }] },
        ],
      })
    );
    const subject = ROUTING_SUBJECTS.imagePin(catalog);
    if (subject === undefined) throw new Error('expected a subject');

    expect(foreignZdrTag(catalog, subject)).toBeUndefined();
  });
});

describe('the local fixture listing', () => {
  it('carries a ceiling subject', async () => {
    expect(ROUTING_SUBJECTS.ceiling(await fixtureRoutingCatalog())).toBeDefined();
  });

  it('carries a pinned image subject', async () => {
    expect(ROUTING_SUBJECTS.imagePin(await fixtureRoutingCatalog())).toBeDefined();
  });
});

describe('the endpoints a call names as serving it', () => {
  it('are read from its step-finish events, the only events the language adapter names them on', () => {
    const events: InferenceEvent[] = [
      { kind: 'step-start', step: 1 },
      { kind: 'text-delta', content: 'Hello' },
      { kind: 'step-finish', step: 1, generationId: 'gen-1', servedBy: 'Alpha' },
      {
        kind: 'finish',
        metadata: {
          generationId: 'gen-1',
          providerCostUsd: 0.000_001,
          usage: { inputTokens: 5, outputTokens: 2 },
          finishReason: 'stop',
        },
      },
    ];

    expect(servedByOf(events)).toEqual(['Alpha']);
  });

  it('name each step once, in step order', () => {
    const events: InferenceEvent[] = [
      { kind: 'step-finish', step: 1, generationId: 'gen-1', servedBy: 'Beta' },
      { kind: 'step-finish', step: 2, generationId: 'gen-2' },
      { kind: 'step-finish', step: 3, generationId: 'gen-3', servedBy: 'Alpha' },
      { kind: 'step-finish', step: 4, generationId: 'gen-4', servedBy: 'Beta' },
    ];

    expect(servedByOf(events)).toEqual(['Beta', 'Alpha']);
  });
});

describe("the anchor's listed max_price", () => {
  it('is the anchor endpoint listed rates in USD per million, with no fee round trip', async () => {
    const catalog = await catalogOf({
      models: [textEntry('vendor/routed', '0.00000001', '0.000000037')],
      zdrRows: [
        zdrRow({
          modelId: 'vendor/routed',
          providerName: 'Alpha',
          tag: 'alpha',
          prompt: '0.00000001',
          completion: '0.000000037',
        }),
        zdrRow({
          modelId: 'vendor/routed',
          providerName: 'Beta',
          tag: 'beta',
          prompt: '0.00000002',
          completion: '0.00000005',
        }),
      ],
    });
    const subject = ROUTING_SUBJECTS.ceiling(catalog);
    if (subject === undefined) throw new Error('expected a subject');

    expect(anchorListedMaxPrice(catalog, subject)).toEqual({
      prompt: '0.010000',
      completion: '0.037000',
    });
  });

  it('keeps every listed digit past the sixth decimal', async () => {
    const catalog = await catalogOf({
      models: [textEntry('vendor/routed', '0.0000000012345', '0.000002')],
      zdrModelIds: ['vendor/routed'],
    });
    const subject = ROUTING_SUBJECTS.ceiling(catalog);
    if (subject === undefined) throw new Error('expected a subject');

    expect(anchorListedMaxPrice(catalog, subject)).toEqual({
      prompt: '0.0012345',
      completion: '2.000000',
    });
  });
});
