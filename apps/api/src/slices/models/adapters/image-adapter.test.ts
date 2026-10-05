import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { expectExposes } from '@hushbox/shared/test-assertions';
import { utcDayKey } from '@hushbox/shared';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { createImageAdapter, imageEstimateInputs } from './image-adapter.js';
import { createCassetteStore, type CassetteStore } from './cassette/cassette-store.js';
import { createCassetteFetch } from './cassette/recording-fetch.js';
import { createFixtureFetch } from './cassette/failure-fixtures.js';
import { IMAGE_FAILURE_FIXTURES } from './cassette/media-failure-fixtures.js';
import type {
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  MediaValue,
  ModelDescriptor,
} from '@hushbox/shared';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);
const FIXTURE_UTC_DAY = utcDayKey(new Date(TEST_DAY_START));

let rootDir: string;
let store: CassetteStore;

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), 'image-adapter-'));
  store = createCassetteStore({ rootDir });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function testDescriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return { ...unpinnedDescriptor(), zdrPin: ['google-vertex/global'], ...overrides };
}

/** The test descriptor with no pin, as a stored row written before pins existed. */
function unpinnedDescriptor(): ModelDescriptor {
  return {
    id: 'google/imagen-4.0-generate-001',
    provider: 'google',
    version: '1',
    inputs: ['text'],
    outputs: ['image'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: tokenPricingFixture({ input: 1n, output: 1n }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

/** A fetch that records each request body it is sent and answers a minimal `/images` 200. */
function captureFetch(): { readonly fetch: typeof globalThis.fetch; readonly bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetch: typeof globalThis.fetch = (_input, init) => {
    bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
    return Promise.resolve(jsonResponse(imageResponseBody()));
  };
  return { fetch, bodies };
}

function imageRequest(text: string, parameters: Record<string, unknown> = {}): InferenceRequest {
  return {
    model: 'google/imagen-4.0-generate-001',
    inputs: [{ modality: 'text', text }],
    parameters,
    outputs: ['image'],
    utcDay: FIXTURE_UTC_DAY,
  };
}

/** PNG signature bytes so the SDK's media-type sniffing is deterministic. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64');

/**
 * SYNTHETIC wire response: OpenRouter's `/images` JSON contract (`data` is an
 * array of `{ b64_json }`; no provider metadata), carrying no `usage.cost` unless
 * a test adds one, authored from the provider schema, not recorded from the live
 * provider (no credentials).
 */
function imageResponseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: [{ b64_json: PNG_BASE64 }],
    usage: { prompt_tokens: 13, completion_tokens: 1568, total_tokens: 1581 },
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return Response.json(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Serves each scripted response once, in order; throws when exhausted. */
function scriptedFetch(responses: (() => Response)[]): typeof globalThis.fetch {
  let next = 0;
  return function scripted(): Promise<Response> {
    const make = responses[next];
    next += 1;
    if (make === undefined) throw new Error(`scriptedFetch exhausted after ${String(next - 1)}`);
    return Promise.resolve(make());
  };
}

async function collect(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const mediaValue: MediaValue = {
  ref: 'media/conv/msg/uuid-1',
  mimeType: 'image/png',
  modality: 'image',
  byteLength: PNG_BYTES.byteLength,
  metadata: {},
};

const mapFilePart: FilePartMapper = (part, index) => [
  { kind: 'media-start', index, modality: 'image', mimeType: part.mediaType },
  { kind: 'media-done', index, value: mediaValue },
];

describe('createImageAdapter cassette replay', () => {
  it('maps a replayed image generation to the exact typed event sequence (no cost)', async () => {
    const recorder = createImageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => jsonResponse(imageResponseBody())]),
      }),
    });
    await collect(recorder.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }));
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const replayer = createImageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({ store, mode: 'replay-only' }),
    });
    const events = await collect(
      replayer.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart })
    );

    // The response names no generation id and no cost, so the finish carries neither.
    expect(events).toEqual([
      { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
      { kind: 'media-done', index: 0, value: mediaValue },
      {
        kind: 'finish',
        metadata: {
          usage: { inputTokens: 13, outputTokens: 1568 },
          finishReason: 'stop',
        },
      },
    ]);
  });
});

