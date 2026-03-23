import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  GenerationStats,
  MockOpenRouterClient,
  StreamToken,
} from './types.js';
import { getModel } from './openrouter.js';
import { AUTO_ROUTER_MODEL_ID, parseTokenPrice } from '@hushbox/shared';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STREAM_DELAY_MS = 5;

/** Characters per token approximation */
const CHARS_PER_TOKEN = 4;

/** Mid-range pricing for auto-router mock billing (per token, USD) */
const AUTO_ROUTER_MOCK_INPUT_PRICE = 0.000_005;
const AUTO_ROUTER_MOCK_OUTPUT_PRICE = 0.000_015;

interface GenerationData {
  modelId: string;
  promptCharacters: number;
  completionCharacters: number;
}

function hasWebSearchPlugin(request: ChatCompletionRequest): boolean {
  return request.plugins?.some((p) => p.id === 'web') === true;
}

function buildSearchMockResponse(query: string): string {
  return (
    `Based on recent web results, here is information about "${query}":\n\n` +
    `According to [wikipedia.org](https://en.wikipedia.org/wiki/Example), ` +
    `this topic has been widely discussed. ` +
    `Recent coverage by [reuters.com](https://www.reuters.com/example) ` +
    `provides additional context on the subject.\n\n` +
    `A detailed analysis from [arxiv.org](https://arxiv.org/abs/example) ` +
    `explores the technical aspects in depth.`
  );
}

function prepareMockResponse(
  request: ChatCompletionRequest,
  history: ChatCompletionRequest[]
): { response: string } {
  history.push({ ...request });

  const lastUserMessage: ChatMessage | undefined = request.messages.findLast(
    (m: ChatMessage) => m.role === 'user'
  );
  const userContent = lastUserMessage?.content ?? 'No message';
  const response = hasWebSearchPlugin(request)
    ? buildSearchMockResponse(userContent)
    : `Echo:\n\n${userContent}`;

  return { response };
}

// ---------------------------------------------------------------------------
// Dev-only: per-model failure simulation
// ---------------------------------------------------------------------------
const failingModels = new Set<string>();

export function addFailingModel(id: string): void {
  failingModels.add(id);
}

export function clearFailingModels(): void {
  failingModels.clear();
}

export function createMockOpenRouterClient(): MockOpenRouterClient {
  const history: ChatCompletionRequest[] = [];
  // Track generation data for billing lookups (generationId → data)
  const generationData = new Map<string, GenerationData>();

  return {
    isMock: true,

    chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      const { response } = prepareMockResponse(request, history);

      return Promise.resolve({
        id: `mock-${String(Date.now())}`,
        model: request.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: response,
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
      const { response } = prepareMockResponse(request, history);

      for (const char of response) {
        yield char;
        await delay(STREAM_DELAY_MS);
      }
    },

    async *chatCompletionStreamWithMetadata(
      request: ChatCompletionRequest
    ): AsyncIterable<StreamToken> {
      if (failingModels.has(request.model)) {
        throw new Error(`Model ${request.model} is unavailable`);
      }

      const { response } = prepareMockResponse(request, history);
      const generationId = `mock-gen-${String(Date.now())}`;

      // Calculate prompt characters (all messages sent to the model)
      const promptCharacters = request.messages.reduce((sum, msg) => sum + msg.content.length, 0);

      // Store generation data for billing lookup
      generationData.set(generationId, {
        modelId: request.model,
        promptCharacters,
        completionCharacters: response.length,
      });

      // Simulate model thinking latency before first token
      await delay(100);

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

      // Estimate tokens: characters / 4
      const promptTokens = Math.ceil(data.promptCharacters / CHARS_PER_TOKEN);
      const completionTokens = Math.ceil(data.completionCharacters / CHARS_PER_TOKEN);

      // Auto-router: use mid-range pricing (actual model pricing is 0/0)
      if (data.modelId === AUTO_ROUTER_MODEL_ID) {
        return {
          id: generationId,
          native_tokens_prompt: promptTokens,
          native_tokens_completion: completionTokens,
          total_cost:
            promptTokens * AUTO_ROUTER_MOCK_INPUT_PRICE +
            completionTokens * AUTO_ROUTER_MOCK_OUTPUT_PRICE,
        };
      }

      // Get REAL model pricing (public OpenRouter API, 1hr cache)
      const model = await getModel(data.modelId);
      const pricePerInputToken = parseTokenPrice(model.pricing.prompt);
      const pricePerOutputToken = parseTokenPrice(model.pricing.completion);

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
