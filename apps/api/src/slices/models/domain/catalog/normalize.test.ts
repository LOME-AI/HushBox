import { describe, expect, it } from 'vitest';
import { ModelDescriptor } from '@hushbox/shared';
import { MAX_MODEL_AGE_MS } from '@hushbox/shared/affordability';
import { DAY_MS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { canonicalJson } from '../../../../lib/idempotency/index.js';
import {
  normalizeCatalog as normalizeListedCatalog,
  normalizeModel as normalizeListedModel,
  pinnableZdrTags,
  textPricingFromEndpoints,
} from './normalize.js';
import { isNonConversational } from './non-chat-exclusions.js';
import { zdrEndpointFixture } from './gateway-fixtures.js';
import { endpointBucketCounts } from './price-schedule.js';
import type {
  ImageMetadata,
  ImagePricingEntry,
  LanguageMetadata,
  VideoMetadata,
  ZdrEndpoint,
} from './gateway-metadata.js';
import type {
  CatalogAdmission,
  CatalogEntry,
  DescriptorContent,
  StoredPricing,
  TextPricing,
  ZdrListing,
} from './normalize.js';

/**
 * The release date every fixture carries: seven weeks before the refresh clock
 * {@link NOW_MS}, so the age cutoff passes unless a test dates a model
 * deliberately old. Moving one without the other lands the fixtures after
 * "now".
 */
const FIXTURE_RELEASE_SECONDS = secondsAt(TEST_DAY_START - 49 * DAY_MS);

/** The rates a language fixture's one ZDR endpoint lists, as decimal USD strings. */
interface FixtureRates {
  readonly prompt?: string;
  readonly completion?: string;
  readonly cacheRead?: string;
}

/** A language model plus the price its single ZDR endpoint lists. */
type LanguageFixture = LanguageMetadata & { readonly pricing?: FixtureRates | undefined };

type ModelFixture = LanguageFixture | ImageMetadata | VideoMetadata;

function languageModel(overrides: Partial<LanguageFixture> = {}): LanguageFixture {
  return {
    source: 'language',
    id: 'openai/gpt-test',
    provider: 'openai',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportedParameters: ['temperature', 'top_p', 'max_tokens', 'tools', 'reasoning'],
    contextLength: 128_000,
    pricing: { prompt: '0.0000025', completion: '0.00001' },
    releasedAt: FIXTURE_RELEASE_SECONDS,
    deprecated: false,
    ...overrides,
  };
}

/** An image fixture's overrides; `endpointPricing` prices its one endpoint. */
type ImageOverrides = Partial<ImageMetadata> & {
  readonly endpointPricing?: readonly ImagePricingEntry[];
};

/**
 * An image model with one endpoint, tagged as {@link zdrEndpointFixture} tags a
 * ZDR row, so a listed fixture pins that endpoint unless `endpoints` says otherwise.
 */
function imageModel(overrides: ImageOverrides = {}): ImageMetadata {
  const {
    endpointPricing = [{ billable: 'output_image', unit: 'image', costUsd: '0.04' }],
    ...rest
  } = overrides;
  return {
    source: 'image',
    id: 'google/test-image',
    provider: 'google',
    inputModalities: ['text'],
    supportedParameters: { resolution: ['1024x1024'], aspectRatio: ['1:1'], maxN: 4 },
    endpoints: [{ providerTag: 'test-provider', pricing: endpointPricing }],
    releasedAt: FIXTURE_RELEASE_SECONDS,
    ...rest,
  };
}

/** A per-image output row at a vendor decimal rate. */
function perImageRow(costUsd: string): ImagePricingEntry {
  return { billable: 'output_image', unit: 'image', costUsd };
}

function videoModel(overrides: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    source: 'video',
    id: 'google/test-video',
    provider: 'google',
    supportsFrameImages: false,
    generateAudio: true,
    seed: true,
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9'],
    durations: ['4', '8'],
    pricingSkus: { duration_seconds_720p: '0.0988', duration_seconds_1080p: '0.15' },
    releasedAt: FIXTURE_RELEASE_SECONDS,
    ...overrides,
  };
}

/** The one ZDR endpoint a fixture lists: standard tier, every parameter a call sends, at the fixture's price. */
function endpointFor(model: ModelFixture | undefined): ZdrEndpoint {
  if (model?.source !== 'language' || model.pricing === undefined) {
    return zdrEndpointFixture(model?.source === 'language' ? { pricing: {} } : {});
  }
  const { prompt, completion, cacheRead } = model.pricing;
  return zdrEndpointFixture({
    pricing: {
      ...(prompt === undefined ? {} : { prompt }),
      ...(completion === undefined ? {} : { completion }),
      ...(cacheRead === undefined ? {} : { input_cache_read: cacheRead }),
    },
  });
}

/** The ZDR listing for a set of listed ids, each listing its fixture's one endpoint. */
function listingFor(models: readonly ModelFixture[], zdr: ReadonlySet<string>): ZdrListing {
  return new Map(
    [...zdr].map((id) => [id, [endpointFor(models.find((model) => model.id === id))]] as const)
  );
}

function normalizeModel(
  model: ModelFixture,
  zdr: ReadonlySet<string>,
  admission: CatalogAdmission
): ReturnType<typeof normalizeListedModel> {
  return normalizeListedModel(model, listingFor([model], zdr), admission);
}

function normalizeCatalog(
  models: readonly ModelFixture[],
  zdr: ReadonlySet<string>,
  nowMs: number
): CatalogEntry[] {
  return normalizeListedCatalog(models, listingFor(models, zdr), nowMs);
}

const ZDR: ReadonlySet<string> = new Set([
  'openai/gpt-test',
  'google/test-image',
  'google/test-video',
]);

/** The refresh clock the fixtures are dated against — seven weeks after
 * {@link FIXTURE_RELEASE_SECONDS}, so the age cutoff passes unless a test dates
 * a model deliberately old. */
const NOW_MS = TEST_DAY_START;

/** A release date one second past the age cutoff, derived from the constant so
 * the boundary cannot drift away from the rule. */
const OLDER_THAN_LIMIT_SECONDS = Math.trunc((NOW_MS - MAX_MODEL_AGE_MS) / 1000) - 1;

/** Pool-relative admission inputs. `ADMISSION` holds the context exemption
 * above every fixture's context length, so the price floor and the age cutoff
 * are the live rules. */
const ADMISSION: CatalogAdmission = { contextExemptionTokens: 1_000_000_000, nowMs: NOW_MS };

/** The exemption a small pool produces: every context length is in the top
 * percentile, so the floor and the cutoff are both bypassed. Used by fixtures
 * that state a sub-floor rate in order to exercise something else. */
const EXEMPT: CatalogAdmission = { contextExemptionTokens: 0, nowMs: NOW_MS };

function tokenPrice(input: string, output: string, anchorContextTokens = 128_000): StoredPricing {
  return { kind: 'tokens', anchor: { base: { input, output }, tiers: [] }, anchorContextTokens };
}

function perImagePrice(rate: string): StoredPricing {
  return { kind: 'perImage', anchor: rate, dearest: rate };
}

/** `bytedance-seed/seedream-5-0-pro`'s one endpoint as listed: a $0.045 row, a $0.09
 * row under the `high_resolution` variant, and an input-image row that prices no output. */
const SEEDREAM_PRO_ROWS: readonly ImagePricingEntry[] = [
  { billable: 'output_image', unit: 'image', costUsd: '0.045' },
  { billable: 'output_image', unit: 'image', costUsd: '0.09' },
  { billable: 'input_image', unit: 'image', costUsd: '0.003' },
];

function perSecondPrice(rates: Readonly<Record<string, string>>): StoredPricing {
  return { kind: 'perSecond', anchor: rates, dearest: rates };
}

function normalized(outcome: ReturnType<typeof normalizeModel>): DescriptorContent {
  if (outcome.kind !== 'normalized') throw new Error(`expected normalized, got ${outcome.kind}`);
  return outcome.content;
}

