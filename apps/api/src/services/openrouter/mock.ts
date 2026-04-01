import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
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

/** Calculate mock inline cost using real model pricing (mirrors real OpenRouter inline usage). */
async function calculateMockInlineCost(
  modelId: string,
  promptCharacters: number,
  completionCharacters: number
): Promise<number> {
  const promptTokens = Math.ceil(promptCharacters / CHARS_PER_TOKEN);
  const completionTokens = Math.ceil(completionCharacters / CHARS_PER_TOKEN);

  if (modelId === AUTO_ROUTER_MODEL_ID) {
    return (
      promptTokens * AUTO_ROUTER_MOCK_INPUT_PRICE + completionTokens * AUTO_ROUTER_MOCK_OUTPUT_PRICE
    );
  }

  // Get REAL model pricing (public OpenRouter API, 1hr cache)
  const model = await getModel(modelId);
  const pricePerInputToken = parseTokenPrice(model.pricing.prompt);
  const pricePerOutputToken = parseTokenPrice(model.pricing.completion);
  return promptTokens * pricePerInputToken + completionTokens * pricePerOutputToken;
}

export function createMockOpenRouterClient(): MockOpenRouterClient {
  const history: ChatCompletionRequest[] = [];

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

      // Yield inline cost (mirrors real OpenRouter final usage chunk)
      const promptCharacters = request.messages.reduce((sum, msg) => sum + msg.content.length, 0);
      const cost = await calculateMockInlineCost(request.model, promptCharacters, response.length);
      yield { content: '', inlineCost: cost };
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
