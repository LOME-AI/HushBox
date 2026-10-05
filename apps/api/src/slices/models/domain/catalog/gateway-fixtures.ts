/**
 * SYNTHETIC OpenRouter catalog fixtures (same convention as the adapter's
 * failure fixtures): authored from OpenRouter's documented metadata format
 * for `/models`, `/endpoints/zdr`, `/images/models` (+ the N+1
 * `/images/models/{id}/endpoints`), and `/videos/models` — never recorded
 * from the live gateway (implementation agents hold no credentials, and
 * tests make zero real calls). If live recordings ever land, replace the
 * fixture bodies and keep the test contracts.
 */

import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-instants';
import type { ZdrEndpoint } from './gateway-metadata.js';

export const TEST_GATEWAY_BASE_URL = 'https://openrouter.test/api/v1';

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A `/models` (language / multimodal) entry. */
export function modelEntryFixture(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'openai/gpt-test',
    name: 'GPT Test',
    description: 'A test model',
    created: OLD_RELEASE_SECONDS,
    context_length: 128_000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.0000025', completion: '0.00001' },
    supported_parameters: ['temperature', 'top_p', 'max_tokens'],
    // Always present upstream (a required key on the model object); its
    // token fields are integer|null.
    top_provider: { context_length: 128_000, max_completion_tokens: 16_384, is_moderated: false },
    expiration_date: null,
    ...overrides,
  };
}

/** An `/images/models` entry. */
export function imageModelFixture(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'google/test-image',
    name: 'Test Image',
    created: OLD_RELEASE_SECONDS,
    architecture: { input_modalities: ['text'], output_modalities: ['image'] },
    supported_parameters: {
      aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
      n: { type: 'range', min: 1, max: 4 },
    },
    supports_streaming: false,
    endpoints: `${TEST_GATEWAY_BASE_URL}/images/models/google/test-image/endpoints`,
    ...overrides,
  };
}

/** The N+1 `/images/models/{id}/endpoints` body: `{id, endpoints:[{provider_tag, pricing}]}`.
 * `cost_usd` is numeric on the wire; `billable` is a role string. The tag is the
 * one {@link zdrBody}'s rows carry, so a listed image model pins its endpoint. */
export function imageEndpointsFixture(
  pricing: unknown[] = [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }]
): unknown {
  return { id: 'google/test-image', endpoints: [{ provider_tag: 'test-provider', pricing }] };
}

/** A `/videos/models` entry. */
export function videoModelFixture(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'google/test-video',
    name: 'Test Video',
    created: OLD_RELEASE_SECONDS,
    architecture: null,
    supported_parameters: null,
    supported_resolutions: ['720p', '1080p'],
    supported_aspect_ratios: ['16:9'],
    supported_durations: [4, 8],
    supported_frame_images: null,
    generate_audio: true,
    seed: true,
    pricing_skus: { duration_seconds_720p: '0.0988', duration_seconds_1080p: '0.15' },
    ...overrides,
  };
}

/** Bedrock and Vertex's long-context price above 200,000 prompt tokens, as listed. */
function sonnetOverride(scale: 'base' | 'regional'): Record<string, unknown> {
  return scale === 'base'
    ? {
        min_prompt_tokens: 200_000,
        prompt: '0.000006',
        completion: '0.0000225',
        input_cache_read: '0.0000006',
        input_cache_write: '0.0000075',
        input_cache_write_1h: '0.000012',
      }
    : {
        min_prompt_tokens: 200_000,
        prompt: '0.0000066',
        completion: '0.00002475',
        input_cache_read: '0.00000066',
        input_cache_write: '0.00000825',
        input_cache_write_1h: '0.0000132',
      };
}

const SONNET_45_PARAMETERS = [
  'reasoning',
  'include_reasoning',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop',
  'tools',
  'tool_choice',
  'structured_outputs',
];

function sonnetRow(
  tag: string,
  providerName: string,
  scale: 'base' | 'regional'
): Record<string, unknown> {
  const regional = scale === 'regional';
  return {
    name: `${providerName} | anthropic/claude-4.5-sonnet`,
    model_id: 'anthropic/claude-sonnet-4.5',
    context_length: 1_000_000,
    pricing: {
      prompt: regional ? '0.0000033' : '0.000003',
      completion: regional ? '0.0000165' : '0.000015',
      web_search: '0.01',
      input_cache_read: regional ? '0.00000033' : '0.0000003',
      input_cache_write: regional ? '0.000004125' : '0.00000375',
      input_cache_write_1h: regional ? '0.0000066' : '0.000006',
      discount: 0,
      overrides: [sonnetOverride(scale)],
    },
    provider_name: providerName,
    tag,
    quantization: 'unknown',
    max_completion_tokens: 64_000,
    max_prompt_tokens: null,
    supported_parameters: SONNET_45_PARAMETERS,
    status: 0,
    supports_implicit_caching: false,
  };
}

/**
 * Claude Sonnet 4.5's four ZDR rows in the shape and at the prices the live
 * `/endpoints/zdr` listing carried on 2026-10-02: two regional endpoints
 * at 1.1× the two global ones, each with a long-context price above 200,000
 * prompt tokens.
 */
export const SONNET_45_ZDR_ROWS: readonly Record<string, unknown>[] = [
  sonnetRow('amazon-bedrock/eu-west-1', 'Amazon Bedrock', 'regional'),
  sonnetRow('google-vertex/us-east5', 'Google', 'regional'),
  sonnetRow('amazon-bedrock', 'Amazon Bedrock', 'base'),
  sonnetRow('google-vertex/global', 'Google', 'base'),
];

