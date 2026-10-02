import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLASSIFIER_EFFORT_DIMENSION_MARKER,
  CLASSIFIER_MODEL_DIMENSION_MARKER,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  SMART_MODEL_ID,
  WEB_SEARCH_TOOL_NAME,
  createAssistantStream,
  createEnvUtilities,
  reduceAssistantStream,
  settleAssistantStream,
  utcDayKey,
} from '@hushbox/shared';
import { Mode, envConfig, resolveRaw } from '@hushbox/shared/env.config';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { runStartBodySchema } from '@hushbox/realtime/protocol';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import {
  MOCK_ECHO_JSON_FENCE,
  MOCK_ECHO_PREFIX,
  MOCK_GENERATION_COST_USD,
  MOCK_REASONING_TEXT,
  createMockModelProvider,
  mockDirectivesFor,
  mockProviderEnabled,
  parseMockDirectives,
  resolveMockDelays,
} from './mock-provider.js';
import { AdapterDefect } from './language-adapter.js';
import { MOCK_VIDEO_BYTES } from './mock-video-clip.js';
import { createFakeSearchProvider } from './fake-search-provider.js';
import { createToolRegistry } from '../domain/tool-registry.js';
import type {
  FilePart,
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  MockDirectives,
  ModelDescriptor,
  Segment,
  WebSearchResults,
} from '@hushbox/shared';
import type { z } from 'zod';
import type { VariableConfig } from '@hushbox/shared/env.config';
import type { InferOptions, SearchProvider, ToolLoopOptions } from '../ports/index.js';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);
const FIXTURE_UTC_DAY = utcDayKey(new Date(TEST_DAY_START));

