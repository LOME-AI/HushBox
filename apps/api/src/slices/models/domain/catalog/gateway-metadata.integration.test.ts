import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, SERVICE_NAMES, createDb, recordServiceEvidence } from '@hushbox/db';
import { evidenceDatabaseUrl } from '@hushbox/db/test-db';
import { createEnvUtilities } from '@hushbox/shared';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { OPENROUTER_BASE_URL } from '../../adapters/openrouter-provider.js';
import { SHOULD_RUN, processEnvContext } from '../../adapters/integration.setup.js';
import { fetchGatewayCatalog } from './gateway-metadata.js';
import { RECOGNIZED_SUPPORTED_PARAMETERS, normalizeCatalog } from './normalize.js';
import {
  TEST_GATEWAY_BASE_URL,
  catalogFetch,
  imageEndpointsFixture,
  imageModelFixture,
  modelEntryFixture,
  videoModelFixture,
} from './gateway-fixtures.js';
import type { CatalogFixture } from './gateway-fixtures.js';
import type {
  GatewayCatalog,
  ImageMetadata,
  LanguageMetadata,
  VideoMetadata,
  ZdrEndpoint,
} from './gateway-metadata.js';
import type { Database } from '@hushbox/db';
import type { EnvUtilities } from '@hushbox/shared';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

/**
 * REAL catalog-metadata integration — the one test with live-wire reach, and
 * therefore the only thing in the repo that can notice the gateway changing its
 * wire format. It records `openrouter-catalog` service-evidence for
 * `verify:evidence`.
 *
 * NO CASSETTE, deliberately. The four catalog endpoints are unauthenticated and
 * free, so a recording bought nothing and cost the detector: a bodyless GET
 * hashes identically forever, so the first recording replayed permanently and a
 * vocabulary change could never reach these assertions. The cassette layer is
 * unchanged and still carries the paid inference calls.
 *
 * CI-vitest only — the live catalog has no local mock, so this suite keeps its
 * skip. The gate is the harness's shared `SHOULD_RUN` (one `createEnvUtilities`
 * derivation, `deriveCiVitestGate` — never raw CI/E2E sniffing), so a CI-shaped
 * local shell cannot reach the real fetch. Db construction happens inside
 * `beforeAll`, so a skipped run never touches it.
 */

/** A live catalog walk is four paged list fetches plus an N+1 per image model,
 * each bounded by the fetcher's own per-request timeout. The suite default is
 * sized for local infrastructure, not a third party across the internet. */
const LIVE_CATALOG_TIMEOUT_MS = 60_000;

/**
 * Assert each wire key the three per-source checks below name, in the
 * existential form "at least one live model exhibits it".
 *
 * WHAT IS PINNED is stated by derivation, not by this comment enumerating it:
 * every key the catalog derives from that parses through a `nullish` field,
 * less the two exclusions recorded at the bottom of this block. The `nullish`
 * part is what earns a key its assertion — a rename there does not fail the
 * parse, it empties the derived field for every model at once. Three such keys
 * empty the catalog outright, and are marked where they are asserted.
 *
 * WHAT NEEDS NO ASSERTION, because a rename fails the parse instead of passing
 * quietly: the required keys `data`, `id` and `model_id`, and the image pricing
 * row's required `unit` and `cost_usd` — a rename there throws inside the row
 * parse, which drops every image model, which the image population assertion
 * catches.
 *
 * THE TWO RECORDED EXCLUSIONS, each with the live population that decided it,
 * measured against the gateway rather than assumed. `expiration_date`, which
 * drives `deprecated`, held a non-null value on 9 of 417 language models: every
 * pinned key rests on a structural majority, while this one rests on how many
 * models the vendor happens to have deprecated, so a quarter with none would red
 * this gate on a true state of the world. Its rename costs a bounded correctness
 * bug — deprecated models stay listed — never an emptied catalog. And the paging
 * container's `links.next`, which no assertion can reach: all four live lists
 * return a single page, and only one of them carries the container at all —
 * `/models` answers 417 rows with top-level keys `data`, `total_count` and
 * `links`, its `links.next` null, while `/endpoints/zdr`, `/images/models` and
 * `/videos/models` answer `data` alone, with no `links` key. `nextPage` reads
 * absent and null identically, so either way a renamed link truncates a walk
 * that does not currently happen, and the only observable would be a population
 * floor — a volatile magic number. Re-measure before pinning either.
 *
 * The existential form rather than "every model" is deliberate: one upstream row
 * omitting an optional control is ordinary, while the whole catalog losing a key
 * is the vocabulary change. Every case in the drift suite below renames one of
 * these keys in a response this same function then judges.
 */