describe('createImageAdapter ZDR', () => {
  it('pins the call to the descriptor ZDR endpoints with fallbacks off', async () => {
    const capture = captureFetch();
    const adapter = createImageAdapter({ apiKey: 'test-key', fetch: capture.fetch });

    await collect(adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }));

    const body = z
      .looseObject({
        provider: z.looseObject({ only: z.array(z.string()), allow_fallbacks: z.boolean() }),
      })
      .parse(capture.bodies[0]);
    expect(body.provider.only).toEqual(['google-vertex/global']);
    expect(body.provider.allow_fallbacks).toBe(false);
  });

  it('sends no zdr field, which the Images API does not define', async () => {
    const capture = captureFetch();
    const adapter = createImageAdapter({ apiKey: 'test-key', fetch: capture.fetch });

    await collect(adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }));

    const body = z
      .looseObject({ provider: z.record(z.string(), z.unknown()) })
      .parse(capture.bodies[0]);
    expect('zdr' in body.provider).toBe(false);
    expect('zdr' in body).toBe(false);
  });

  it('refuses a descriptor without a pin before any request', () => {
    const capture = captureFetch();
    const adapter = createImageAdapter({ apiKey: 'test-key', fetch: capture.fetch });

    expect(() =>
      adapter.infer(imageRequest('A red fox'), unpinnedDescriptor(), { mapFilePart })
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
    expect(capture.bodies).toHaveLength(0);
  });

  it('refuses a ZDR-unreachable descriptor without calling the provider', () => {
    const adapter = createImageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    expect(() =>
      adapter.infer(imageRequest('A red fox'), testDescriptor({ zdrReachable: false }), {
        mapFilePart,
      })
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });
});

describe('createImageAdapter parameters', () => {
  it('wires n, size, and aspect_ratio onto the request body', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([
          () =>
            jsonResponse(
              imageResponseBody({ data: [{ b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }] })
            ),
        ]),
      }),
    });

    await collect(
      adapter.infer(
        imageRequest('A red fox', { n: 2, size: '1024x768', aspectRatio: '4:3' }),
        testDescriptor(),
        { mapFilePart }
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ n: 2, size: '1024x768', aspect_ratio: '4:3' });
  });

  it('wires resolution onto the request body', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => jsonResponse(imageResponseBody())]),
      }),
    });

    await collect(
      adapter.infer(imageRequest('A red fox', { resolution: '1K' }), testDescriptor(), {
        mapFilePart,
      })
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ resolution: '1K' });
  });

  it('rejects a parameter key the adapter cannot wire', async () => {
    const adapter = createImageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    await expect(
      collect(
        adapter.infer(imageRequest('A red fox', { steps: 50 }), testDescriptor(), { mapFilePart })
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });

  it('rejects a request whose model differs from the descriptor', () => {
    const adapter = createImageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    expect(() =>
      adapter.infer({ ...imageRequest('A red fox'), model: 'google/other' }, testDescriptor(), {
        mapFilePart,
      })
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });
});

describe('createImageAdapter returned cost', () => {
  it("carries the images API's returned usage.cost onto the finish", async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          jsonResponse(
            imageResponseBody({
              usage: {
                prompt_tokens: 13,
                completion_tokens: 1568,
                total_tokens: 1581,
                cost: 0.045,
              },
            })
          ),
      ]),
    });

    const events = await collect(
      adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart })
    );

    expect(events.at(-1)).toMatchObject({ kind: 'finish', metadata: { providerCostUsd: 0.045 } });
  });

  it.each([
    ['a negative', -0.045],
    ['a string', '0.045'],
  ])('carries no cost when usage.cost is %s', async (_shape, cost) => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          jsonResponse(
            imageResponseBody({
              usage: { prompt_tokens: 13, completion_tokens: 1568, total_tokens: 1581, cost },
            })
          ),
      ]),
    });

    const events = await collect(
      adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart })
    );

    expect(events.at(-1)).toMatchObject({ kind: 'finish' });
    expect(events.at(-1)).not.toHaveProperty('metadata.providerCostUsd');
  });

  it("sums the returned cost across a call's /images requests", async () => {
    // Twelve images exceed the SDK's ten-per-request limit, so the call makes two requests.
    const costed = (images: number) => (): Response =>
      jsonResponse(
        imageResponseBody({
          data: Array.from({ length: images }, () => ({ b64_json: PNG_BASE64 })),
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.045 },
        })
      );
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([costed(10), costed(2)]),
    });

    const events = await collect(
      adapter.infer(imageRequest('A red fox', { n: 12 }), testDescriptor(), { mapFilePart })
    );

    expect(events.at(-1)).toMatchObject({ kind: 'finish', metadata: { providerCostUsd: 0.09 } });
  });

  it("carries no cost when one of the call's /images requests returned none", async () => {
    const response = (cost?: number) => (): Response =>
      jsonResponse(
        imageResponseBody({
          data: Array.from({ length: cost === undefined ? 2 : 10 }, () => ({
            b64_json: PNG_BASE64,
          })),
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
            ...(cost === undefined ? {} : { cost }),
          },
        })
      );
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([response(0.045), response()]),
    });

    const events = await collect(
      adapter.infer(imageRequest('A red fox', { n: 12 }), testDescriptor(), { mapFilePart })
    );

    expect(events.at(-1)).toMatchObject({ kind: 'finish' });
    expect(events.at(-1)).not.toHaveProperty('metadata.providerCostUsd');
  });
});