/** A minimal language-family descriptor for the given model id. */
function languageDescriptor(id: string): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: tokenPricingFixture({ input: 1n, output: 1n }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

function textRequest(model: string, text: string): InferenceRequest {
  return {
    model,
    inputs: [{ modality: 'text', text }],
    parameters: {},
    outputs: ['text'],
    utcDay: FIXTURE_UTC_DAY,
  };
}

/** A classifier request: the system prompt (marker-prefixed) rides as the first input part. */
function classifierRequest(model: string): InferenceRequest {
  return {
    model,
    inputs: [
      { modality: 'text', text: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nchoose a model` },
      { modality: 'text', text: 'the latest exchange' },
    ],
    parameters: { maxOutputTokens: 32 },
    outputs: ['text'],
    utcDay: FIXTURE_UTC_DAY,
  };
}

async function collect(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** The full echo the mock streams for a prompt: prefix + prompt + trailing JSON fence. */
function echoOf(prompt: string): string {
  return `${MOCK_ECHO_PREFIX}\n${prompt}${MOCK_ECHO_JSON_FENCE}`;
}

function textOf(events: readonly InferenceEvent[]): string {
  return events
    .filter(
      (event): event is Extract<InferenceEvent, { kind: 'text-delta' }> =>
        event.kind === 'text-delta'
    )
    .map((event) => event.content)
    .join('');
}

function finishOf(events: readonly InferenceEvent[]): Extract<InferenceEvent, { kind: 'finish' }> {
  const finish = events.find(
    (event): event is Extract<InferenceEvent, { kind: 'finish' }> => event.kind === 'finish'
  );
  if (finish === undefined) throw new Error('expected a finish event');
  return finish;
}

/** An image-family descriptor for the given model id. */
function imageDescriptor(id: string): ModelDescriptor {
  return { ...languageDescriptor(id), outputs: ['image'] };
}

/** A video-family descriptor for the given model id. */
function videoDescriptor(id: string): ModelDescriptor {
  return { ...languageDescriptor(id), outputs: ['video'] };
}

/** A video row whose catalog entry declares a discrete duration domain. */
function constrainedVideoDescriptor(id: string): ModelDescriptor {
  return {
    ...videoDescriptor(id),
    parameters: {
      durationSeconds: { type: 'enum', values: [4, 6, 8], wire: 'providerOptions' },
    },
  };
}

function imageRequest(model: string): InferenceRequest {
  return {
    model,
    inputs: [{ modality: 'text', text: 'a cat' }],
    parameters: {},
    outputs: ['image'],
    utcDay: FIXTURE_UTC_DAY,
  };
}

function videoRequest(model: string, parameters: Record<string, unknown> = {}): InferenceRequest {
  return {
    model,
    inputs: [{ modality: 'text', text: 'a cat' }],
    parameters,
    outputs: ['video'],
    utcDay: FIXTURE_UTC_DAY,
  };
}

/**
 * A mapFilePart that records each FilePart the provider hands it (so tests can
 * assert the canned bytes/mime the mock produced) and maps it to the media
 * event pair exactly as the engine's real mapper would.
 */
function capturingMapper(modality: 'image' | 'video'): {
  readonly mapFilePart: FilePartMapper;
  readonly parts: FilePart[];
} {
  const parts: FilePart[] = [];
  const mapFilePart: FilePartMapper = (part, index) => {
    parts.push(part);
    return [
      { kind: 'media-start', index, modality, mimeType: part.mediaType },
      {
        kind: 'media-done',
        index,
        value: {
          ref: `mock-ref-${modality}-${String(index)}`,
          mimeType: part.mediaType,
          modality,
          byteLength: part.data.byteLength,
          metadata: {},
        },
      },
    ];
  };
  return { mapFilePart, parts };
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
/** The EBML magic every WebM container opens with. */
const EBML_SIGNATURE = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);

/** Read a big-endian uint32 from `bytes` at `offset` (PNG IHDR width/height). */
function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  );
}

// A grayscale (type-0) 400×300 PNG raster is 300 rows of [filterByte, ...400 px].
const PNG_WIDTH = 400;
const PNG_HEIGHT = 300;
const EXPECTED_RASTER_LENGTH = PNG_HEIGHT * (1 + PNG_WIDTH); // 120300

/** A single decoded PNG chunk with its stored CRC and the byte range it covers. */
interface PngChunk {
  readonly type: string;
  readonly data: Uint8Array;
  readonly storedCrc: number;
  /** type + data — the exact span the chunk CRC is computed over. */
  readonly crcInput: Uint8Array;
}

/** CRC32 (standard PNG polynomial 0xEDB88320), computed independently of the encoder. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xed_b8_83_20 : crc >>> 1;
    }
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/**
 * Split a PNG byte stream into its chunks (past the 8-byte signature). Bounds
 * every declared chunk length against the remaining bytes: a corrupt stream
 * whose length field overruns the buffer stops here rather than reading a
 * garbage multi-gigabyte "chunk" — the test must fail on a clean assertion,
 * never on an out-of-bounds allocation.
 */
function parsePngChunks(bytes: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = [];
  let offset = 8; // skip the signature
  while (offset + 12 <= bytes.length) {
    const length = readUint32BE(bytes, offset) >>> 0;
    if (offset + 12 + length > bytes.length) break; // declared length overruns the buffer
    const crcInput = bytes.subarray(offset + 4, offset + 8 + length); // type + data
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const storedCrc = readUint32BE(bytes, offset + 8 + length) >>> 0;
    const type = String.fromCodePoint(...bytes.subarray(offset + 4, offset + 8));
    chunks.push({ type, data, storedCrc, crcInput });
    offset += 12 + length;
  }
  return chunks;
}

describe('parseMockDirectives', () => {
  function getterFor(headers: Record<string, string>): (name: string) => string | undefined {
    return (name) => headers[name];
  }

  it('reads x-mock-classifier-resolution into classifierResolution', () => {
    const directives = parseMockDirectives(
      getterFor({ 'x-mock-classifier-resolution': 'a/model' })
    );
    expect(directives).toEqual({ classifierResolution: 'a/model' });
  });

  it('reads x-mock-classifier-effort into classifierEffort', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-classifier-effort': 'low' }));
    expect(directives).toEqual({ classifierEffort: 'low' });
  });

  it('reads x-mock-classifier-failure=true into classifierFailure', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-classifier-failure': 'true' }));
    expect(directives).toEqual({ classifierFailure: true });
  });

  it('ignores x-mock-classifier-failure when not exactly "true"', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-classifier-failure': '1' }));
    expect(directives).toEqual({});
  });

  it('splits x-mock-failing-models CSV into a trimmed non-empty list', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-failing-models': ' a/x , , b/y ' }));
    expect(directives).toEqual({ failingModels: ['a/x', 'b/y'] });
  });

  it('drops x-mock-failing-models when the CSV yields no ids', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-failing-models': ' , ' }));
    expect(directives).toEqual({});
  });

  it('reads a positive x-mock-classifier-delay-ms into classifierDelayMs', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-classifier-delay-ms': '250' }));
    expect(directives).toEqual({ classifierDelayMs: 250 });
  });

  it('ignores a non-positive or non-numeric classifier delay', () => {
    expect(parseMockDirectives(getterFor({ 'x-mock-classifier-delay-ms': '0' }))).toEqual({});
    expect(parseMockDirectives(getterFor({ 'x-mock-classifier-delay-ms': 'nope' }))).toEqual({});
  });

  it('reads positive x-mock-text-delay-ms / x-mock-media-delay-ms into the delay fields', () => {
    const directives = parseMockDirectives(
      getterFor({ 'x-mock-text-delay-ms': '40', 'x-mock-media-delay-ms': '2500' })
    );
    expect(directives).toEqual({ textDelayMs: 40, mediaDelayMs: 2500 });
  });

  it('ignores a non-positive or non-numeric text/media delay', () => {
    expect(parseMockDirectives(getterFor({ 'x-mock-text-delay-ms': '0' }))).toEqual({});
    expect(parseMockDirectives(getterFor({ 'x-mock-media-delay-ms': 'nope' }))).toEqual({});
  });

  it('reads x-mock-hold-primary-stream=true into holdPrimaryStream', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-hold-primary-stream': 'true' }));
    expect(directives).toEqual({ holdPrimaryStream: true });
  });

  it('ignores x-mock-hold-primary-stream when not exactly "true"', () => {
    expect(parseMockDirectives(getterFor({ 'x-mock-hold-primary-stream': '1' }))).toEqual({});
    expect(parseMockDirectives(getterFor({ 'x-mock-hold-primary-stream': 'false' }))).toEqual({});
  });

  it('reads a positive x-mock-hold-primary-stream-stride into holdPrimaryStreamStride', () => {
    const directives = parseMockDirectives(
      getterFor({ 'x-mock-hold-primary-stream': 'true', 'x-mock-hold-primary-stream-stride': '3' })
    );
    expect(directives).toEqual({ holdPrimaryStream: true, holdPrimaryStreamStride: 3 });
  });

  it('ignores a non-positive or non-numeric hold stride', () => {
    expect(parseMockDirectives(getterFor({ 'x-mock-hold-primary-stream-stride': '0' }))).toEqual(
      {}
    );
    expect(parseMockDirectives(getterFor({ 'x-mock-hold-primary-stream-stride': 'nope' }))).toEqual(
      {}
    );
  });

  it('combines all four knobs from one request', () => {
    const directives = parseMockDirectives(
      getterFor({
        'x-mock-classifier-resolution': 'a/model',
        'x-mock-classifier-failure': 'true',
        'x-mock-failing-models': 'c/z',
        'x-mock-classifier-delay-ms': '10',
      })
    );
    expect(directives).toEqual({
      classifierResolution: 'a/model',
      classifierFailure: true,
      failingModels: ['c/z'],
      classifierDelayMs: 10,
    });
  });

  it('returns an empty directive set when no headers are present', () => {
    expect(parseMockDirectives(getterFor({}))).toEqual({});
  });

  it('reads a positive x-mock-web-search-count into webSearchCount', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-web-search-count': '2' }));
    expect(directives).toEqual({ webSearchCount: 2 });
  });

  it('ignores a non-positive or non-numeric web search count', () => {
    expect(parseMockDirectives(getterFor({ 'x-mock-web-search-count': '0' }))).toEqual({});
    expect(parseMockDirectives(getterFor({ 'x-mock-web-search-count': 'nope' }))).toEqual({});
  });

  it('reads x-mock-web-search-after-text=true into webSearchAfterText', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-web-search-after-text': 'true' }));
    expect(directives).toEqual({ webSearchAfterText: true });
  });

  it('ignores x-mock-web-search-after-text when not exactly "true"', () => {
    expect(parseMockDirectives(getterFor({ 'x-mock-web-search-after-text': '1' }))).toEqual({});
    expect(parseMockDirectives(getterFor({ 'x-mock-web-search-after-text': 'false' }))).toEqual({});
  });
});

describe('the web search directives on their way to the mock', () => {
  /** The run-start body the chat route posts to the room, before its directives are added. */
  const trialBody: z.input<typeof runStartBodySchema> = {
    mode: 'trial',
    runKey: 'key-1',
    bodyHash: 'body-hash-1',
    definition: {
      version: 1,
      deadlineClass: 'text',
      hooks: { admission: 'chatAdmission', settlement: 'chatSettlement' },
      nodes: [
        {
          id: 'n1',
          version: 1,
          out: 'out',
          type: 'modelCall',
          model: 'test-model',
          params: {},
          in: { node: 'n1', port: 'in' },
        },
      ],
      edges: [],
    },
    inputs: { prompt: { kind: 'text', text: 'hi' } },
    sessionId: 'session-1',
  };

  it('survives the chat route header parse and the room run-start validation', () => {
    const headers = new Headers({
      'X-Mock-Web-Search-Count': '2',
      'X-Mock-Web-Search-After-Text': 'true',
    });
    const mockDirectives = parseMockDirectives((name) => headers.get(name) ?? undefined);
    const wire = JSON.stringify({ ...trialBody, mockDirectives });

    const parsed = runStartBodySchema.safeParse(JSON.parse(wire));

    expect(parsed.success && parsed.data.mockDirectives).toEqual({
      webSearchCount: 2,
      webSearchAfterText: true,
    });
  });
});

describe('mockProviderEnabled / mockDirectivesFor', () => {
  const headers = { 'x-mock-classifier-resolution': 'a/model' };
  const get = (name: string): string | undefined => (headers as Record<string, string>)[name];

  it('is enabled in local dev and E2E, disabled otherwise', () => {
    expect(mockProviderEnabled({ isLocalDev: true, isE2E: false, isProduction: false })).toBe(true);
    expect(mockProviderEnabled({ isLocalDev: false, isE2E: true, isProduction: false })).toBe(true);
    expect(mockProviderEnabled({ isLocalDev: false, isE2E: false, isProduction: false })).toBe(
      false
    );
  });

  it('stays false in production even if a spurious E2E flag leaks in', () => {
    expect(mockProviderEnabled({ isLocalDev: false, isE2E: true, isProduction: true })).toBe(false);
    expect(mockProviderEnabled({ isLocalDev: true, isE2E: false, isProduction: true })).toBe(false);
  });

  it('parses directives when the mock is enabled (dev/E2E)', () => {
    expect(mockDirectivesFor({ isLocalDev: true, isE2E: false, isProduction: false }, get)).toEqual(
      {
        classifierResolution: 'a/model',
      }
    );
  });

  it('is inert when the mock is disabled — headers are never read (production/CI)', () => {
    expect(
      mockDirectivesFor({ isLocalDev: false, isE2E: false, isProduction: false }, get)
    ).toEqual({});
  });
});

describe('createMockModelProvider — language echo', () => {
  it('echoes the prompt as streamed text with a billable finish', async () => {
    const provider = createMockModelProvider();
    const events = await collect(
      provider.infer(textRequest('a/model', 'hello'), languageDescriptor('a/model'))
    );
    expect(textOf(events)).toBe(echoOf('hello'));
    const finish = finishOf(events);
    expect(finish.metadata.finishReason).toBe('stop');
    // The inline provider cost makes settlement bill authoritative (not estimated).
    expect(finish.metadata.providerCostUsd).toBeGreaterThan(0);
    expect(finish.metadata.generationId).toBeDefined();
  });

  it('names itself as the endpoint that served the echo', async () => {
    const provider = createMockModelProvider();
    const events = await collect(
      provider.infer(textRequest('a/model', 'hello'), languageDescriptor('a/model'))
    );
    expect(finishOf(events).metadata.servedBy).toBe('mock');
  });

  it('keeps a leading code fence at column 0 so the echoed block round-trips intact', async () => {
    // Mock-fidelity contract: the mock must not corrupt the *shape* prod would
    // produce. A prompt that begins with a CommonMark fence must echo back with
    // that fence still at column 0 (a mid-line ``` is not a fence opener), so a
    // 15-line fenced block stays extraction-eligible downstream.
    const fencedLines = [
      '```python',
      ...Array.from({ length: 13 }, (_, index) => `line_${String(index + 1)} = ${String(index)}`),
      '```',
    ];
    const prompt = fencedLines.join('\n');
    const provider = createMockModelProvider();
    const events = await collect(
      provider.infer(textRequest('a/model', prompt), languageDescriptor('a/model'))
    );
    const text = textOf(events);
    // The full echo is `Echo:\n<prompt><trailing json fence>`.
    expect(text).toBe(echoOf(prompt));
    const lines = text.split('\n');
    // The prompt's python block round-trips verbatim, opener/closer at column 0,
    // starting right after the `Echo:` prefix line.
    expect(lines.slice(1, 1 + fencedLines.length)).toEqual(fencedLines);
  });

  it('appends a trailing fenced JSON block to the echo (streamdown incomplete-markdown path)', async () => {
    const provider = createMockModelProvider();
    const events = await collect(
      provider.infer(textRequest('a/model', 'hi'), languageDescriptor('a/model'))
    );
    const text = textOf(events);
    expect(text.endsWith('```json\n{\n  "ok": true\n}\n```')).toBe(true);
    expect(text).toBe(echoOf('hi'));
  });

  it('never splits a multi-code-unit grapheme across chunk boundaries', async () => {
    // A ZWJ family emoji is a single grapheme spanning many UTF-16 code units;
    // a naive index-based slice would sever it. Grapheme segmentation must not.
    const prompt = `family 👨‍👩‍👧‍👦 and flag 🇺🇸 done`;
    const provider = createMockModelProvider();
    const events = await collect(
      provider.infer(textRequest('a/model', prompt), languageDescriptor('a/model'))
    );
    const deltas = events.filter(
      (event): event is Extract<InferenceEvent, { kind: 'text-delta' }> =>
        event.kind === 'text-delta'
    );
    const content = echoOf(prompt);
    // Every grapheme-cluster boundary (in code-unit offsets) is a legal chunk edge.
    const boundaries = new Set<number>([0]);
    let accumulator = 0;
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      content
    )) {
      accumulator += segment.length;
      boundaries.add(accumulator);
    }
    let cumulative = 0;
    for (const delta of deltas) {
      cumulative += delta.content.length;
      expect(boundaries.has(cumulative)).toBe(true);
    }
    // Sanity: the deltas still reconstitute the whole echo, and there is >1 chunk.
    expect(deltas.map((delta) => delta.content).join('')).toBe(content);
    expect(deltas.length).toBeGreaterThan(1);
  });

  it('emits reasoning deltas before the echo text when the request carries reasoning config', async () => {
    const provider = createMockModelProvider();
    const request: InferenceRequest = {
      ...textRequest('a/model', 'hi'),
      parameters: { reasoning: { effort: 'low' } },
    };

    const events = await collect(provider.infer(request, languageDescriptor('a/model')));

    const reasoningIndexes = events
      .map((event, index) => (event.kind === 'reasoning-delta' ? index : -1))
      .filter((index) => index >= 0);
    expect(reasoningIndexes.length).toBeGreaterThan(1);
    const firstTextIndex = events.findIndex((event) => event.kind === 'text-delta');
    expect(Math.max(...reasoningIndexes)).toBeLessThan(firstTextIndex);
    const reasoningContent = events
      .filter((event): event is Extract<InferenceEvent, { kind: 'reasoning-delta' }> => {
        return event.kind === 'reasoning-delta';
      })
      .map((event) => event.content)
      .join('');
    expect(reasoningContent).toBe(MOCK_REASONING_TEXT);
    expect(textOf(events)).toBe(echoOf('hi'));
  });

  it('carries reasoningTokens > 0 on the finish usage when reasoning config is present', async () => {
    const provider = createMockModelProvider();
    const request: InferenceRequest = {
      ...textRequest('a/model', 'hi'),
      parameters: { reasoning: { max_tokens: 2048 } },
    };

    const finish = finishOf(await collect(provider.infer(request, languageDescriptor('a/model'))));

    expect(finish.metadata.usage.reasoningTokens ?? 0).toBeGreaterThan(0);
    expect(finish.metadata.providerCostUsd).toBeGreaterThan(0);
  });

  it('emits no reasoning events and no reasoningTokens without reasoning config', async () => {
    const provider = createMockModelProvider();

    const events = await collect(
      provider.infer(textRequest('a/model', 'hi'), languageDescriptor('a/model'))
    );

    expect(events.some((event) => event.kind === 'reasoning-delta')).toBe(false);
    expect(finishOf(events).metadata.usage.reasoningTokens).toBeUndefined();
  });

  it('emits no reasoning deltas and no reasoningTokens under the hard-off wire', async () => {
    const provider = createMockModelProvider();
    const request: InferenceRequest = {
      ...textRequest('a/model', 'hi'),
      parameters: { reasoning: { enabled: false } },
    };

    const events = await collect(provider.infer(request, languageDescriptor('a/model')));

    expect(events.some((event) => event.kind === 'reasoning-delta')).toBe(false);
    expect(finishOf(events).metadata.usage.reasoningTokens).toBeUndefined();
    expect(textOf(events)).toBe(echoOf('hi'));
  });

  it('mints a distinct generation id per call', async () => {
    const provider = createMockModelProvider();
    const first = finishOf(
      await collect(provider.infer(textRequest('a/model', 'one'), languageDescriptor('a/model')))
    );
    const second = finishOf(
      await collect(provider.infer(textRequest('a/model', 'two'), languageDescriptor('a/model')))
    );
    expect(first.metadata.generationId).not.toBe(second.metadata.generationId);
  });
});

