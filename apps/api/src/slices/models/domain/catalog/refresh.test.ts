import { describe, expect, it } from 'vitest';
import { EXCLUDE_REASONS } from '@hushbox/shared';
import { DAY_MS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { zdrEndpointFixture } from './gateway-fixtures.js';
import { normalizeCatalog } from './normalize.js';
import { alertMassExclusion, alertPriceBandOpen } from './refresh.js';
import type { ExcludeReason } from '@hushbox/shared';
import type { SafeLogFields, Telemetry } from '../../../../lib/telemetry/index.js';
import type { RefreshSummary } from './refresh.js';
import type { LanguageMetadata, ZdrEndpoint } from './gateway-metadata.js';

interface RecordedLine {
  readonly msg: string;
  readonly fields: SafeLogFields | undefined;
}

interface RecordedCapture {
  readonly message: string;
  readonly code: string;
}

function recordingTelemetry(warns: RecordedLine[], captures: RecordedCapture[]): Telemetry {
  return {
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: SafeLogFields) => {
      warns.push({ msg, fields });
    },
    error: () => {},
    captureError: (error: Error, code: string) => {
      captures.push({ message: error.message, code });
    },
  };
}

function excludedByReason(
  overrides: Partial<Record<ExcludeReason, number>>
): Record<ExcludeReason, number> {
  const counts = {} as Record<ExcludeReason, number>;
  for (const reason of EXCLUDE_REASONS) counts[reason] = overrides[reason] ?? 0;
  return counts;
}

function summaryOf(overrides: Partial<RefreshSummary> = {}): RefreshSummary {
  return {
    discovered: 100,
    written: 0,
    unchanged: 0,
    excluded: 0,
    excludedByReason: excludedByReason({}),
    excludedReasonById: new Map(),
    endpointsByBucket: {
      'service-tier': 0,
      'unsupported-parameter': 0,
      unreadable: 0,
      unrepresentable: 0,
      reachable: 0,
    },
    previouslyIncluded: 0,
    newlyExcluded: 0,
    ...overrides,
  };
}

function warnsFor(summary: RefreshSummary): RecordedLine[] {
  const warns: RecordedLine[] = [];
  alertMassExclusion(recordingTelemetry(warns, []), summary);
  return warns;
}

function capturesFor(summary: RefreshSummary): RecordedCapture[] {
  const captures: RecordedCapture[] = [];
  alertMassExclusion(recordingTelemetry([], captures), summary);
  return captures;
}

describe('alertMassExclusion', () => {
  it('warns when a refresh newly excludes half of the previously included catalog', () => {
    expect(warnsFor(summaryOf({ previouslyIncluded: 80, newlyExcluded: 40 }))).toEqual([
      {
        msg: 'catalog refresh newly excluded most of the models it was selling',
        fields: { droppedCount: 40, errorCode: 'model_catalog_mass_exclusion' },
      },
    ]);
  });

  it('stays silent when a refresh newly excludes less than half of it', () => {
    expect(warnsFor(summaryOf({ previouslyIncluded: 80, newlyExcluded: 39 }))).toEqual([]);
  });

  it('stays silent when the catalog held nothing before the refresh', () => {
    expect(warnsFor(summaryOf({ previouslyIncluded: 0, newlyExcluded: 0 }))).toEqual([]);
  });

  it('reports the empty retention list rather than the share when both hold', () => {
    const summary = summaryOf({
      discovered: 100,
      excluded: 100,
      excludedByReason: excludedByReason({ 'non-zdr': 100 }),
      previouslyIncluded: 80,
      newlyExcluded: 80,
    });
    expect(warnsFor(summary)).toEqual([
      {
        msg: 'gateway retention list excluded every discovered model — nothing is sellable',
        fields: { droppedCount: 80, errorCode: 'model_catalog_retention_list_empty' },
      },
    ]);
  });

  it('stays silent when the gateway discovered nothing at all', () => {
    expect(warnsFor(summaryOf({ discovered: 0 }))).toEqual([]);
  });

  it('pages Sentry once with a content-free message when nothing is left to sell', () => {
    const summary = summaryOf({
      discovered: 100,
      excluded: 100,
      excludedByReason: excludedByReason({ 'non-zdr': 100 }),
      previouslyIncluded: 80,
      newlyExcluded: 80,
    });
    expect(capturesFor(summary)).toEqual([
      {
        message: 'gateway retention list excluded every discovered model',
        code: 'model_catalog_retention_list_empty',
      },
    ]);
  });

  it('pages Sentry once with a content-free message on a mass exclusion', () => {
    expect(capturesFor(summaryOf({ previouslyIncluded: 80, newlyExcluded: 40 }))).toEqual([
      {
        message: 'catalog refresh newly excluded most of the models it was selling',
        code: 'model_catalog_mass_exclusion',
      },
    ]);
  });

  it('pages nobody when neither aggregate condition holds', () => {
    expect(capturesFor(summaryOf({ previouslyIncluded: 80, newlyExcluded: 39 }))).toEqual([]);
  });
});