function expectGatewayWireShape(catalog: GatewayCatalog): void {
  for (const model of catalog.models) {
    expect(['language', 'image', 'video']).toContain(model.source);
  }
  const language = catalog.models.filter(
    (model): model is LanguageMetadata => model.source === 'language'
  );
  const images = catalog.models.filter((model): model is ImageMetadata => model.source === 'image');
  const videos = catalog.models.filter((model): model is VideoMetadata => model.source === 'video');
  expect(language.length).toBeGreaterThan(0);
  expect(images.length).toBeGreaterThan(0);
  expect(videos.length).toBeGreaterThan(0);

  // `/endpoints/zdr` `model_id` — membership is the fail-closed exposure gate.
  expect(catalog.zdrModelIds.size).toBeGreaterThan(0);

  expectZdrWireShape([...catalog.zdrEndpoints.values()].flat());
  expectLanguageWireShape(language);
  expectImageWireShape(images);
  expectVideoWireShape(videos);
}

/** `/models`. */
function expectLanguageWireShape(language: readonly LanguageMetadata[]): void {
  // `supported_parameters`, and every member the normalizer switches on. A
  // member that stops arriving silently drops a control, because an
  // unrecognized name is skipped by design — so name the missing ones.
  const declared = new Set(language.flatMap((model) => model.supportedParameters));
  expect(RECOGNIZED_SUPPORTED_PARAMETERS.filter((parameter) => !declared.has(parameter))).toEqual(
    []
  );

  // `created`. EMPTIES THE CATALOG: without it every model normalizes to the
  // `missing-release-date` exclusion.
  expect(language.some((model) => model.releasedAt !== undefined && model.releasedAt > 0)).toBe(
    true
  );

  // `architecture.output_modalities`. EMPTIES THE CATALOG: without it every
  // model normalizes to the `unclassifiable-modality` exclusion.
  expect(language.some((model) => model.outputModalities.length > 0)).toBe(true);
  // `architecture.input_modalities` — the modality gate on what may be sent.
  expect(language.some((model) => model.inputModalities.length > 0)).toBe(true);

  // `top_provider.max_completion_tokens` — the output ceiling.
  expect(
    language.some(
      (model) => model.maxCompletionTokens !== undefined && model.maxCompletionTokens > 0
    )
  ).toBe(true);
  // `context_length` — the window, one bound of the sold context the exemption reads.
  expect(language.some((model) => model.contextLength !== undefined)).toBe(true);

  // `reasoning` and each sub-key effort control derives from positionally.
  expect(language.some((model) => model.reasoning !== undefined)).toBe(true);
  expect(language.some((model) => model.reasoning?.mandatory !== undefined)).toBe(true);
  expect(language.some((model) => model.reasoning?.supportedEfforts !== undefined)).toBe(true);
  expect(language.some((model) => model.reasoning?.defaultEffort !== undefined)).toBe(true);
  expect(language.some((model) => model.reasoning?.defaultEnabled !== undefined)).toBe(true);

  // `name` / `description` — the description is the classifier prompt's input.
  expect(language.some((model) => model.name !== undefined)).toBe(true);
  expect(language.some((model) => model.description !== undefined)).toBe(true);
}

/**
 * `/endpoints/zdr`, every field a text model's anchor schedule is read from.
 * EMPTIES THE TEXT CATALOG: a renamed `pricing` reads every endpoint as
 * unreadable, and a renamed `supported_parameters` makes every endpoint
 * unreachable.
 */
