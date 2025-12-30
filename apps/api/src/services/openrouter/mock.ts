import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  MockOpenRouterClient,
} from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMockOpenRouterClient(): MockOpenRouterClient {
  const history: ChatCompletionRequest[] = [];

  return {
    chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      history.push({ ...request });

      const lastUserMessage = [...request.messages].reverse().find((m) => m.role === 'user');

      return Promise.resolve({
        id: `mock-${String(Date.now())}`,
        model: request.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: `Echo: ${lastUserMessage?.content ?? 'No message'}`,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      });
    },

    async *chatCompletionStream(request: ChatCompletionRequest): AsyncIterable<string> {
      history.push({ ...request });

      const lastUserMessage = [...request.messages].reverse().find((m) => m.role === 'user');
      const response = `Echo: ${lastUserMessage?.content ?? 'No message'}`;

      for (const char of response) {
        yield char;
        await delay(20);
      }
    },

    listModels() {
      throw new Error('Not implemented - use fetchModels() instead');
    },

    getModel() {
      throw new Error('Not implemented - use getModel() from openrouter.ts instead');
    },

    getCompletionHistory(): ChatCompletionRequest[] {
      return [...history];
    },

    clearHistory(): void {
      history.length = 0;
    },
  };
}
