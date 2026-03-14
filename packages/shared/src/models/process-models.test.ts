import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processModels } from './process-models.js';
import {
  AUTO_ROUTER_MODEL_ID,
  AUTO_ROUTER_INPUT_PRICE_PER_TOKEN,
  AUTO_ROUTER_OUTPUT_PRICE_PER_TOKEN,
} from '../constants.js';

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

/** Build a ZDR set containing all model IDs (pass-all filter for non-ZDR tests). */
function allZdr(models: ReturnType<typeof createModel>[]): Set<string> {
  return new Set(models.map((m) => m.id));
}

describe('processModels', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('filtering - ZDR compliance', () => {
    it('filters to only ZDR-compliant models when zdrModelIds provided', () => {
      const models = [
        createModel({ id: 'zdr/model-a' }),
        createModel({ id: 'non-zdr/model-b' }),
        createModel({ id: 'zdr/model-c' }),
      ];
      const zdrModelIds = new Set(['zdr/model-a', 'zdr/model-c']);

      const result = processModels(models, zdrModelIds);

      expect(result.models.map((m) => m.id)).toEqual(['zdr/model-a', 'zdr/model-c']);
    });

    it('excludes non-ZDR models even if they pass other filters', () => {
      const models = [
        createModel({
          id: 'non-zdr/expensive-recent',
          pricing: { prompt: '0.01', completion: '0.01' },
          context_length: 200_000,
          created: Math.floor(now / 1000),
        }),
        createModel({ id: 'zdr/basic' }),
      ];
      const zdrModelIds = new Set(['zdr/basic']);

      const result = processModels(models, zdrModelIds);

      expect(result.models.map((m) => m.id)).toEqual(['zdr/basic']);
    });
  });

  describe('filtering - always excluded', () => {
    it('excludes free models (both prices = 0)', () => {
      const models = [
        createModel({ id: 'paid/model' }),
        createModel({ id: 'free/model', pricing: { prompt: '0', completion: '0' } }),
      ];

      const result = processModels(models, allZdr(models));

      expect(result.models.map((m) => m.id)).toEqual(['paid/model']);
    });

    it('excludes Body Builder models', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'utility/builder', name: 'Body Builder (beta)' }),
      ];

      const result = processModels(models, allZdr(models));

      expect(result.models.map((m) => m.id)).toEqual(['normal/model']);
    });

    it('excludes Auto Router models', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'utility/router', name: 'Auto Router' }),
      ];

      const result = processModels(models, allZdr(models));

      expect(result.models.map((m) => m.id)).toEqual(['normal/model']);
    });

    it('excludes models with audio in name', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'openai/gpt-audio', name: 'GPT Audio' }),
        createModel({ id: 'openai/audio-preview', name: 'OpenAI: Audio Preview' }),
      ];

      const result = processModels(models, allZdr(models));

      expect(result.models.map((m) => m.id)).toEqual(['normal/model']);
    });

    it('excludes models with image in name', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'openai/gpt-image', name: 'GPT Image' }),
        createModel({ id: 'openai/image-gen', name: 'OpenAI: Image Generator' }),
      ];

      const result = processModels(models, allZdr(models));

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

      const result = processModels(models, allZdr(models));

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

      const result = processModels(models, allZdr(models));

      expect(result.models.map((m) => m.id)).toEqual(['text/model']);
    });

    it('includes multimodal models with text input and output', () => {
      const models = [
        createModel({
          id: 'vision/model',
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        }),
      ];

      const result = processModels(models, allZdr(models));

      expect(result.models.map((m) => m.id)).toEqual(['vision/model']);
    });

    it('applies name pattern matching case-insensitively', () => {
      const models = [
        createModel({ id: 'normal/model' }),
        createModel({ id: 'utility/1', name: 'BODY BUILDER' }),
        createModel({ id: 'utility/2', name: 'auto router' }),
      ];

      const result = processModels(models, allZdr(models));

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

      const result = processModels(models, allZdr(models));

      expect(result.models.map((m) => m.id)).not.toContain('old/model');
    });

    it('includes models at exactly 2 years old', () => {
      const models = [
        createModel({ id: 'boundary/model', created: Math.floor(twoYearsAgo / 1000) }),
      ];

      const result = processModels(models, allZdr(models));

      expect(result.models.map((m) => m.id)).toEqual(['boundary/model']);
    });

    it('excludes models cheaper than $0.0002 per 1K tokens combined', () => {
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

      const result = processModels(models, allZdr(models));

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

      const result = processModels(models, allZdr(models));

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

      const result = processModels(models, allZdr(models));

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

      const result = processModels(models, allZdr(models));

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

      const result = processModels(models, allZdr(models));

      expect(result.models.map((m) => m.id)).not.toContain('utility-large-context/model');
    });
  });

  describe('premium classification', () => {
    it('marks models in top 25% price as premium', () => {
      // Use realistic per-token prices ($0.001/1K to $0.01/1K per side)
      const models = Array.from({ length: 10 }, (_, index) =>
        createModel({
          id: `model-${String(index)}`,
          pricing: {
            prompt: String(0.000_001 * (index + 1)),
            completion: String(0.000_001 * (index + 1)),
          },
          created: Math.floor(twoYearsAgo / 1000), // Old, so recency doesn't make them premium
        })
      );

      const result = processModels(models, allZdr(models));

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

      const result = processModels(models, allZdr(models));

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

      const result = processModels(models, allZdr(models));

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

      const result = processModels(models, allZdr(models));
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
        const result = processModels(models, allZdr(models));
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

      const result = processModels(models, allZdr(models));

      expect(result.models[0]?.provider).toBe('Acme Corp');
      expect(result.models[0]?.name).toBe('Super Model');
    });

    it('splits on first colon when name has multiple colons', () => {
      const models = [
        createModel({
          id: 'someunknown/model',
          name: 'Provider: Model: Version 2',
        }),
      ];

      const result = processModels(models, allZdr(models));

      expect(result.models[0]?.provider).toBe('Provider');
      expect(result.models[0]?.name).toBe('Model: Version 2');
    });

    it('falls back to ID prefix when name has only whitespace after colon', () => {
      const models = [
        createModel({
          id: 'openai/model',
          name: 'Provider:   ',
        }),
      ];

      const result = processModels(models, allZdr(models));

      expect(result.models[0]?.provider).toBe('OpenAI');
    });

    it('derives internet-search capability from web_search_options parameter', () => {
      const modelsData = [
        createModel({
          id: 'with-search/model',
          supported_parameters: ['tools', 'web_search_options'],
        }),
        createModel({
          id: 'without-search/model',
          supported_parameters: ['tools', 'temperature'],
        }),
        createModel({
          id: 'basic/model',
          supported_parameters: ['temperature'],
        }),
      ];

      const result = processModels(modelsData, allZdr(modelsData));

      const withSearch = result.models.find((m) => m.id === 'with-search/model');
      const withoutSearch = result.models.find((m) => m.id === 'without-search/model');
      const basic = result.models.find((m) => m.id === 'basic/model');

      expect(withSearch?.capabilities).toEqual(['internet-search']);
      expect(withoutSearch?.capabilities).toEqual([]);
      expect(basic?.capabilities).toEqual([]);
    });

    it('extracts webSearchPrice from pricing.web_search', () => {
      const modelsData = [
        createModel({
          id: 'search/model',
          pricing: { prompt: '0.001', completion: '0.002', web_search: '0.005' },
          supported_parameters: ['web_search_options'],
        }),
      ];

      const result = processModels(modelsData, allZdr(modelsData));
      const model = result.models.find((m) => m.id === 'search/model');

      expect(model?.webSearchPrice).toBe(0.005);
    });

    it('omits webSearchPrice when pricing.web_search is absent', () => {
      const modelsData = [
        createModel({
          id: 'no-search/model',
          pricing: { prompt: '0.001', completion: '0.002' },
        }),
      ];

      const result = processModels(modelsData, allZdr(modelsData));
      const model = result.models.find((m) => m.id === 'no-search/model');

      expect(model?.webSearchPrice).toBeUndefined();
    });
  });

  describe('auto-router', () => {
    const autoRouterRaw = createModel({
      id: AUTO_ROUTER_MODEL_ID,
      name: 'Auto Router',
      description: 'Automatically selects the best model for your task',
      context_length: 2_000_000,
      pricing: { prompt: '0', completion: '0' },
    });

    it('includes auto-router when present in ZDR list', () => {
      const models = [createModel({ id: 'normal/model' }), autoRouterRaw];

      const result = processModels(models, allZdr(models));

      expect(result.models.map((m) => m.id)).toContain(AUTO_ROUTER_MODEL_ID);
    });

    it('includes auto-router even when not in ZDR set', () => {
      const normal = createModel({ id: 'normal/model' });
      const models = [normal, autoRouterRaw];
      const zdr = new Set([normal.id]); // auto-router NOT in ZDR set

      const result = processModels(models, zdr);

      expect(result.models.map((m) => m.id)).toContain(AUTO_ROUTER_MODEL_ID);
    });

    it('sets isAutoRouter flag on the auto-router model', () => {
      const models = [createModel({ id: 'normal/model' }), autoRouterRaw];

      const result = processModels(models, allZdr(models));
      const autoModel = result.models.find((m) => m.id === AUTO_ROUTER_MODEL_ID);

      expect(autoModel?.isAutoRouter).toBe(true);
    });

    it('uses hardcoded client estimation prices', () => {
      const models = [createModel({ id: 'normal/model' }), autoRouterRaw];

      const result = processModels(models, allZdr(models));
      const autoModel = result.models.find((m) => m.id === AUTO_ROUTER_MODEL_ID);

      expect(autoModel?.pricePerInputToken).toBe(AUTO_ROUTER_INPUT_PRICE_PER_TOKEN);
      expect(autoModel?.pricePerOutputToken).toBe(AUTO_ROUTER_OUTPUT_PRICE_PER_TOKEN);
    });

    it('computes price ranges from the model pool', () => {
      const cheapModel = createModel({
        id: 'cheap/model',
        pricing: { prompt: '0.0001', completion: '0.0002' },
      });
      const expensiveModel = createModel({
        id: 'expensive/model',
        pricing: { prompt: '0.01', completion: '0.02' },
      });
      const models = [cheapModel, expensiveModel, autoRouterRaw];

      const result = processModels(models, allZdr(models));
      const autoModel = result.models.find((m) => m.id === AUTO_ROUTER_MODEL_ID);

      expect(autoModel?.minPricePerInputToken).toBe(0.0001);
      expect(autoModel?.minPricePerOutputToken).toBe(0.0002);
      expect(autoModel?.maxPricePerInputToken).toBe(0.01);
      expect(autoModel?.maxPricePerOutputToken).toBe(0.02);
    });

    it('does not classify auto-router as premium', () => {
      const models = [createModel({ id: 'normal/model' }), autoRouterRaw];

      const result = processModels(models, allZdr(models));

      expect(result.premiumIds).not.toContain(AUTO_ROUTER_MODEL_ID);
    });

    it('uses "Smart Model" as display name', () => {
      const models = [createModel({ id: 'normal/model' }), autoRouterRaw];

      const result = processModels(models, allZdr(models));
      const autoModel = result.models.find((m) => m.id === AUTO_ROUTER_MODEL_ID);

      expect(autoModel?.name).toBe('Smart Model');
    });

    it('does not include auto-router when pool is empty after filtering', () => {
      const models = [autoRouterRaw]; // Only auto-router, no other models

      const result = processModels(models, allZdr(models));

      expect(result.models.map((m) => m.id)).not.toContain(AUTO_ROUTER_MODEL_ID);
    });

    it('preserves context length from OpenRouter', () => {
      const models = [createModel({ id: 'normal/model' }), autoRouterRaw];

      const result = processModels(models, allZdr(models));
      const autoModel = result.models.find((m) => m.id === AUTO_ROUTER_MODEL_ID);

      expect(autoModel?.contextLength).toBe(2_000_000);
    });
  });

  describe('trial affordability classification', () => {
    it('marks models that exceed trial budget as premium even when below price percentile', () => {
      // Need enough models so that Sonar Reasoning Pro pricing is NOT in the top 25% by combined price,
      // but IS too expensive for trial users due to high output cost.
      // Sonar Reasoning Pro: prompt=$0.0023/1K, completion=$0.0092/1K → combined=$0.0115/1K
      // Add models with higher combined prices so Sonar isn't in top 25% by price.
      const models = [
        // 8 models more expensive (combined price) than Sonar — keeps Sonar below 75th percentile
        ...Array.from({ length: 8 }, (_, index) =>
          createModel({
            id: `expensive/model-${String(index)}`,
            pricing: { prompt: '0.00005', completion: '0.00005' }, // $0.1/1K combined — very expensive
            created: Math.floor(twoYearsAgo / 1000),
          })
        ),
        // 4 models cheaper than Sonar
        ...Array.from({ length: 4 }, (_, index) =>
          createModel({
            id: `cheap/model-${String(index)}`,
            pricing: { prompt: '0.000001', completion: '0.000001' }, // $0.002/1K combined — cheap
            created: Math.floor(twoYearsAgo / 1000),
          })
        ),
        // Sonar Reasoning Pro: below 75th percentile by combined price, but output too expensive for trial
        createModel({
          id: 'perplexity/sonar-reasoning-pro',
          pricing: { prompt: '0.0000023', completion: '0.0000092' },
          created: Math.floor(twoYearsAgo / 1000),
        }),
      ];

      const result = processModels(models, allZdr(models));

      // Sonar should be marked premium due to trial affordability, not price percentile
      expect(result.premiumIds).toContain('perplexity/sonar-reasoning-pro');
      // Cheap models should NOT be premium
      expect(result.premiumIds).not.toContain('cheap/model-0');
    });
  });

  describe('edge cases', () => {
    it('handles empty array', () => {
      const result = processModels([], new Set());

      expect(result.models).toEqual([]);
      expect(result.premiumIds).toEqual([]);
    });

    it('handles single model', () => {
      const models = [createModel({ id: 'only/model' })];

      const result = processModels(models, allZdr(models));

      expect(result.models).toHaveLength(1);
      expect(result.models[0]?.id).toBe('only/model');
    });
  });
});
