import { describe, it, expect } from 'vitest';
import { createFastMockOpenRouterClient } from './openrouter-mocks.js';

describe('createFastMockOpenRouterClient', () => {
  it('creates a mock client with default options', () => {
    const client = createFastMockOpenRouterClient();
    expect(client).toBeDefined();
    expect(typeof client.chatCompletion).toBe('function');
    expect(typeof client.chatCompletionStream).toBe('function');
    expect(typeof client.chatCompletionStreamWithMetadata).toBe('function');
    expect(typeof client.listModels).toBe('function');
    expect(typeof client.getModel).toBe('function');
    expect(typeof client.getGenerationStats).toBe('function');
  });

  it('chatCompletion returns mock response', async () => {
    const client = createFastMockOpenRouterClient();
    const result = await client.chatCompletion({
      model: 'test',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.id).toBe('mock-123');
    expect(result.choices[0]?.message.content).toBe('Echo: Hello');
  });

  it('chatCompletion uses custom stream content', async () => {
    const client = createFastMockOpenRouterClient({ streamContent: 'Custom response' });
    const result = await client.chatCompletion({
      model: 'test',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.choices[0]?.message.content).toBe('Custom response');
  });

  it('chatCompletionStream yields characters', async () => {
    const client = createFastMockOpenRouterClient({ streamContent: 'ABC' });
    const chars: string[] = [];

    for await (const char of client.chatCompletionStream({
      model: 'test',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      chars.push(char);
    }

    expect(chars).toEqual(['A', 'B', 'C']);
  });

  it('chatCompletionStreamWithMetadata includes generationId on first chunk', async () => {
    const client = createFastMockOpenRouterClient({
      streamContent: 'AB',
      generationId: 'custom-gen-id',
    });
    const chunks: { content: string; generationId?: string }[] = [];

    for await (const chunk of client.chatCompletionStreamWithMetadata({
      model: 'test',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks[0]?.generationId).toBe('custom-gen-id');
    expect(chunks[1]?.generationId).toBeUndefined();
  });

  it('listModels returns provided models', async () => {
    const customModels = [
      {
        id: 'test-model',
        name: 'Test Model',
        description: 'A test model',
        context_length: 4096,
        pricing: { prompt: '0.001', completion: '0.002' },
        supported_parameters: ['temperature'],
        created: 1_234_567_890,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
    ];

    const client = createFastMockOpenRouterClient({ models: customModels });
    const models = await client.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('test-model');
  });

  it('listModels returns empty array by default', async () => {
    const client = createFastMockOpenRouterClient();
    const models = await client.listModels();

    expect(models).toEqual([]);
  });

  it('getModel returns model if found in models list', async () => {
    const customModels = [
      {
        id: 'test-model',
        name: 'Test Model',
        description: 'A test model',
        context_length: 4096,
        pricing: { prompt: '0.001', completion: '0.002' },
        supported_parameters: ['temperature'],
        created: 1_234_567_890,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
    ];

    const client = createFastMockOpenRouterClient({ models: customModels });
    const model = await client.getModel('test-model');

    expect(model.id).toBe('test-model');
    expect(model.name).toBe('Test Model');
  });

  it('getModel rejects with error if model not found', async () => {
    const client = createFastMockOpenRouterClient();

    await expect(client.getModel('nonexistent-model')).rejects.toThrow('Model not found');
  });

  it('getGenerationStats returns mock stats with provided id', async () => {
    const client = createFastMockOpenRouterClient();
    const stats = await client.getGenerationStats('my-gen-id');

    expect(stats.id).toBe('my-gen-id');
    expect(stats.native_tokens_prompt).toBe(100);
    expect(stats.native_tokens_completion).toBe(50);
    expect(stats.total_cost).toBe(0.001);
  });
});