describe('createImageAdapter result mapping', () => {
  it('defaults missing usage to zero and emits no generation id or cost', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => jsonResponse(imageResponseBody({ usage: undefined }))]),
    });

    const events = await collect(
      adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart })
    );

    expect(events.at(-1)).toEqual({
      kind: 'finish',
      metadata: {
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'stop',
      },
    });
  });

  it('propagates a generated file without a mapper contract as a defect', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => jsonResponse(imageResponseBody())]),
    });

    const consumed = collect(adapter.infer(imageRequest('A red fox'), testDescriptor()));

    await expect(consumed).rejects.toThrow(/mapFilePart/);
    await expect(consumed).rejects.toMatchObject({ name: 'AdapterDefect' });
  });
});

describe('createImageAdapter failure shapes', () => {
  it('classifies the no_providers_available fixture as the typed ZDR fail-closed error', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(IMAGE_FAILURE_FIXTURES.noProvidersAvailable),
    });

    await expect(
      collect(adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'no_providers_available' });
  });

  it('classifies the 429 fixture as rate_limited', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(IMAGE_FAILURE_FIXTURES.rateLimited),
    });

    await expect(
      collect(adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'rate_limited' });
  });

  it('classifies the malformed-response fixture as a typed upstream error', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(IMAGE_FAILURE_FIXTURES.malformedResponse),
    });

    await expect(
      collect(adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'upstream_error' });
  });

  it('classifies a 200 whose body is not JSON as a typed upstream error', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () => new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
      ]),
    });

    await expect(
      collect(adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'upstream_error' });
  });

  it('classifies an empty image list as an empty completion', async () => {
    const adapter = createImageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => jsonResponse(imageResponseBody({ data: [] }))]),
    });

    await expect(
      collect(adapter.infer(imageRequest('A red fox'), testDescriptor(), { mapFilePart }))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'empty_completion' });
  });
});

describe('createImageAdapter abort', () => {
  it('aborts the underlying provider fetch when the signal fires', async () => {
    let fetchedSignal: AbortSignal | undefined;
    const hangingFetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      fetchedSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };
    const adapter = createImageAdapter({ apiKey: 'test-key', fetch: hangingFetch });
    const controller = new AbortController();

    const consumed = collect(
      adapter.infer(imageRequest('A red fox'), testDescriptor(), {
        mapFilePart,
        signal: controller.signal,
      })
    );
    await vi.waitFor(() => {
      expect(fetchedSignal).toBeDefined();
    });
    controller.abort();

    await expect(consumed).rejects.toMatchObject({ name: 'InferenceError', code: 'aborted' });
    expect(fetchedSignal?.aborted).toBe(true);
  });
});

describe('createImageAdapter construction', () => {
  it('constructs a production adapter without a custom fetch', () => {
    expectExposes(createImageAdapter({ apiKey: 'test-key' }), 'infer');
  });
});

describe('imageEstimateInputs', () => {
  it('defaults to a single image when no parameters are declared', () => {
    expect(imageEstimateInputs(imageRequest('A red fox'))).toEqual({ n: 1 });
  });

  it('carries the declared count and dimensions', () => {
    expect(
      imageEstimateInputs(imageRequest('A red fox', { n: 3, size: '1024x768', aspectRatio: '4:3' }))
    ).toEqual({ n: 3, size: '1024x768', aspectRatio: '4:3' });
  });

  it('rejects a parameter key the adapter cannot wire', () => {
    expect(() => imageEstimateInputs(imageRequest('A red fox', { steps: 50 }))).toThrow(
      expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' })
    );
  });
});