describe('createMockModelProvider — holdPrimaryStream', () => {
  /** A manually-drivable release gate: the promise the provider awaits + its resolver. */
  function releaseGate(): { readonly await: () => Promise<void>; readonly release: () => void } {
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    return {
      await: () => gate,
      release: () => {
        resolveGate();
      },
    };
  }

  /**
   * Pull events until one pull stops settling — the park. Returns what arrived
   * before it plus the still-pending pull, so a caller asserts on the phase the
   * stream is held in without timing how long it took to get there.
   */
  async function drainUntilParked(iterator: AsyncIterator<InferenceEvent>): Promise<{
    readonly events: InferenceEvent[];
    readonly pending: Promise<IteratorResult<InferenceEvent>>;
  }> {
    const events: InferenceEvent[] = [];
    for (;;) {
      const pull = iterator.next();
      const settled = await Promise.race([
        pull.then(() => true),
        new Promise<false>((resolve) => {
          setTimeout(() => {
            resolve(false);
          }, 20);
        }),
      ]);
      if (!settled) return { events, pending: pull };
      const result = await pull;
      if (result.done === true) return { events, pending: pull };
      events.push(result.value);
    }
  }

  /** A language request carrying an ACTIVE reasoning wire, so the mock thinks first. */
  function reasoningRequest(model: string, text: string): InferenceRequest {
    return { ...textRequest(model, text), parameters: { reasoning: { effort: 'low' } } };
  }

  it('emits the first echo chunk then parks the stream until released', async () => {
    const gate = releaseGate();
    const provider = createMockModelProvider({ holdPrimaryStream: true }, gate.await);
    const iterator = provider
      .infer(textRequest('a/model', 'hello there'), languageDescriptor('a/model'))
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ kind: 'text-delta', index: 0 });

    // The stream is parked at the release await: the next pull does not settle.
    let settled = false;
    const secondPull = (async () => {
      const result = await iterator.next();
      settled = true;
      return result;
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    gate.release();
    await secondPull;
    expect(settled).toBe(true);
  });

  it('resumes to the same complete echo + billable finish once released', async () => {
    const gate = releaseGate();
    const provider = createMockModelProvider({ holdPrimaryStream: true }, gate.await);
    const stream = provider.infer(
      textRequest('a/model', 'hello there'),
      languageDescriptor('a/model')
    );
    // Release before draining: the whole stream is then equivalent to the unheld echo.
    gate.release();
    const events = await collect(stream);
    expect(textOf(events)).toBe(echoOf('hello there'));
    expect(finishOf(events).metadata.finishReason).toBe('stop');
  });

  it('ends a parked stream as aborted once its signal fires, unreleased', async () => {
    const gate = releaseGate();
    const controller = new AbortController();
    const provider = createMockModelProvider({ holdPrimaryStream: true }, gate.await);
    const iterator = provider
      .infer(textRequest('a/model', 'hello there'), languageDescriptor('a/model'), {
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    const { pending } = await drainUntilParked(iterator);
    controller.abort();
    const ended = await Promise.race([
      pending.then(
        () => 'continued',
        (error: unknown) => error
      ),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve('still parked');
        }, 100);
      }),
    ]);
    expect(ended).toMatchObject({ name: 'InferenceError', code: 'aborted' });
  });

  it('ends a stream as aborted at its first pull when its signal fired before the call', async () => {
    const controller = new AbortController();
    controller.abort();
    const iterator = createMockModelProvider()
      .infer(textRequest('a/model', 'hello there'), languageDescriptor('a/model'), {
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'InferenceError',
      code: 'aborted',
    });
  });

  it('ends an unheld stream as aborted at the event after its signal fires', async () => {
    const controller = new AbortController();
    const iterator = createMockModelProvider()
      .infer(textRequest('a/model', 'hello there'), languageDescriptor('a/model'), {
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'InferenceError',
      code: 'aborted',
    });
  });

  it('does not hold when the directive is set but no release awaitable is wired', async () => {
    const provider = createMockModelProvider({ holdPrimaryStream: true });
    const events = await collect(
      provider.infer(textRequest('a/model', 'hello there'), languageDescriptor('a/model'))
    );
    expect(textOf(events)).toBe(echoOf('hello there'));
    expect(finishOf(events).metadata.finishReason).toBe('stop');
  });

  it('streams instantly with no directive even when a release awaitable is present', async () => {
    const gate = releaseGate();
    const provider = createMockModelProvider({}, gate.await);
    const events = await collect(
      provider.infer(textRequest('a/model', 'hello there'), languageDescriptor('a/model'))
    );
    expect(textOf(events)).toBe(echoOf('hello there'));
  });

  it('parks before the first answer delta when the request carries reasoning config', async () => {
    const gate = releaseGate();
    const provider = createMockModelProvider({ holdPrimaryStream: true }, gate.await);
    const iterator = provider
      .infer(reasoningRequest('a/model', 'hello there'), languageDescriptor('a/model'))
      [Symbol.asyncIterator]();

    const parked = await drainUntilParked(iterator);

    expect(parked.events.every((event) => event.kind === 'reasoning-delta')).toBe(true);
    expect(
      parked.events
        .filter((event): event is Extract<InferenceEvent, { kind: 'reasoning-delta' }> => {
          return event.kind === 'reasoning-delta';
        })
        .map((event) => event.content)
        .join('')
    ).toBe(MOCK_REASONING_TEXT);

    gate.release();
    await parked.pending;
  });

  it('resumes a parked reasoning stream to the same complete echo + billable finish', async () => {
    const gate = releaseGate();
    const provider = createMockModelProvider({ holdPrimaryStream: true }, gate.await);
    const iterator = provider
      .infer(reasoningRequest('a/model', 'hello there'), languageDescriptor('a/model'))
      [Symbol.asyncIterator]();
    const parked = await drainUntilParked(iterator);

    gate.release();
    const events = [...parked.events];
    for (let next = await parked.pending; next.done !== true; next = await iterator.next()) {
      events.push(next.value);
    }

    expect(textOf(events)).toBe(echoOf('hello there'));
    const finish = finishOf(events);
    expect(finish.metadata.finishReason).toBe('stop');
    expect(finish.metadata.usage.reasoningTokens ?? 0).toBeGreaterThan(0);
  });

  /**
   * A gate that re-arms on every release, so one stream can park against it
   * repeatedly; `parks` counts the parks the stream has reached.
   */
  function reArmingGate(): {
    readonly await: () => Promise<void>;
    readonly release: () => void;
    readonly parks: number;
  } {
    let resolveGate!: () => void;
    let gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const control = {
      parks: 0,
      await: async (): Promise<void> => {
        control.parks += 1;
        await gate;
      },
      release: (): void => {
        const free = resolveGate;
        gate = new Promise<void>((resolve) => {
          resolveGate = resolve;
        });
        free();
      },
    };
    return control;
  }

  /** Long enough that the echo spans several chunks, so several parks fit in it. */
  const MULTI_CHUNK_PROMPT = 'multi park prompt '.repeat(8);

  it('parks again after every stride of further chunks', async () => {
    const gate = reArmingGate();
    const provider = createMockModelProvider(
      { holdPrimaryStream: true, holdPrimaryStreamStride: 1 },
      gate.await
    );
    const iterator = provider
      .infer(textRequest('a/model', MULTI_CHUNK_PROMPT), languageDescriptor('a/model'))
      [Symbol.asyncIterator]();

    const events: InferenceEvent[] = [];
    let parked = await drainUntilParked(iterator);
    events.push(...parked.events);
    expect(parked.events).toHaveLength(1);
    expect(gate.parks).toBe(1);

    // Each release lets exactly the stride through and the stream parks again.
    for (let release = 1; release <= 3; release += 1) {
      gate.release();
      const resumed = await parked.pending;
      expect(resumed.done).toBe(false);
      if (resumed.done !== true) events.push(resumed.value);
      parked = await drainUntilParked(iterator);
      expect(parked.events).toHaveLength(0);
      expect(gate.parks).toBe(release + 1);
    }
    expect(gate.parks).toBeGreaterThanOrEqual(4);
    expect(textOf(events)).toBe(echoOf(MULTI_CHUNK_PROMPT).slice(0, textOf(events).length));
    expect(events).toHaveLength(4);
  });

  it('streams the same complete echo across an arbitrary number of parks', async () => {
    const gate = reArmingGate();
    const provider = createMockModelProvider(
      { holdPrimaryStream: true, holdPrimaryStreamStride: 2 },
      gate.await
    );
    const iterator = provider
      .infer(textRequest('a/model', MULTI_CHUNK_PROMPT), languageDescriptor('a/model'))
      [Symbol.asyncIterator]();

    const events: InferenceEvent[] = [];
    for (let parked = await drainUntilParked(iterator); ; ) {
      events.push(...parked.events);
      gate.release();
      const resumed = await parked.pending;
      if (resumed.done === true) break;
      events.push(resumed.value);
      parked = await drainUntilParked(iterator);
    }

    expect(gate.parks).toBeGreaterThanOrEqual(3);
    expect(textOf(events)).toBe(echoOf(MULTI_CHUNK_PROMPT));
    expect(finishOf(events).metadata.finishReason).toBe('stop');
  });

  /** A stride wide enough that a release is several chunks, and narrow enough to park often. */
  const REASONING_STRIDE = 2;

  it('parks a reasoning turn under a stride before any answer chunk is emitted', async () => {
    const gate = reArmingGate();
    const provider = createMockModelProvider(
      { holdPrimaryStream: true, holdPrimaryStreamStride: REASONING_STRIDE },
      gate.await
    );
    const iterator = provider
      .infer(reasoningRequest('a/model', MULTI_CHUNK_PROMPT), languageDescriptor('a/model'))
      [Symbol.asyncIterator]();

    const parked = await drainUntilParked(iterator);

    // The whole trace has streamed and no answer chunk has been spent: a
    // reasoning turn reaches its first park with every chunk still ahead of it,
    // which is what makes its release budget differ from a plain turn's.
    expect(gate.parks).toBe(1);
    expect(textOf(parked.events)).toBe('');
    expect(parked.events.every((event) => event.kind === 'reasoning-delta')).toBe(true);
  });

  it('lets exactly the stride through per release on a reasoning turn', async () => {
    const gate = reArmingGate();
    const provider = createMockModelProvider(
      { holdPrimaryStream: true, holdPrimaryStreamStride: REASONING_STRIDE },
      gate.await
    );
    const iterator = provider
      .infer(reasoningRequest('a/model', MULTI_CHUNK_PROMPT), languageDescriptor('a/model'))
      [Symbol.asyncIterator]();

    let parked = await drainUntilParked(iterator);
    for (let release = 1; release <= 3; release += 1) {
      gate.release();
      const resumed = await parked.pending;
      expect(resumed.done).toBe(false);
      const arrived: InferenceEvent[] = resumed.done === true ? [] : [resumed.value];
      parked = await drainUntilParked(iterator);
      arrived.push(...parked.events);

      expect(arrived.filter((event) => event.kind === 'text-delta')).toHaveLength(REASONING_STRIDE);
      expect(gate.parks).toBe(release + 1);
    }
  });

  it('drains the whole remainder on the single park when no stride is given', async () => {
    const gate = reArmingGate();
    const provider = createMockModelProvider({ holdPrimaryStream: true }, gate.await);
    const iterator = provider
      .infer(textRequest('a/model', MULTI_CHUNK_PROMPT), languageDescriptor('a/model'))
      [Symbol.asyncIterator]();

    const parked = await drainUntilParked(iterator);
    gate.release();
    const events = [...parked.events];
    for (let next = await parked.pending; next.done !== true; next = await iterator.next()) {
      events.push(next.value);
    }

    expect(gate.parks).toBe(1);
    expect(textOf(events)).toBe(echoOf(MULTI_CHUNK_PROMPT));
    expect(finishOf(events).metadata.finishReason).toBe('stop');
  });

  describe('a search turn', () => {
    /** The searches each held turn asks for, more than one so "every tool-call" means something. */
    const SEARCHES = 2;

    /** The same turn run unheld, with nothing wired to park on: what a held run must add up to. */
    async function unheldSearchTurn(request: InferenceRequest): Promise<InferenceEvent[]> {
      return collect(
        createMockModelProvider({ webSearchCount: SEARCHES }).infer(
          request,
          languageDescriptor('m'),
          { tools: searchLoop(recordingFakeSearch().search) }
        )
      );
    }

    const HELD_SEARCH_TURNS: readonly {
      readonly turn: string;
      readonly request: InferenceRequest;
      readonly directives: MockDirectives;
    }[] = [
      { turn: 'without reasoning', request: textRequest('m', 'find it'), directives: {} },
      { turn: 'with reasoning', request: reasoningRequest('m', 'find it'), directives: {} },
      {
        turn: 'with webSearchAfterText',
        request: textRequest('m', 'find it'),
        directives: { webSearchAfterText: true },
      },
    ];

    it.each(HELD_SEARCH_TURNS)(
      'parks $turn after its tool-calls, ahead of any tool-result',
      async ({ request, directives }) => {
        const gate = reArmingGate();
        const provider = createMockModelProvider(
          { webSearchCount: SEARCHES, holdPrimaryStream: true, ...directives },
          gate.await
        );
        const iterator = provider
          .infer(request, languageDescriptor('m'), {
            tools: searchLoop(recordingFakeSearch().search),
          })
          [Symbol.asyncIterator]();

        const parked = await drainUntilParked(iterator);

        expect(gate.parks).toBe(1);
        expect(eventsOfKind(parked.events, 'tool-call')).toHaveLength(SEARCHES);
        expect(parked.events.at(-1)?.kind).toBe('tool-call');
        expect(eventsOfKind(parked.events, 'tool-result')).toEqual([]);
        expect(eventsOfKind(parked.events, 'tool-error')).toEqual([]);
        gate.release();
        await parked.pending;
      }
    );

    it('lets the rest of the turn through on its one release, finishing the run', async () => {
      const gate = reArmingGate();
      const request = textRequest('m', 'find it');
      const provider = createMockModelProvider(
        { webSearchCount: SEARCHES, holdPrimaryStream: true },
        gate.await
      );
      const iterator = provider
        .infer(request, languageDescriptor('m'), {
          tools: searchLoop(recordingFakeSearch().search),
        })
        [Symbol.asyncIterator]();

      const parked = await drainUntilParked(iterator);
      gate.release();
      const events = [...parked.events];
      for (let next = await parked.pending; next.done !== true; next = await iterator.next()) {
        events.push(next.value);
      }

      expect(gate.parks).toBe(1);
      expect(events).toEqual(await unheldSearchTurn(request));
    });

    /** How far one release carries a strided search turn's answer. */
    const SEARCH_STRIDE = 3;

    /**
     * Walks a held search turn under {@link SEARCH_STRIDE}, releasing each park
     * until the finish arrives: what came before the first release, what each
     * release let through, and the pull left once the finish had arrived.
     */
    async function walkStridedSearchTurn(request: InferenceRequest): Promise<{
      readonly beforeFirstRelease: readonly InferenceEvent[];
      readonly arrivals: readonly (readonly InferenceEvent[])[];
      readonly afterFinish: Promise<IteratorResult<InferenceEvent>>;
    }> {
      const gate = reArmingGate();
      const provider = createMockModelProvider(
        {
          webSearchCount: SEARCHES,
          holdPrimaryStream: true,
          holdPrimaryStreamStride: SEARCH_STRIDE,
        },
        gate.await
      );
      const iterator = provider
        .infer(request, languageDescriptor('m'), {
          tools: searchLoop(recordingFakeSearch().search),
        })
        [Symbol.asyncIterator]();

      let parked = await drainUntilParked(iterator);
      const beforeFirstRelease = parked.events;
      const arrivals: InferenceEvent[][] = [];
      while (!arrivals.at(-1)?.some((event) => event.kind === 'finish')) {
        gate.release();
        const resumed = await parked.pending;
        if (resumed.done === true) throw new Error('a release found the stream already ended');
        parked = await drainUntilParked(iterator);
        arrivals.push([resumed.value, ...parked.events]);
      }
      return { beforeFirstRelease, arrivals, afterFinish: parked.pending };
    }

    it('parks its answer text again after every stride of chunks', async () => {
      const walk = await walkStridedSearchTurn(textRequest('m', MULTI_CHUNK_PROMPT));

      const released = walk.arrivals.slice(0, -1);
      expect(released.length).toBeGreaterThanOrEqual(2);
      expect(released.map((arrived) => eventsOfKind(arrived, 'text-delta').length)).toEqual(
        released.map(() => SEARCH_STRIDE)
      );
    });

    it('finishes the run on its last release under a stride', async () => {
      const request = textRequest('m', MULTI_CHUNK_PROMPT);
      const walk = await walkStridedSearchTurn(request);

      const last = walk.arrivals.at(-1) ?? [];
      expect(eventsOfKind(last, 'text-delta').length).toBeGreaterThan(0);
      expect(last.at(-1)?.kind).toBe('finish');
      await expect(walk.afterFinish).resolves.toMatchObject({ done: true });
      expect([...walk.beforeFirstRelease, ...walk.arrivals.flat()]).toEqual(
        await unheldSearchTurn(request)
      );
    });

    it('streams unparked when a release is wired but the run does not hold', async () => {
      let parks = 0;
      const provider = createMockModelProvider({ webSearchCount: SEARCHES }, () => {
        parks += 1;
        return Promise.resolve();
      });

      const events = await collect(
        provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
          tools: searchLoop(recordingFakeSearch().search),
        })
      );

      expect(parks).toBe(0);
      expect(events).toEqual(await unheldSearchTurn(textRequest('m', 'find it')));
    });
  });
});

