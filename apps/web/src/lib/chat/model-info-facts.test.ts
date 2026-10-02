import { describe, it, expect } from 'vitest';
import { modelSwatch } from '@/lib/utils/model-color';
import { modelInfoFacts, modelSelectionLabel, SMART_MODEL_ROLE } from './model-info-facts';
import type { Model } from '@hushbox/shared';

// Rates are BILLABLE nano-USD per token (or per image), as the catalog serves them.
function buildModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'anthropic/claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    provider: 'Anthropic',
    modality: 'text',
    contextLength: 200_000,
    pricing: { inputPerToken: '3450', outputPerToken: '17250' },
    description: 'A capable model.',
    supportedParameters: [],
    ...overrides,
  };
}

function smartModel(overrides: Partial<Model> = {}): Model {
  return buildModel({
    id: 'smart-model',
    name: 'Smart Model',
    provider: 'HushBox',
    isSmartModel: true,
    pricing: {},
    minPricing: { inputPerToken: '35', outputPerToken: '115' },
    maxPricing: { inputPerToken: '34500', outputPerToken: '207000' },
    ...overrides,
  });
}

function imageModel(overrides: Partial<Model> = {}): Model {
  return buildModel({
    id: 'bytedance-seed/seedream-4.5',
    name: 'Seedream 4.5',
    provider: 'ByteDance Seed',
    modality: 'image',
    contextLength: 0,
    pricing: { perImage: '46000000', dearestPerImage: '46000000' },
    ...overrides,
  });
}

describe('modelInfoFacts', () => {
  describe('a text model', () => {
    it('names the model', () => {
      expect(modelInfoFacts(buildModel(), 1, true).label).toBe('Claude Sonnet 4.5');
    });

    it('names the model by its short name, as the chip does', () => {
      const facts = modelInfoFacts(buildModel({ name: 'GPT-4o-2024-08-06' }), 1, true);

      expect(facts.label).toBe('GPT-4o');
    });

    it('takes the model its own swatch', () => {
      const model = buildModel();

      expect(modelInfoFacts(model, 1, true).swatch).toBe(modelSwatch(model.id));
    });

    it('names its maker', () => {
      expect(modelInfoFacts(buildModel(), 1, true).maker).toBe('Anthropic');
    });

    it('gives an account its input and output rates per 1k', () => {
      expect(modelInfoFacts(buildModel(), 1, true).rates).toEqual([
        { kind: 'input', value: '$0.00345/1k' },
        { kind: 'output', value: '$0.01725/1k' },
      ]);
    });

    it('gives a visitor no rates', () => {
      expect(modelInfoFacts(buildModel(), 1, false).rates).toEqual([]);
    });

    it('shows no rate for a row stating only one, which prices nothing rather than half', () => {
      const model = buildModel({ pricing: { inputPerToken: '3450' } });

      expect(modelInfoFacts(model, 1, true).rates).toEqual([]);
    });
  });

  describe('the Smart Model', () => {
    it('reads as the model that picks for you', () => {
      expect(modelInfoFacts(smartModel(), 1, true).maker).toBe('Auto-picks the best model');
    });

    it('gives an account the range of its pool per 1k', () => {
      expect(modelInfoFacts(smartModel(), 1, true).rates).toEqual([
        { kind: 'input', value: '$0.000035–0.0345/1k' },
        { kind: 'output', value: '$0.000115–0.207/1k' },
      ]);
    });

    it('drops a range whose bound the catalog does not carry', () => {
      const model = smartModel({ maxPricing: { outputPerToken: '207000' } });

      expect(modelInfoFacts(model, 1, true).rates).toEqual([
        { kind: 'output', value: '$0.000115–0.207/1k' },
      ]);
    });

    it('gives a visitor no range', () => {
      expect(modelInfoFacts(smartModel(), 1, false).rates).toEqual([]);
    });
  });

  describe('an image model', () => {
    it('names its maker', () => {
      expect(modelInfoFacts(imageModel(), 1, true).maker).toBe('ByteDance Seed');
    });

    it('gives an account its price per image', () => {
      expect(modelInfoFacts(imageModel(), 1, true).rates).toEqual([
        { kind: 'image', value: '$0.046/image' },
      ]);
    });

    it('gives a visitor no price', () => {
      expect(modelInfoFacts(imageModel(), 1, false).rates).toEqual([]);
    });

    it('shows no price the catalog does not carry', () => {
      expect(modelInfoFacts(imageModel({ pricing: {} }), 1, true).rates).toEqual([]);
    });
  });

  describe('a video model', () => {
    const video = buildModel({
      id: 'google/veo-3.1',
      name: 'Veo 3.1',
      provider: 'Google',
      modality: 'video',
      contextLength: 0,
      pricing: { perSecondByResolution: { '720p': '460000000' } },
    });

    it('names its maker', () => {
      expect(modelInfoFacts(video, 1, true).maker).toBe('Google');
    });

    it('shows no rate', () => {
      expect(modelInfoFacts(video, 1, true).rates).toEqual([]);
    });
  });

  describe('an audio model', () => {
    const audio = buildModel({
      id: 'openai/tts',
      name: 'TTS',
      provider: 'OpenAI',
      modality: 'audio',
      contextLength: 0,
      pricing: {},
    });

    it('names its maker', () => {
      expect(modelInfoFacts(audio, 1, true).maker).toBe('OpenAI');
    });

    it('shows no rate', () => {
      expect(modelInfoFacts(audio, 1, true).rates).toEqual([]);
    });
  });

  describe('several models', () => {
    it("reads as the chip's label: the first model and how many more", () => {
      expect(modelInfoFacts(buildModel(), 3, true).label).toBe('Claude Sonnet 4.5 + 2');
    });

    it("keeps the first model's swatch", () => {
      const model = buildModel();

      expect(modelInfoFacts(model, 3, true).swatch).toBe(modelSwatch(model.id));
    });

    it('names no maker', () => {
      expect(modelInfoFacts(buildModel(), 2, true).maker).toBeUndefined();
    });

    it('gives an account no rates', () => {
      expect(modelInfoFacts(buildModel(), 2, true).rates).toEqual([]);
    });
  });
});

describe('modelSelectionLabel', () => {
  it('names one model by its short name', () => {
    expect(modelSelectionLabel('GPT-4o-2024-08-06', 1)).toBe('GPT-4o');
  });

  it('names several models by the first and how many more', () => {
    expect(modelSelectionLabel('Claude Sonnet 4.5', 3)).toBe('Claude Sonnet 4.5 + 2');
  });

  it('shortens the first name when there are several', () => {
    expect(modelSelectionLabel('GPT-4o-2024-08-06', 2)).toBe('GPT-4o + 1');
  });
});

describe('SMART_MODEL_ROLE', () => {
  it("is the Smart Model's line", () => {
    expect(SMART_MODEL_ROLE).toBe('Auto-picks the best model');
  });
});