/** A parsed ZDR endpoint: standard tier, every parameter a text call sends, no caps stated. */
export function zdrEndpointFixture(overrides: Partial<ZdrEndpoint>): ZdrEndpoint {
  return {
    providerName: 'Test Provider',
    tag: 'test-provider',
    supportedParameters: ['max_tokens', 'tools', 'reasoning'],
    implicitCaching: false,
    pricing: { prompt: '0.0000025', completion: '0.00001' },
    overrides: [],
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The ZDR row a `/models` entry's own price implies: one standard-tier endpoint
 * serving the entry at its listed rates, caps and parameters. A model whose
 * top provider is ZDR lists exactly this, so a fixture that states only a
 * `/models` entry keeps the rates it states.
 */
function zdrRowFor(
  id: string,
  entry: Record<string, unknown> | undefined
): Record<string, unknown> {
  const row = {
    model_id: id,
    provider_name: id,
    tag: 'test-provider',
    pricing: { prompt: '0.0000025', completion: '0.00001' },
    supported_parameters: ['max_tokens'],
    supports_implicit_caching: false,
  };
  return entry === undefined ? row : { ...row, ...entryLimits(entry) };
}

/** The price, caps and parameters a `/models` entry states, under their ZDR row keys. */
function entryLimits(entry: Record<string, unknown>): Record<string, unknown> {
  const topProvider = isRecord(entry['top_provider']) ? entry['top_provider'] : {};
  return {
    ...(entry['pricing'] === undefined ? {} : { pricing: entry['pricing'] }),
    ...(entry['supported_parameters'] === undefined
      ? {}
      : { supported_parameters: entry['supported_parameters'] }),
    max_completion_tokens: wholeCountOrNull(topProvider['max_completion_tokens']),
    context_length: wholeCountOrNull(entry['context_length']),
  };
}

/** A whole positive count, or null: a `/models` limit that is not one says nothing about the endpoint. */
function wholeCountOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** The `/endpoints/zdr` body from the listed model ids: one row per id,
 * priced as the matching `/models` entry lists it (see {@link zdrRowFor}). */
export function zdrBody(modelIds: readonly string[], models: readonly unknown[] = []): unknown {
  const entries = new Map(
    models.flatMap((entry) =>
      isRecord(entry) && typeof entry['id'] === 'string' ? [[entry['id'], entry] as const] : []
    )
  );
  return { data: modelIds.map((id) => zdrRowFor(id, entries.get(id))) };
}

interface GatewayRouteTable {
  readonly models?: () => Response;
  readonly zdr?: () => Response;
  readonly images?: () => Response;
  readonly imageEndpoints?: (modelId: string) => Response;
  readonly videos?: () => Response;
}

const EMPTY_LIST = (): Response => jsonResponse({ data: [] });

// Match by URL pathname, ignoring any query string: the language `/models`
// fetch carries `?sort=top-weekly`, and routing on the full URL would miss it.
const pathOf = (url: string): string => new URL(url).pathname;

/** Routes fixture responses by URL shape across the four catalog endpoints.
 * Missing list routes default to an empty `{ data: [] }` so a test can
 * exercise one endpoint without stubbing the others. */
export function routedFetch(routes: GatewayRouteTable): typeof globalThis.fetch {
  const listRoutes: Record<string, () => Response> = {
    [pathOf(`${TEST_GATEWAY_BASE_URL}/models`)]: routes.models ?? EMPTY_LIST,
    [pathOf(`${TEST_GATEWAY_BASE_URL}/endpoints/zdr`)]: routes.zdr ?? EMPTY_LIST,
    [pathOf(`${TEST_GATEWAY_BASE_URL}/images/models`)]: routes.images ?? EMPTY_LIST,
    [pathOf(`${TEST_GATEWAY_BASE_URL}/videos/models`)]: routes.videos ?? EMPTY_LIST,
  };
  return function routed(input: RequestInfo | URL): Promise<Response> {
    const url = new Request(input).url;
    const pathname = pathOf(url);
    const endpointsMatch = /\/images\/models\/(.+)\/endpoints$/.exec(pathname);
    if (endpointsMatch?.[1] !== undefined) {
      return routes.imageEndpoints === undefined
        ? Promise.reject(new Error(`routedFetch: no imageEndpoints route for ${url}`))
        : Promise.resolve(routes.imageEndpoints(endpointsMatch[1]));
    }
    const listRoute = listRoutes[pathname];
    return listRoute === undefined
      ? Promise.reject(new Error(`routedFetch: unrouted URL ${url}`))
      : Promise.resolve(listRoute());
  };
}

export interface CatalogFixture {
  readonly models?: unknown[];
  readonly zdrModelIds?: readonly string[];
  /** Explicit `/endpoints/zdr` rows, in place of the rows `zdrModelIds` implies. */
  readonly zdrRows?: readonly unknown[];
  readonly images?: unknown[];
  readonly imageEndpoints?: (modelId: string) => unknown;
  readonly videos?: unknown[];
}

/** Data-level convenience over `routedFetch`: build a catalog fetch from
 * model lists and the ZDR membership, defaulting every endpoint to empty. */
export function catalogFetch(fixture: CatalogFixture): typeof globalThis.fetch {
  return routedFetch({
    models: () => jsonResponse({ data: fixture.models ?? [] }),
    zdr: () =>
      jsonResponse(
        fixture.zdrRows === undefined
          ? zdrBody(fixture.zdrModelIds ?? [], fixture.models)
          : { data: fixture.zdrRows }
      ),
    images: () => jsonResponse({ data: fixture.images ?? [] }),
    imageEndpoints: (id) => jsonResponse(fixture.imageEndpoints?.(id) ?? imageEndpointsFixture()),
    videos: () => jsonResponse({ data: fixture.videos ?? [] }),
  });
}