describe('createMockModelProvider — failing-models knob', () => {
  it('throws a typed InferenceError for a listed failing model', async () => {
    const provider = createMockModelProvider({ failingModels: ['bad/model'] });
    await expect(
      collect(provider.infer(textRequest('bad/model', 'hi'), languageDescriptor('bad/model')))
    ).rejects.toMatchObject({ name: 'InferenceError' });
  });

  it('lets an unlisted model succeed while a listed one fails', async () => {
    const provider = createMockModelProvider({ failingModels: ['bad/model'] });
    const ok = await collect(
      provider.infer(textRequest('good/model', 'hi'), languageDescriptor('good/model'))
    );
    expect(textOf(ok)).toBe(echoOf('hi'));
    await expect(
      collect(provider.infer(textRequest('bad/model', 'hi'), languageDescriptor('bad/model')))
    ).rejects.toMatchObject({ name: 'InferenceError' });
  });

  it('throws the same typed InferenceError for a listed failing image model', async () => {
    const provider = createMockModelProvider({ failingModels: ['bad/image'] });
    const { mapFilePart } = capturingMapper('image');
    await expect(
      collect(
        provider.infer(imageRequest('bad/image'), imageDescriptor('bad/image'), { mapFilePart })
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'upstream_error' });
  });

  it('throws the same typed InferenceError for a listed failing video model', async () => {
    const provider = createMockModelProvider({ failingModels: ['bad/video'] });
    const { mapFilePart } = capturingMapper('video');
    await expect(
      collect(
        provider.infer(videoRequest('bad/video'), videoDescriptor('bad/video'), { mapFilePart })
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'upstream_error' });
  });

  it('throws the same typed InferenceError for a listed failing language model', async () => {
    const provider = createMockModelProvider({ failingModels: ['bad/model'] });
    await expect(
      collect(provider.infer(textRequest('bad/model', 'hi'), languageDescriptor('bad/model')))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'upstream_error' });
  });

  it('fails a listed video model without requiring a supported duration', async () => {
    const provider = createMockModelProvider({ failingModels: ['vid/constrained'] });
    const { mapFilePart } = capturingMapper('video');
    await expect(
      collect(
        provider.infer(
          videoRequest('vid/constrained', { durationSeconds: 5 }),
          constrainedVideoDescriptor('vid/constrained'),
          { mapFilePart }
        )
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'upstream_error' });
  });

  it('lets an unlisted image model succeed while another is listed', async () => {
    const provider = createMockModelProvider({ failingModels: ['bad/image'] });
    const { mapFilePart } = capturingMapper('image');
    const events = await collect(
      provider.infer(imageRequest('img/model'), imageDescriptor('img/model'), { mapFilePart })
    );
    expect(events.map((event) => event.kind)).toEqual(['media-start', 'media-done', 'finish']);
  });

  it('lets an unlisted video model succeed while another is listed', async () => {
    const provider = createMockModelProvider({ failingModels: ['bad/video'] });
    const { mapFilePart } = capturingMapper('video');
    const events = await collect(
      provider.infer(videoRequest('vid/model'), videoDescriptor('vid/model'), { mapFilePart })
    );
    expect(events.map((event) => event.kind)).toEqual(['media-start', 'media-done', 'finish']);
  });

  it('refuses the smart-model sentinel ahead of the failing-models check', async () => {
    const provider = createMockModelProvider({ failingModels: [SMART_MODEL_ID] });
    await expect(
      collect(provider.infer(textRequest(SMART_MODEL_ID, 'hi'), languageDescriptor(SMART_MODEL_ID)))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });

  it('still refuses an unsupported modality for a listed failing model', async () => {
    const provider = createMockModelProvider({ failingModels: ['audio/model'] });
    const audioDescriptor: ModelDescriptor = {
      ...languageDescriptor('audio/model'),
      outputs: ['audio'],
    };
    await expect(
      collect(provider.infer(textRequest('audio/model', 'hi'), audioDescriptor))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'unsupported_modality' });
  });

  it('still routes a classifier call for a listed failing model to the classifier', async () => {
    const provider = createMockModelProvider({
      failingModels: ['cheap/model'],
      classifierResolution: 'picked/model',
    });
    const events = await collect(
      provider.infer(classifierRequest('cheap/model'), languageDescriptor('cheap/model'))
    );
    expect(textOf(events)).toBe('model: picked/model');
  });
});

