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
  plugins?: { id: string; allowed_models?: string[] }[];
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
    web_search?: string;
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
 * Streaming chunk from OpenRouter API (SSE format).
 * The final chunk before [DONE] includes usage stats. Some providers send it
 * with an empty choices array; others omit the choices field entirely.
 */
export interface ChatCompletionChunk {
  id: string;
  model: string;
  /** May be absent on usage-only chunks from some providers behind the auto-router. */
  choices?: {
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
  }[];
  /** Inline usage stats — present in the final chunk before [DONE] */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** Cost in USD. Always present per OpenRouter docs. */
    cost: number;
  };
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
  /** Inline cost from OpenRouter's final usage chunk (USD). Undefined if usage chunk was missing. */
  inlineCost?: number;
}

export interface OpenRouterClient {
  /** True for mock client (dev), false for real client (CI/production) */
  readonly isMock: boolean;
  chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  chatCompletionStream(request: ChatCompletionRequest): AsyncIterable<string>;
  /** Stream that yields tokens with generation ID on first token and inline cost on final token */
  chatCompletionStreamWithMetadata(request: ChatCompletionRequest): AsyncIterable<StreamToken>;
  listModels(): Promise<ModelInfo[]>;
  getModel(modelId: string): Promise<ModelInfo>;
}

export interface MockOpenRouterClient extends OpenRouterClient {
  getCompletionHistory(): ChatCompletionRequest[];
  clearHistory(): void;
}