/** The refresh clock; every fixture below is exempt from the age cutoff by its context. */
const NOW_MS = TEST_DAY_START;

function textModel(id: string): LanguageMetadata {
  return {
    source: 'language',
    id,
    provider: 'vendor',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedParameters: ['max_tokens', 'tools', 'reasoning'],
    contextLength: 1_000_000,
    releasedAt: secondsAt(NOW_MS - DAY_MS),
    deprecated: false,
  };
}

/** Claude Sonnet 4.5's four live ZDR endpoints: two regional at 1.1× the two global ones. */
function sonnetEndpoints(): readonly ZdrEndpoint[] {
  const at = (tag: string, scale: 'global' | 'regional'): ZdrEndpoint =>
    zdrEndpointFixture({
      tag,
      maxCompletionTokens: 64_000,
      contextLength: 1_000_000,
      pricing:
        scale === 'global'
          ? { prompt: '0.000003', completion: '0.000015' }
          : { prompt: '0.0000033', completion: '0.0000165' },
      overrides: [
        scale === 'global'
          ? { min_prompt_tokens: 200_000, prompt: '0.000006', completion: '0.0000225' }
          : { min_prompt_tokens: 200_000, prompt: '0.0000066', completion: '0.00002475' },
      ],
    });
  return [
    at('amazon-bedrock/eu-west-1', 'regional'),
    at('google-vertex/us-east5', 'regional'),
    at('amazon-bedrock', 'global'),
    at('google-vertex/global', 'global'),
  ];
}

/** An anchor at 1 / 10 USD a million tiered at 2 / 20, beside an endpoint above its base ceiling and inside its tier's. */
function bandOpenEndpoints(): readonly ZdrEndpoint[] {
  return [
    zdrEndpointFixture({
      tag: 'anchor',
      pricing: { prompt: '0.000001', completion: '0.00001' },
      overrides: [{ min_prompt_tokens: 100_000, prompt: '0.000002', completion: '0.00002' }],
    }),
    zdrEndpointFixture({ tag: 'mid', pricing: { prompt: '0.0000015', completion: '0.000012' } }),
  ];
}

function bandCaptures(listing: ReadonlyMap<string, readonly ZdrEndpoint[]>): {
  readonly warns: RecordedLine[];
  readonly captures: RecordedCapture[];
} {
  const warns: RecordedLine[] = [];
  const captures: RecordedCapture[] = [];
  const entries = normalizeCatalog(
    [...listing.keys()].map((id) => textModel(id)),
    listing,
    NOW_MS
  );
  alertPriceBandOpen(recordingTelemetry(warns, captures), entries);
  return { warns, captures };
}

describe('alertPriceBandOpen', () => {
  it('captures once when a model has a standard-tier endpoint above its base ceiling that max_price admits', () => {
    const listing = new Map([
      ['vendor/one', bandOpenEndpoints()],
      ['vendor/two', bandOpenEndpoints()],
    ]);
    expect(bandCaptures(listing).captures).toEqual([
      {
        message:
          'catalog refresh found standard-tier endpoints above the base ceiling within max_price',
        code: 'max_price_band_open',
      },
    ]);
  });

  it('names each such model in its own warning', () => {
    const listing = new Map([
      ['vendor/one', bandOpenEndpoints()],
      ['vendor/two', bandOpenEndpoints()],
    ]);
    expect(bandCaptures(listing).warns.map((line) => line.fields)).toEqual([
      { modelName: 'vendor/one', errorCode: 'max_price_band_open' },
      { modelName: 'vendor/two', errorCode: 'max_price_band_open' },
    ]);
  });

  it('captures nothing over the live listing shape, where regional endpoints sit inside the base ceiling', () => {
    expect(bandCaptures(new Map([['anthropic/claude-sonnet-4.5', sonnetEndpoints()]]))).toEqual({
      warns: [],
      captures: [],
    });
  });
});
