import type { OpenRouterClient } from '../services/openrouter/types.js';

/**
 * Create a fast mock OpenRouter client for testing (no delays).
 * Returns immediate responses without network simulation.
 */
export function createFastMockOpenRouterClient(
  options: {
    streamContent?: string;
    generationId?: string;
    models?: {
      id: string;
      name: string;
      description: string;
      context_length: number;
      pricing: { prompt: string; completion: string };
      supported_parameters: string[];
      created: number;
    }[];
  } = {}
): OpenRouterClient {
  const { streamContent = 'Echo: Hello', generationId = 'mock-gen-123', models = [] } = options;

  return {
    isMock: true,
    chatCompletion() {
      return Promise.resolve({
        id: 'mock-123',
        model: 'openai/gpt-4-turbo',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: streamContent },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for fast tests
    async *chatCompletionStream() {
      for (const char of streamContent) {
        yield char;
      }
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- sync yields for fast tests
    async *chatCompletionStreamWithMetadata() {
      let isFirst = true;
      for (const char of streamContent) {
        if (isFirst) {
          yield { content: char, generationId };
          isFirst = false;
        } else {
          yield { content: char };
        }
      }
    },
    listModels() {
      return Promise.resolve(models);
    },
    getModel() {
      return Promise.reject(new Error('Model not found'));
    },
    getGenerationStats(genId: string) {
      return Promise.resolve({
        id: genId,
        native_tokens_prompt: 100,
        native_tokens_completion: 50,
        total_cost: 0.001,
      });
    },
  };
}