function expectZdrWireShape(endpoints: readonly ZdrEndpoint[]): void {
  const priced = endpoints.flatMap((endpoint) =>
    endpoint.pricing === 'unreadable' ? [] : [endpoint.pricing]
  );
  expect(priced.some((pricing) => typeof pricing['prompt'] === 'string')).toBe(true);
  expect(priced.some((pricing) => typeof pricing['completion'] === 'string')).toBe(true);
  // `pricing.overrides[].min_prompt_tokens` — the long-context tiers.
  expect(
    endpoints.some((endpoint) =>
      endpoint.overrides.some((entry) => typeof entry['min_prompt_tokens'] === 'number')
    )
  ).toBe(true);
  // `tag` — its variant names the service tier no request of ours reaches.
  expect(endpoints.some((endpoint) => endpoint.tag.includes('/'))).toBe(true);
  expect(endpoints.some((endpoint) => endpoint.providerName.length > 0)).toBe(true);
  expect(endpoints.some((endpoint) => typeof endpoint.maxCompletionTokens === 'number')).toBe(true);
  expect(endpoints.some((endpoint) => typeof endpoint.contextLength === 'number')).toBe(true);
  expect(
    endpoints.some(
      (endpoint) =>
        endpoint.supportedParameters !== 'unreadable' &&
        endpoint.supportedParameters.includes('max_tokens')
    )
  ).toBe(true);
  expect(endpoints.some((endpoint) => endpoint.implicitCaching)).toBe(true);
}

/**
 * The descriptor invariants over every text model the listing normalizes:
 * tiers strictly ascending, no rate falling as tiers rise (the first tier at
 * least the base), and every rate a positive nano-USD count.
 */
function expectTextScheduleInvariants(catalog: GatewayCatalog, nowMs: number): void {
  const schedules = normalizeCatalog(catalog.models, catalog.zdrEndpoints, nowMs).flatMap(
    (entry) =>
      entry.kind === 'normalized' && entry.content.pricing.kind === 'tokens'
        ? [entry.content.pricing.anchor]
        : []
  );
  expect(schedules.length).toBeGreaterThan(0);
  const broken = schedules.filter((schedule) => {
    const levels = [schedule.base, ...schedule.tiers.map((tier) => tier.rates)];
    const ascending = schedule.tiers.every(
      (tier, index) =>
        index === 0 || tier.abovePromptTokens > (schedule.tiers[index - 1]?.abovePromptTokens ?? 0)
    );
    const monotone = levels.every((rates, index) => {
      const below = levels[index - 1];
      return (
        below === undefined ||
        (BigInt(rates.input) >= BigInt(below.input) && BigInt(rates.output) >= BigInt(below.output))
      );
    });
    const positive = levels.every((rates) => BigInt(rates.input) > 0n && BigInt(rates.output) > 0n);
    return !(ascending && monotone && positive);
  });
  expect(broken).toEqual([]);
}

/** `/images/models`, plus the N+1 endpoint detail behind each entry. */
function expectImageWireShape(images: readonly ImageMetadata[]): void {
  // `supported_parameters` — both typed shapes the parser reads, an enum's
  // `values` and a range's `max`, under all three axis names.
  expect(images.some((model) => model.supportedParameters.aspectRatio.length > 0)).toBe(true);
  expect(images.some((model) => model.supportedParameters.resolution.length > 0)).toBe(true);
  expect(images.some((model) => model.supportedParameters.maxN !== undefined)).toBe(true);

  // The endpoint detail's `endpoints[].pricing`, and the row's `billable`.
  // EMPTIES THE IMAGE CATALOG: without either, every image model normalizes to
  // the `missing-pricing` exclusion.
  const rows = images.flatMap((model) => model.endpoints.flatMap((endpoint) => endpoint.pricing));
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.some((row) => row.billable === 'output_image')).toBe(true);
  // The endpoint detail's `endpoints[].provider_tag`, the slug a call's pin names.
  // EMPTIES THE IMAGE CATALOG: without it no image endpoint can be pinned, so
  // every image model normalizes to the `non-zdr` exclusion.
  expect(
    images.some((model) => model.endpoints.some((endpoint) => endpoint.providerTag !== null))
  ).toBe(true);

  expect(images.some((model) => model.releasedAt !== undefined && model.releasedAt > 0)).toBe(true);
  // `architecture.input_modalities`. Non-emptiness cannot pin it — the image
  // mapper substitutes `['text']` when the key is absent, so only a modality
  // the default does not contain distinguishes a rename from a text-only model.
  expect(
    images.some((model) => model.inputModalities.some((modality) => modality !== 'text'))
  ).toBe(true);
  expect(images.some((model) => model.name !== undefined)).toBe(true);
  expect(images.some((model) => model.description !== undefined)).toBe(true);
}

