import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  GenerationStats,
  MockOpenRouterClient,
  StreamToken,
} from './types.js';
import { getModel } from './openrouter.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STREAM_DELAY_MS = 10;

/** Characters per token approximation */
const CHARS_PER_TOKEN = 4;

interface GenerationData {
  modelId: string;
  promptCharacters: number;
  completionCharacters: number;
}

export function createMockOpenRouterClient(): MockOpenRouterClient {
  const history: ChatCompletionRequest[] = [];
  // Track generation data for billing lookups (generationId → data)
  const generationData = new Map<string, GenerationData>();

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
              content: `Echo:\n\n${lastUserMessage?.content ?? 'No message'}`,
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
      const response = `Echo:\n\n${lastUserMessage?.content ?? 'No message'}`;

      for (const char of response) {
        yield char;
        await delay(STREAM_DELAY_MS);
      }
    },

    async *chatCompletionStreamWithMetadata(
      request: ChatCompletionRequest
    ): AsyncIterable<StreamToken> {
      history.push({ ...request });

      const lastUserMessage = [...request.messages].reverse().find((m) => m.role === 'user');
      const response = `Echo:\n\n${lastUserMessage?.content ?? 'No message'}`;
      const generationId = `mock-gen-${String(Date.now())}`;

      // Calculate prompt characters (all messages sent to the model)
      const promptCharacters = request.messages.reduce((sum, msg) => sum + msg.content.length, 0);

      // Store generation data for billing lookup
      generationData.set(generationId, {
        modelId: request.model,
        promptCharacters,
        completionCharacters: response.length,
      });

      let isFirst = true;
      for (const char of response) {
        const token: StreamToken = { content: char };
        if (isFirst) {
          token.generationId = generationId;
          isFirst = false;
        }
        yield token;
        await delay(STREAM_DELAY_MS);
      }
    },

    listModels() {
      throw new Error('Not implemented - use fetchModels() instead');
    },

    getModel() {
      throw new Error('Not implemented - use getModel() from openrouter.ts instead');
    },

    async getGenerationStats(generationId: string): Promise<GenerationStats> {
      const data = generationData.get(generationId);
      if (!data) {
        throw new Error(`Unknown generation ID: ${generationId}`);
      }

      // Get REAL model pricing (public OpenRouter API, 1hr cache)
      const model = await getModel(data.modelId);
      const pricePerInputToken = parseFloat(model.pricing.prompt);
      const pricePerOutputToken = parseFloat(model.pricing.completion);

      // Estimate tokens: characters / 4
      const promptTokens = Math.ceil(data.promptCharacters / CHARS_PER_TOKEN);
      const completionTokens = Math.ceil(data.completionCharacters / CHARS_PER_TOKEN);

      // Calculate base cost using ACTUAL model pricing
      const baseCost = promptTokens * pricePerInputToken + completionTokens * pricePerOutputToken;

      return {
        id: generationId,
        native_tokens_prompt: promptTokens,
        native_tokens_completion: completionTokens,
        total_cost: baseCost,
      };
    },

    getCompletionHistory(): ChatCompletionRequest[] {
      return [...history];
    },

    clearHistory(): void {
      history.length = 0;
    },
  };
}
