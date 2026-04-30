import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  assertValidMediaBytes,
  clearTestModelCache,
  consumeStream,
  getCheapestTestModel,
} from './test-utilities.js';
import type { AIClient, InferenceEvent, InferenceStream, ModelInfo } from './types.js';

function makeStubClient(models: ModelInfo[]): AIClient {
  return {
    isMock: true,
    listModels: vi.fn().mockResolvedValue(models),
    getModel: vi.fn(),
    stream: vi.fn() as unknown as AIClient['stream'],
    getGenerationStats: vi.fn(),
  };
}

function tokenModel(
  id: string,
  inputPerToken: number,
  outputPerToken: number,
  isZdr = true
): ModelInfo {
  return {
    id,
    name: id,
    provider: id.split('/')[0] ?? 'unknown',
    modality: 'text',
    description: `Mock ${id}`,
    pricing: { kind: 'token', inputPerToken, outputPerToken },
    capabilities: [],
    isZdr,
  };
}

function imageModel(id: string, perImage: number, isZdr = true): ModelInfo {
  return {
    id,
    name: id,
    provider: id.split('/')[0] ?? 'unknown',
    modality: 'image',
    description: `Mock ${id}`,
    pricing: { kind: 'image', perImage },
    capabilities: [],
    isZdr,
  };
}

function videoModel(
  id: string,
  perSecondByResolution: Record<string, number>,
  isZdr = true
): ModelInfo {
  return {
    id,
    name: id,
    provider: id.split('/')[0] ?? 'unknown',
    modality: 'video',
    description: `Mock ${id}`,
    pricing: { kind: 'video', perSecondByResolution },
    capabilities: [],
    isZdr,
  };
}

async function* asyncIter<T>(items: T[]): AsyncIterableIterator<T> {
  await Promise.resolve();
  for (const item of items) {
    yield item;
  }
}

function streamFrom(events: InferenceEvent[]): InferenceStream {
  return {
    [Symbol.asyncIterator]: () => asyncIter(events),
  };
}

describe('getCheapestTestModel', () => {
  beforeEach(() => {
    clearTestModelCache();
  });

  it('returns cheapest paid ZDR text model with maxOutputTokens=10', async () => {
    const client = makeStubClient([
      tokenModel('p/free', 0, 0),
      tokenModel('p/cheap', 0.000_001, 0.000_001),
      tokenModel('p/expensive', 0.0001, 0.0001),
    ]);
    const spec = await getCheapestTestModel(client, 'text');
    expect(spec.modelId).toBe('p/cheap');
    expect(spec.parameters).toEqual({ kind: 'text', maxOutputTokens: 10 });
  });

  it('falls back to cheapest paid ZDR text model when none fit the threshold', async () => {
    const client = makeStubClient([
      tokenModel('p/free', 0, 0),
      tokenModel('p/expensive', 1, 1),
      tokenModel('p/very-expensive', 5, 5),
    ]);
    const spec = await getCheapestTestModel(client, 'text');
    expect(spec.modelId).toBe('p/expensive');
  });

  it('throws when no paid ZDR text model exists at all', async () => {
    const client = makeStubClient([tokenModel('p/free', 0, 0)]);
    await expect(getCheapestTestModel(client, 'text')).rejects.toThrow('No paid ZDR text model');
  });

  it('excludes non-ZDR models from text selection', async () => {
    const client = makeStubClient([
      tokenModel('p/non-zdr', 0.000_001, 0.000_001, false),
      tokenModel('p/zdr', 0.000_005, 0.000_005, true),
    ]);
    const spec = await getCheapestTestModel(client, 'text');
    expect(spec.modelId).toBe('p/zdr');
  });

  it('returns cheapest paid ZDR image model with aspectRatio 1:1', async () => {
    const client = makeStubClient([
      imageModel('p/free-image', 0),
      imageModel('p/cheap-image', 0.001),
      imageModel('p/medium-image', 0.01),
    ]);
    const spec = await getCheapestTestModel(client, 'image');
    expect(spec.modelId).toBe('p/cheap-image');
    expect(spec.parameters).toEqual({ kind: 'image', aspectRatio: '1:1' });
  });

  it('throws when no image model fits the price ceiling', async () => {
    const client = makeStubClient([imageModel('p/expensive-image', 100)]);
    await expect(getCheapestTestModel(client, 'image')).rejects.toThrow('No paid ZDR image model');
  });

  it('returns cheapest video model+resolution with duration=MIN_VIDEO_DURATION_SECONDS', async () => {
    const client = makeStubClient([
      videoModel('p/video-a', { '720p': 0.1, '1080p': 0.15 }),
      videoModel('p/video-b', { '480p': 0.05, '720p': 0.12 }),
    ]);
    const spec = await getCheapestTestModel(client, 'video');
    expect(spec.modelId).toBe('p/video-b');
    expect(spec.parameters).toEqual({ kind: 'video', duration: 1, resolution: '480p' });
  });

  it('throws when no video model fits the per-second ceiling', async () => {
    const client = makeStubClient([videoModel('p/expensive-video', { '720p': 100 })]);
    await expect(getCheapestTestModel(client, 'video')).rejects.toThrow('No paid ZDR video model');
  });

  it('throws for audio modality (out of scope)', async () => {
    const client = makeStubClient([]);
    await expect(getCheapestTestModel(client, 'audio')).rejects.toThrow('Audio');
  });

  it('caches the result across calls', async () => {
    const client = makeStubClient([tokenModel('p/cached', 0.000_001, 0.000_001)]);
    await getCheapestTestModel(client, 'text');
    await getCheapestTestModel(client, 'text');
    expect(client.listModels).toHaveBeenCalledTimes(1);
  });

  it('clearTestModelCache resets cached selection', async () => {
    const client = makeStubClient([tokenModel('p/cached', 0.000_001, 0.000_001)]);
    await getCheapestTestModel(client, 'text');
    clearTestModelCache();
    await getCheapestTestModel(client, 'text');
    expect(client.listModels).toHaveBeenCalledTimes(2);
  });
});