describe('normalizeModel (language)', () => {
  it('normalizes a language model into descriptor content', () => {
    expect(normalized(normalizeModel(languageModel(), ZDR, ADMISSION))).toMatchObject({
      id: 'openai/gpt-test',
      provider: 'openai',
      inputs: ['text', 'image'],
      outputs: ['text'],
      behaviors: ['streaming', 'tools', 'reasoning'],
      limits: { contextLength: 128_000 },
      pricing: tokenPrice('2875', '11500'),
      zdrReachable: true,
    });
  });

  it('never carries the gateway popularityRank into descriptor content', () => {
    const content = normalized(
      normalizeModel(languageModel({ popularityRank: 7 }), ZDR, ADMISSION)
    );
    expect('popularityRank' in content).toBe(false);
  });

  it('seeds parameter specs from supported parameter names', () => {
    const content = normalized(normalizeModel(languageModel(), ZDR, ADMISSION));
    expect(content.parameters['temperature']).toMatchObject({ type: 'number', wire: 'firstClass' });
    expect(content.parameters['topP']).toMatchObject({ type: 'number' });
    expect(content.parameters['maxOutputTokens']).toMatchObject({ type: 'integer' });
  });

  it('skips supported parameter names without a known spec', () => {
    const content = normalized(
      normalizeModel(
        languageModel({ supportedParameters: ['temperature', 'mystery_knob'] }),
        ZDR,
        ADMISSION
      )
    );
    expect(Object.keys(content.parameters)).toEqual(['temperature']);
  });

  it('carries the gateway reasoning metadata into descriptor content', () => {
    const content = normalized(
      normalizeModel(
        languageModel({
          reasoning: {
            mandatory: true,
            supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'none'],
            defaultEffort: 'medium',
            defaultEnabled: true,
          },
        }),
        ZDR,
        ADMISSION
      )
    );
    expect(content.reasoning).toEqual({
      mandatory: true,
      supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'none'],
      defaultEffort: 'medium',
      defaultEnabled: true,
    });
  });

  it('leaves the reasoning field absent when the gateway carries no reasoning object', () => {
    const content = normalized(normalizeModel(languageModel(), ZDR, ADMISSION));
    expect('reasoning' in content).toBe(false);
  });

  it('round-trips a reasoning-carrying descriptor through the persisted jsonb schema', () => {
    const content = normalized(
      normalizeModel(
        languageModel({ reasoning: { mandatory: false, supportedEfforts: null } }),
        ZDR,
        ADMISSION
      )
    );
    const parsed = ModelDescriptor.parse({ ...content, fetchedAt: 0 });
    expect(parsed.reasoning).toEqual({ mandatory: false, supportedEfforts: null });
  });

  it('excludes a model whose output modalities classify to no family', () => {
    expect(normalizeModel(languageModel({ outputModalities: ['smell'] }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'unclassifiable-modality',
    });
  });

  it('excludes a model with empty output modalities', () => {
    expect(normalizeModel(languageModel({ outputModalities: [] }), ZDR, ADMISSION)).toMatchObject({
      kind: 'excluded',
      reason: 'unclassifiable-modality',
    });
  });

  it('excludes a deprecated model', () => {
    expect(normalizeModel(languageModel({ deprecated: true }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'deprecated',
    });
  });

  it('carries the source description into descriptor content for every family', () => {
    expect(
      normalized(
        normalizeModel(languageModel({ description: 'Fast frontier model.' }), ZDR, ADMISSION)
      ).description
    ).toBe('Fast frontier model.');
    expect(
      normalized(normalizeModel(imageModel({ description: 'Draws pictures.' }), ZDR, ADMISSION))
        .description
    ).toBe('Draws pictures.');
    expect(
      normalized(normalizeModel(videoModel({ description: 'Makes movies.' }), ZDR, ADMISSION))
        .description
    ).toBe('Makes movies.');
  });

  it('omits description when the source carries none — absence never excludes', () => {
    expect(normalized(normalizeModel(languageModel(), ZDR, ADMISSION))).not.toHaveProperty(
      'description'
    );
  });

  it('carries the source display name into descriptor content for every family', () => {
    expect(
      normalized(normalizeModel(languageModel({ name: 'GPT Test' }), ZDR, ADMISSION)).name
    ).toBe('GPT Test');
    expect(normalized(normalizeModel(imageModel({ name: 'Draw Test' }), ZDR, ADMISSION)).name).toBe(
      'Draw Test'
    );
    expect(normalized(normalizeModel(videoModel({ name: 'Film Test' }), ZDR, ADMISSION)).name).toBe(
      'Film Test'
    );
  });

  it('omits name when the source carries none — absence never excludes', () => {
    expect(normalized(normalizeModel(languageModel(), ZDR, ADMISSION))).not.toHaveProperty('name');
  });

  it('parses a stored descriptor row written before name/description existed (additive-optional)', () => {
    const legacyRow = {
      id: 'openai/legacy',
      provider: 'openai',
      version: '4',
      inputs: ['text'],
      outputs: ['text'],
      parameters: {},
      behaviors: ['streaming'],
      limits: {},
      pricing: tokenPrice('2875', '11500'),
      zdrReachable: true,
      releasedAt: FIXTURE_RELEASE_SECONDS,
      fetchedAt: 0,
    };
    const parsed = ModelDescriptor.parse(legacyRow);
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
  });

  it('captures the release timestamp as releasedAt', () => {
    expect(normalized(normalizeModel(languageModel(), ZDR, ADMISSION)).releasedAt).toBe(
      FIXTURE_RELEASE_SECONDS
    );
  });

  it('excludes a language model with no release date (fail-closed)', () => {
    expect(normalizeModel(languageModel({ releasedAt: undefined }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'missing-release-date',
    });
  });

  it('excludes a language model with a non-positive release date (fail-closed)', () => {
    for (const releasedAt of [0, -1]) {
      expect(normalizeModel(languageModel({ releasedAt }), ZDR, ADMISSION)).toEqual({
        kind: 'excluded',
        modelId: 'openai/gpt-test',
        reason: 'missing-release-date',
      });
    }
  });

  it('excludes a language model not in the ZDR set (only ZDR models are persisted)', () => {
    expect(normalizeModel(languageModel(), new Set<string>(), ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'non-zdr',
    });
  });

  it('filters input modalities outside the closed enum', () => {
    expect(
      normalized(
        normalizeModel(languageModel({ inputModalities: ['text', 'smell'] }), ZDR, ADMISSION)
      ).inputs
    ).toEqual(['text']);
  });

  it('defaults empty input modalities to text', () => {
    expect(
      normalized(normalizeModel(languageModel({ inputModalities: [] }), ZDR, ADMISSION)).inputs
    ).toEqual(['text']);
  });

  it('assigns no language behaviors to a media-only-output model', () => {
    const content = normalized(
      normalizeModel(languageModel({ outputModalities: ['image', 'video'] }), ZDR, ADMISSION)
    );
    expect(content.behaviors).toEqual([]);
    expect(content.outputs).toEqual(['image', 'video']);
  });

  it('excludes a text model whose standard-tier endpoint lists no prompt rate, loudly', () => {
    // A standard-tier endpoint whose price states no prompt rate prices a call at a
    // rate nothing bounds. The warning the reason raises is emitted by the
    // refresh, and asserted in `refresh.integration.test.ts`.
    expect(
      normalizeModel(languageModel({ pricing: { completion: '0.00001' } }), ZDR, ADMISSION)
    ).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'unrepresentable-endpoint-price',
    });
  });

  it('excludes a text model with exactly one zero token rate, loudly (unknown-pricing-unit)', () => {
    expect(
      normalizeModel(
        languageModel({ pricing: { prompt: '0.0000025', completion: '0' } }),
        ZDR,
        ADMISSION
      )
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'unknown-pricing-unit' });
  });

  it('excludes a text model whose standard-tier endpoint lists a rate that is not a decimal, loudly', () => {
    expect(
      normalizeModel(
        languageModel({ pricing: { prompt: 'mystery', completion: '0.00001' } }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'unrepresentable-endpoint-price',
    });
  });

  it('carries no cache-read rate, since nothing HushBox reserves or bills reads one', () => {
    expect(
      normalized(
        normalizeModel(
          languageModel({
            pricing: { prompt: '0.000002', completion: '0.00001', cacheRead: '0.000001' },
          }),
          ZDR,
          ADMISSION
        )
      ).pricing
    ).toEqual(tokenPrice('2300', '11500'));
  });

  it('omits limits when there is no context length', () => {
    expect(
      normalized(normalizeModel(languageModel({ contextLength: undefined }), ZDR, ADMISSION)).limits
    ).toEqual({});
  });

  it('excludes a model whose gateway window is not a positive integer', () => {
    for (const nonsensical of [0, -1, 8192.5]) {
      expect(normalizeModel(languageModel({ contextLength: nonsensical }), ZDR, ADMISSION)).toEqual(
        {
          kind: 'excluded',
          modelId: 'openai/gpt-test',
          reason: 'unrepresentable-token-limit',
        }
      );
    }
  });

  it('excludes a model whose gateway window is past the safe-integer range without failing the catalog', () => {
    const models = [
      languageModel({ id: 'unsafe/window', contextLength: 2 ** 53 }),
      languageModel({ id: 'healthy/model' }),
    ];
    expect(
      normalizeCatalog(models, new Set(models.map((model) => model.id)), NOW_MS).map((entry) =>
        entry.kind === 'excluded' ? entry.reason : entry.kind
      )
    ).toEqual(['unrepresentable-token-limit', 'normalized']);
  });

  it.each([
    ['window', { contextLength: 2 ** 53 }],
    ['window', { contextLength: 1e300 }],
    ['ceiling', { maxCompletionTokens: 2 ** 53 }],
    ['ceiling', { maxCompletionTokens: 1e300 }],
  ])(
    'excludes a model whose gateway %s is an integer past the safe range: %o',
    (_limit, limits) => {
      expect(normalizeModel(languageModel(limits), ZDR, ADMISSION)).toEqual({
        kind: 'excluded',
        modelId: 'openai/gpt-test',
        reason: 'unrepresentable-token-limit',
      });
    }
  );

  it('keeps a gateway window at the largest safe integer', () => {
    expect(
      normalized(
        normalizeModel(languageModel({ contextLength: Number.MAX_SAFE_INTEGER }), ZDR, ADMISSION)
      ).limits
    ).toEqual({ contextLength: Number.MAX_SAFE_INTEGER });
  });

  it('writes limits.maxOutputTokens from a positive-integer gateway ceiling', () => {
    expect(
      normalized(normalizeModel(languageModel({ maxCompletionTokens: 16_384 }), ZDR, ADMISSION))
        .limits
    ).toEqual({ contextLength: 128_000, maxOutputTokens: 16_384 });
  });

  it('omits maxOutputTokens when the gateway reports no ceiling', () => {
    expect(
      normalized(normalizeModel(languageModel({ maxCompletionTokens: undefined }), ZDR, ADMISSION))
        .limits
    ).toEqual({ contextLength: 128_000 });
  });

  it('excludes a model whose gateway ceiling is not a positive integer', () => {
    for (const nonsensical of [0, -1, 0.5]) {
      expect(
        normalizeModel(languageModel({ maxCompletionTokens: nonsensical }), ZDR, ADMISSION)
      ).toEqual({
        kind: 'excluded',
        modelId: 'openai/gpt-test',
        reason: 'unrepresentable-token-limit',
      });
    }
  });

  it('keeps the reason a row already earned when its window is also unrepresentable', () => {
    expect(
      normalizeModel(
        languageModel({ contextLength: 8192.5, releasedAt: undefined }),
        ZDR,
        ADMISSION
      )
    ).toMatchObject({ kind: 'excluded', reason: 'missing-release-date' });
  });
});

describe('normalizeModel (missing aspect ratio)', () => {
  it('excludes an image model that declares no aspect ratio', () => {
    expect(
      normalizeModel(
        imageModel({
          supportedParameters: { resolution: ['1024x1024'], aspectRatio: [], maxN: 4 },
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'missing-aspect-ratio',
    });
  });

  it('excludes a video model that declares no aspect ratio', () => {
    expect(normalizeModel(videoModel({ aspectRatios: [] }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'missing-aspect-ratio',
    });
  });

  it('keeps the earlier exclusion reason for a shapeless row that is already hidden', () => {
    expect(normalizeModel(videoModel({ aspectRatios: [] }), new Set<string>(), ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'non-zdr',
    });
  });
});

describe('normalizeModel (specialty exclusions)', () => {
  const NO_ZDR: ReadonlySet<string> = new Set<string>();

  it('excludes a non-ZDR model for each family with reason non-zdr', () => {
    expect(normalizeModel(languageModel(), NO_ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'non-zdr',
    });
    expect(normalizeModel(imageModel(), NO_ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'non-zdr',
    });
    expect(normalizeModel(videoModel(), NO_ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'non-zdr',
    });
  });

  it('non-zdr wins over an otherwise-quiet exclusion reason', () => {
    expect(normalizeModel(languageModel({ deprecated: true }), NO_ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'non-zdr',
    });
  });

  it('excludes a ZDR-reachable model from the banned provider relace', () => {
    expect(
      normalizeModel(
        languageModel({ id: 'relace/relace-apply-3', provider: 'relace' }),
        new Set(['relace/relace-apply-3']),
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'relace/relace-apply-3',
      reason: 'non-conversational',
    });
  });

  it('excludes a ZDR-reachable model from the banned provider morph', () => {
    expect(
      normalizeModel(
        languageModel({ id: 'morph/morph-v3-large', provider: 'morph' }),
        new Set(['morph/morph-v3-large']),
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'morph/morph-v3-large',
      reason: 'non-conversational',
    });
  });

  it('excludes a ZDR-reachable moderation model by its guard/safeguard id or name', () => {
    // Id matches the guard heuristic but is not a denylist member and its
    // provider is not banned — isolating the id-regex branch.
    expect(
      normalizeModel(
        languageModel({ id: 'acme/acme-guard-9b', provider: 'acme' }),
        new Set(['acme/acme-guard-9b']),
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'acme/acme-guard-9b',
      reason: 'non-conversational',
    });
    // Name-only match: id is clean, the display name carries "Safeguard".
    expect(
      normalizeModel(
        languageModel({ id: 'acme/chat-42', provider: 'acme', name: 'Acme Safeguard' }),
        new Set(['acme/chat-42']),
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'acme/chat-42',
      reason: 'non-conversational',
    });
  });

  it('excludes a ZDR-reachable model whose id is on the explicit denylist', () => {
    // A denylisted id with a non-banned provider and no guard/safeguard token,
    // so only the explicit denylist catches it — isolating that branch.
    expect(
      normalizeModel(
        languageModel({ id: 'morph/morph-v3-fast', provider: 'not-banned', name: 'Fast Coder' }),
        new Set(['morph/morph-v3-fast']),
        ADMISSION
      )
    ).toMatchObject({ kind: 'excluded', reason: 'non-conversational' });
  });

  it('still normalizes a ZDR-reachable general chat model (no over-exclusion)', () => {
    expect(normalized(normalizeModel(languageModel(), ZDR, ADMISSION)).zdrReachable).toBe(true);
  });

  // Perplexity `sonar` models are conversational search models and must stay
  // in the catalog — they superficially resemble "search" specialty models but
  // are not non-conversational. This guard pins the product decision so a future
  // denylist/regex change can't silently exclude them.
  it('keeps the Perplexity sonar family (conversational search, never a specialty exclusion)', () => {
    const sonarIds = [
      'perplexity/sonar',
      'perplexity/sonar-pro',
      'perplexity/sonar-reasoning',
      'perplexity/sonar-deep-research',
      'perplexity/sonar-pro-search',
    ];
    const noName: string | undefined = undefined;
    for (const id of sonarIds) {
      expect(isNonConversational(id, 'perplexity', noName)).toBe(false);
      expect(
        normalizeModel(languageModel({ id, provider: 'perplexity' }), new Set([id]), ADMISSION)
      ).toMatchObject({ kind: 'normalized' });
    }
  });
});

describe('normalizeModel (image)', () => {
  it('normalizes an image model with per-image pricing and derived params', () => {
    const content = normalized(normalizeModel(imageModel(), ZDR, ADMISSION));
    expect(content).toMatchObject({
      outputs: ['image'],
      inputs: ['text'],
      behaviors: [],
      pricing: perImagePrice('46000000'),
      zdrReachable: true,
      zdrPin: ['test-provider'],
    });
    expect(content.parameters['aspectRatio']).toMatchObject({ type: 'enum', values: ['1:1'] });
    expect(content.parameters['resolution']).toMatchObject({ type: 'enum', values: ['1024x1024'] });
    expect(content.parameters['n']).toMatchObject({ type: 'integer', min: 1, max: 4 });
    expect(content.releasedAt).toBe(FIXTURE_RELEASE_SECONDS);
  });

  it('carries no limits — image models have no token-cap concept', () => {
    expect(normalized(normalizeModel(imageModel(), ZDR, ADMISSION)).limits).toEqual({});
  });

  it('excludes an image model with no release date (fail-closed)', () => {
    expect(normalizeModel(imageModel({ releasedAt: undefined }), ZDR, ADMISSION)).toMatchObject({
      kind: 'excluded',
      reason: 'missing-release-date',
    });
  });

  it('excludes an image model with a non-positive release date (fail-closed)', () => {
    for (const releasedAt of [0, -1]) {
      expect(normalizeModel(imageModel({ releasedAt }), ZDR, ADMISSION)).toMatchObject({
        kind: 'excluded',
        reason: 'missing-release-date',
      });
    }
  });

  it('ignores non-output rows so an image-unit input rate never prices the model', () => {
    // The input_image image-unit row must not price the model; the output row is
    // megapixel, so the model is excluded (quietly) rather than priced off the input.
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [
            { billable: 'input_image', unit: 'image', costUsd: '0.04' },
            { billable: 'output_image', unit: 'megapixel', costUsd: '0.01' },
          ],
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'megapixel-priced-image',
    });
  });

  it('excludes a megapixel-priced image model quietly (megapixel-priced-image, not a defect)', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'megapixel', costUsd: '0.01' }],
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'megapixel-priced-image',
    });
  });

  it('excludes an image model with no output pricing rows quietly (missing-pricing)', () => {
    expect(normalizeModel(imageModel({ endpointPricing: [] }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'missing-pricing',
    });
  });

  it('excludes an image model whose only output row has a per-input role quietly (missing-pricing)', () => {
    // Only input_image rows means no output pricing exists at all — missing, not unknown.
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'input_image', unit: 'megapixel', costUsd: '0.06' }],
        }),
        ZDR,
        ADMISSION
      )
    ).toMatchObject({ kind: 'excluded', reason: 'missing-pricing' });
  });

  it('loudly excludes an image model whose output unit is genuinely unrecognized', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'furlong', costUsd: '0.01' }],
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'unknown-pricing-unit',
    });
  });

  it('excludes a token-priced image model quietly (token-priced-image, not a defect)', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'token', costUsd: '0.00003' }],
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'token-priced-image',
    });
  });

  it('treats any per-token output unit as token-priced-image, not unknown', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'output_token', costUsd: '0.00003' }],
        }),
        ZDR,
        ADMISSION
      )
    ).toMatchObject({ kind: 'excluded', reason: 'token-priced-image' });
  });

  it.each([
    ['an unrecognized unit', 'image_hd', '5'],
    ['a per-token unit', 'token', '0.00003'],
    ['a per-megapixel unit', 'megapixel', '0.01'],
  ])(
    'excludes an image model with an output row of %s beside a per-image row, loudly',
    (_shape, unit, costUsd) => {
      // The reserve must cover every row the provider can bill, and this row's
      // per-image figure is unknown.
      expect(
        normalizeModel(
          imageModel({
            endpointPricing: [
              { billable: 'output_image', unit, costUsd },
              { billable: 'output_image', unit: 'image', costUsd: '0.045' },
            ],
          }),
          ZDR,
          ADMISSION
        )
      ).toEqual({
        kind: 'excluded',
        modelId: 'google/test-image',
        reason: 'unknown-pricing-unit',
      });
    }
  );

  it('prices an image model whose output rows are all per-image', () => {
    const content = normalized(
      normalizeModel(
        imageModel({
          endpointPricing: [
            { billable: 'output_image', unit: 'image', costUsd: '0.045' },
            { billable: 'output_image', unit: 'per_image', costUsd: '0.09' },
          ],
        }),
        ZDR,
        ADMISSION
      )
    );
    expect(content.pricing).toEqual({
      kind: 'perImage',
      anchor: '51750000',
      dearest: '103500000',
    });
  });

  it('excludes an image model with a sub-nano per-image row beside a priced one, loudly', () => {
    // Below 1 nano-USD the row is a free row in another spelling, and a free row
    // beside a priced one is a price the schedule cannot represent.
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [
            { billable: 'output_image', unit: 'image', costUsd: '0.045' },
            { billable: 'output_image', unit: 'image', costUsd: `0.${'0'.repeat(30)}1` },
          ],
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'unknown-pricing-unit',
    });
  });

  it('omits the optional image params the structured surface does not declare', () => {
    const content = normalized(
      normalizeModel(
        imageModel({
          supportedParameters: { resolution: [], aspectRatio: ['1:1'], maxN: undefined },
        }),
        ZDR,
        ADMISSION
      )
    );
    expect(content.parameters).toEqual({
      aspectRatio: { type: 'enum', values: ['1:1'], wire: 'providerOptions' },
    });
  });

  it('reserves an image at its dearest per-image row, variant rows included', () => {
    const content = normalized(
      normalizeModel(imageModel({ endpointPricing: SEEDREAM_PRO_ROWS }), ZDR, ADMISSION)
    );
    // $0.09 × 1.15, where the first-listed $0.045 row would store 51,750,000.
    expect(content.pricing).toMatchObject({ kind: 'perImage', dearest: '103500000' });
  });

  it('anchors an image at its cheapest per-image row whatever order the rows are listed in', () => {
    const content = normalized(
      normalizeModel(
        imageModel({ endpointPricing: SEEDREAM_PRO_ROWS.toReversed() }),
        ZDR,
        ADMISSION
      )
    );
    expect(content.pricing).toMatchObject({ kind: 'perImage', anchor: '51750000' });
  });

  it('bakes a per-image rate from its vendor decimal with one round-up', () => {
    // ceil(0.0000000605 × 10⁹ × 1.15) = ceil(69.575) = 70; rounding the rate to
    // 60 nano first would store 69.
    const content = normalized(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'image', costUsd: '0.0000000605' }],
        }),
        ZDR,
        ADMISSION
      )
    );
    expect(content.pricing).toEqual(perImagePrice('70'));
  });

  it('excludes an image model with an unreadable per-image row beside a readable one, loudly', () => {
    // The reserve must cover every row, and an unreadable row's rate is unknown.
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [
            { billable: 'output_image', unit: 'image', costUsd: '0.045' },
            { billable: 'output_image', unit: 'image', costUsd: 'mystery' },
          ],
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'unknown-pricing-unit',
    });
  });

  it('defaults the resolution to the smallest listed size when the per-image rows differ in price', () => {
    const content = normalized(
      normalizeModel(
        imageModel({
          endpointPricing: SEEDREAM_PRO_ROWS,
          supportedParameters: { resolution: ['2K', '1K', '768'], aspectRatio: ['1:1'], maxN: 1 },
        }),
        ZDR,
        ADMISSION
      )
    );
    expect(content.parameters['resolution']).toMatchObject({ default: '768' });
  });

  it('defaults the resolution to a sized value over one that names no size', () => {
    const content = normalized(
      normalizeModel(
        imageModel({
          endpointPricing: SEEDREAM_PRO_ROWS,
          supportedParameters: { resolution: ['auto', '2K', '1K'], aspectRatio: ['1:1'], maxN: 1 },
        }),
        ZDR,
        ADMISSION
      )
    );
    expect(content.parameters['resolution']).toMatchObject({ default: '1K' });
  });

  it('declares no resolution default when every per-image row prices the same', () => {
    const content = normalized(
      normalizeModel(
        imageModel({
          endpointPricing: [
            { billable: 'output_image', unit: 'image', costUsd: '0.03' },
            { billable: 'output_image', unit: 'image', costUsd: '0.03' },
          ],
          supportedParameters: { resolution: ['1K', '2K'], aspectRatio: ['1:1'], maxN: 1 },
        }),
        ZDR,
        ADMISSION
      )
    );
    expect(content.parameters['resolution']).toEqual({
      type: 'enum',
      values: ['1K', '2K'],
      wire: 'providerOptions',
    });
  });

  it('declares no resolution when a variant-priced model lists none', () => {
    const content = normalized(
      normalizeModel(
        imageModel({
          endpointPricing: SEEDREAM_PRO_ROWS,
          supportedParameters: { resolution: [], aspectRatio: ['1:1'], maxN: 1 },
        }),
        ZDR,
        ADMISSION
      )
    );
    expect(content.parameters['resolution']).toBeUndefined();
  });

  it('excludes an image model whose only per-image rate is unrepresentable in nano-USD', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'image', costUsd: 'mystery' }],
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'unknown-pricing-unit',
    });
  });
});