/**
 * At least one image model the listing exposes carries a pin: its ZDR rows'
 * `tag` and its endpoints' `provider_tag` join. Without one, no image call can
 * be pinned and the image catalog is empty.
 */
function expectImagePinned(catalog: GatewayCatalog, nowMs: number): void {
  const pins = normalizeCatalog(catalog.models, catalog.zdrEndpoints, nowMs).flatMap((entry) =>
    entry.kind === 'normalized' && entry.content.zdrPin !== undefined ? [entry.content.zdrPin] : []
  );
  expect(pins.some((pin) => pin.length > 0)).toBe(true);
}

/** `/videos/models`. */
function expectVideoWireShape(videos: readonly VideoMetadata[]): void {
  // `pricing_skus` — the whole video price matrix is interpreted from its keys.
  expect(videos.some((model) => Object.keys(model.pricingSkus).length > 0)).toBe(true);
  // The declared domains: the price matrix is keyed by resolutions, and a model
  // declaring no aspect ratios is excluded outright.
  expect(videos.some((model) => model.resolutions.length > 0)).toBe(true);
  expect(videos.some((model) => model.aspectRatios.length > 0)).toBe(true);
  expect(videos.some((model) => model.durations.length > 0)).toBe(true);
  // The three booleans behind the generate-audio, seed and frame-image controls.
  expect(videos.some((model) => model.generateAudio)).toBe(true);
  expect(videos.some((model) => model.seed)).toBe(true);
  expect(videos.some((model) => model.supportsFrameImages)).toBe(true);

  expect(videos.some((model) => model.releasedAt !== undefined && model.releasedAt > 0)).toBe(true);
  expect(videos.some((model) => model.name !== undefined)).toBe(true);
  expect(videos.some((model) => model.description !== undefined)).toBe(true);
}

describe.skipIf(!SHOULD_RUN)('fetchGatewayCatalog live integration', () => {
  let db: Database;
  let envUtilities: EnvUtilities;

  beforeAll(() => {
    envUtilities = createEnvUtilities(processEnvContext());
    // The evidence row has to outlive this worker's database — `verify:evidence`
    // reads the stack's own in a later process.
    db = createDb(evidenceDatabaseUrl(process.env), { neonDev: LOCAL_NEON_DEV_CONFIG });
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it(
    'pins the live gateway wire format and records evidence',
    async () => {
      const result = await fetchGatewayCatalog({
        baseUrl: OPENROUTER_BASE_URL,
        fetch: globalThis.fetch.bind(globalThis),
      });
      expect(result.isOk()).toBe(true);
      expectGatewayWireShape(result._unsafeUnwrap());
      expectTextScheduleInvariants(result._unsafeUnwrap(), secondsAt(TEST_DAY_START) * 1000);
      expectImagePinned(result._unsafeUnwrap(), secondsAt(TEST_DAY_START) * 1000);

      // Last, only after every assertion passed: the real fetch succeeded.
      await recordServiceEvidence(db, envUtilities.isCI, SERVICE_NAMES.OPENROUTER_CATALOG);
    },
    LIVE_CATALOG_TIMEOUT_MS
  );
});

/** A ZDR endpoint's listed rates, as decimal USD strings. */
const LANGUAGE_PRICING = {
  prompt: '0.0000025',
  completion: '0.00001',
  input_cache_read: '0.0000003',
};

/** Reasoning metadata carrying all four sub-keys effort control derives from. */
const LANGUAGE_REASONING = {
  mandatory: false,
  supported_efforts: ['high', 'medium', 'low'],
  default_effort: 'medium',
  default_enabled: true,
};

/** Image parameters under all three axis names, in both typed shapes. */
const IMAGE_PARAMETERS = {
  resolution: { type: 'enum', values: ['1024x1024'] },
  aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
  n: { type: 'range', min: 1, max: 4 },
};

/** An entry carrying every pinned `/models` key; overrides drift one away. */
function languageEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return modelEntryFixture({
    supported_parameters: [...RECOGNIZED_SUPPORTED_PARAMETERS],
    reasoning: LANGUAGE_REASONING,
    ...overrides,
  });
}

/** A ZDR row carrying every pinned `/endpoints/zdr` key; overrides drift one away. */
function zdrRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model_id: 'openai/gpt-test',
    provider_name: 'Azure',
    tag: 'azure/us',
    pricing: {
      ...LANGUAGE_PRICING,
      overrides: [{ min_prompt_tokens: 272_000, prompt: '0.000005', completion: '0.00002' }],
    },
    max_completion_tokens: 16_384,
    context_length: 128_000,
    supported_parameters: [...RECOGNIZED_SUPPORTED_PARAMETERS],
    supports_implicit_caching: true,
    ...overrides,
  };
}

