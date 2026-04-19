import { describe, it, expect } from 'vitest';
import { getModelCapabilities, modelSupportsCapability } from './model-capabilities.js';
import type { Model } from '../schemas/api/models.js';

describe('getModelCapabilities', () => {
  it('returns only capabilities with no requirements for model with no supported parameters', () => {
    const model: Model = {
      id: 'test/model',
      name: 'Test Model',
      provider: 'Test',
      modality: 'text' as const,
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      capabilities: [],
      description: 'A test model',
      supportedParameters: [],
    };

    const capabilities = getModelCapabilities(model);

    // Only vision is returned since it has no required parameters
    expect(capabilities).toEqual(['vision']);
  });

  it('returns tool-based capabilities for model with tools support', () => {
    const model: Model = {
      id: 'test/model',
      name: 'Test Model',
      provider: 'Test',
      modality: 'text' as const,
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      capabilities: [],
      description: 'A test model',
      supportedParameters: ['tools', 'temperature'],
    };

    const capabilities = getModelCapabilities(model);

    expect(capabilities).toContain('python-execution');
    expect(capabilities).toContain('javascript-execution');
    expect(capabilities).toContain('vision'); // vision always included
    expect(capabilities).not.toContain('web-search'); // web-search requires web_search_options, not tools
  });

  it('returns web-search capability for model with web_search_options support', () => {
    const model: Model = {
      id: 'test/model',
      name: 'Test Model',
      provider: 'Test',
      modality: 'text' as const,
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      capabilities: [],
      description: 'A test model',
      supportedParameters: ['tools', 'web_search_options', 'temperature'],
    };

    const capabilities = getModelCapabilities(model);

    expect(capabilities).toContain('web-search');
    expect(capabilities).toContain('python-execution');
    expect(capabilities).toContain('javascript-execution');
    expect(capabilities).toContain('vision');
  });

  it('handles undefined supportedParameters gracefully', () => {
    // Simulate a model where supportedParameters might be undefined (e.g., from API)
    const model = {
      id: 'test/model',
      name: 'Test Model',
      provider: 'Test',
      contextLength: 4096,
      pricePerInputToken: 0.001,
      pricePerOutputToken: 0.002,
      capabilities: [],
      description: 'A test model',
      supportedParameters: undefined,
    } as unknown as Model;

    const capabilities = getModelCapabilities(model);

    // Should still return vision since it has no required parameters
    expect(capabilities).toContain('vision');
  });
});

describe('modelSupportsCapability', () => {
  const modelWithToolsAndSearch: Model = {
    id: 'test/model-with-tools-and-search',
    name: 'Test Model With Tools And Search',
    provider: 'Test',
    modality: 'text' as const,
    contextLength: 4096,
    pricePerInputToken: 0.001,
    pricePerOutputToken: 0.002,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    capabilities: [],
    description: 'A test model with tools and web search support',
    supportedParameters: ['tools', 'web_search_options', 'temperature', 'max_tokens'],
  };

  const modelWithToolsOnly: Model = {
    id: 'test/model-with-tools',
    name: 'Test Model With Tools',
    provider: 'Test',
    modality: 'text' as const,
    contextLength: 4096,
    pricePerInputToken: 0.001,
    pricePerOutputToken: 0.002,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    capabilities: [],
    description: 'A test model with tools support',
    supportedParameters: ['tools', 'temperature', 'max_tokens'],
  };

  const modelWithoutTools: Model = {
    id: 'test/model-without-tools',
    name: 'Test Model Without Tools',
    provider: 'Test',
    modality: 'text' as const,
    contextLength: 4096,
    pricePerInputToken: 0.001,
    pricePerOutputToken: 0.002,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    capabilities: [],
    description: 'A test model without tools support',
    supportedParameters: ['temperature', 'max_tokens'],
  };

  it('returns true when model has all required parameters', () => {
    expect(modelSupportsCapability(modelWithToolsAndSearch, 'python-execution')).toBe(true);
    expect(modelSupportsCapability(modelWithToolsAndSearch, 'javascript-execution')).toBe(true);
    expect(modelSupportsCapability(modelWithToolsAndSearch, 'web-search')).toBe(true);
  });

  it('returns false for web-search when model has tools but not web_search_options', () => {
    expect(modelSupportsCapability(modelWithToolsOnly, 'python-execution')).toBe(true);
    expect(modelSupportsCapability(modelWithToolsOnly, 'web-search')).toBe(false);
  });

  it('returns false when model lacks required parameters', () => {
    expect(modelSupportsCapability(modelWithoutTools, 'python-execution')).toBe(false);
    expect(modelSupportsCapability(modelWithoutTools, 'javascript-execution')).toBe(false);
    expect(modelSupportsCapability(modelWithoutTools, 'web-search')).toBe(false);
  });

  it('returns true for capabilities with no required parameters', () => {
    expect(modelSupportsCapability(modelWithToolsAndSearch, 'vision')).toBe(true);
    expect(modelSupportsCapability(modelWithoutTools, 'vision')).toBe(true);
  });
});