describe('pinnableZdrTags', () => {
  it('pins a ZDR tag that an image endpoint carries', () => {
    expect(pinnableZdrTags(['seed'], ['seed'])).toEqual(['seed']);
  });

  it('leaves out a ZDR tag no image endpoint carries', () => {
    expect(pinnableZdrTags(['seed', 'azure'], ['seed'])).toEqual(['seed']);
  });

  it('never pins an endpoint whose tag is null', () => {
    expect(pinnableZdrTags(['seed'], [null])).toEqual([]);
  });

  it('pins nothing when any image endpoint has no tag', () => {
    // The pin cannot speak for an endpoint it cannot name.
    expect(pinnableZdrTags(['seed'], ['seed', null])).toEqual([]);
  });

  it('pins every tagged endpoint when each one is named', () => {
    expect(pinnableZdrTags(['seed', 'azure'], ['seed', 'azure'])).toEqual(['seed', 'azure']);
  });

  it('pins each tag once', () => {
    expect(pinnableZdrTags(['seed', 'seed'], ['seed', 'seed'])).toEqual(['seed']);
  });

  it('pins nothing when a non-ZDR endpoint carries a pinned tag', () => {
    // Two endpoints under one tag against one ZDR row: `only` would admit both.
    expect(pinnableZdrTags(['azure'], ['azure', 'azure'])).toEqual([]);
  });

  it('pins nothing when a non-ZDR endpoint is a variant of a pinned base slug', () => {
    // A base slug in `only` matches every variant under it.
    expect(pinnableZdrTags(['azure'], ['azure', 'azure/eu'])).toEqual([]);
  });

  it('keeps a pin whose non-ZDR sibling only shares a name prefix', () => {
    expect(pinnableZdrTags(['azure'], ['azure', 'azure-eu'])).toEqual(['azure']);
  });

  it('keeps a full-slug pin beside non-ZDR endpoints of another provider', () => {
    expect(
      pinnableZdrTags(
        ['google-vertex/global'],
        [
          'google-ai-studio/priority',
          'google-ai-studio/flex',
          'google-ai-studio',
          'google-vertex/global',
        ]
      )
    ).toEqual(['google-vertex/global']);
  });

  it('keeps a variant pin beside a non-ZDR base endpoint of the same provider', () => {
    // `only: ["google-vertex/global"]` targets that variant alone, never the base.
    expect(
      pinnableZdrTags(['google-vertex/global'], ['google-vertex/global', 'google-vertex'])
    ).toEqual(['google-vertex/global']);
  });
});

describe('normalizeModel (image ZDR pin)', () => {
  /** A ZDR listing of one model, one row per tag. */
  function zdrRows(modelId: string, tags: readonly string[]): ZdrListing {
    return new Map([[modelId, tags.map((tag) => zdrEndpointFixture({ tag }))]]);
  }

  it('excludes a model whose non-ZDR endpoint is a variant of its ZDR base slug', () => {
    const model = imageModel({
      id: 'microsoft/test-image',
      endpoints: [
        { providerTag: 'azure', pricing: [perImageRow('0.04')] },
        { providerTag: 'azure/eu', pricing: [perImageRow('0.04')] },
      ],
    });

    expect(
      normalizeListedModel(model, zdrRows('microsoft/test-image', ['azure']), ADMISSION)
    ).toEqual({ kind: 'excluded', modelId: 'microsoft/test-image', reason: 'non-zdr' });
  });

  it("pins google/gemini-2.5-flash-image's one ZDR endpoint among its AI Studio ones", () => {
    const model = imageModel({
      id: 'google/gemini-2.5-flash-image',
      endpoints: [
        { providerTag: 'google-ai-studio/priority', pricing: [perImageRow('0.039')] },
        { providerTag: 'google-ai-studio/flex', pricing: [perImageRow('0.039')] },
        { providerTag: 'google-ai-studio', pricing: [perImageRow('0.039')] },
        { providerTag: 'google-vertex/global', pricing: [perImageRow('0.039')] },
      ],
    });

    const content = normalized(
      normalizeListedModel(
        model,
        zdrRows('google/gemini-2.5-flash-image', ['google-vertex/global']),
        ADMISSION
      )
    );

    expect(content.zdrPin).toEqual(['google-vertex/global']);
  });

  it('excludes a model with an untagged endpoint beside its ZDR endpoint', () => {
    const model = imageModel({
      endpoints: [
        { providerTag: 'test-provider', pricing: [perImageRow('0.04')] },
        { providerTag: null, pricing: [perImageRow('0.04')] },
      ],
    });

    expect(normalizeModel(model, ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'google/test-image',
      reason: 'non-zdr',
    });
  });

  it('excludes a listed model whose ZDR tags no image endpoint carries', () => {
    expect(
      normalizeListedModel(imageModel(), zdrRows('google/test-image', ['other']), ADMISSION)
    ).toEqual({ kind: 'excluded', modelId: 'google/test-image', reason: 'non-zdr' });
  });

  it('reserves the dearest row of the pinned endpoints only', () => {
    const model = imageModel({
      endpoints: [
        { providerTag: 'test-provider', pricing: [perImageRow('0.04')] },
        { providerTag: 'other', pricing: [perImageRow('0.09')] },
      ],
    });

    expect(normalized(normalizeModel(model, ZDR, ADMISSION)).pricing).toEqual(
      perImagePrice('46000000')
    );
  });

  it('anchors on the cheapest row of the pinned endpoints only', () => {
    const model = imageModel({
      endpoints: [
        { providerTag: 'test-provider', pricing: [perImageRow('0.04')] },
        { providerTag: 'other', pricing: [perImageRow('0.01')] },
      ],
    });

    expect(normalized(normalizeModel(model, ZDR, ADMISSION)).pricing).toEqual(
      perImagePrice('46000000')
    );
  });

  it('carries the pin when a language row and an image row merge into an image model', () => {
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'dup/pic', outputModalities: ['image'] }),
        imageModel({ id: 'dup/pic' }),
      ],
      new Set(['dup/pic']),
      NOW_MS
    );

    expect(entries[0]).toMatchObject({
      kind: 'normalized',
      content: { zdrPin: ['test-provider'] },
    });
  });

  it('excludes an image model no image endpoint pins, reached through a language row alone', () => {
    const entries = normalizeCatalog(
      [languageModel({ id: 'solo/pic', outputModalities: ['image'] })],
      new Set(['solo/pic']),
      NOW_MS
    );

    expect(entries).toEqual([{ kind: 'excluded', modelId: 'solo/pic', reason: 'non-zdr' }]);
  });
});