/** An entry carrying every pinned `/images/models` key. */
function imageEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return imageModelFixture({
    description: 'Draws pictures',
    // A non-text input modality, as every live image model declares: the
    // mapper's `['text']` default makes text-only indistinguishable from absent.
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
    supported_parameters: IMAGE_PARAMETERS,
    ...overrides,
  });
}

/** An entry carrying every pinned `/videos/models` key. */
function videoEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return videoModelFixture({
    description: 'Makes movies',
    supported_frame_images: ['first_frame'],
    ...overrides,
  });
}

/** A catalog that satisfies every assertion above, so a drift case differs from
 * it in exactly the one wire key it renames. */
function undriftedFixture(): CatalogFixture {
  return {
    models: [languageEntry()],
    images: [imageEntry()],
    videos: [videoEntry()],
    // The image entry's ZDR row, tagged as its endpoint detail tags its endpoint.
    zdrRows: [zdrRow(), zdrRow({ model_id: 'google/test-image', tag: 'test-provider' })],
  };
}

function withZdrRow(row: Record<string, unknown>): CatalogFixture {
  return { ...undriftedFixture(), zdrRows: [row] };
}

function withLanguage(entry: Record<string, unknown>): CatalogFixture {
  return { ...undriftedFixture(), models: [entry] };
}

function withImage(entry: Record<string, unknown>): CatalogFixture {
  return { ...undriftedFixture(), images: [entry] };
}

function withVideo(entry: Record<string, unknown>): CatalogFixture {
  return { ...undriftedFixture(), videos: [entry] };
}

/** The endpoint-detail body behind an image entry, rebuilt from `rows`. */
function withImagePricing(rows: unknown[]): CatalogFixture {
  return { ...undriftedFixture(), imageEndpoints: () => imageEndpointsFixture(rows) };
}

interface DriftCase {
  /** The wire key this case renames away. */
  readonly wireKey: string;
  readonly fixture: CatalogFixture;
}

/** One case per wire key the shape check pins, each renaming that key to a name
 * the parser does not read — the vocabulary change the detector must catch. */
