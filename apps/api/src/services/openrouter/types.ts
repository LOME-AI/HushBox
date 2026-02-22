export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'tool_calls' | 'length';
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
  };
  supported_parameters: string[];
  /** Unix timestamp when the model was created */
  created: number;
  architecture: {
    input_modalities: string[];
    output_modalities: string[];
  };
}

/**
 * Entry from OpenRouter's /endpoints/zdr endpoint.
 * Represents a model/provider combo that supports Zero Data Retention.
 */
export interface ZdrEndpoint {
  model_id: string;
  model_name: string;
  provider_name: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

/**
 * Streaming chunk from OpenRouter API (SSE format).
 */
export interface ChatCompletionChunk {
  id: string;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
  }[];
}

/**
 * Generation stats from OpenRouter's /generation endpoint.
 * Contains exact cost and native token counts (not normalized).
 */
export interface GenerationStats {
  id: string;
  native_tokens_prompt: number;
  native_tokens_completion: number;
  /** Exact USD cost that OpenRouter charged us */
  total_cost: number;
}

/**
 * Token from streaming response with optional metadata.
 * Used by chatCompletionStreamWithMetadata to return generation ID
 * along with content tokens.
 */
export interface StreamToken {
  /** The content of this token */
  content: string;
  /** Generation ID from first chunk - only present on first token */
  generationId?: string;
}

export interface OpenRouterClient {
  /** True for mock client (dev), false for real client (CI/production) */
  readonly isMock: boolean;
  chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  chatCompletionStream(request: ChatCompletionRequest): AsyncIterable<string>;
  /** Stream that yields tokens with generation ID on first token (for billing) */
  chatCompletionStreamWithMetadata(request: ChatCompletionRequest): AsyncIterable<StreamToken>;
  listModels(): Promise<ModelInfo[]>;
  getModel(modelId: string): Promise<ModelInfo>;
  /** Fetch exact generation stats including native token counts and actual cost */
  getGenerationStats(generationId: string): Promise<GenerationStats>;
}

export interface MockOpenRouterClient extends OpenRouterClient {
  getCompletionHistory(): ChatCompletionRequest[];
  clearHistory(): void;
}
