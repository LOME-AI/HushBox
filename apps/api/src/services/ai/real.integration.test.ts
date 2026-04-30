import { describe, it, expect, beforeAll } from 'vitest';
import {
  assertValidMediaBytes,
  clearTestModelCache,
  consumeStream,
  getCheapestTestModel,
  setupIntegrationClient,
} from './test-utilities.js';
import type { AIClient, TextRequest, ImageRequest, VideoRequest } from './types.js';

const TEXT_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 60_000;
const VIDEO_TIMEOUT_MS = 300_000;

const MIN_DISTINCT_PROVIDERS = 2;

describe('AIClient real integration', () => {
  let client: AIClient;

  beforeAll(() => {
    clearTestModelCache();
    const setup = setupIntegrationClient();
    client = setup.client;
  });

  describe('listModels', () => {
    it(
      'returns ZDR-only models with the expected discriminated shape',
      async () => {
        const models = await client.listModels();
        expect(models.length).toBeGreaterThan(0);
        for (const model of models) {
          expect(model.id).toBeTruthy();
          expect(model.name).toBeTruthy();
          expect(model.provider).toBeTruthy();
          expect(['text', 'image', 'audio', 'video']).toContain(model.modality);
          expect(model.isZdr).toBe(true);
          expect(['token', 'image', 'audio', 'video']).toContain(model.pricing.kind);
        }
      },
      TEXT_TIMEOUT_MS
    );

    it(
      'spans multiple distinct providers',
      async () => {
        const models = await client.listModels();
        const distinctProviders = new Set(models.map((m) => m.provider));
        expect(distinctProviders.size).toBeGreaterThanOrEqual(MIN_DISTINCT_PROVIDERS);
      },
      TEXT_TIMEOUT_MS
    );
  });

  describe('getModel', () => {
    it(
      'returns the requested model by id',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        const model = await client.getModel(spec.modelId);
        expect(model.id).toBe(spec.modelId);
        expect(model.modality).toBe('text');
      },
      TEXT_TIMEOUT_MS
    );

    it(
      'rejects for an unknown model id',
      async () => {
        await expect(
          client.getModel('nonexistent/model-that-does-not-exist')
        ).rejects.toBeDefined();
      },
      TEXT_TIMEOUT_MS
    );
  });

  describe('stream(text)', () => {
    it(
      'produces text content and a finish event with providerMetadata.generationId',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        if (spec.parameters.kind !== 'text') throw new Error('expected text spec');
        const request: TextRequest = {
          modality: 'text',
          model: spec.modelId,
          messages: [{ role: 'user', content: 'Reply with a short greeting.' }],
          maxOutputTokens: spec.parameters.maxOutputTokens,
        };
        const result = await consumeStream(client.stream(request));
        expect(result.textContent.length).toBeGreaterThan(0);
        expect(result.events.at(-1)?.kind).toBe('finish');
        expect(result.generationId).toBeDefined();
        expect(result.generationId?.length ?? 0).toBeGreaterThan(0);
      },
      TEXT_TIMEOUT_MS
    );

    it(
      'streams multiple events incrementally rather than one buffered chunk',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        if (spec.parameters.kind !== 'text') throw new Error('expected text spec');
        const request: TextRequest = {
          modality: 'text',
          model: spec.modelId,
          messages: [{ role: 'user', content: 'Write a one-sentence reply.' }],
          maxOutputTokens: spec.parameters.maxOutputTokens,
        };
        const result = await consumeStream(client.stream(request));
        expect(result.events.length).toBeGreaterThan(1);
      },
      TEXT_TIMEOUT_MS
    );

    it(
      'produces non-empty content for a system + user message',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        if (spec.parameters.kind !== 'text') throw new Error('expected text spec');
        const request: TextRequest = {
          modality: 'text',
          model: spec.modelId,
          messages: [
            { role: 'system', content: 'You are a concise assistant.' },
            { role: 'user', content: 'Say hello.' },
          ],
          maxOutputTokens: spec.parameters.maxOutputTokens,
        };
        const result = await consumeStream(client.stream(request));
        expect(result.textContent.length).toBeGreaterThan(0);
      },
      TEXT_TIMEOUT_MS
    );
  });

  describe('stream(image)', () => {
    it(
      'produces a valid image with media-start, media-done, and finish events',
      async () => {
        const spec = await getCheapestTestModel(client, 'image');
        if (spec.parameters.kind !== 'image') throw new Error('expected image spec');
        const request: ImageRequest = {
          modality: 'image',
          model: spec.modelId,
          prompt: 'A small red dot on a white background',
          aspectRatio: spec.parameters.aspectRatio,
        };
        const result = await consumeStream(client.stream(request));
        const kinds = result.events.map((e) => e.kind);
        expect(kinds).toContain('media-start');
        expect(kinds).toContain('media-done');
        expect(kinds.at(-1)).toBe('finish');
        expect(result.mediaBytes).toBeDefined();
        const detection = assertValidMediaBytes(
          result.mediaBytes!,
          ['image/png', 'image/jpeg', 'image/webp'],
          { min: 32, max: 10_000_000 }
        );
        expect(detection.detectedMime).toMatch(/^image\//);
        expect(result.generationId).toBeDefined();
      },
      IMAGE_TIMEOUT_MS
    );
  });

  describe('stream(video)', () => {
    it(
      'produces a valid 1-second video with media-start, media-done, and finish events',
      async () => {
        const spec = await getCheapestTestModel(client, 'video');
        if (spec.parameters.kind !== 'video') throw new Error('expected video spec');
        const request: VideoRequest = {
          modality: 'video',
          model: spec.modelId,
          prompt: 'A short panning shot of a calm landscape',
          durationSeconds: spec.parameters.duration,
          resolution: spec.parameters.resolution,
        };
        const result = await consumeStream(client.stream(request));
        const kinds = result.events.map((e) => e.kind);
        expect(kinds).toContain('media-start');
        expect(kinds).toContain('media-done');
        expect(kinds.at(-1)).toBe('finish');
        expect(result.mediaBytes).toBeDefined();
        assertValidMediaBytes(result.mediaBytes!, ['video/mp4'], {
          min: 16,
          max: 50_000_000,
        });
        expect(result.generationId).toBeDefined();
      },
      VIDEO_TIMEOUT_MS
    );
  });

  describe('ZDR enforcement', () => {
    it(
      'every model returned by listModels has isZdr === true',
      async () => {
        const models = await client.listModels();
        const nonZdr = models.filter((m) => !m.isZdr);
        expect(nonZdr).toHaveLength(0);
      },
      TEXT_TIMEOUT_MS
    );
  });
});