describe('normalizeModel (video SKU interpreter)', () => {
  it('captures the release timestamp and excludes a video model with no release date', () => {
    expect(normalized(normalizeModel(videoModel(), ZDR, ADMISSION)).releasedAt).toBe(
      FIXTURE_RELEASE_SECONDS
    );
    expect(normalizeModel(videoModel({ releasedAt: undefined }), ZDR, ADMISSION)).toMatchObject({
      kind: 'excluded',
      reason: 'missing-release-date',
    });
  });

  it('carries no limits — video models have no token-cap concept', () => {
    expect(normalized(normalizeModel(videoModel(), ZDR, ADMISSION)).limits).toEqual({});
  });

  it('excludes a video model with a non-positive release date (fail-closed)', () => {
    for (const releasedAt of [0, -1]) {
      expect(normalizeModel(videoModel({ releasedAt }), ZDR, ADMISSION)).toMatchObject({
        kind: 'excluded',
        reason: 'missing-release-date',
      });
    }
  });

  /** Assert a video model normalizes and return its outcome (so tests can read
   * `pricingFallbacks` — the loud substitution flag — alongside content). */
  function videoOutcome(
    overrides: Partial<VideoMetadata>
  ): Extract<ReturnType<typeof normalizeModel>, { kind: 'normalized' }> {
    const outcome = normalizeModel(videoModel(overrides), ZDR, ADMISSION);
    if (outcome.kind !== 'normalized') throw new Error(`expected normalized, got ${outcome.kind}`);
    return outcome;
  }

  it('keys the matrix on supported_resolutions (USD-per-second), no fallback', () => {
    const outcome = videoOutcome({
      resolutions: ['720p', '1080p'],
      pricingSkus: { duration_seconds_720p: '0.0988', duration_seconds_1080p: '0.15' },
    });
    expect(outcome.content.pricing).toEqual(
      perSecondPrice({ '720p': '113620000', '1080p': '172500000' })
    );
    expect(outcome.content.outputs).toEqual(['video']);
    expect(outcome.pricingFallbacks).toBeUndefined();
  });

  it('interprets cents-per-second SKUs by dividing by one hundred', () => {
    const content = videoOutcome({
      resolutions: ['480p'],
      pricingSkus: { cents_per_video_output_second_480p: '5' },
    }).content;
    // 5 cents/sec = 0.05 USD/sec = 50_000_000 nano-USD provider → 57_500_000 billable.
    expect(content.pricing).toEqual(perSecondPrice({ '480p': '57500000' }));
  });

  it('interprets multi-digit cents SKUs (whole-part shift)', () => {
    const content = videoOutcome({
      resolutions: ['720p'],
      pricingSkus: { cents_per_video_output_second_720p: '250' },
    }).content;
    // 250 cents/sec = 2.50 USD/sec = 2_500_000_000 nano-USD provider → 2_875_000_000 billable.
    expect(content.pricing).toEqual(perSecondPrice({ '720p': '2875000000' }));
  });

  it('reserves the dearer of two SKUs that share a resolution', () => {
    const content = videoOutcome({
      resolutions: ['720p'],
      pricingSkus: { duration_seconds_720p: '0.1', cents_per_video_output_second_720p: '15' },
    }).content;
    expect(content.pricing).toEqual(perSecondPrice({ '720p': '172500000' }));
  });

  it('applies a flat rate to every supported resolution with no loud fallback', () => {
    // wan-2.7: a single flat `duration_seconds` prices all declared resolutions;
    // a stated flat rate is not a substitution, so no fallback is flagged.
    const outcome = videoOutcome({
      resolutions: ['720p', '1080p'],
      pricingSkus: { duration_seconds: '0.1' },
    });
    expect(outcome.content.pricing).toEqual(
      perSecondPrice({ '720p': '115000000', '1080p': '115000000' })
    );
    expect(outcome.pricingFallbacks).toBeUndefined();
  });

  it('reserves the dearer of a flat rate with audio and one without', () => {
    const content = videoOutcome({
      resolutions: ['720p'],
      pricingSkus: { duration_seconds: '0.112', duration_seconds_with_audio: '0.168' },
    }).content;
    expect(content.pricing).toEqual(perSecondPrice({ '720p': '193200000' }));
  });

  it("reserves kling-v3.0-pro's 720p at its flat with-audio rate, the dearest SKU that can bill it", () => {
    // kling-v3.0-pro's live SKU set: a call that sends no audio flag can bill the
    // flat with-audio $0.168, above every $0.112 rate; image_to_video is dropped.
    const outcome = videoOutcome({
      resolutions: ['720p'],
      pricingSkus: {
        duration_seconds: '0.112',
        duration_seconds_with_audio: '0.168',
        text_to_video_duration_seconds_480p: '0.112',
        text_to_video_duration_seconds_720p: '0.112',
        image_to_video_duration_seconds_720p: '0.112',
        text_to_video_duration_seconds_1080p: '0.112',
        image_to_video_duration_seconds_1080p: '0.112',
      },
    });
    expect(outcome.content.pricing).toEqual(perSecondPrice({ '720p': '193200000' }));
    expect(outcome.pricingFallbacks).toBeUndefined();
  });

  it('reserves each resolution at its dearest SKU, flat rates included, matching 4K case-insensitively', () => {
    // veo-3.1-fast: 720p's own rates ($0.10, $0.08) sit below the flat $0.12;
    // 4K's own $0.30, matched from a lower-case `4k` token, sits above it.
    const outcome = videoOutcome({
      resolutions: ['720p', '1080p', '4K'],
      pricingSkus: {
        duration_seconds_with_audio: '0.12',
        duration_seconds_with_audio_4k: '0.30',
        duration_seconds_without_audio: '0.10',
        duration_seconds_with_audio_720p: '0.10',
        duration_seconds_without_audio_4k: '0.25',
        duration_seconds_without_audio_720p: '0.08',
      },
    });
    expect(outcome.content.pricing).toEqual(
      perSecondPrice({ '720p': '138000000', '1080p': '138000000', '4K': '345000000' })
    );
    expect(outcome.pricingFallbacks).toBeUndefined();
  });

  it('drops image_to_video SKUs and ignores resolutions outside supported (wan-2.6)', () => {
    const outcome = videoOutcome({
      resolutions: ['720p', '1080p'],
      pricingSkus: {
        text_to_video_duration_seconds_480p: '0.04',
        text_to_video_duration_seconds_720p: '0.08',
        text_to_video_duration_seconds_1080p: '0.12',
        image_to_video_duration_seconds_720p: '0.10',
        image_to_video_duration_seconds_1080p: '0.15',
      },
    });
    expect(outcome.content.pricing).toEqual(
      perSecondPrice({ '720p': '92000000', '1080p': '138000000' })
    );
    expect(outcome.pricingFallbacks).toBeUndefined();
  });

  it('prices per-resolution from cents and skips input-role SKUs (grok-imagine-video)', () => {
    const outcome = videoOutcome({
      resolutions: ['480p', '720p'],
      pricingSkus: {
        cents_per_image_input: '2',
        cents_per_video_output_second_480p: '5',
        cents_per_video_output_second_720p: '8',
      },
    });
    expect(outcome.content.pricing).toEqual(
      perSecondPrice({ '480p': '57500000', '720p': '92000000' })
    );
    expect(outcome.pricingFallbacks).toBeUndefined();
  });

  it('substitutes the max known rate with a LOUD fallback for an unpriced resolution', () => {
    // Synthetic: 1080p is declared but no SKU can bill it — the one rate is
    // 480p's and there is no flat rate — so 1080p takes the model's max known
    // rate and is flagged for a human to verify.
    const outcome = videoOutcome({
      resolutions: ['1080p'],
      pricingSkus: { text_to_video_duration_seconds_480p: '0.05' },
    });
    expect(outcome.content.pricing).toEqual(perSecondPrice({ '1080p': '57500000' }));
    expect(outcome.pricingFallbacks).toEqual(['1080p']);
  });

  it('reserves a resolution at its without-audio rate when that is its dearest SKU', () => {
    const content = videoOutcome({
      resolutions: ['720p'],
      pricingSkus: {
        duration_seconds_with_audio_720p: '0.1',
        duration_seconds_without_audio_720p: '0.2',
      },
    }).content;
    expect(content.pricing).toEqual(perSecondPrice({ '720p': '230000000' }));
  });

  it('bakes a per-second rate from its vendor decimal with one round-up', () => {
    // 0.00000605 cents = $0.0000000605; ceil(69.575) = 70, where rounding the
    // rate to 60 nano first would store 69.
    const content = videoOutcome({
      resolutions: ['720p'],
      pricingSkus: { cents_per_video_output_second_720p: '0.00000605' },
    }).content;
    expect(content.pricing).toEqual(perSecondPrice({ '720p': '70' }));
  });

  it('excludes a video model with an unreadable SKU value beside readable ones, loudly', () => {
    // The reserve must cover every SKU that can bill a resolution, and an
    // unreadable SKU's rate is unknown.
    expect(
      normalizeModel(
        videoModel({
          resolutions: ['720p', '1080p'],
          pricingSkus: { duration_seconds_720p: 'mystery', duration_seconds_1080p: '0.15' },
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'unknown-pricing-unit',
    });
  });

  it('excludes a token-priced video model quietly (token-priced-video)', () => {
    expect(
      normalizeModel(
        videoModel({ pricingSkus: { video_tokens: '0.001', video_tokens_without_audio: '0.001' } }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'token-priced-video',
    });
  });

  it('excludes a video model with an unknown pricing unit (loud, fail-closed)', () => {
    expect(
      normalizeModel(videoModel({ pricingSkus: { per_video_token: '0.001' } }), ZDR, ADMISSION)
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'unknown-pricing-unit',
    });
  });

  it('excludes a video model whose only SKU value is unparseable', () => {
    // An unparseable value is a rate no reserve can cover → fail-closed
    // exclusion, never an exposed model whose declared resolutions have no price.
    expect(
      normalizeModel(
        videoModel({ resolutions: ['720p'], pricingSkus: { duration_seconds: 'mystery' } }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'unknown-pricing-unit',
    });
  });

  it('excludes a video model with a sub-nano resolution rate beside a priced one, loudly', () => {
    expect(
      normalizeModel(
        videoModel({
          resolutions: ['720p', '1080p'],
          pricingSkus: {
            duration_seconds_720p: '0.0000000009',
            duration_seconds_1080p: '0.15',
          },
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'unknown-pricing-unit',
    });
  });

  it('excludes a video model with a sub-nano cents rate beside a priced one, loudly', () => {
    // 0.00000009 cents a second is $0.0000000009, below 1 nano-USD.
    expect(
      normalizeModel(
        videoModel({
          resolutions: ['720p', '1080p'],
          pricingSkus: {
            cents_per_video_output_second_720p: '0.00000009',
            cents_per_video_output_second_1080p: '15',
          },
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'unknown-pricing-unit',
    });
  });

  it('prices a resolution at a dearer covering rate that outvotes its sub-nano rate', () => {
    const content = videoOutcome({
      resolutions: ['720p'],
      pricingSkus: {
        duration_seconds_720p: '0.0000000009',
        duration_seconds: '0.1',
      },
    }).content;
    expect(content.pricing).toEqual(perSecondPrice({ '720p': '115000000' }));
  });

  it('excludes a video model with an empty cents value beside readable rates, loudly', () => {
    expect(
      normalizeModel(
        videoModel({
          resolutions: ['720p'],
          pricingSkus: {
            cents_per_video_output_second_720p: '8',
            cents_per_video_output_second_with_audio: '',
          },
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'unknown-pricing-unit',
    });
  });

  it('excludes a video model with a bare-point cents value beside readable rates, loudly', () => {
    expect(
      normalizeModel(
        videoModel({
          resolutions: ['720p'],
          pricingSkus: {
            cents_per_video_output_second_720p: '8',
            cents_per_video_output_second_with_audio: '.',
          },
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'unknown-pricing-unit',
    });
  });

  it('excludes a video model whose only SKUs price an input mode the call never sends, loudly', () => {
    expect(
      normalizeModel(
        videoModel({
          resolutions: ['720p'],
          pricingSkus: { image_to_video_duration_seconds_720p: '0.1' },
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({
      kind: 'excluded',
      modelId: 'google/test-video',
      reason: 'unknown-pricing-unit',
    });
  });

  it('excludes a video model that declares no resolution quietly (missing-pricing)', () => {
    expect(
      normalizeModel(
        videoModel({ resolutions: [], pricingSkus: { duration_seconds: '0.1' } }),
        ZDR,
        ADMISSION
      )
    ).toEqual({ kind: 'excluded', modelId: 'google/test-video', reason: 'missing-pricing' });
  });

  it('derives video params and frame-image input support', () => {
    const content = normalized(
      normalizeModel(videoModel({ supportsFrameImages: true }), ZDR, ADMISSION)
    );
    expect(content.inputs).toEqual(['text', 'image']);
    expect(content.parameters['resolution']).toMatchObject({
      type: 'enum',
      values: ['720p', '1080p'],
    });
    expect(content.parameters['aspectRatio']).toMatchObject({ type: 'enum', values: ['16:9'] });
    expect(content.parameters['durationSeconds']).toMatchObject({ type: 'enum', values: [4, 8] });
    expect(content.parameters['generateAudio']).toMatchObject({ type: 'boolean' });
    expect(content.parameters['seed']).toMatchObject({ type: 'integer' });
  });

  it('omits optional video params when absent', () => {
    // A resolution stays: a video row that declares none has no price and is
    // excluded, so only the optional axes can be absent from a priced row.
    const content = normalized(
      normalizeModel(
        videoModel({
          resolutions: ['720p'],
          aspectRatios: ['16:9'],
          durations: [],
          generateAudio: false,
          seed: false,
        }),
        ZDR,
        ADMISSION
      )
    );
    expect(Object.keys(content.parameters).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'aspectRatio',
      'resolution',
    ]);
  });
});

describe('normalizeCatalog (dedupe + merge by id)', () => {
  function onlyNormalized(entry: CatalogEntry | undefined): DescriptorContent {
    if (entry?.kind !== 'normalized') {
      throw new Error(`expected a normalized entry, got ${entry?.kind ?? 'undefined'}`);
    }
    return entry.content;
  }

  it('leaves disjoint ids as separate entries (cheap no-op)', () => {
    const entries = normalizeCatalog(
      [languageModel({ id: 'a/lang' }), imageModel({ id: 'b/img' })],
      new Set(['a/lang', 'b/img']),
      NOW_MS
    );
    expect(entries.map((entry) => entry.modelId).toSorted((x, y) => x.localeCompare(y))).toEqual([
      'a/lang',
      'b/img',
    ]);
  });

  it('excludes a merged dual-output model as non-runnable (never persisted)', () => {
    // A slug advertised on both /models (text) and /images (image) merges to
    // outputs ['text','image'] — two outputs, which no turn can run. Admission
    // denies it quietly rather than persisting an unrunnable catalog row.
    const entries = normalizeCatalog(
      [languageModel({ id: 'dup/model' }), imageModel({ id: 'dup/model' })],
      new Set(['dup/model']),
      NOW_MS
    );
    expect(entries).toEqual([
      { kind: 'excluded', modelId: 'dup/model', reason: 'non-runnable-shape' },
    ]);
  });

  it('carries the per-image price when a language row and an image row merge into an image model', () => {
    // The language row is the fold base, but it charges by tokens and the
    // merged model is an image model, so the image sibling's price is the one
    // the row carries — never a union of the two.
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'dup/pic', outputModalities: ['image'] }),
        imageModel({ id: 'dup/pic' }),
      ],
      new Set(['dup/pic']),
      NOW_MS
    );
    expect(onlyNormalized(entries[0]).pricing).toEqual(perImagePrice('46000000'));
  });

  it('keeps the base price when two language rows merge into a text model', () => {
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'dup/txt', outputModalities: ['text'] }),
        languageModel({ id: 'dup/txt', outputModalities: ['text'], supportedParameters: [] }),
      ],
      new Set(['dup/txt']),
      NOW_MS
    );
    expect(onlyNormalized(entries[0]).pricing).toEqual(tokenPrice('2875', '11500'));
  });

  it('excludes a merged non-text multi-output model (image+video) as non-runnable', () => {
    const entries = normalizeCatalog(
      [imageModel({ id: 'dup/av' }), videoModel({ id: 'dup/av' })],
      new Set(['dup/av']),
      NOW_MS
    );
    expect(entries).toEqual([
      { kind: 'excluded', modelId: 'dup/av', reason: 'non-runnable-shape' },
    ]);
  });

  it('excludes a single-source dual-output model as non-runnable at admission', () => {
    const entries = normalizeCatalog(
      [languageModel({ id: 'solo/multi', outputModalities: ['text', 'video'] })],
      new Set(['solo/multi']),
      NOW_MS
    );
    expect(entries).toEqual([
      { kind: 'excluded', modelId: 'solo/multi', reason: 'non-runnable-shape' },
    ]);
  });

  it('keeps language behaviors on a merged single-output model (streaming survives)', () => {
    // Two same-id language endpoints merge to a single text output (runnable);
    // the merged behaviors keep streaming and gain the sibling's tools.
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'dup/model', supportedParameters: ['temperature'] }),
        languageModel({ id: 'dup/model', supportedParameters: ['tools'] }),
      ],
      new Set(['dup/model']),
      NOW_MS
    );
    const content = onlyNormalized(entries[0]);
    expect(content.outputs).toEqual(['text']);
    expect(content.behaviors).toEqual(['streaming', 'tools']);
  });

  it('admits runnable shapes: text→text, vision (text+image in → text), and text→image', () => {
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'run/text', inputModalities: ['text'], outputModalities: ['text'] }),
        languageModel({
          id: 'run/vision',
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
        }),
        imageModel({ id: 'run/image' }),
      ],
      new Set(['run/text', 'run/vision', 'run/image']),
      NOW_MS
    );
    expect(entries.every((entry) => entry.kind === 'normalized')).toBe(true);
  });

  it('produces identical merged content regardless of the source order (no oscillation)', () => {
    const forward = normalizeCatalog(
      [languageModel({ id: 'ord/model' }), imageModel({ id: 'ord/model' })],
      new Set(['ord/model']),
      NOW_MS
    );
    const reversed = normalizeCatalog(
      [imageModel({ id: 'ord/model' }), languageModel({ id: 'ord/model' })],
      new Set(['ord/model']),
      NOW_MS
    );
    expect(forward).toEqual(reversed);
  });

  it('keeps the normalized sibling when a same-id sibling is excluded', () => {
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'mix/model' }),
        imageModel({
          id: 'mix/model',
          endpointPricing: [{ billable: 'output_image', unit: 'megapixel', costUsd: '0.01' }],
        }),
      ],
      new Set(['mix/model']),
      NOW_MS
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('normalized');
  });

  it('carries reasoning through a same-id fold regardless of which sibling declares it', () => {
    const withReasoning = languageModel({
      id: 'dup/lang',
      reasoning: { mandatory: true, supportedEfforts: ['high', 'low'] },
    });
    const withoutReasoning = languageModel({ id: 'dup/lang' });
    const zdr = new Set(['dup/lang']);
    for (const siblings of [
      [withReasoning, withoutReasoning],
      [withoutReasoning, withReasoning],
    ]) {
      const entries = normalizeCatalog(siblings, zdr, NOW_MS);
      expect(onlyNormalized(entries[0]).reasoning).toEqual({
        mandatory: true,
        supportedEfforts: ['high', 'low'],
      });
    }
  });

  it('excludes an id only when every sibling for it is excluded', () => {
    const entries = normalizeCatalog(
      [languageModel({ id: 'dep/model', deprecated: true })],
      new Set(['dep/model']),
      NOW_MS
    );
    expect(entries).toEqual([{ kind: 'excluded', modelId: 'dep/model', reason: 'deprecated' }]);
  });

  it('propagates a video pricing fallback onto the catalog entry', () => {
    const entries = normalizeCatalog(
      [
        videoModel({
          id: 'vid/fallback',
          resolutions: ['1080p'],
          pricingSkus: { text_to_video_duration_seconds_480p: '0.05' },
        }),
      ],
      new Set(['vid/fallback']),
      NOW_MS
    );
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'normalized', pricingFallbacks: ['1080p'] }),
    ]);
  });
});

