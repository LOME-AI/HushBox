import { describe, it, expect } from 'vitest';
import { modelSchema, type Model, modelCapabilitySchema, type ModelCapability } from './models.js';

describe('modelCapabilitySchema', () => {
  it('accepts valid capabilities', () => {
    const validCapabilities: ModelCapability[] = ['internet-search'];

    for (const cap of validCapabilities) {
      const result = modelCapabilitySchema.safeParse(cap);
      expect(result.success).toBe(true);
    }
  });

  it('rejects old capability values', () => {
    const oldCapabilities = ['vision', 'functions', 'json-mode', 'streaming'];

    for (const cap of oldCapabilities) {
      const result = modelCapabilitySchema.safeParse(cap);
      expect(result.success).toBe(false);
    }
  });

  it('rejects invalid capabilities', () => {
    const result = modelCapabilitySchema.safeParse('invalid-capability');
    expect(result.success).toBe(false);
  });
});

describe('modelSchema', () => {
  it('parses a valid model object', () => {
    const validModel = {
      id: 'gpt-4-turbo',
      name: 'GPT-4 Turbo',
      provider: 'OpenAI',
      contextLength: 128_000,
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0.000_03,
      capabilities: ['internet-search'],
      description: 'A powerful language model from OpenAI.',
    };

    const result = modelSchema.safeParse(validModel);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        ...validModel,
        supportedParameters: [],
        modality: 'text',
        pricePerImage: 0,
      });
    }
  });

  it('requires description field', () => {
    const modelWithoutDescription = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
    };

    const result = modelSchema.safeParse(modelWithoutDescription);
    expect(result.success).toBe(false);
  });

  it('requires all fields', () => {
    const incompleteModel = {
      id: 'gpt-4',
      name: 'GPT-4',
    };

    const result = modelSchema.safeParse(incompleteModel);
    expect(result.success).toBe(false);
  });

  it('validates contextLength is positive', () => {
    const invalidModel = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: -1,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(invalidModel);
    expect(result.success).toBe(false);
  });

  it('validates prices are non-negative', () => {
    const invalidModel = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: -0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(invalidModel);
    expect(result.success).toBe(false);
  });

  it('allows empty capabilities array', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
  });

  it('accepts optional created timestamp', () => {
    const modelWithCreated = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
      created: 1_704_067_200, // 2024-01-01
    };

    const result = modelSchema.safeParse(modelWithCreated);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.created).toBe(1_704_067_200);
    }
  });

  it('allows model without created timestamp', () => {
    const modelWithoutCreated = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(modelWithoutCreated);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.created).toBeUndefined();
    }
  });
});

describe('Model type', () => {
  it('infers correct type from schema', () => {
    const model: Model = {
      id: 'test-model',
      name: 'Test Model',
      provider: 'Test Provider',
      modality: 'text' as const,
      contextLength: 8192,
      pricePerInputToken: 0.0001,
      pricePerOutputToken: 0.0002,
      pricePerImage: 0,
      capabilities: ['internet-search'],
      description: 'A test model for type inference.',
      supportedParameters: ['temperature', 'web_search_options'],
    };

    expect(model.id).toBe('test-model');
    expect(model.capabilities).toContain('internet-search');
    expect(model.description).toBe('A test model for type inference.');
  });

  it('accepts optional webSearchPrice', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: ['internet-search'],
      description: 'Test description.',
      webSearchPrice: 0.005,
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webSearchPrice).toBe(0.005);
    }
  });

  it('allows model without webSearchPrice', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webSearchPrice).toBeUndefined();
    }
  });

  it('rejects negative webSearchPrice', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
      webSearchPrice: -0.01,
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(false);
  });

  it('accepts optional isSmartModel flag', () => {
    const model = {
      id: 'smart-model',
      name: 'Smart Model',
      provider: 'HushBox',
      contextLength: 2_000_000,
      pricePerInputToken: 0.000_000_039,
      pricePerOutputToken: 0.000_000_19,
      capabilities: [],
      description: 'Uses the best model for your task',
      isSmartModel: true,
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isSmartModel).toBe(true);
    }
  });

  it('defaults isSmartModel to undefined when omitted', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isSmartModel).toBeUndefined();
    }
  });

  it('accepts Smart Model price range fields', () => {
    const model = {
      id: 'smart-model',
      name: 'Smart Model',
      provider: 'HushBox',
      contextLength: 2_000_000,
      pricePerInputToken: 0.000_000_039,
      pricePerOutputToken: 0.000_000_19,
      capabilities: [],
      description: 'Uses the best model for your task',
      isSmartModel: true,
      minPricePerInputToken: 0.000_000_039,
      minPricePerOutputToken: 0.000_000_19,
      maxPricePerInputToken: 0.000_06,
      maxPricePerOutputToken: 0.000_18,
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.minPricePerInputToken).toBe(0.000_000_039);
      expect(result.data.maxPricePerOutputToken).toBe(0.000_18);
    }
  });

  it('rejects negative price range values', () => {
    const model = {
      id: 'test',
      name: 'Test',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'Test description.',
      minPricePerInputToken: -0.001,
    };

    const result = modelSchema.safeParse(model);
    expect(result.success).toBe(false);
  });
});