const DRIFT_CASES: readonly DriftCase[] = [
  {
    wireKey: 'supported_parameters',
    fixture: withLanguage(
      languageEntry({
        supported_parameters: undefined,
        supported_params: [...RECOGNIZED_SUPPORTED_PARAMETERS],
      })
    ),
  },
  ...RECOGNIZED_SUPPORTED_PARAMETERS.map((parameter) => ({
    wireKey: `the supported_parameters member ${parameter}`,
    fixture: withLanguage(
      languageEntry({
        supported_parameters: RECOGNIZED_SUPPORTED_PARAMETERS.filter(
          (member) => member !== parameter
        ),
      })
    ),
  })),
  {
    wireKey: 'created',
    fixture: withLanguage(languageEntry({ created: undefined, created_at: FIXTURE_STAMP_SECONDS })),
  },
  {
    wireKey: 'architecture.output_modalities',
    fixture: withLanguage(
      languageEntry({ architecture: { input_modalities: ['text'], outputs: ['text'] } })
    ),
  },
  {
    wireKey: 'architecture.input_modalities',
    fixture: withLanguage(
      languageEntry({ architecture: { inputs: ['text'], output_modalities: ['text'] } })
    ),
  },
  {
    wireKey: 'top_provider.max_completion_tokens',
    fixture: withLanguage(
      languageEntry({ top_provider: { context_length: 128_000, max_completion: 16_384 } })
    ),
  },
  {
    wireKey: 'context_length',
    fixture: withLanguage(languageEntry({ context_length: undefined, context_window: 128_000 })),
  },
  {
    wireKey: 'the ZDR pricing',
    fixture: withZdrRow(zdrRow({ pricing: undefined, prices: LANGUAGE_PRICING })),
  },
  {
    wireKey: 'the ZDR pricing.prompt',
    fixture: withZdrRow(
      zdrRow({ pricing: { ...LANGUAGE_PRICING, prompt: undefined, prompt_cost: '0.0000025' } })
    ),
  },
  {
    wireKey: 'the ZDR pricing.completion',
    fixture: withZdrRow(
      zdrRow({
        pricing: { ...LANGUAGE_PRICING, completion: undefined, completion_cost: '0.00001' },
      })
    ),
  },
  {
    wireKey: 'the ZDR pricing.overrides',
    fixture: withZdrRow(zdrRow({ pricing: LANGUAGE_PRICING })),
  },
  {
    wireKey: 'the ZDR tag',
    fixture: withZdrRow(zdrRow({ tag: undefined, slug: 'azure/us' })),
  },
  {
    wireKey: 'the ZDR provider_name',
    fixture: withZdrRow(zdrRow({ provider_name: undefined, provider: 'Azure' })),
  },
  {
    wireKey: 'the ZDR max_completion_tokens',
    fixture: withZdrRow(zdrRow({ max_completion_tokens: undefined, max_output: 16_384 })),
  },
  {
    wireKey: 'the ZDR context_length',
    fixture: withZdrRow(zdrRow({ context_length: undefined, context_window: 128_000 })),
  },
  {
    wireKey: 'the ZDR supported_parameters',
    fixture: withZdrRow(zdrRow({ supported_parameters: undefined, parameters: ['max_tokens'] })),
  },
  {
    wireKey: 'the ZDR supports_implicit_caching',
    fixture: withZdrRow(zdrRow({ supports_implicit_caching: undefined, implicit_caching: true })),
  },
  {
    wireKey: 'reasoning',
    fixture: withLanguage(languageEntry({ reasoning: undefined, thinking: LANGUAGE_REASONING })),
  },
  {
    wireKey: 'reasoning.mandatory',
    fixture: withLanguage(
      languageEntry({ reasoning: { ...LANGUAGE_REASONING, mandatory: undefined, required: false } })
    ),
  },
  {
    wireKey: 'reasoning.supported_efforts',
    fixture: withLanguage(
      languageEntry({
        reasoning: { ...LANGUAGE_REASONING, supported_efforts: undefined, efforts: ['high'] },
      })
    ),
  },
  {
    wireKey: 'reasoning.default_effort',
    fixture: withLanguage(
      languageEntry({
        reasoning: { ...LANGUAGE_REASONING, default_effort: undefined, effort_default: 'medium' },
      })
    ),
  },
  {
    wireKey: 'reasoning.default_enabled',
    fixture: withLanguage(
      languageEntry({
        reasoning: { ...LANGUAGE_REASONING, default_enabled: undefined, enabled_default: true },
      })
    ),
  },
  {
    wireKey: 'name',
    fixture: withLanguage(languageEntry({ name: undefined, label: 'GPT Test' })),
  },
  {
    wireKey: 'description',
    fixture: withLanguage(languageEntry({ description: undefined, summary: 'A test model' })),
  },
  {
    wireKey: 'the image supported_parameters.aspect_ratio enum',
    fixture: withImage(
      imageEntry({
        supported_parameters: {
          ...IMAGE_PARAMETERS,
          aspect_ratio: undefined,
          aspectRatio: { type: 'enum', values: ['1:1'] },
        },
      })
    ),
  },
  {
    wireKey: 'the image supported_parameters.resolution enum',
    fixture: withImage(
      imageEntry({
        supported_parameters: {
          ...IMAGE_PARAMETERS,
          resolution: undefined,
          size: { type: 'enum', values: ['1024x1024'] },
        },
      })
    ),
  },
  {
    wireKey: 'the image supported_parameters.n range',
    fixture: withImage(
      imageEntry({
        supported_parameters: {
          ...IMAGE_PARAMETERS,
          n: undefined,
          count: { type: 'range', min: 1, max: 4 },
        },
      })
    ),
  },
  {
    wireKey: 'the image endpoint pricing row billable',
    fixture: withImagePricing([{ role: 'output_image', unit: 'image', cost_usd: 0.04 }]),
  },
  {
    wireKey: 'the image endpoint provider_tag',
    fixture: {
      ...undriftedFixture(),
      imageEndpoints: () => ({
        id: 'google/test-image',
        endpoints: [
          {
            provider_slug: 'test-provider',
            pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }],
          },
        ],
      }),
    },
  },
  {
    wireKey: 'the image endpoint detail pricing rows',
    fixture: {
      ...undriftedFixture(),
      imageEndpoints: () => ({ id: 'google/test-image', tiers: [] }),
    },
  },
  {
    wireKey: 'the image created',
    fixture: withImage(imageEntry({ created: undefined, created_at: FIXTURE_STAMP_SECONDS })),
  },
  {
    wireKey: 'the image architecture.input_modalities',
    fixture: withImage(
      imageEntry({ architecture: { inputs: ['text', 'image'], output_modalities: ['image'] } })
    ),
  },
  {
    wireKey: 'the image name',
    fixture: withImage(imageEntry({ name: undefined, label: 'Test Image' })),
  },
  {
    wireKey: 'the image description',
    fixture: withImage(imageEntry({ description: undefined, summary: 'Draws pictures' })),
  },
  {
    wireKey: 'pricing_skus',
    fixture: withVideo(
      videoEntry({
        pricing_skus: undefined,
        pricing_sku_rates: { duration_seconds_720p: '0.0988' },
      })
    ),
  },
  {
    wireKey: 'supported_resolutions',
    fixture: withVideo(
      videoEntry({ supported_resolutions: undefined, resolutions: ['720p', '1080p'] })
    ),
  },
  {
    wireKey: 'supported_aspect_ratios',
    fixture: withVideo(videoEntry({ supported_aspect_ratios: undefined, aspect_ratios: ['16:9'] })),
  },
  {
    wireKey: 'supported_durations',
    fixture: withVideo(videoEntry({ supported_durations: undefined, durations: [4, 8] })),
  },
  {
    wireKey: 'supported_frame_images',
    fixture: withVideo(
      videoEntry({ supported_frame_images: undefined, frame_images: ['first_frame'] })
    ),
  },
  {
    wireKey: 'generate_audio',
    fixture: withVideo(videoEntry({ generate_audio: undefined, audio: true })),
  },
  {
    wireKey: 'the video seed',
    fixture: withVideo(videoEntry({ seed: undefined, seeded: true })),
  },
  {
    wireKey: 'the video created',
    fixture: withVideo(videoEntry({ created: undefined, created_at: FIXTURE_STAMP_SECONDS })),
  },
  {
    wireKey: 'the video name',
    fixture: withVideo(videoEntry({ name: undefined, label: 'Test Video' })),
  },
  {
    wireKey: 'the video description',
    fixture: withVideo(videoEntry({ description: undefined, summary: 'Makes movies' })),
  },
];

