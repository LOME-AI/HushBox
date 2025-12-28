import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  MockOpenRouterClient,
  ModelInfo,
} from './types.js';

/**
 * Mock model data for development.
 * These mirror the MOCK_MODELS in packages/shared but include OpenRouter-specific fields.
 */
const MOCK_MODEL_INFO: ModelInfo[] = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    description:
      "OpenAI's most capable model. Excels at complex reasoning, creative writing, and following nuanced instructions.",
    context_length: 128000,
    pricing: { prompt: '0.00001', completion: '0.00003' },
    supported_parameters: [
      'temperature',
      'top_p',
      'max_tokens',
      'tools',
      'tool_choice',
      'response_format',
    ],
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    description:
      "Anthropic's most intelligent model. Excels at complex reasoning, coding, and nuanced content creation.",
    context_length: 200000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    supported_parameters: ['temperature', 'top_p', 'max_tokens', 'tools', 'tool_choice'],
  },
  {
    id: 'google/gemini-pro-1.5',
    name: 'Gemini Pro 1.5',
    description:
      "Google's flagship model with the largest context window. Ideal for processing long documents.",
    context_length: 1000000,
    pricing: { prompt: '0.0000005', completion: '0.0000015' },
    supported_parameters: ['temperature', 'top_p', 'max_tokens', 'tools', 'tool_choice'],
  },
  {
    id: 'meta-llama/llama-3.1-70b-instruct',
    name: 'Llama 3.1 70B',
    description: "Meta's open-weight model offering excellent performance at low cost.",
    context_length: 131072,
    pricing: { prompt: '0.00000059', completion: '0.00000079' },
    supported_parameters: ['temperature', 'top_p', 'max_tokens'],
  },
];

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

    listModels(): Promise<ModelInfo[]> {
      return Promise.resolve(MOCK_MODEL_INFO);
    },

    getModel(modelId: string): Promise<ModelInfo> {
      const model = MOCK_MODEL_INFO.find((m) => m.id === modelId);
      if (!model) {
        return Promise.reject(new Error(`Model not found: ${modelId}`));
      }
      return Promise.resolve(model);
    },

    getCompletionHistory(): ChatCompletionRequest[] {
      return [...history];
    },

    clearHistory(): void {
      history.length = 0;
    },
  };
}