describe('createMockModelProvider — classifier knobs', () => {
  it('emits the directed resolution as the classifier output', async () => {
    const provider = createMockModelProvider({ classifierResolution: 'picked/model' });
    const events = await collect(
      provider.infer(classifierRequest('cheap/model'), languageDescriptor('cheap/model'))
    );
    expect(textOf(events)).toBe('model: picked/model');
    expect(finishOf(events).metadata.providerCostUsd).toBeGreaterThan(0);
  });

  it('defaults the resolution to the classifier model id (cheapest candidate)', async () => {
    const provider = createMockModelProvider();
    const events = await collect(
      provider.infer(classifierRequest('cheap/model'), languageDescriptor('cheap/model'))
    );
    expect(textOf(events)).toBe('model: cheap/model');
  });

  it('throws a typed InferenceError when classifier-failure is set', async () => {
    const provider = createMockModelProvider({ classifierFailure: true });
    await expect(
      collect(provider.infer(classifierRequest('cheap/model'), languageDescriptor('cheap/model')))
    ).rejects.toMatchObject({ name: 'InferenceError' });
  });

  it('does not treat a plain (non-marker) request as a classifier call', async () => {
    const provider = createMockModelProvider({ classifierResolution: 'picked/model' });
    const events = await collect(
      provider.infer(textRequest('a/model', 'hello'), languageDescriptor('a/model'))
    );
    // A plain turn echoes; the classifier resolution never leaks into it.
    expect(textOf(events)).toBe(echoOf('hello'));
  });

  it('answers ONLY the effort line for an effort-dimension-only classifier prompt', async () => {
    const provider = createMockModelProvider();
    const effortOnly: InferenceRequest = {
      model: 'cheap/model',
      inputs: [
        {
          modality: 'text',
          text: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}${CLASSIFIER_EFFORT_DIMENSION_MARKER}\nchoose an effort`,
        },
      ],
      parameters: { maxOutputTokens: 32 },
      outputs: ['text'],
      utcDay: FIXTURE_UTC_DAY,
    };
    const events = await collect(provider.infer(effortOnly, languageDescriptor('cheap/model')));
    expect(textOf(events)).toBe('effort: Mid');
  });

  it('answers one labelled line per dimension for a both-dimensions classifier prompt', async () => {
    const provider = createMockModelProvider({ classifierResolution: 'picked/model' });
    const both: InferenceRequest = {
      model: 'cheap/model',
      inputs: [
        {
          modality: 'text',
          text: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}${CLASSIFIER_MODEL_DIMENSION_MARKER}${CLASSIFIER_EFFORT_DIMENSION_MARKER}\nroute`,
        },
      ],
      parameters: { maxOutputTokens: 32 },
      outputs: ['text'],
      utcDay: FIXTURE_UTC_DAY,
    };
    const events = await collect(provider.infer(both, languageDescriptor('cheap/model')));
    expect(textOf(events)).toBe('model: picked/model\neffort: Mid');
  });

  it('emits the directed classifier effort when the knob is set', async () => {
    const provider = createMockModelProvider({ classifierEffort: 'high' });
    const effortOnly: InferenceRequest = {
      model: 'cheap/model',
      inputs: [
        {
          modality: 'text',
          text: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}${CLASSIFIER_EFFORT_DIMENSION_MARKER}\nchoose`,
        },
      ],
      parameters: {},
      outputs: ['text'],
      utcDay: FIXTURE_UTC_DAY,
    };
    const events = await collect(provider.infer(effortOnly, languageDescriptor('cheap/model')));
    // The directive is an option id; the mock emits the user-facing LABEL,
    // because that is what the classifier is presented and what the answer
    // parser matches on.
    expect(textOf(events)).toBe('effort: High');
  });

  it('resolves a classifier request whose only input is the marker system prompt', async () => {
    const provider = createMockModelProvider({ classifierResolution: 'picked/model' });
    const markerOnly: InferenceRequest = {
      model: 'cheap/model',
      inputs: [{ modality: 'text', text: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nchoose` }],
      parameters: {},
      outputs: ['text'],
      utcDay: FIXTURE_UTC_DAY,
    };
    const events = await collect(provider.infer(markerOnly, languageDescriptor('cheap/model')));
    expect(textOf(events)).toBe('model: picked/model');
  });
});

