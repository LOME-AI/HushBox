// ---------------------------------------------------------------------------
// AIClient — provider-agnostic inference interface
//
// The real implementation uses the Vercel AI SDK + AI Gateway, but that detail
// stays in real.ts. Nothing in this file references a specific gateway or SDK.
// ---------------------------------------------------------------------------

/** Content modality discriminator. */
export type Modality = 'text' | 'image' | 'audio' | 'video';

/** Capability tag advertised by a model (beyond its base modality). */
export type ModelCapability = 'aspect-ratio' | 'duration';

// ---------------------------------------------------------------------------
// Model metadata
// ---------------------------------------------------------------------------

export type ModelPricing =
  | { kind: 'token'; inputPerToken: number; outputPerToken: number; webSearchPerCall?: number }
  | { kind: 'image'; perImage: number }
  | { kind: 'audio'; perSecond: number }
  | { kind: 'video'; perSecond: number };

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  modality: Modality;
  description: string;
  contextLength?: number;
  pricing: ModelPricing;
  capabilities: ModelCapability[];
  isZdr: boolean;
  created?: number;
}

// ---------------------------------------------------------------------------
// Request types — discriminated by modality
// ---------------------------------------------------------------------------

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContentPart[];
}

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: Uint8Array; mimeType: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface TextRequest {
  modality: 'text';
  model: string;
  messages: AIMessage[];
  maxOutputTokens?: number;
  webSearchEnabled?: boolean;
}

export interface ImageRequest {
  modality: 'image';
  model: string;
  prompt: string;
  aspectRatio?: string;
  size?: string;
  n?: number;
}

export interface AudioRequest {
  modality: 'audio';
  model: string;
  prompt: string;
  voice?: string;
  format?: 'mp3' | 'wav' | 'ogg';
}

export interface VideoRequest {
  modality: 'video';
  model: string;
  prompt: string;
  aspectRatio?: string;
  durationSeconds?: number;
  resolution?: string;
}

export type InferenceRequest = TextRequest | ImageRequest | AudioRequest | VideoRequest;

// ---------------------------------------------------------------------------
// Streaming events — yielded by AIClient.stream()
// ---------------------------------------------------------------------------

export type InferenceEvent =
  | { kind: 'text-delta'; content: string }
  | { kind: 'media-start'; mediaType: 'image' | 'audio' | 'video'; mimeType: string }
  | {
      kind: 'media-done';
      bytes: Uint8Array;
      mimeType: string;
      width?: number;
      height?: number;
      durationMs?: number;
    }
  | { kind: 'finish'; providerMetadata?: ProviderMetadata };

export interface ProviderMetadata {
  generationId?: string;
  costUsd?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

// ---------------------------------------------------------------------------
// Stream interface
// ---------------------------------------------------------------------------

export interface InferenceStream {
  [Symbol.asyncIterator](): AsyncIterator<InferenceEvent>;
}

// ---------------------------------------------------------------------------
// Client interfaces
// ---------------------------------------------------------------------------

export interface AIClient {
  readonly isMock: boolean;
  listModels(): Promise<ModelInfo[]>;
  getModel(id: string): Promise<ModelInfo>;
  stream(request: InferenceRequest): InferenceStream;
  getGenerationStats(generationId: string): Promise<{ costUsd: number }>;
}

export interface MockAIClient extends AIClient {
  getRequestHistory(): InferenceRequest[];
  clearHistory(): void;
  addFailingModel(id: string): void;
  clearFailingModels(): void;
}