describe('normalizeModel (fee baking — billable rates, descriptor v4)', () => {
  it("stamps descriptor version '4' on every family", () => {
    expect(normalized(normalizeModel(languageModel(), ZDR, ADMISSION)).version).toBe('4');
    expect(normalized(normalizeModel(imageModel(), ZDR, ADMISSION)).version).toBe('4');
    expect(normalized(normalizeModel(videoModel(), ZDR, ADMISSION)).version).toBe('4');
  });

  it('bakes the ceil-rounded markup into a flat language rate (against the user)', () => {
    // 1 nano provider rate × 1.15 = 1.15 → ceil 2, never the half-even 1. A
    // rate that low is under the catalog price floor, so the fixture rides the
    // top-context exemption to reach the baking step at all.
    expect(
      normalized(
        normalizeModel(
          languageModel({ pricing: { prompt: '0.000000001', completion: '0.000000001' } }),
          ZDR,
          EXEMPT
        )
      ).pricing
    ).toEqual(tokenPrice('2', '2'));
  });

  it('marks up a merged same-id fold exactly once per rate', () => {
    const forward = normalizeCatalog(
      [
        languageModel({ id: 'dup/baked', supportedParameters: ['temperature'] }),
        languageModel({ id: 'dup/baked', supportedParameters: ['tools'] }),
      ],
      new Set(['dup/baked']),
      NOW_MS
    );
    const entry = forward[0];
    if (entry?.kind !== 'normalized') throw new Error('expected normalized');
    // 2500/10000 provider nano → 2875/11500 billable — not marked up again on merge.
    expect(entry.content.pricing).toEqual(tokenPrice('2875', '11500'));
    expect(entry.content.version).toBe('4');
  });

  it('marks up a substituted video fallback rate exactly once', () => {
    const outcome = normalizeModel(
      videoModel({
        resolutions: ['720p', '1080p'],
        pricingSkus: { text_to_video_duration_seconds_720p: '0.05' },
      }),
      ZDR,
      ADMISSION
    );
    if (outcome.kind !== 'normalized') throw new Error('expected normalized');
    // 0.05 USD/sec = 50_000_000 provider nano → 57_500_000 billable for the
    // stated 720p AND the substituted 1080p (the substitute is the same rate,
    // marked up once at the choke point).
    expect(outcome.content.pricing).toEqual(
      perSecondPrice({ '720p': '57500000', '1080p': '57500000' })
    );
    expect(outcome.pricingFallbacks).toEqual(['1080p']);
  });
});