async function catalogOf(fixture: CatalogFixture): Promise<GatewayCatalog> {
  const result = await fetchGatewayCatalog({
    baseUrl: TEST_GATEWAY_BASE_URL,
    fetch: catalogFetch(fixture),
  });
  return result._unsafeUnwrap();
}

describe('the live gateway wire-shape assertions', () => {
  it('passes a response carrying every wire key the catalog reads', async () => {
    expectGatewayWireShape(await catalogOf(undriftedFixture()));
  });

  it.each(DRIFT_CASES)('fails when the gateway renames $wireKey', async ({ fixture }) => {
    const catalog = await catalogOf(fixture);
    expect(() => {
      expectGatewayWireShape(catalog);
    }).toThrow();
  });
});

describe('the live image pin assertion', () => {
  const NOW_MS = secondsAt(TEST_DAY_START) * 1000;

  it('passes a listing whose ZDR row tags an image endpoint', async () => {
    expectImagePinned(await catalogOf(undriftedFixture()), NOW_MS);
  });

  it('fails a listing whose ZDR rows tag no image endpoint', async () => {
    const untagged = await catalogOf({
      ...undriftedFixture(),
      zdrRows: [zdrRow(), zdrRow({ model_id: 'google/test-image', tag: 'elsewhere' })],
    });
    expect(() => {
      expectImagePinned(untagged, NOW_MS);
    }).toThrow();
  });
});