describe('createMockModelProvider — classifier delay knob', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gates the classifier stream by classifier-delay-ms', async () => {
    vi.useFakeTimers();
    const provider = createMockModelProvider({
      classifierResolution: 'picked/model',
      classifierDelayMs: 1000,
    });
    let settled = false;
    const pending = (async (): Promise<InferenceEvent[]> => {
      const events = await collect(
        provider.infer(classifierRequest('cheap/model'), languageDescriptor('cheap/model'))
      );
      settled = true;
      return events;
    })();
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const events = await pending;
    expect(settled).toBe(true);
    expect(textOf(events)).toBe('model: picked/model');
  });

  it('does not delay a plain (non-classifier) turn', async () => {
    const provider = createMockModelProvider({ classifierDelayMs: 100_000 });
    const events = await collect(
      provider.infer(textRequest('a/model', 'hi'), languageDescriptor('a/model'))
    );
    expect(textOf(events)).toBe(echoOf('hi'));
  });
});

describe('resolveMockDelays — the isDevServer env gate', () => {
  it('applies the human-facing dev-server defaults (60/3000/1000) only when isDevServer', () => {
    expect(resolveMockDelays({}, true)).toEqual({
      textDelayMs: 60,
      mediaDelayMs: 3000,
      classifierDelayMs: 1000,
    });
  });

  it('zeroes every delay when NOT a dev server (E2E / vitest / CI / production)', () => {
    expect(resolveMockDelays({}, false)).toEqual({
      textDelayMs: 0,
      mediaDelayMs: 0,
      classifierDelayMs: 0,
    });
  });

  it('lets a per-request directive override the default in either branch', () => {
    expect(
      resolveMockDelays({ textDelayMs: 5, mediaDelayMs: 7, classifierDelayMs: 9 }, true)
    ).toEqual({ textDelayMs: 5, mediaDelayMs: 7, classifierDelayMs: 9 });
    expect(resolveMockDelays({ textDelayMs: 5 }, false)).toEqual({
      textDelayMs: 5,
      mediaDelayMs: 0,
      classifierDelayMs: 0,
    });
  });
});

describe('createMockModelProvider — delay wiring (dev-server branch)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('paces the echo by the dev-server text delay when isDevServer is true', async () => {
    vi.useFakeTimers();
    // isDevServer=true → 60ms between chunks; a multi-chunk echo cannot settle
    // until the timers advance.
    const provider = createMockModelProvider({}, undefined, true);
    let settled = false;
    const pending = (async (): Promise<InferenceEvent[]> => {
      const events = await collect(
        provider.infer(
          textRequest('a/model', 'a reasonably long prompt to force several chunks'),
          languageDescriptor('a/model')
        )
      );
      settled = true;
      return events;
    })();
    // The first chunk is immediate; subsequent chunks await 60ms each.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 50);
    const events = await pending;
    expect(settled).toBe(true);
    expect(textOf(events)).toBe(echoOf('a reasonably long prompt to force several chunks'));
  });

  it('streams instantly (no timers) when isDevServer is false', async () => {
    // Real timers, no advance: with isDevServer=false the echo must resolve
    // synchronously — proving E2E/vitest never inherit artificial delay.
    const provider = createMockModelProvider({}, undefined, false);
    const events = await collect(
      provider.infer(textRequest('a/model', 'no delay here'), languageDescriptor('a/model'))
    );
    expect(textOf(events)).toBe(echoOf('no delay here'));
  });

  it('parks the media stream between media-start and media-done by the dev-server media delay', async () => {
    vi.useFakeTimers();
    const provider = createMockModelProvider({}, undefined, true);
    const { mapFilePart } = capturingMapper('image');
    let settled = false;
    const pending = (async (): Promise<InferenceEvent[]> => {
      const events = await collect(
        provider.infer(imageRequest('img/model'), imageDescriptor('img/model'), { mapFilePart })
      );
      settled = true;
      return events;
    })();
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const events = await pending;
    expect(settled).toBe(true);
    expect(events.map((event) => event.kind)).toEqual(['media-start', 'media-done', 'finish']);
  });
});

describe('createMockModelProvider — refusals', () => {
  it('refuses an audio-family descriptor with a typed unsupported-modality error', async () => {
    const provider = createMockModelProvider();
    const audioDescriptor: ModelDescriptor = {
      ...languageDescriptor('audio/model'),
      outputs: ['audio'],
    };
    await expect(
      collect(provider.infer(textRequest('audio/model', 'hi'), audioDescriptor))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'unsupported_modality' });
  });

  it('refuses the virtual smart-model sentinel (it must be resolved before inference)', async () => {
    const provider = createMockModelProvider();
    await expect(
      collect(provider.infer(textRequest(SMART_MODEL_ID, 'hi'), languageDescriptor(SMART_MODEL_ID)))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });
});

describe('createMockModelProvider — image synthesis', () => {
  it('yields a media-start→media-done→finish stream carrying the canned PNG bytes', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart, parts } = capturingMapper('image');
    const events = await collect(
      provider.infer(imageRequest('img/model'), imageDescriptor('img/model'), { mapFilePart })
    );
    expect(events.map((event) => event.kind)).toEqual(['media-start', 'media-done', 'finish']);

    const start = events[0];
    if (start?.kind !== 'media-start') {
      throw new Error('expected a media-start event');
    }
    expect(start.modality).toBe('image');
    expect(start.mimeType).toBe('image/png');

    expect(parts).toHaveLength(1);
    const file = parts[0];
    if (file === undefined) throw new Error('expected a captured file part');
    expect(file.mediaType).toBe('image/png');
    expect(file.data.slice(0, 8)).toEqual(PNG_SIGNATURE);
    // The IHDR width/height (bytes 16..24) are load-bearing: the image e2e spec
    // decodes the rendered <img> and asserts naturalWidth/Height === 400/300.
    expect(readUint32BE(file.data, 16)).toBe(400);
    expect(readUint32BE(file.data, 20)).toBe(300);
  });

  it('produces a genuinely decodable PNG — a valid IDAT zlib stream and correct chunk CRCs', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart, parts } = capturingMapper('image');
    await collect(
      provider.infer(imageRequest('img/model'), imageDescriptor('img/model'), { mapFilePart })
    );
    const file = parts[0];
    if (file === undefined) throw new Error('expected a captured file part');

    const chunks = parsePngChunks(file.data);
    // Every chunk's stored CRC must match a fresh recomputation — a corrupt
    // chunk body (as the old hand-authored bytes had) fails here.
    for (const chunk of chunks) {
      expect(crc32(chunk.crcInput)).toBe(chunk.storedCrc);
    }
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);

    // The IDAT payload must inflate as a valid zlib stream to the exact raster
    // size. A malformed zlib stream throws; a wrong body yields a wrong length.
    const idat = chunks.find((chunk) => chunk.type === 'IDAT');
    if (idat === undefined) throw new Error('expected an IDAT chunk');
    const raster = inflateSync(Buffer.from(idat.data));
    expect(raster.byteLength).toBe(EXPECTED_RASTER_LENGTH);
  });

  it('honors aspectRatio, scaling the long side to 1024 (16:9 → 1024×576)', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart, parts } = capturingMapper('image');
    const request: InferenceRequest = {
      model: 'img/model',
      inputs: [{ modality: 'text', text: 'a cat' }],
      parameters: { aspectRatio: '16:9' },
      outputs: ['image'],
      utcDay: FIXTURE_UTC_DAY,
    };
    await collect(provider.infer(request, imageDescriptor('img/model'), { mapFilePart }));
    const file = parts[0];
    if (file === undefined) throw new Error('expected a captured file part');
    expect(readUint32BE(file.data, 16)).toBe(1024);
    expect(readUint32BE(file.data, 20)).toBe(576);
  });

  it('honors a square aspectRatio (1:1 → 1024×1024)', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart, parts } = capturingMapper('image');
    const request: InferenceRequest = {
      model: 'img/model',
      inputs: [{ modality: 'text', text: 'a cat' }],
      parameters: { aspectRatio: '1:1' },
      outputs: ['image'],
      utcDay: FIXTURE_UTC_DAY,
    };
    await collect(provider.infer(request, imageDescriptor('img/model'), { mapFilePart }));
    const file = parts[0];
    if (file === undefined) throw new Error('expected a captured file part');
    expect(readUint32BE(file.data, 16)).toBe(1024);
    expect(readUint32BE(file.data, 20)).toBe(1024);
  });

  it('honors a portrait aspectRatio, scaling the height to the long side (2:3 → 683×1024)', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart, parts } = capturingMapper('image');
    const request: InferenceRequest = {
      model: 'img/model',
      inputs: [{ modality: 'text', text: 'a cat' }],
      parameters: { aspectRatio: '2:3' },
      outputs: ['image'],
      utcDay: FIXTURE_UTC_DAY,
    };
    await collect(provider.infer(request, imageDescriptor('img/model'), { mapFilePart }));
    const file = parts[0];
    if (file === undefined) throw new Error('expected a captured file part');
    expect(readUint32BE(file.data, 16)).toBe(Math.round((1024 * 2) / 3)); // 683
    expect(readUint32BE(file.data, 20)).toBe(1024);
  });

  it('falls back to the fixture 400×300 for a non-positive aspectRatio ratio', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart, parts } = capturingMapper('image');
    const request: InferenceRequest = {
      model: 'img/model',
      inputs: [{ modality: 'text', text: 'a cat' }],
      parameters: { aspectRatio: '0:5' },
      outputs: ['image'],
      utcDay: FIXTURE_UTC_DAY,
    };
    await collect(provider.infer(request, imageDescriptor('img/model'), { mapFilePart }));
    const file = parts[0];
    if (file === undefined) throw new Error('expected a captured file part');
    expect(readUint32BE(file.data, 16)).toBe(400);
    expect(readUint32BE(file.data, 20)).toBe(300);
  });

  it('falls back to the fixture 400×300 for a malformed aspectRatio', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart, parts } = capturingMapper('image');
    const request: InferenceRequest = {
      model: 'img/model',
      inputs: [{ modality: 'text', text: 'a cat' }],
      parameters: { aspectRatio: 'oops' },
      outputs: ['image'],
      utcDay: FIXTURE_UTC_DAY,
    };
    await collect(provider.infer(request, imageDescriptor('img/model'), { mapFilePart }));
    const file = parts[0];
    if (file === undefined) throw new Error('expected a captured file part');
    expect(readUint32BE(file.data, 16)).toBe(400);
    expect(readUint32BE(file.data, 20)).toBe(300);
  });

  it('finishes an image with no inline cost so settlement falls back to the estimate', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart } = capturingMapper('image');
    const events = await collect(
      provider.infer(imageRequest('img/model'), imageDescriptor('img/model'), { mapFilePart })
    );
    const finish = finishOf(events);
    expect(finish.metadata.finishReason).toBe('stop');
    // OpenRouter's images API returns no inline cost — the mock mirrors that so
    // settlement bills the deterministic catalog estimate (isEstimated=true).
    expect(finish.metadata.providerCostUsd).toBeUndefined();
  });

  it('raises an AdapterDefect when a media call arrives without a mapFilePart contract', async () => {
    const provider = createMockModelProvider();
    await expect(
      collect(provider.infer(imageRequest('img/model'), imageDescriptor('img/model')))
    ).rejects.toBeInstanceOf(AdapterDefect);
  });
});