describe('normalizeModel (catalog admission)', () => {
  /** 100 nano-USD per token on each leg — the $0.0002/1K floor exactly. */
  const AT_FLOOR = { prompt: '0.0000001', completion: '0.0000001' };
  /** One nano under the combined floor. */
  const BELOW_FLOOR = { prompt: '0.000000099', completion: '0.0000001' };
  /** One nano over the combined floor. */
  const ABOVE_FLOOR = { prompt: '0.000000101', completion: '0.0000001' };

  it('excludes a language model whose combined rate is zero', () => {
    expect(
      normalizeModel(languageModel({ pricing: { prompt: '0', completion: '0' } }), ZDR, ADMISSION)
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'zero-priced' });
  });

  it('excludes a language model whose standard-tier endpoint states no rate at all, loudly', () => {
    expect(normalizeModel(languageModel({ pricing: undefined }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'unrepresentable-endpoint-price',
    });
  });

  it('excludes a language model one nano under the price floor', () => {
    expect(normalizeModel(languageModel({ pricing: BELOW_FLOOR }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'below-price-floor',
    });
  });

  it('admits a language model exactly at the price floor', () => {
    expect(normalizeModel(languageModel({ pricing: AT_FLOOR }), ZDR, ADMISSION).kind).toBe(
      'normalized'
    );
  });

  it('admits a language model one nano over the price floor', () => {
    expect(normalizeModel(languageModel({ pricing: ABOVE_FLOOR }), ZDR, ADMISSION).kind).toBe(
      'normalized'
    );
  });

  it('tests the floor against the pre-fee rate, not the baked billable rate', () => {
    // A rate one nano under the floor clears it once the 15% markup is applied
    // (199 → 229). The floor is a MARGIN floor, so the raw rate decides.
    expect(normalizeModel(languageModel({ pricing: BELOW_FLOOR }), ZDR, ADMISSION)).toEqual({
      kind: 'excluded',
      modelId: 'openai/gpt-test',
      reason: 'below-price-floor',
    });
  });

  it('excludes a language model older than the age limit', () => {
    expect(
      normalizeModel(languageModel({ releasedAt: OLDER_THAN_LIMIT_SECONDS }), ZDR, ADMISSION)
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'too-old' });
  });

  it('admits a language model exactly at the age limit', () => {
    expect(
      normalizeModel(languageModel({ releasedAt: OLDER_THAN_LIMIT_SECONDS + 1 }), ZDR, ADMISSION)
        .kind
    ).toBe('normalized');
  });

  it('reports the price floor first when a model fails the floor and the age limit', () => {
    expect(
      normalizeModel(
        languageModel({ pricing: BELOW_FLOOR, releasedAt: OLDER_THAN_LIMIT_SECONDS }),
        ZDR,
        ADMISSION
      )
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'below-price-floor' });
  });

  it('exempts a top-context model from the price floor', () => {
    const admission: CatalogAdmission = { contextExemptionTokens: 128_000, nowMs: NOW_MS };

    expect(
      normalizeModel(
        languageModel({ pricing: BELOW_FLOOR, contextLength: 128_000 }),
        ZDR,
        admission
      ).kind
    ).toBe('normalized');
  });

  it('exempts a top-context model from the age limit', () => {
    const admission: CatalogAdmission = { contextExemptionTokens: 128_000, nowMs: NOW_MS };

    expect(
      normalizeModel(
        languageModel({ releasedAt: OLDER_THAN_LIMIT_SECONDS, contextLength: 128_000 }),
        ZDR,
        admission
      ).kind
    ).toBe('normalized');
  });

  it('does not exempt a model one token below the context threshold', () => {
    const admission: CatalogAdmission = { contextExemptionTokens: 128_000, nowMs: NOW_MS };

    expect(
      normalizeModel(
        languageModel({ pricing: BELOW_FLOOR, contextLength: 127_999 }),
        ZDR,
        admission
      )
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'below-price-floor' });
  });

  it('never exempts a zero-priced model, however large its context', () => {
    expect(
      normalizeModel(
        languageModel({ pricing: { prompt: '0', completion: '0' }, contextLength: 100_000_000 }),
        ZDR,
        EXEMPT
      )
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'zero-priced' });
  });

  it('applies no per-token floor or age limit to an image model', () => {
    // Per-unit pricing: a per-token floor has no meaning for it, so a cheap,
    // years-old image model is admitted on its own pricing shape alone.
    expect(
      normalizeModel(
        imageModel({
          releasedAt: OLDER_THAN_LIMIT_SECONDS,
          endpointPricing: [{ billable: 'output_image', unit: 'image', costUsd: '0.0000001' }],
        }),
        ZDR,
        ADMISSION
      ).kind
    ).toBe('normalized');
  });

  it('applies no per-token floor or age limit to a video model', () => {
    expect(
      normalizeModel(
        videoModel({
          releasedAt: OLDER_THAN_LIMIT_SECONDS,
          pricingSkus: { duration_seconds_720p: '0.0000001' },
        }),
        ZDR,
        ADMISSION
      ).kind
    ).toBe('normalized');
  });

  it('excludes an image model the gateway prices at zero', () => {
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'image', costUsd: '0' }],
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({ kind: 'excluded', modelId: 'google/test-image', reason: 'zero-priced' });
  });

  it('excludes an image model priced below nano-USD precision', () => {
    // The exponent form the gateway metadata layer keeps for a rate at or below
    // 5e-13 — rendering it as twelve decimals would make it a plain zero, which
    // is why it arrives unparseable and is refused as an unrepresentable rate.
    expect(
      normalizeModel(
        imageModel({
          endpointPricing: [{ billable: 'output_image', unit: 'image', costUsd: '3e-13' }],
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({ kind: 'excluded', modelId: 'google/test-image', reason: 'unknown-pricing-unit' });
  });

  it('excludes a video model that prices every declared resolution at zero', () => {
    expect(
      normalizeModel(videoModel({ pricingSkus: { duration_seconds: '0' } }), ZDR, ADMISSION)
    ).toEqual({ kind: 'excluded', modelId: 'google/test-video', reason: 'zero-priced' });
  });

  it('excludes a video model that prices one resolution at zero and another above it, loudly', () => {
    // A price schedule holds only positive rates, so a free resolution beside a
    // priced one is a price the catalog cannot represent, not a free SKU.
    expect(
      normalizeModel(
        videoModel({
          pricingSkus: { duration_seconds_720p: '0', duration_seconds_1080p: '0.15' },
        }),
        ZDR,
        ADMISSION
      )
    ).toEqual({ kind: 'excluded', modelId: 'google/test-video', reason: 'unknown-pricing-unit' });
  });

  it('reports non-zdr ahead of a commercial exclusion', () => {
    expect(
      normalizeModel(languageModel({ pricing: BELOW_FLOOR }), new Set<string>(), ADMISSION)
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'non-zdr' });
  });

  it('reports a missing release date ahead of a commercial exclusion', () => {
    expect(
      normalizeModel(languageModel({ pricing: BELOW_FLOOR, releasedAt: undefined }), ZDR, ADMISSION)
    ).toEqual({ kind: 'excluded', modelId: 'openai/gpt-test', reason: 'missing-release-date' });
  });
});

describe('normalizeCatalog (catalog admission over the pool)', () => {
  const BELOW_FLOOR = { prompt: '0.000000099', completion: '0.0000001' };

  function dispositions(entries: readonly CatalogEntry[]): readonly (readonly [string, string])[] {
    return entries.map((entry) =>
      entry.kind === 'excluded'
        ? ([entry.modelId, entry.reason] as const)
        : ([entry.modelId, 'normalized'] as const)
    );
  }

  it('measures the context exemption over the pool, not over one model', () => {
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'small/ctx', contextLength: 8000, pricing: BELOW_FLOOR }),
        languageModel({ id: 'large/ctx', contextLength: 128_000, pricing: BELOW_FLOOR }),
      ],
      new Set(['small/ctx', 'large/ctx']),
      NOW_MS
    );

    expect(dispositions(entries)).toEqual([
      ['small/ctx', 'below-price-floor'],
      ['large/ctx', 'normalized'],
    ]);
  });

  it('leaves a ZDR-unreachable model out of the pool the exemption is measured over', () => {
    // Were the unreachable million-token model counted, the threshold would rise
    // to its context length and `large/ctx` would lose its exemption.
    const entries = normalizeCatalog(
      [
        languageModel({ id: 'small/ctx', contextLength: 8000, pricing: BELOW_FLOOR }),
        languageModel({ id: 'large/ctx', contextLength: 128_000, pricing: BELOW_FLOOR }),
        languageModel({ id: 'hidden/huge', contextLength: 1_000_000, pricing: BELOW_FLOOR }),
      ],
      new Set(['small/ctx', 'large/ctx']),
      NOW_MS
    );

    expect(dispositions(entries)).toEqual([
      ['small/ctx', 'below-price-floor'],
      ['large/ctx', 'normalized'],
      ['hidden/huge', 'non-zdr'],
    ]);
  });

  it('leaves a media model out of the pool the exemption is measured over', () => {
    // Media context lengths are not token contexts; counting them would move a
    // text model's exemption for a reason unrelated to text capability.
    //
    // The pool size is load-bearing. A media entry carries no context length, so
    // counting it contributes 0, and the exemption index is
    // `min(floor(n × 0.95), n − 1)` — the LAST element for every n ≤ 20. Below 21
    // entries a leading zero therefore cannot shift the threshold off the largest
    // context, and any smaller version of this fixture holds whatever the filter
    // does. At 21 the index is 19, one rank below the top, so counting the media
    // zero drops the threshold to the second-largest language context.
    const fillers = Array.from({ length: 18 }, (_unused, index) =>
      languageModel({ id: `filler/${String(index)}`, contextLength: 1000 })
    );
    const entries = normalizeCatalog(
      [
        ...fillers,
        languageModel({ id: 'second/ctx', contextLength: 100_000, pricing: BELOW_FLOOR }),
        languageModel({ id: 'largest/ctx', contextLength: 200_000 }),
        imageModel({ id: 'pic/gen' }),
      ],
      new Set([...fillers.map((model) => model.id), 'second/ctx', 'largest/ctx', 'pic/gen']),
      NOW_MS
    );

    // `second/ctx` is the discriminating row: it sits at the second-largest
    // context and is below the price floor, so it earns the exemption only if the
    // media zero is counted into the pool.
    expect(dispositions(entries)).toEqual([
      ...fillers.map((model) => [model.id, 'normalized'] as const),
      ['second/ctx', 'below-price-floor'],
      ['largest/ctx', 'normalized'],
      ['pic/gen', 'normalized'],
    ]);
  });

  it('leaves a language model with no context length out of the pool the exemption is measured over', () => {
    // Same 21-entry arithmetic as the media case: the exemption index is
    // `min(floor(n × 0.95), n − 1)`, so a 21st entry moves it off the largest
    // context. A ZDR language model that advertises no context length is not a
    // zero-token model — it is a model whose window the gateway did not state,
    // and counting it as 0 drops the threshold from 200_000 to 100_000, which
    // hands `second/ctx` an exemption it has not earned.
    const fillers = Array.from({ length: 18 }, (_unused, index) =>
      languageModel({ id: `filler/${String(index)}`, contextLength: 1000 })
    );
    const entries = normalizeCatalog(
      [
        ...fillers,
        languageModel({ id: 'second/ctx', contextLength: 100_000, pricing: BELOW_FLOOR }),
        languageModel({ id: 'largest/ctx', contextLength: 200_000 }),
        languageModel({ id: 'no/ctx', contextLength: undefined }),
      ],
      new Set([...fillers.map((model) => model.id), 'second/ctx', 'largest/ctx', 'no/ctx']),
      NOW_MS
    );

    expect(dispositions(entries)).toEqual([
      ...fillers.map((model) => [model.id, 'normalized'] as const),
      ['second/ctx', 'below-price-floor'],
      ['largest/ctx', 'normalized'],
      ['no/ctx', 'normalized'],
    ]);
  });

  it('measures a model against the exemption at the context it is sold with, not the gateway context', () => {
    // The gateway states 131_072, but the model's only eligible endpoint
    // serves 8_192, so the descriptor sells 8_192. At 20 entries the
    // exemption index is the top, which `big/ctx` holds at 131_072 whichever
    // context this model enters the pool with.
    const fillers = Array.from({ length: 18 }, (_unused, index) =>
      languageModel({ id: `filler/${String(index)}`, contextLength: 1000 })
    );
    const models = [
      ...fillers,
      languageModel({ id: 'big/ctx', contextLength: 131_072 }),
      languageModel({
        id: 'sao10k/l3.1-euryale-70b',
        contextLength: 131_072,
        pricing: BELOW_FLOOR,
      }),
    ];
    const listing = new Map([
      ...listingFor(models, new Set(models.map((model) => model.id))),
      [
        'sao10k/l3.1-euryale-70b',
        [zdrEndpointFixture({ pricing: { ...BELOW_FLOOR }, contextLength: 8192 })],
      ],
    ]);
    expect(dispositions(normalizeListedCatalog(models, listing, NOW_MS))).toEqual([
      ...fillers.map((model) => [model.id, 'normalized'] as const),
      ['big/ctx', 'normalized'],
      ['sao10k/l3.1-euryale-70b', 'below-price-floor'],
    ]);
  });

  it('counts a model in the exemption pool at the context it is sold with, not the gateway context', () => {
    // At 21 entries the exemption index is one rank below the top. `wide/gateway`
    // is sold at 500: counted there, the threshold is `second/ctx`'s 100_000 and
    // exempts it; counted at the gateway's 1_000_000, the threshold rises to
    // 200_000 and `second/ctx` falls to the price floor.
    const fillers = Array.from({ length: 18 }, (_unused, index) =>
      languageModel({ id: `filler/${String(index)}`, contextLength: 1000 })
    );
    const models = [
      ...fillers,
      languageModel({ id: 'second/ctx', contextLength: 100_000, pricing: BELOW_FLOOR }),
      languageModel({ id: 'largest/ctx', contextLength: 200_000 }),
      languageModel({ id: 'wide/gateway', contextLength: 1_000_000 }),
    ];
    const listing = new Map([
      ...listingFor(models, new Set(models.map((model) => model.id))),
      ['wide/gateway', [zdrEndpointFixture({ contextLength: 500 })]],
    ]);
    expect(dispositions(normalizeListedCatalog(models, listing, NOW_MS))).toEqual([
      ...fillers.map((model) => [model.id, 'normalized'] as const),
      ['second/ctx', 'normalized'],
      ['largest/ctx', 'normalized'],
      ['wide/gateway', 'normalized'],
    ]);
  });

  it('counts and tests a model the gateway states no window for at its eligible endpoint context', () => {
    // At 20 entries the exemption index is the top. `unstated/gateway` states
    // no window on `/models`; its endpoint serves 200_000, which is the top of
    // the pool and exempts it. `second/ctx` sits below that top.
    const fillers = Array.from({ length: 18 }, (_unused, index) =>
      languageModel({ id: `filler/${String(index)}`, contextLength: 1000 })
    );
    const models = [
      ...fillers,
      languageModel({ id: 'second/ctx', contextLength: 100_000, pricing: BELOW_FLOOR }),
      languageModel({ id: 'unstated/gateway', contextLength: undefined, pricing: BELOW_FLOOR }),
    ];
    const listing = new Map([
      ...listingFor(models, new Set(models.map((model) => model.id))),
      [
        'unstated/gateway',
        [zdrEndpointFixture({ pricing: { ...BELOW_FLOOR }, contextLength: 200_000 })],
      ],
    ]);
    expect(dispositions(normalizeListedCatalog(models, listing, NOW_MS))).toEqual([
      ...fillers.map((model) => [model.id, 'normalized'] as const),
      ['second/ctx', 'below-price-floor'],
      ['unstated/gateway', 'normalized'],
    ]);
  });

  it('leaves a language model with no context length out of a pool where it would rank above every stated one', () => {
    // At 39 stated contexts the exemption index is floor(39 × 0.95) = 37, one
    // rank below the top, so `second/ctx` is exempt. A 40th entry ranked above
    // every stated context moves the index to 38, the top, and takes that
    // exemption away; an unstated window is neither zero nor unbounded.
    const fillers = Array.from({ length: 37 }, (_unused, index) =>
      languageModel({ id: `filler/${String(index)}`, contextLength: 1000 })
    );
    const models = [
      ...fillers,
      languageModel({ id: 'second/ctx', contextLength: 100_000, pricing: BELOW_FLOOR }),
      languageModel({ id: 'largest/ctx', contextLength: 200_000 }),
      languageModel({ id: 'no/ctx', contextLength: undefined }),
    ];
    expect(
      dispositions(normalizeCatalog(models, new Set(models.map((model) => model.id)), NOW_MS))
    ).toEqual([
      ...fillers.map((model) => [model.id, 'normalized'] as const),
      ['second/ctx', 'normalized'],
      ['largest/ctx', 'normalized'],
      ['no/ctx', 'normalized'],
    ]);
  });

  it.each([
    ['a flex service tier', zdrEndpointFixture({ tag: 'vendor/flex' })],
    ['no tool calls', zdrEndpointFixture({ supportedParameters: ['max_tokens', 'reasoning'] })],
  ])(
    'leaves a listed model whose only endpoint is %s out of the pool the exemption is measured over',
    (_shape, endpoint) => {
      // Same 21-entry arithmetic: a 21st context of 500 would move the
      // exemption index onto `second/ctx`. `unsold/small` is listed for ZDR,
      // but its only endpoint cannot anchor a call the model makes, so it is
      // never sold and must not move the threshold.
      const fillers = Array.from({ length: 18 }, (_unused, index) =>
        languageModel({ id: `filler/${String(index)}`, contextLength: 1000 })
      );
      const models = [
        ...fillers,
        languageModel({ id: 'second/ctx', contextLength: 100_000, pricing: BELOW_FLOOR }),
        languageModel({ id: 'largest/ctx', contextLength: 200_000 }),
        languageModel({ id: 'unsold/small', contextLength: 500 }),
      ];
      const listing = new Map([
        ...listingFor(models, new Set(models.map((model) => model.id))),
        ['unsold/small', [endpoint]],
      ]);
      expect(dispositions(normalizeListedCatalog(models, listing, NOW_MS))).toEqual([
        ...fillers.map((model) => [model.id, 'normalized'] as const),
        ['second/ctx', 'below-price-floor'],
        ['largest/ctx', 'normalized'],
        ['unsold/small', 'non-zdr'],
      ]);
    }
  );

  it('keeps a listed model with an endpoint it can anchor on in the pool the exemption is measured over', () => {
    const fillers = Array.from({ length: 18 }, (_unused, index) =>
      languageModel({ id: `filler/${String(index)}`, contextLength: 1000 })
    );
    const models = [
      ...fillers,
      languageModel({ id: 'second/ctx', contextLength: 100_000, pricing: BELOW_FLOOR }),
      languageModel({ id: 'largest/ctx', contextLength: 200_000 }),
      languageModel({ id: 'sold/small', contextLength: 500 }),
    ];
    expect(
      dispositions(normalizeCatalog(models, new Set(models.map((model) => model.id)), NOW_MS))
    ).toEqual([
      ...fillers.map((model) => [model.id, 'normalized'] as const),
      ['second/ctx', 'normalized'],
      ['largest/ctx', 'normalized'],
      ['sold/small', 'normalized'],
    ]);
  });

  it('measures the age cutoff from the clock the caller passes', () => {
    const entries = normalizeCatalog(
      [
        languageModel({
          id: 'old/model',
          contextLength: 8000,
          releasedAt: OLDER_THAN_LIMIT_SECONDS,
        }),
        languageModel({ id: 'new/model', contextLength: 128_000 }),
      ],
      new Set(['old/model', 'new/model']),
      NOW_MS
    );

    expect(dispositions(entries)).toEqual([
      ['old/model', 'too-old'],
      ['new/model', 'normalized'],
    ]);
  });
});

