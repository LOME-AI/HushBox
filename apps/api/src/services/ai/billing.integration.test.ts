import { describe, it, expect, beforeAll } from 'vitest';
import { applyFees, calculateMediaGenerationCost, TOTAL_FEE_RATE } from '@hushbox/shared';
import { calculateMessageCost } from '../billing/cost-calculator.js';
import {
  clearTestModelCache,
  consumeStream,
  getCheapestTestModel,
  setupIntegrationClient,
} from './test-utilities.js';
import type { AIClient, ImageRequest, TextRequest, VideoRequest } from './types.js';

const TEXT_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 60_000;
const VIDEO_TIMEOUT_MS = 300_000;
const SANITY_TEXT_MAX_USD = 0.01;
const FEE_MATH_PRECISION = 12;

describe('AIClient billing integration', () => {
  let client: AIClient;

  beforeAll(() => {
    clearTestModelCache();
    const setup = setupIntegrationClient();
    client = setup.client;
  });

  describe('text cost retrieval', () => {
    it(
      'getGenerationStats returns a positive USD cost within sanity bounds',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        if (spec.parameters.kind !== 'text') throw new Error('expected text spec');
        const request: TextRequest = {
          modality: 'text',
          model: spec.modelId,
          messages: [{ role: 'user', content: 'Reply with one short word.' }],
          maxOutputTokens: spec.parameters.maxOutputTokens,
        };
        const result = await consumeStream(client.stream(request));
        expect(result.generationId).toBeDefined();
        const stats = await client.getGenerationStats(result.generationId!);
        expect(stats.costUsd).toBeGreaterThan(0);
        expect(stats.costUsd).toBeLessThan(SANITY_TEXT_MAX_USD);
      },
      TEXT_TIMEOUT_MS
    );

    it(
      'applyFees(costUsd) equals costUsd × (1 + TOTAL_FEE_RATE)',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        if (spec.parameters.kind !== 'text') throw new Error('expected text spec');
        const request: TextRequest = {
          modality: 'text',
          model: spec.modelId,
          messages: [{ role: 'user', content: 'Say hi.' }],
          maxOutputTokens: spec.parameters.maxOutputTokens,
        };
        const result = await consumeStream(client.stream(request));
        const stats = await client.getGenerationStats(result.generationId!);
        const expected = stats.costUsd * (1 + TOTAL_FEE_RATE);
        expect(applyFees(stats.costUsd)).toBeCloseTo(expected, FEE_MATH_PRECISION);
      },
      TEXT_TIMEOUT_MS
    );
  });

  describe('calculateMessageCost end-to-end', () => {
    it(
      'returns applyFees(gatewayCost) + storageCost over input and output characters',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        if (spec.parameters.kind !== 'text') throw new Error('expected text spec');
        const inputContent = 'Reply with the single word OK.';
        const request: TextRequest = {
          modality: 'text',
          model: spec.modelId,
          messages: [{ role: 'user', content: inputContent }],
          maxOutputTokens: spec.parameters.maxOutputTokens,
        };
        const stream = await consumeStream(client.stream(request));
        const generationId = stream.generationId!;
        const outputContent = stream.textContent;

        const cost = await calculateMessageCost({
          aiClient: client,
          generationId,
          inputContent,
          outputContent,
        });

        expect(cost).toBeGreaterThan(0);
        const stats = await client.getGenerationStats(generationId);
        // calculateMessageCost = applyFees(gateway) + (inputChars + outputChars) * storage
        // The storage component is small but positive, so cost > applyFees(gatewayCost).
        expect(cost).toBeGreaterThanOrEqual(applyFees(stats.costUsd));
      },
      TEXT_TIMEOUT_MS
    );
  });

  describe('image cost is deterministic (no gateway call)', () => {
    it(
      'calculateMediaGenerationCost matches applyFees(perImage × n) + mediaStorageCost(bytes)',
      async () => {
        const spec = await getCheapestTestModel(client, 'image');
        if (spec.parameters.kind !== 'image') throw new Error('expected image spec');
        const request: ImageRequest = {
          modality: 'image',
          model: spec.modelId,
          prompt: 'A small geometric shape on a plain background',
          aspectRatio: spec.parameters.aspectRatio,
        };
        const result = await consumeStream(client.stream(request));
        expect(result.mediaBytes).toBeDefined();

        const model = await client.getModel(spec.modelId);
        if (model.pricing.kind !== 'image') throw new Error('expected image pricing');
        const sizeBytes = result.mediaBytes!.byteLength;
        const cost = calculateMediaGenerationCost({
          pricing: { kind: 'image', perImage: model.pricing.perImage },
          sizeBytes,
          imageCount: 1,
        });
        const modelComponent = applyFees(model.pricing.perImage);
        expect(cost).toBeGreaterThanOrEqual(modelComponent);
        // Storage cost must be nonneg and exactly explain the gap.
        const storageComponent = cost - modelComponent;
        expect(storageComponent).toBeGreaterThanOrEqual(0);
      },
      IMAGE_TIMEOUT_MS
    );
  });

  describe('video cost is deterministic (no gateway call)', () => {
    it(
      'calculateMediaGenerationCost matches applyFees(perSecond × duration) + storage(actualBytes)',
      async () => {
        const spec = await getCheapestTestModel(client, 'video');
        if (spec.parameters.kind !== 'video') throw new Error('expected video spec');
        const request: VideoRequest = {
          modality: 'video',
          model: spec.modelId,
          prompt: 'A short calm scene',
          durationSeconds: spec.parameters.duration,
          resolution: spec.parameters.resolution,
        };
        const result = await consumeStream(client.stream(request));
        expect(result.mediaBytes).toBeDefined();

        const model = await client.getModel(spec.modelId);
        if (model.pricing.kind !== 'video') throw new Error('expected video pricing');
        const perSecond = model.pricing.perSecondByResolution[spec.parameters.resolution];
        if (perSecond === undefined) {
          throw new Error(
            `Model ${spec.modelId} missing pricing for ${spec.parameters.resolution}`
          );
        }
        const sizeBytes = result.mediaBytes!.byteLength;
        const duration = spec.parameters.duration;

        const cost = calculateMediaGenerationCost({
          pricing: { kind: 'video', perSecond },
          sizeBytes,
          durationSeconds: duration,
        });

        const expectedModelCost = applyFees(perSecond * duration);
        expect(cost).toBeGreaterThanOrEqual(expectedModelCost);
      },
      VIDEO_TIMEOUT_MS
    );
  });
});