describe('createMockModelProvider — video synthesis', () => {
  it('yields a media-start→media-done→finish stream carrying the canned video bytes', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart, parts } = capturingMapper('video');
    const events = await collect(
      provider.infer(videoRequest('vid/model'), videoDescriptor('vid/model'), { mapFilePart })
    );
    expect(events.map((event) => event.kind)).toEqual(['media-start', 'media-done', 'finish']);

    const start = events[0];
    if (start?.kind !== 'media-start') {
      throw new Error('expected a media-start event');
    }
    expect(start.modality).toBe('video');
    expect(start.mimeType).toBe('video/webm');

    expect(parts).toHaveLength(1);
    const file = parts[0];
    if (file === undefined) throw new Error('expected a captured file part');
    expect(file.mediaType).toBe('video/webm');
    expect(file.data.slice(0, 4)).toEqual(EBML_SIGNATURE);
    expect(file.data).toEqual(MOCK_VIDEO_BYTES);
  });

  it('finishes a video with the authoritative inline cost and a generation id', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart } = capturingMapper('video');
    const events = await collect(
      provider.infer(videoRequest('vid/model'), videoDescriptor('vid/model'), { mapFilePart })
    );
    const finish = finishOf(events);
    expect(finish.metadata.finishReason).toBe('stop');
    // Video carries OpenRouter's inline cost — the mock mirrors that so settlement
    // bills authoritative (isEstimated=false), matching the real video adapter.
    expect(finish.metadata.providerCostUsd).toBeGreaterThan(0);
    expect(finish.metadata.generationId).toBeDefined();
  });

  it('rejects an unsupported requested duration for a constrained model', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart } = capturingMapper('video');
    await expect(
      collect(
        provider.infer(
          videoRequest('vid/constrained', { durationSeconds: 5 }),
          constrainedVideoDescriptor('vid/constrained'),
          { mapFilePart }
        )
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });

  it('accepts a supported requested duration for a constrained model', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart } = capturingMapper('video');
    const events = await collect(
      provider.infer(
        videoRequest('vid/constrained', { durationSeconds: 8 }),
        constrainedVideoDescriptor('vid/constrained'),
        { mapFilePart }
      )
    );
    expect(events.map((event) => event.kind)).toEqual(['media-start', 'media-done', 'finish']);
  });

  it('accepts any duration for a model with no duration constraint', async () => {
    const provider = createMockModelProvider();
    const { mapFilePart } = capturingMapper('video');
    const events = await collect(
      provider.infer(
        videoRequest('vid/model', { durationSeconds: 999 }),
        videoDescriptor('vid/model'),
        { mapFilePart }
      )
    );
    expect(events.map((event) => event.kind)).toEqual(['media-start', 'media-done', 'finish']);
  });
});

/** A search adapter answering with the fake's results, recording each query it is asked. */
function recordingFakeSearch(): { readonly search: SearchProvider; readonly queries: string[] } {
  const fake = createFakeSearchProvider();
  const queries: string[] = [];
  return {
    queries,
    search: {
      search: (query, options) => {
        queries.push(query.query);
        return fake.search(query, options);
      },
    },
  };
}

/** The results the fake search adapter answers every query with. */
function fakeResults(): Promise<WebSearchResults> {
  return createFakeSearchProvider().search(
    { query: 'any query' },
    { signal: new AbortController().signal }
  );
}

/** A run's tool loop carrying the web search tool, built from `search`. */
function searchLoop(search: SearchProvider, maxSteps = 3): ToolLoopOptions {
  return { registry: createToolRegistry({ search }), maxSteps };
}

function eventsOfKind<K extends InferenceEvent['kind']>(
  events: readonly InferenceEvent[],
  kind: K
): Extract<InferenceEvent, { kind: K }>[] {
  return events.filter(
    (event): event is Extract<InferenceEvent, { kind: K }> => event.kind === kind
  );
}

/** The message tree `events` store, folded and settled as the modelCall node does. */
function treeOf(events: readonly InferenceEvent[]): readonly Segment[] {
  let state = createAssistantStream();
  for (const event of events) state = reduceAssistantStream(state, event);
  return settleAssistantStream(state).tree;
}

/** A search adapter whose every search rejects with an error carrying `text`. */
function failingSearch(text: string): SearchProvider {
  return { search: () => Promise.reject(new Error(text)) };
}

/** The events a stream yields before it throws, and what it threw. */
async function collectUntilThrow(
  stream: AsyncIterable<InferenceEvent>
): Promise<{ readonly events: InferenceEvent[]; readonly thrown: unknown }> {
  const events: InferenceEvent[] = [];
  const drain = async (): Promise<void> => {
    for await (const event of stream) events.push(event);
  };
  const thrown = await drain().then(
    () => undefined,
    (error: unknown) => error
  );
  return { events, thrown };
}

