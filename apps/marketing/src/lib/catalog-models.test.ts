import { describe, it, expect } from 'vitest';
import { SMART_MODEL_ID } from '@hushbox/shared';
import { catalogModels } from './catalog-models';
import type { Model } from '@hushbox/shared';

function makeModel(id: string, provider: string): Model {
  return {
    id,
    name: 'Test',
    provider,
    modality: 'text',
    contextLength: 128_000,
    pricing: { inputPerToken: '1000', outputPerToken: '2000' },
    description: 'Test',
    supportedParameters: [],
  };
}

describe('catalogModels', () => {
  it('drops the Smart Model entry', () => {
    const models = [makeModel('openai/gpt', 'OpenAI'), makeModel(SMART_MODEL_ID, 'HushBox')];
    expect(catalogModels(models).map((m) => m.id)).toEqual(['openai/gpt']);
  });

  it('finds the Smart Model by its id rather than its provider name', () => {
    const models = [makeModel(SMART_MODEL_ID, 'Renamed'), makeModel('hushbox/other', 'HushBox')];
    expect(catalogModels(models).map((m) => m.id)).toEqual(['hushbox/other']);
  });

  it('keeps every other model in catalog order', () => {
    const models = [makeModel('b/two', 'B'), makeModel('a/one', 'A')];
    expect(catalogModels(models)).toEqual(models);
  });
});