// --- the anchor schedule ------------------------------------------------------

/** Every parameter a tool-capable reasoning model's calls carry. */
const CALL_PARAMETERS: readonly string[] = ['max_tokens', 'tools', 'reasoning'];

function limitsOf(
  overrides: Partial<Parameters<typeof textPricingFromEndpoints>[1]> = {}
): Parameters<typeof textPricingFromEndpoints>[1] {
  return {
    maxOutputTokens: undefined,
    contextLength: undefined,
    supportedParameters: CALL_PARAMETERS,
    ...overrides,
  };
}

/** One ZDR endpoint at two decimal rates, optionally with listed overrides. */
function endpointAt(
  tag: string,
  prompt: string,
  completion: string,
  extra: Partial<ZdrEndpoint> = {}
): ZdrEndpoint {
  return zdrEndpointFixture({ tag, pricing: { prompt, completion }, ...extra });
}

interface ScheduleFigures {
  readonly base: readonly [string, string];
  readonly tiers: readonly (readonly [number, string, string])[];
}

/** A priced result's billable schedule as plain figures. */
function figuresOf(result: TextPricing): ScheduleFigures {
  if (result.kind !== 'priced') throw new Error(`expected priced, got ${result.reason}`);
  const { base, tiers } = result.pricing.anchor;
  return {
    base: [base.input.toString(), base.output.toString()],
    tiers: tiers.map(
      (tier) =>
        [tier.abovePromptTokens, tier.rates.input.toString(), tier.rates.output.toString()] as const
    ),
  };
}

function reasonOf(result: TextPricing): string {
  return result.kind === 'excluded' ? result.reason : 'priced';
}

/** Claude Sonnet 4.5's four live ZDR endpoints, each with its tier above 200,000. */
function sonnetEndpoint(tag: string, regional: boolean): ZdrEndpoint {
  const scale = (base: string, region: string): string => (regional ? region : base);
  return zdrEndpointFixture({
    tag,
    maxCompletionTokens: 64_000,
    contextLength: 1_000_000,
    pricing: {
      prompt: scale('0.000003', '0.0000033'),
      completion: scale('0.000015', '0.0000165'),
      web_search: '0.01',
      input_cache_read: scale('0.0000003', '0.00000033'),
      input_cache_write: scale('0.00000375', '0.000004125'),
      input_cache_write_1h: scale('0.000006', '0.0000066'),
      discount: 0,
    },
    overrides: [
      {
        min_prompt_tokens: 200_000,
        prompt: scale('0.000006', '0.0000066'),
        completion: scale('0.0000225', '0.00002475'),
        input_cache_read: scale('0.0000006', '0.00000066'),
        input_cache_write: scale('0.0000075', '0.00000825'),
        input_cache_write_1h: scale('0.000012', '0.0000132'),
      },
    ],
  });
}

const SONNET_45 = [
  sonnetEndpoint('amazon-bedrock/eu-west-1', true),
  sonnetEndpoint('google-vertex/us-east5', true),
  sonnetEndpoint('amazon-bedrock', false),
  sonnetEndpoint('google-vertex/global', false),
];

const SONNET_45_LIMITS = limitsOf({ maxOutputTokens: 64_000, contextLength: 1_000_000 });

/** DeepSeek V4 Pro's ZDR endpoints: the cheapest that accepts its 384,000 cap is DigitalOcean. */
const DEEPSEEK_V4_PRO = [
  endpointAt('relace/fp4', '0.0000009', '0.0000027', { maxCompletionTokens: 393_216 }),
  endpointAt('digitalocean', '0.000001044', '0.000002088', { maxCompletionTokens: 384_000 }),
  endpointAt('venice', '0.00000165', '0.000003301', { maxCompletionTokens: 32_768 }),
  endpointAt('deepinfra/fp8', '0.0000013', '0.0000026', { maxCompletionTokens: 16_384 }),
];

/** One tier above 200,000 prompt tokens at the given prompt and completion rates. */
function longContext(prompt: string, completion: string): ZdrEndpoint['overrides'] {
  return [{ min_prompt_tokens: 200_000, prompt, completion }];
}

const GEMINI_31_PRO = [
  endpointAt('google-vertex/global/priority', '0.0000036', '0.0000216', {
    overrides: longContext('0.0000072', '0.0000324'),
  }),
  endpointAt('google-vertex/global/flex', '0.000001', '0.000006', {
    overrides: longContext('0.000002', '0.000009'),
  }),
  endpointAt('google-vertex/global', '0.000002', '0.000012', {
    overrides: longContext('0.000004', '0.000018'),
  }),
];

const GROK_47 = [
  endpointAt('xai/zdr/us', '0.0000022', '0.0000066', {
    overrides: longContext('0.0000044', '0.0000132'),
  }),
  endpointAt('xai/zdr/priority', '0.000004', '0.000012', {
    overrides: longContext('0.000008', '0.000024'),
  }),
  endpointAt('xai/zdr', '0.000002', '0.000006', {
    overrides: longContext('0.000004', '0.000012'),
  }),
];

/** The `openai/gpt-5.4` shape: a cheap 400,000-context endpoint beside 1,050,000-context ones tiered above 272,000. */
const GPT_54 = [
  endpointAt('small-context', '0.0000002', '0.00000125', {
    contextLength: 400_000,
    maxCompletionTokens: 128_000,
  }),
  endpointAt('azure/us', '0.00000275', '0.0000165', {
    contextLength: 1_050_000,
    maxCompletionTokens: 128_000,
    overrides: [{ min_prompt_tokens: 272_000, prompt: '0.0000055', completion: '0.00002475' }],
  }),
  endpointAt('azure', '0.0000025', '0.000015', {
    contextLength: 1_050_000,
    maxCompletionTokens: 128_000,
    overrides: [{ min_prompt_tokens: 272_000, prompt: '0.000005', completion: '0.0000225' }],
  }),
];

/** Tencent's `tencent/hy3` endpoint as a refresh reads it inside one window: the top level is that window's price. */
function hy3InWindow(window: 'dear' | 'cheap'): ZdrEndpoint {
  const dear = { prompt: '0.000000132', completion: '0.000000528' };
  const cheap = { prompt: '0.0000000825', completion: '0.00000033' };
  return zdrEndpointFixture({
    tag: 'tencent/fp8',
    pricing: window === 'dear' ? dear : cheap,
    overrides: [
      { utc_start: 0, utc_end: 1600, ...dear },
      { utc_start: 1600, utc_end: 0, ...cheap },
    ],
  });
}

describe('textPricingFromEndpoints (the anchor schedule)', () => {
  it('bakes Claude Sonnet 4.5 at its cheapest endpoint with a tier above 200,000 prompt tokens', () => {
    expect(figuresOf(textPricingFromEndpoints(SONNET_45, SONNET_45_LIMITS))).toEqual({
      base: ['3450', '17250'],
      tiers: [[200_000, '6900', '25875']],
    });
  });

  it('anchors DeepSeek V4 Pro on the cheapest ZDR endpoint that accepts its output cap', () => {
    expect(
      figuresOf(textPricingFromEndpoints(DEEPSEEK_V4_PRO, limitsOf({ maxOutputTokens: 384_000 })))
        .base
    ).toEqual(['1201', '2402']);
  });

  it('bakes each rate once from the exact vendor decimal', () => {
    expect(
      figuresOf(
        textPricingFromEndpoints([endpointAt('vendor', '0.0000000605', '0.000000121')], limitsOf())
      ).base[0]
    ).toBe('70');
  });

  it('never anchors on a flex endpoint, even at half the default tier price', () => {
    expect(figuresOf(textPricingFromEndpoints(GEMINI_31_PRO, limitsOf()))).toEqual({
      base: ['2300', '13800'],
      tiers: [[200_000, '4600', '20700']],
    });
  });

  it('takes the anchor and its tier from the standard endpoint, never the priority one', () => {
    expect(figuresOf(textPricingFromEndpoints(GROK_47, limitsOf()))).toEqual({
      base: ['2300', '6900'],
      tiers: [[200_000, '4600', '13800']],
    });
  });

  it('anchors on the next-cheapest endpoint when the cheapest cannot accept the output cap', () => {
    const endpoints = [
      endpointAt('cheapest/fp8', '0.0000003', '0.000001', { maxCompletionTokens: 117_964 }),
      endpointAt('dearest', '0.0000006', '0.000002', { maxCompletionTokens: 131_072 }),
      endpointAt('next', '0.0000004', '0.0000012', { maxCompletionTokens: 131_072 }),
    ];
    expect(
      figuresOf(textPricingFromEndpoints(endpoints, limitsOf({ maxOutputTokens: 131_072 }))).base
    ).toEqual(['460', '1380']);
  });

  it('caps the output at the largest cap an eligible endpoint accepts', () => {
    const endpoints = [
      endpointAt('a', '0.000001', '0.000002', { maxCompletionTokens: 32_768 }),
      endpointAt('b', '0.000001', '0.000003', { maxCompletionTokens: 16_384 }),
    ];
    const result = textPricingFromEndpoints(endpoints, limitsOf({ maxOutputTokens: 117_964 }));
    expect(result.kind === 'priced' ? result.maxOutputTokens : undefined).toBe(32_768);
  });

  it('keeps the gateway output cap when every eligible endpoint accepts more', () => {
    const endpoints = [endpointAt('a', '0.000001', '0.000002', { maxCompletionTokens: 65_536 })];
    const result = textPricingFromEndpoints(endpoints, limitsOf({ maxOutputTokens: 16_384 }));
    expect(result.kind === 'priced' ? result.maxOutputTokens : undefined).toBe(16_384);
  });

  it('bounds the context at the largest context an eligible endpoint serves', () => {
    const endpoints = [endpointAt('a', '0.000001', '0.000002', { contextLength: 131_072 })];
    const result = textPricingFromEndpoints(endpoints, limitsOf({ contextLength: 1_000_000 }));
    expect(result.kind === 'priced' ? result.contextLength : undefined).toBe(131_072);
  });

  it("records the anchor endpoint's own context, below which every tier is the anchor's", () => {
    const result = textPricingFromEndpoints(
      GPT_54,
      limitsOf({ maxOutputTokens: 128_000, contextLength: 1_050_000 })
    );
    expect(result.kind === 'priced' ? result.pricing.anchorContextTokens : undefined).toBe(400_000);
  });

  it("records an anchor's context past its own tier when no larger context exists", () => {
    const result = textPricingFromEndpoints(SONNET_45, SONNET_45_LIMITS);
    expect(result.kind === 'priced' ? result.pricing.anchorContextTokens : undefined).toBe(
      1_000_000
    );
  });

  it('writes the anchor context into the stored price it parses', () => {
    const result = textPricingFromEndpoints(SONNET_45, SONNET_45_LIMITS);
    expect(result.kind === 'priced' && result.stored).toEqual(
      expect.objectContaining({ anchorContextTokens: 1_000_000 })
    );
  });

  it('prices prompts past the anchor context at the covering endpoint, tier included', () => {
    expect(
      figuresOf(
        textPricingFromEndpoints(
          GPT_54,
          limitsOf({ maxOutputTokens: 128_000, contextLength: 1_050_000 })
        )
      )
    ).toEqual({ base: ['230', '1438'], tiers: [[400_000, '5750', '25875']] });
  });

  it('drops a tier whose threshold no prompt can reach inside the context', () => {
    const endpoints = [
      endpointAt('a', '0.000003', '0.000015', {
        contextLength: 200_000,
        overrides: longContext('0.000006', '0.0000225'),
      }),
    ];
    expect(
      figuresOf(textPricingFromEndpoints(endpoints, limitsOf({ contextLength: 200_000 }))).tiers
    ).toEqual([]);
  });

  it('folds a tiered override into each higher tier as a cumulative maximum', () => {
    const endpoints = [
      endpointAt('a', '0.000001', '0.000004', {
        overrides: [
          { min_prompt_tokens: 100_000, prompt: '0.000003' },
          { min_prompt_tokens: 200_000, completion: '0.000005' },
        ],
      }),
    ];
    expect(figuresOf(textPricingFromEndpoints(endpoints, limitsOf())).tiers).toEqual([
      [100_000, '3450', '4600'],
      [200_000, '3450', '5750'],
    ]);
  });

  it('normalizes a windowed endpoint to the same content whichever window the refresh reads it in', () => {
    const model = languageModel({ id: 'tencent/hy3', contextLength: 262_144 });
    const contentIn = (window: 'dear' | 'cheap'): string =>
      canonicalJson(
        normalized(
          normalizeListedModel(model, new Map([['tencent/hy3', [hy3InWindow(window)]]]), EXEMPT)
        )
      );
    expect(contentIn('cheap')).toBe(contentIn('dear'));
  });

  it('prices a windowed endpoint at its dear window', () => {
    expect(figuresOf(textPricingFromEndpoints([hy3InWindow('cheap')], limitsOf())).base).toEqual([
      '152',
      '608',
    ]);
  });

  it('gives equal-sum endpoints the same anchor in either listing order', () => {
    const left = endpointAt('left', '0.000001', '0.000003');
    const right = endpointAt('right', '0.000002', '0.000002');
    expect([
      figuresOf(textPricingFromEndpoints([left, right], limitsOf())).base,
      figuresOf(textPricingFromEndpoints([right, left], limitsOf())).base,
    ]).toEqual([
      ['2300', '2300'],
      ['2300', '2300'],
    ]);
  });

  it('breaks an equal-rate tie by tag, in either listing order', () => {
    // Equal base rates; only `alpha`'s tier separates the stored schedules.
    const alpha = endpointAt('alpha', '0.000001', '0.000002', {
      overrides: [{ min_prompt_tokens: 100_000, prompt: '0.000003' }],
    });
    const beta = endpointAt('beta', '0.000001', '0.000002');
    expect([
      figuresOf(textPricingFromEndpoints([alpha, beta], limitsOf())),
      figuresOf(textPricingFromEndpoints([beta, alpha], limitsOf())),
    ]).toEqual([
      { base: ['1150', '2300'], tiers: [[100_000, '3450', '2300']] },
      { base: ['1150', '2300'], tiers: [[100_000, '3450', '2300']] },
    ]);
  });

  it('breaks an equal-rate, equal-tag tie by provider name, in either listing order', () => {
    const bedrock = endpointAt('shared-tag', '0.000001', '0.000002', {
      providerName: 'Amazon Bedrock',
      overrides: [{ min_prompt_tokens: 100_000, prompt: '0.000003' }],
    });
    const vertex = endpointAt('shared-tag', '0.000001', '0.000002', { providerName: 'Google' });
    expect([
      figuresOf(textPricingFromEndpoints([bedrock, vertex], limitsOf())),
      figuresOf(textPricingFromEndpoints([vertex, bedrock], limitsOf())),
    ]).toEqual([
      { base: ['1150', '2300'], tiers: [[100_000, '3450', '2300']] },
      { base: ['1150', '2300'], tiers: [[100_000, '3450', '2300']] },
    ]);
  });

  it.each(['fast', 'priority', 'flex'])(
    'never anchors on a %s endpoint priced below the standard one',
    (variant) => {
      const serviceTier = endpointAt(`vendor/${variant}`, '0.0000005', '0.000001');
      const standard = endpointAt('vendor', '0.000001', '0.000002');
      expect(figuresOf(textPricingFromEndpoints([serviceTier, standard], limitsOf())).base).toEqual(
        ['1150', '2300']
      );
    }
  );

  it('reads a service tier from a hyphenated variant token', () => {
    const serviceTier = endpointAt('vendor/eu-fast', '0.0000005', '0.000001');
    const standard = endpointAt('vendor', '0.000001', '0.000002');
    expect(figuresOf(textPricingFromEndpoints([serviceTier, standard], limitsOf())).base).toEqual([
      '1150',
      '2300',
    ]);
  });

  it('reads no service tier from a tag without a variant, even one named for a tier', () => {
    const named = endpointAt('fast', '0.0000005', '0.000001');
    const standard = endpointAt('vendor', '0.000001', '0.000002');
    expect(figuresOf(textPricingFromEndpoints([named, standard], limitsOf())).base).toEqual([
      '575',
      '1150',
    ]);
  });
});

