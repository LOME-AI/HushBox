import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processModels } from './models.js';

// ============================================================
// Test Fixtures
// ============================================================

const now = Date.now();
const twoYearsAgo = now - 2 * 365 * 24 * 60 * 60 * 1000;
const threeYearsAgo = now - 3 * 365 * 24 * 60 * 60 * 1000;

function createModel(overrides: Partial<Parameters<typeof processModels>[0][0]> = {}) {
  return {
    id: 'test/model',
    name: 'Test Model',
    description: 'A test model',
    context_length: 100_000,
    pricing: { prompt: '0.001', completion: '0.002' },
    supported_parameters: ['temperature'],
    created: Math.floor(now / 1000),
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
    },
    ...overrides,
  };
}

describe('processModels', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('filtering - always excluded', () => {
    it('excludes free models (both prices = 0)', () => {
      const models = [
        createModel({ id: 'paid/model' }),
        createModel({ id: 'free/model', pricing: { prompt: '0', completion: '0' } }),
      ];

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toEqual(['paid/model']);
    });

    it('excludes Body Builder models', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'utility/builder', name: 'Body Builder (beta)' }),
      ];

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toEqual(['normal/model']);
    });

    it('excludes Auto Router models', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'utility/router', name: 'Auto Router' }),
      ];

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toEqual(['normal/model']);
    });

    it('excludes models with audio in name', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'openai/gpt-audio', name: 'GPT Audio' }),
        createModel({ id: 'openai/audio-preview', name: 'OpenAI: Audio Preview' }),
      ];

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toEqual(['normal/model']);
    });

    it('excludes models with image in name', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'openai/gpt-image', name: 'GPT Image' }),
        createModel({ id: 'openai/image-gen', name: 'OpenAI: Image Generator' }),
      ];

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toEqual(['normal/model']);
    });

    it('excludes models without text in input_modalities', () => {
      const models = [
        createModel({ id: 'text/model' }),
        createModel({
          id: 'image-only/model',
          architecture: { input_modalities: ['image'], output_modalities: ['text'] },
        }),
      ];

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toEqual(['text/model']);
    });

    it('excludes models without text in output_modalities', () => {
      const models = [
        createModel({ id: 'text/model' }),
        createModel({
          id: 'embedding/model',
          architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] },
        }),
      ];

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toEqual(['text/model']);
    });

    it('includes multimodal models with text input and output', () => {
      const models = [
        createModel({
          id: 'vision/model',
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        }),
      ];

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toEqual(['vision/model']);
    });

    it('applies name pattern matching case-insensitively', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'utility/1', name: 'BODY BUILDER' }),
        createModel({ id: 'utility/2', name: 'auto router' }),
      ];

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toEqual(['normal/model']);
    });
  });

  describe('filtering - standard criteria (bypassable)', () => {
    it('excludes models older than 2 years', () => {
      const models = Array.from({ length: 20 }, (_, index) =>
        createModel({
          id: `recent/model-${String(index)}`,
          context_length: 200_000,
          created: Math.floor(now / 1000),
        })
      );
      // Add old model with lower context (won't be in top 5%)
      models.push(
        createModel({
          id: 'old/model',
          context_length: 50_000,
          created: Math.floor(threeYearsAgo / 1000),
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).not.toContain('old/model');
    });

    it('includes models at exactly 2 years old', () => {
      const models = [
        createModel({ id: 'boundary/model', created: Math.floor(twoYearsAgo / 1000) }),
      ];

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toEqual(['boundary/model']);
    });

    it('excludes models cheaper than $0.001 per 1K tokens combined', () => {
      const models = Array.from({ length: 20 }, (_, index) =>
        createModel({
          id: `expensive/model-${String(index)}`,
          context_length: 200_000,
          pricing: { prompt: '0.001', completion: '0.001' },
        })
      );
      models.push(
        createModel({
          id: 'cheap/model',
          context_length: 50_000,
          pricing: { prompt: '0.0000001', completion: '0.0000001' },
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).not.toContain('cheap/model');
    });
  });

  describe('filtering - top 5% context bypass', () => {
    it('includes old models if in top 5% context size', () => {
      const models = Array.from({ length: 99 }, (_, index) =>
        createModel({
          id: `normal/model-${String(index)}`,
          context_length: 100_000,
          created: Math.floor(now / 1000),
        })
      );
      models.push(
        createModel({
          id: 'old-but-large-context/model',
          context_length: 2_000_000, // Much larger than others
          created: Math.floor(threeYearsAgo / 1000),
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toContain('old-but-large-context/model');
    });

    it('includes cheap models if in top 5% context size', () => {
      const models = Array.from({ length: 99 }, (_, index) =>
        createModel({
          id: `normal/model-${String(index)}`,
          context_length: 100_000,
          pricing: { prompt: '0.001', completion: '0.001' },
        })
      );
      models.push(
        createModel({
          id: 'cheap-but-large-context/model',
          context_length: 2_000_000,
          pricing: { prompt: '0.0000001', completion: '0.0000001' },
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).toContain('cheap-but-large-context/model');
    });

    it('still excludes top context models if always-excluded (free)', () => {
      const models = Array.from({ length: 99 }, (_, index) =>
        createModel({
          id: `normal/model-${String(index)}`,
          context_length: 100_000,
        })
      );
      models.push(
        createModel({
          id: 'free-large-context/model',
          context_length: 2_000_000,
          pricing: { prompt: '0', completion: '0' },
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).not.toContain('free-large-context/model');
    });

    it('still excludes top context models if always-excluded (name pattern)', () => {
      const models = Array.from({ length: 99 }, (_, index) =>
        createModel({
          id: `normal/model-${String(index)}`,
          context_length: 100_000,
        })
      );
      models.push(
        createModel({
          id: 'utility-large-context/model',
          context_length: 2_000_000,
          name: 'Body Builder Large',
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).not.toContain('utility-large-context/model');
    });
  });

  describe('premium classification', () => {
    it('marks models in top 25% price as premium', () => {
      const models = Array.from({ length: 10 }, (_, index) =>
        createModel({
          id: `model-${String(index)}`,
          pricing: {
            prompt: String(0.001 * (index + 1)),
            completion: String(0.001 * (index + 1)),
          },
          created: Math.floor(twoYearsAgo / 1000), // Old, so recency doesn't make them premium
        })
      );

      const result = processModels(models);

      expect(result.premiumIds).toContain('model-9');
      expect(result.premiumIds).toContain('model-8');
      expect(result.premiumIds).not.toContain('model-0');
    });

    it('marks recent models as premium regardless of price', () => {
      const models = [
        createModel({
          id: 'old-expensive/model',
          pricing: { prompt: '0.1', completion: '0.1' },
          created: Math.floor(twoYearsAgo / 1000),
        }),
        createModel({
          id: 'new-cheap/model',
          pricing: { prompt: '0.0001', completion: '0.0001' },
          created: Math.floor(now / 1000),
        }),
      ];

      const result = processModels(models);

      expect(result.premiumIds).toContain('new-cheap/model');
    });

    it('calculates price percentile on filtered models only', () => {
      const models = Array.from({ length: 20 }, (_, index) =>
        createModel({
          id: `normal/model-${String(index)}`,
          context_length: 200_000,
          pricing: { prompt: '0.001', completion: '0.001' },
        })
      );
      models.push(
        createModel({
          id: 'old-expensive/model',
          context_length: 50_000,
          pricing: { prompt: '1.0', completion: '1.0' },
          created: Math.floor(threeYearsAgo / 1000),
        })
      );

      const result = processModels(models);

      expect(result.models.map((m) => m.id)).not.toContain('old-expensive/model');
      expect(result.models).toHaveLength(20);
    });
  });

  describe('transformation', () => {
    it('transforms OpenRouter model to Model type', () => {
      const models = [
        createModel({
          id: 'openai/gpt-4-turbo',
          name: 'GPT-4 Turbo',
          description: 'Most capable GPT-4',
          context_length: 128_000,
          pricing: { prompt: '0.00001', completion: '0.00003' },
          supported_parameters: ['temperature', 'tools', 'tool_choice'],
          created: 1_704_067_200,
        }),
      ];

      const result = processModels(models);
      const model = result.models[0];

      expect(model).toMatchObject({
        id: 'openai/gpt-4-turbo',
        name: 'GPT-4 Turbo',
        description: 'Most capable GPT-4',
        provider: 'OpenAI',
        contextLength: 128_000,
        pricePerInputToken: 0.000_01,
        pricePerOutputToken: 0.000_03,
        created: 1_704_067_200,
      });
    });

    it('extracts provider from model ID prefix', () => {
      const testCases = [
        { id: 'openai/gpt-4', expected: 'OpenAI' },
        { id: 'anthropic/claude', expected: 'Anthropic' },
        { id: 'google/gemini', expected: 'Google' },
        { id: 'meta-llama/llama-3', expected: 'Meta' },
        { id: 'mistral/mistral-large', expected: 'Mistral' },
        { id: 'deepseek/deepseek-r1', expected: 'DeepSeek' },
        { id: 'unknown/model', expected: 'Unknown' },
      ];

      for (const { id, expected } of testCases) {
        const models = [createModel({ id })];
        const result = processModels(models);
        expect(result.models[0]?.provider).toBe(expected);
      }
    });

    it('extracts provider from name format "Provider: Model Name"', () => {
      const models = [
        createModel({
          id: 'someunknown/model',
          name: 'Acme Corp: Super Model',
        }),
      ];

      const result = processModels(models);

      expect(result.models[0]?.provider).toBe('Acme Corp');
      expect(result.models[0]?.name).toBe('Super Model');
    });

    it('derives capabilities from supported_parameters', () => {
      const modelsData = [
        createModel({
          id: 'with-tools/model',
          supported_parameters: ['tools', 'tool_choice'],
        }),
        createModel({
          id: 'with-json/model',
          supported_parameters: ['response_format'],
        }),
        createModel({
          id: 'basic/model',
          supported_parameters: ['temperature'],
        }),
      ];

      const result = processModels(modelsData);

      const withTools = result.models.find((m) => m.id === 'with-tools/model');
      const withJson = result.models.find((m) => m.id === 'with-json/model');
      const basic = result.models.find((m) => m.id === 'basic/model');

      expect(withTools?.capabilities).toContain('functions');
      expect(withJson?.capabilities).toContain('json-mode');
      expect(basic?.capabilities).toContain('streaming');
      expect(basic?.capabilities).not.toContain('functions');
    });
  });

  describe('edge cases', () => {
    it('handles empty array', () => {
      const result = processModels([]);

      expect(result.models).toEqual([]);
      expect(result.premiumIds).toEqual([]);
    });

    it('handles single model', () => {
      const models = [createModel({ id: 'only/model' })];

      const result = processModels(models);

      expect(result.models).toHaveLength(1);
      expect(result.models[0]?.id).toBe('only/model');
    });
  });
});