describe('consumeStream', () => {
  it('collects text-delta content and finish.generationId', async () => {
    const result = await consumeStream(
      streamFrom([
        { kind: 'text-delta', content: 'Hello, ' },
        { kind: 'text-delta', content: 'world!' },
        { kind: 'finish', providerMetadata: { generationId: 'gen-123' } },
      ])
    );
    expect(result.textContent).toBe('Hello, world!');
    expect(result.generationId).toBe('gen-123');
    expect(result.events).toHaveLength(3);
    expect(result.timestamps).toHaveLength(3);
  });

  it('captures media bytes and metadata from media-done', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await consumeStream(
      streamFrom([
        { kind: 'media-start', mediaType: 'image', mimeType: 'image/png' },
        {
          kind: 'media-done',
          bytes,
          mimeType: 'image/png',
          width: 1024,
          height: 768,
        },
        { kind: 'finish', providerMetadata: { generationId: 'gen-img' } },
      ])
    );
    expect(result.mediaBytes).toBe(bytes);
    expect(result.mediaMimeType).toBe('image/png');
    expect(result.mediaWidth).toBe(1024);
    expect(result.mediaHeight).toBe(768);
    expect(result.generationId).toBe('gen-img');
  });

  it('captures video duration on media-done', async () => {
    const result = await consumeStream(
      streamFrom([
        { kind: 'media-start', mediaType: 'video', mimeType: 'video/mp4' },
        {
          kind: 'media-done',
          bytes: new Uint8Array([0]),
          mimeType: 'video/mp4',
          durationMs: 1000,
        },
        { kind: 'finish' },
      ])
    );
    expect(result.mediaDurationMs).toBe(1000);
  });

  it('returns empty result for empty stream', async () => {
    const result = await consumeStream(streamFrom([]));
    expect(result.events).toHaveLength(0);
    expect(result.textContent).toBe('');
    expect(result.generationId).toBeUndefined();
    expect(result.mediaBytes).toBeUndefined();
  });
});

describe('assertValidMediaBytes', () => {
  // Magic byte fixtures
  const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const WEBP_HEAD = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const MP4_HEAD = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

  function pad(head: Uint8Array, size: number): Uint8Array {
    const out = new Uint8Array(size);
    out.set(head, 0);
    return out;
  }

  it('accepts valid PNG bytes within bounds', () => {
    const bytes = pad(PNG_HEAD, 2048);
    const result = assertValidMediaBytes(bytes, ['image/png'], { min: 1024, max: 10_000_000 });
    expect(result.detectedMime).toBe('image/png');
  });

  it('accepts valid JPEG bytes within bounds', () => {
    const bytes = pad(JPEG_HEAD, 2048);
    const result = assertValidMediaBytes(bytes, ['image/jpeg'], { min: 1024, max: 10_000_000 });
    expect(result.detectedMime).toBe('image/jpeg');
  });

  it('accepts valid WebP bytes within bounds', () => {
    const bytes = pad(WEBP_HEAD, 2048);
    const result = assertValidMediaBytes(bytes, ['image/webp'], { min: 1024, max: 10_000_000 });
    expect(result.detectedMime).toBe('image/webp');
  });

  it('accepts valid MP4 bytes within bounds', () => {
    const bytes = pad(MP4_HEAD, 50_000);
    const result = assertValidMediaBytes(bytes, ['video/mp4'], { min: 10_000, max: 5_000_000 });
    expect(result.detectedMime).toBe('video/mp4');
  });

  it('rejects bytes too small for size bounds', () => {
    const bytes = pad(PNG_HEAD, 16);
    expect(() =>
      assertValidMediaBytes(bytes, ['image/png'], { min: 1024, max: 10_000_000 })
    ).toThrow('too small');
  });

  it('rejects bytes too large for size bounds', () => {
    const bytes = pad(PNG_HEAD, 20_000_000);
    expect(() =>
      assertValidMediaBytes(bytes, ['image/png'], { min: 1024, max: 10_000_000 })
    ).toThrow('too large');
  });

  it('rejects bytes whose magic signature is unrecognized', () => {
    const bytes = new Uint8Array(2048);
    bytes.fill(0xab);
    expect(() =>
      assertValidMediaBytes(bytes, ['image/png'], { min: 1024, max: 10_000_000 })
    ).toThrow('detect media format');
  });

  it('rejects when detected MIME is not in allowed list', () => {
    const bytes = pad(PNG_HEAD, 2048);
    expect(() =>
      assertValidMediaBytes(bytes, ['image/jpeg'], { min: 1024, max: 10_000_000 })
    ).toThrow('not in allowed list');
  });
});