describe('textPricingFromEndpoints (reachability)', () => {
  it('excludes a model with no standard-tier endpoint as non-zdr', () => {
    expect(
      reasonOf(
        textPricingFromEndpoints(
          [endpointAt('google-vertex/global/flex', '0.000001', '0.000006')],
          limitsOf()
        )
      )
    ).toBe('non-zdr');
  });

  it('excludes a tool-capable model as non-zdr when its one endpoint lacks tools', () => {
    expect(
      reasonOf(
        textPricingFromEndpoints(
          [
            endpointAt('a', '0.000001', '0.000002', {
              supportedParameters: ['max_tokens', 'reasoning'],
            }),
          ],
          limitsOf()
        )
      )
    ).toBe('non-zdr');
  });

  it('excludes a reasoning model as non-zdr when its one endpoint lacks reasoning', () => {
    expect(
      reasonOf(
        textPricingFromEndpoints(
          [
            endpointAt('a', '0.000001', '0.000002', {
              supportedParameters: ['max_tokens', 'tools'],
            }),
          ],
          limitsOf()
        )
      )
    ).toBe('non-zdr');
  });

  it('excludes a model whose endpoint accepts no output cap parameter, loudly', () => {
    expect(
      reasonOf(
        textPricingFromEndpoints(
          [
            endpointAt('a', '0.000001', '0.000002', {
              supportedParameters: ['tools', 'reasoning'],
            }),
          ],
          limitsOf()
        )
      )
    ).toBe('unrepresentable-endpoint-price');
  });

  it('accepts max_completion_tokens in place of max_tokens', () => {
    expect(
      reasonOf(
        textPricingFromEndpoints(
          [
            endpointAt('a', '0.000001', '0.000002', {
              supportedParameters: ['max_completion_tokens', 'tools', 'reasoning'],
            }),
          ],
          limitsOf()
        )
      )
    ).toBe('priced');
  });

  it('reaches an endpoint without tools or reasoning for a model that sends neither', () => {
    expect(
      reasonOf(
        textPricingFromEndpoints(
          [endpointAt('a', '0.000001', '0.000002', { supportedParameters: ['max_tokens'] })],
          limitsOf({ supportedParameters: ['max_tokens', 'temperature'] })
        )
      )
    ).toBe('priced');
  });

  it('never anchors on an endpoint lacking a parameter, even when it is cheaper', () => {
    const endpoints = [
      endpointAt('cheap', '0.0000001', '0.0000002', { supportedParameters: ['max_tokens'] }),
      endpointAt('served', '0.000001', '0.000002'),
    ];
    expect(figuresOf(textPricingFromEndpoints(endpoints, limitsOf())).base).toEqual([
      '1150',
      '2300',
    ]);
  });
});

/** One eligible endpoint priced normally, beside one carrying the shape under test. */
function besideAnchor(odd: Partial<ZdrEndpoint>, tag = 'odd'): readonly ZdrEndpoint[] {
  return [endpointAt('anchor', '0.000001', '0.000002'), zdrEndpointFixture({ tag, ...odd })];
}

const UNREPRESENTABLE_SHAPES: readonly (readonly [string, Partial<ZdrEndpoint>])[] = [
  ['a request fee', { pricing: { prompt: '0.000001', completion: '0.000002', request: '0.001' } }],
  [
    'reasoning dearer than completion',
    { pricing: { prompt: '0.000001', completion: '0.000002', internal_reasoning: '0.000003' } },
  ],
  [
    'a cached read dearer than the prompt',
    { pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: '0.000002' } },
  ],
  [
    'an override key outside the conditions and rates',
    {
      pricing: { prompt: '0.000001', completion: '0.000002' },
      overrides: [{ min_prompt_tokens: 100_000, prompt: '0.000002', surge: '2' }],
    },
  ],
  [
    'a time schedule that does not tile every weekday',
    {
      pricing: { prompt: '0.000001', completion: '0.000002' },
      overrides: [{ utc_start: 0, utc_end: 1200, prompt: '0.000002' }],
    },
  ],
  [
    'a top-level price key in neither the represented nor the ignored list',
    { pricing: { prompt: '0.000001', completion: '0.000002', surge_multiplier: '2' } },
  ],
  ['a price that could not be read', { pricing: 'unreadable' }],
];

describe('textPricingFromEndpoints (prices the schedule cannot represent)', () => {
  it.each(UNREPRESENTABLE_SHAPES)(
    'excludes the model when a standard-tier endpoint lists %s',
    (_label, odd) => {
      expect(reasonOf(textPricingFromEndpoints(besideAnchor(odd), limitsOf()))).toBe(
        'unrepresentable-endpoint-price'
      );
    }
  );

  it.each(UNREPRESENTABLE_SHAPES)('ignores %s on a flex endpoint', (_label, odd) => {
    expect(reasonOf(textPricingFromEndpoints(besideAnchor(odd, 'vendor/flex'), limitsOf()))).toBe(
      'priced'
    );
  });

  it('excludes a model whose anchor lists a 5-minute cache write above five quarters of its prompt rate', () => {
    const endpoints = [
      endpointAt('a', '0.000001', '0.000002', {
        overrides: [
          { min_prompt_tokens: 100_000, prompt: '0.000002', input_cache_write: '0.0000026' },
        ],
      }),
    ];
    expect(reasonOf(textPricingFromEndpoints(endpoints, limitsOf()))).toBe(
      'unrepresentable-endpoint-price'
    );
  });

  it('admits an anchor cache write of exactly five quarters of its prompt rate', () => {
    const endpoints = [
      zdrEndpointFixture({
        pricing: {
          prompt: '0.000001',
          completion: '0.000002',
          input_cache_write: '0.00000125',
          input_cache_write_1h: '0.000002',
        },
      }),
    ];
    expect(reasonOf(textPricingFromEndpoints(endpoints, limitsOf()))).toBe('priced');
  });

  it('ignores the prices a text call never triggers', () => {
    const endpoints = [
      zdrEndpointFixture({
        pricing: {
          prompt: '0.000001',
          completion: '0.000002',
          web_search: '0.01',
          discount: 0.15,
          image: '0.001',
          audio: '0.00001',
          input_audio_cache: '0.000001',
          image_output: '0.00003',
          image_token: '0.00001',
        },
      }),
    ];
    expect(reasonOf(textPricingFromEndpoints(endpoints, limitsOf()))).toBe('priced');
  });

  it('excludes a model whose every rate is zero as zero-priced', () => {
    expect(reasonOf(textPricingFromEndpoints([endpointAt('a', '0', '0')], limitsOf()))).toBe(
      'zero-priced'
    );
  });

  it('excludes a model with exactly one zero rate, loudly', () => {
    expect(reasonOf(textPricingFromEndpoints([endpointAt('a', '0.000001', '0')], limitsOf()))).toBe(
      'unknown-pricing-unit'
    );
  });
});

describe('textPricingFromEndpoints (the max_price band)', () => {
  /** An anchor at 1 / 10 USD a million with a tier above 100,000 at 2 / 20. */
  const anchor = endpointAt('anchor', '0.000001', '0.00001', {
    overrides: [{ min_prompt_tokens: 100_000, prompt: '0.000002', completion: '0.00002' }],
  });

  function bandOf(endpoints: readonly ZdrEndpoint[]): number | undefined {
    const result = textPricingFromEndpoints(endpoints, limitsOf());
    return result.kind === 'priced' ? result.bandOpenEndpoints : undefined;
  }

  it('counts an endpoint above the base ceiling that a short call still admits', () => {
    expect(bandOf([anchor, endpointAt('mid', '0.0000015', '0.000012')])).toBe(1);
  });

  it('leaves out an endpoint inside the base ceiling', () => {
    expect(bandOf([anchor, endpointAt('near', '0.0000011', '0.000011')])).toBe(0);
  });

  it('leaves out an endpoint above the short-call max_price', () => {
    expect(bandOf([anchor, endpointAt('far', '0.000003', '0.00003')])).toBe(0);
  });

  it('counts nothing on Claude Sonnet 4.5, whose regional endpoints sit inside the base ceiling', () => {
    const result = textPricingFromEndpoints(SONNET_45, SONNET_45_LIMITS);
    expect(result.kind === 'priced' ? result.bandOpenEndpoints : undefined).toBe(0);
  });
});

describe('endpointBucketCounts', () => {
  it("lands each of a model's ZDR endpoints in exactly one bucket", () => {
    const endpoints = [
      ...GEMINI_31_PRO,
      endpointAt('no-tools', '0.000001', '0.000002', { supportedParameters: ['max_tokens'] }),
      zdrEndpointFixture({ tag: 'garbled', pricing: 'unreadable' }),
      zdrEndpointFixture({ tag: 'fee', pricing: { prompt: '1', completion: '1', request: '1' } }),
    ];
    const counts = endpointBucketCounts(endpoints, CALL_PARAMETERS);
    expect(counts).toEqual({
      'service-tier': 2,
      'unsupported-parameter': 1,
      unreadable: 1,
      unrepresentable: 1,
      reachable: 1,
    });
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(endpoints.length);
  });
});

describe('the descriptor invariants over every fixture listing', () => {
  const listings: readonly (readonly [string, readonly ZdrEndpoint[]])[] = [
    ['Claude Sonnet 4.5', SONNET_45],
    ['DeepSeek V4 Pro', DEEPSEEK_V4_PRO],
    ['Gemini 3.1 Pro', GEMINI_31_PRO],
    ['Grok 4.7', GROK_47],
    ['GPT-5.4', GPT_54],
    ['Hy3', [hy3InWindow('dear')]],
  ];

  it.each(listings)(
    '%s: tiers ascend strictly, no rate falls, and every rate is positive',
    (_label, endpoints) => {
      const result = textPricingFromEndpoints(endpoints, limitsOf());
      if (result.kind !== 'priced') throw new Error(`expected priced, got ${result.reason}`);
      const { base, tiers } = result.pricing.anchor;
      const levels = [base, ...tiers.map((tier) => tier.rates)];
      expect(
        tiers.every(
          (tier, index) =>
            index === 0 || tier.abovePromptTokens > (tiers[index - 1]?.abovePromptTokens ?? 0)
        )
      ).toBe(true);
      expect(
        levels.every(
          (rates, index) =>
            index === 0 ||
            (rates.input >= (levels[index - 1]?.input ?? 0n) &&
              rates.output >= (levels[index - 1]?.output ?? 0n))
        )
      ).toBe(true);
      expect(levels.every((rates) => rates.input > 0n && rates.output > 0n)).toBe(true);
    }
  );
});