describe('createMockModelProvider: web search', () => {
  it('searches through the run webSearch tool execute, reaching the fake adapter, under the directive', async () => {
    const recording = recordingFakeSearch();
    const provider = createMockModelProvider({ webSearchCount: 1 });

    const events = await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        tools: searchLoop(recording.search),
      })
    );

    expect(recording.queries).toHaveLength(1);
    expect(eventsOfKind(events, 'tool-result').map((event) => event.result)).toEqual([
      await fakeResults(),
    ]);
  });

  it('opens the searching step and the answering step each with a step-start', async () => {
    const provider = createMockModelProvider({ webSearchCount: 1 });

    const events = await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        tools: searchLoop(recordingFakeSearch().search),
      })
    );

    expect(events.map((event) => event.kind).slice(0, 5)).toEqual([
      'step-start',
      'tool-call',
      'tool-result',
      'step-finish',
      'step-start',
    ]);
    expect(eventsOfKind(events, 'step-start').map((event) => event.step)).toEqual([0, 1]);
  });

  it('emits one tool-call and its tool-result for each search the directive asks for', async () => {
    const recording = recordingFakeSearch();
    const provider = createMockModelProvider({ webSearchCount: 2 });

    const events = await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        tools: searchLoop(recording.search),
      })
    );

    const calls = eventsOfKind(events, 'tool-call');
    expect(calls.map((call) => call.args)).toEqual(recording.queries.map((query) => ({ query })));
    expect(new Set(recording.queries).size).toBe(2);
    expect(eventsOfKind(events, 'tool-result').map((result) => result.id)).toEqual(
      calls.map((call) => call.id)
    );
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
  });

  it('answers after the search with the echo naming the first result title', async () => {
    const provider = createMockModelProvider({ webSearchCount: 1 });
    const { results } = await fakeResults();
    const [first] = results;

    const events = await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        tools: searchLoop(recordingFakeSearch().search),
      })
    );

    const answer = textOf(events);
    expect(answer.startsWith(`${MOCK_ECHO_PREFIX}\nfind it`)).toBe(true);
    expect(answer).toContain(first?.title);
  });

  it('reports each step its own generation and cost, and the finish their sum, as the real loop does', async () => {
    const provider = createMockModelProvider({ webSearchCount: 1 });

    const events = await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        tools: searchLoop(recordingFakeSearch().search),
      })
    );

    expect(eventsOfKind(events, 'step-finish')).toMatchObject([
      {
        kind: 'step-finish',
        step: 0,
        generationId: 'mock-gen-1',
        providerCostUsd: MOCK_GENERATION_COST_USD,
      },
      {
        kind: 'step-finish',
        step: 1,
        generationId: 'mock-gen-2',
        providerCostUsd: MOCK_GENERATION_COST_USD,
      },
    ]);
    const { metadata } = finishOf(events);
    expect(metadata.providerCostUsd).toBe(MOCK_GENERATION_COST_USD + MOCK_GENERATION_COST_USD);
    expect(metadata.generationId).toBeUndefined();
  });

  it('names itself as the endpoint that served each step', async () => {
    const provider = createMockModelProvider({ webSearchCount: 1 });

    const events = await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        tools: searchLoop(recordingFakeSearch().search),
      })
    );

    expect(eventsOfKind(events, 'step-finish').map((event) => event.servedBy)).toEqual([
      'mock',
      'mock',
    ]);
  });

  it('reports each step a usage, the steps together making up the finish usage', async () => {
    const provider = createMockModelProvider({ webSearchCount: 1, webSearchAfterText: true });

    const events = await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        tools: searchLoop(recordingFakeSearch().search),
      })
    );

    const steps = eventsOfKind(events, 'step-finish').map((event) => event.usage);
    const { usage } = finishOf(events).metadata;
    expect(steps.every((step) => step !== undefined)).toBe(true);
    expect(steps.reduce((sum, step) => sum + (step?.inputTokens ?? 0), 0)).toBe(usage.inputTokens);
    expect(steps.reduce((sum, step) => sum + (step?.outputTokens ?? 0), 0)).toBe(
      usage.outputTokens
    );
  });

  it('nests the search inside the reasoning it streams first when the request reasons', async () => {
    const provider = createMockModelProvider({ webSearchCount: 1 });
    const request: InferenceRequest = {
      ...textRequest('m', 'find it'),
      parameters: { reasoning: { effort: 'low' } },
    };

    const events = await collect(
      provider.infer(request, languageDescriptor('m'), {
        tools: searchLoop(recordingFakeSearch().search),
      })
    );

    const [reasoning, answer] = treeOf(events);
    expect(
      reasoning?.kind === 'reasoning' && reasoning.children.map((child) => child.kind)
    ).toEqual(['text', 'webSearch']);
    expect(answer?.kind).toBe('text');
  });

  it('carries reasoningTokens on the finish of a search turn that reasons', async () => {
    const provider = createMockModelProvider({ webSearchCount: 1 });
    const request: InferenceRequest = {
      ...textRequest('m', 'find it'),
      parameters: { reasoning: { effort: 'low' } },
    };

    const events = await collect(
      provider.infer(request, languageDescriptor('m'), {
        tools: searchLoop(recordingFakeSearch().search),
      })
    );

    expect(finishOf(events).metadata.usage.reasoningTokens).toBeGreaterThan(0);
  });

  it('puts the search after a line of answer text under webSearchAfterText', async () => {
    const provider = createMockModelProvider({ webSearchCount: 1, webSearchAfterText: true });

    const events = await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        tools: searchLoop(recordingFakeSearch().search),
      })
    );

    expect(treeOf(events).map((segment) => segment.kind)).toEqual(['text', 'webSearch', 'text']);
  });

  it('emits a tool-error with the failed reason, and no tool-result, when execute throws', async () => {
    const provider = createMockModelProvider({ webSearchCount: 1 });

    const events = await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        tools: searchLoop(failingSearch('search exploded')),
      })
    );

    expect(eventsOfKind(events, 'tool-error')).toEqual([
      { kind: 'tool-error', id: 'mock-search-1', name: WEB_SEARCH_TOOL_NAME, reason: 'failed' },
    ]);
    expect(eventsOfKind(events, 'tool-result')).toEqual([]);
  });

  it('carries none of a failed search error text on any event', async () => {
    const provider = createMockModelProvider({ webSearchCount: 1 });

    const events = await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        tools: searchLoop(failingSearch('quokka-marker-text')),
      })
    );

    expect(JSON.stringify(events)).not.toContain('quokka-marker-text');
  });

  it('answers with the plain echo, naming no title, when no search returned', async () => {
    const provider = createMockModelProvider({ webSearchCount: 1 });

    const events = await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        tools: searchLoop(failingSearch('search exploded')),
      })
    );

    expect(textOf(events)).toBe(echoOf('find it'));
  });

  it('answers with the plain echo, naming no title, when the search found nothing', async () => {
    const provider = createMockModelProvider({ webSearchCount: 1 });

    const events = await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        tools: searchLoop({ search: () => Promise.resolve({ results: [] }) }),
      })
    );

    expect(textOf(events)).toBe(echoOf('find it'));
  });

  it('hands the run signal to execute', async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const fake = createFakeSearchProvider();
    const provider = createMockModelProvider({ webSearchCount: 1 });

    await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        signal: controller.signal,
        tools: searchLoop({
          search: (query, options) => {
            seen.push(options.signal);
            return fake.search(query, options);
          },
        }),
      })
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(controller.signal);
  });

  it('fails as aborted, with no tool-error, when execute fails after the run aborted', async () => {
    const controller = new AbortController();
    const provider = createMockModelProvider({ webSearchCount: 1 });

    const { events, thrown } = await collectUntilThrow(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        signal: controller.signal,
        tools: searchLoop({
          search: () => {
            controller.abort();
            return Promise.reject(new Error('cancelled mid-search'));
          },
        }),
      })
    );

    expect(thrown).toMatchObject({ name: 'InferenceError', code: 'aborted' });
    expect(eventsOfKind(events, 'tool-error')).toEqual([]);
  });

  it('streams exactly the plain echo when the run carries web search but no search is asked for', async () => {
    const request = textRequest('m', 'find it');
    const plain = await collect(createMockModelProvider().infer(request, languageDescriptor('m')));

    const events = await collect(
      createMockModelProvider().infer(request, languageDescriptor('m'), {
        tools: searchLoop(recordingFakeSearch().search),
      })
    );

    expect(events).toEqual(plain);
  });

  it.each([
    { run: 'no tool loop', options: {} },
    { run: 'a tool loop without web search', options: { tools: { registry: {}, maxSteps: 3 } } },
  ])(
    'streams exactly the plain echo under the directive for a run carrying $run',
    async ({ options }) => {
      const request = textRequest('m', 'find it');
      const plain = await collect(
        createMockModelProvider().infer(request, languageDescriptor('m'))
      );

      const events = await collect(
        createMockModelProvider({ webSearchCount: 1 }).infer(
          request,
          languageDescriptor('m'),
          options satisfies InferOptions
        )
      );

      expect(events).toEqual(plain);
    }
  );

  it('refuses the searches past the loop call budget with limit, never running them', async () => {
    const recording = recordingFakeSearch();
    const provider = createMockModelProvider({ webSearchCount: 3 });

    const events = await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        // Two steps allow one tool call.
        tools: searchLoop(recording.search, 2),
      })
    );

    expect(recording.queries).toHaveLength(1);
    expect(eventsOfKind(events, 'tool-result').map((result) => result.id)).toEqual([
      'mock-search-1',
    ]);
    expect(eventsOfKind(events, 'tool-error')).toEqual([
      { kind: 'tool-error', id: 'mock-search-2', name: WEB_SEARCH_TOOL_NAME, reason: 'limit' },
      { kind: 'tool-error', id: 'mock-search-3', name: WEB_SEARCH_TOOL_NAME, reason: 'limit' },
    ]);
  });
});

describe('createMockModelProvider: the dev-server web search switch', () => {
  /** The modes whose processes the vitest runner hosts, which set `VITEST` in them. */
  const VITEST_HOSTED: ReadonlySet<Mode> = new Set([Mode.Test, Mode.CiVitest]);

  /** `isDevServer` as a process of `mode` derives it from its bindings. */
  function isDevServerIn(mode: Mode): boolean {
    const read = (config: VariableConfig): string | undefined => {
      const raw = resolveRaw(config, mode);
      return typeof raw === 'string' ? raw : undefined;
    };
    const nodeEnv = read(envConfig.NODE_ENV);
    const ci = read(envConfig.CI);
    const e2e = read(envConfig.E2E);
    return createEnvUtilities({
      ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
      ...(ci === undefined ? {} : { CI: ci }),
      ...(e2e === undefined ? {} : { E2E: e2e }),
      ...(VITEST_HOSTED.has(mode) ? { VITEST: 'true' } : {}),
    }).isDevServer;
  }

  async function searchesWithoutDirective(isDevServer: boolean): Promise<boolean> {
    const recording = recordingFakeSearch();
    const provider = createMockModelProvider({}, undefined, isDevServer);
    await collect(
      provider.infer(textRequest('m', 'find it'), languageDescriptor('m'), {
        tools: searchLoop(recording.search),
      })
    );
    return recording.queries.length > 0;
  }

  it('searches with no directive on the development stack when the run carries the tool', async () => {
    await expect(searchesWithoutDirective(isDevServerIn(Mode.Development))).resolves.toBe(true);
  });

  it.each(Object.values(Mode).filter((mode) => mode !== Mode.Development))(
    'makes no search without the directive in %s',
    async (mode) => {
      await expect(searchesWithoutDirective(isDevServerIn(mode))).resolves.toBe(false);
    }
  );
});
