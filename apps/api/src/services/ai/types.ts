/**
 * `unicorn/prefer-export-from` requires `export type … from` for re-exports;
 * we also need `RawModel` in this file's local scope for the AIClient
 * declarations below, so pair the re-export with a separate type import.
 */
export type { RawModel } from '@hushbox/shared/models';
import type { RawModel } from '@hushbox/shared/models';

/** Content modality discriminator. */
export type Modality = 'text' | 'image' | 'audio' | 'video';

/** Capability tag advertised by a model (beyond its base modality). */
export type ModelCapability = 'aspect-ratio' | 'duration';

export type ModelPricing =
  | { kind: 'token'; inputPerToken: number; outputPerToken: number; webSearchPerCall?: number }
  | { kind: 'image'; perImage: number }
  | { kind: 'audio'; perSecond: number }
  | { kind: 'video'; perSecondByResolution: Record<string, number> };

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

/**
 * Metadata emitted with a finish event. The real AI SDK does NOT return cost
 * inline; `generationId` is the breadcrumb used with `getGenerationStats` to
 * fetch actual cost post-hoc.
 */
export interface ProviderMetadata {
  generationId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface InferenceStream {
  [Symbol.asyncIterator](): AsyncIterator<InferenceEvent>;
}

/**
 * Shared methods for any AIClient. Concrete clients narrow `isMock` to a
 * literal so `if (client.isMock)` is enough for TypeScript to discriminate.
 */
export interface AIClientBase {
  listModels(): Promise<ModelInfo[]>;
  /**
   * Gateway-shaped catalog (raw, before processModels filtering / smart-model
   * synthesis). The single funnel for any caller that needs `processModels`'s
   * `premiumIds` or `Model[]` output. Keeping this on the AIClient is what
   * lets `getAIClient`'s `isLocalDev || isE2E` fork stay the only env check —
   * routes never touch `fetchModels` directly.
   */
  listRawModels(): Promise<RawModel[]>;
  getModel(id: string): Promise<ModelInfo>;
  stream(request: InferenceRequest): InferenceStream;
  getGenerationStats(generationId: string): Promise<{ costUsd: number }>;
}

export interface RealAIClient extends AIClientBase {
  readonly isMock: false;
}

/**
 * History entry recorded by the mock client. Carries the original
 * {@link InferenceRequest} fields plus a `zdrEnforced` flag so tests can
 * assert that ZDR was applied on every call without having to inspect the
 * SDK args. The mock never talks to a real gateway, so the flag is always
 * `true` — tracking it explicitly lets a regression on `real.ts`-style
 * paths (where ZDR is REAL provider options, not just a flag) surface at
 * the boundary.
 */
export type RecordedInferenceRequest = InferenceRequest & { zdrEnforced: boolean };

export interface MockAIClient extends AIClientBase {
  readonly isMock: true;
  getRequestHistory(): RecordedInferenceRequest[];
  clearHistory(): void;
  addFailingModel(id: string): void;
  clearFailingModels(): void;
  /**
   * Configure the model id the mock returns for classifier calls (any text
   * stream whose system message starts with `CLASSIFIER_SYSTEM_PROMPT_MARKER`).
   * Defaults to a stable mock id; tests override per scenario.
   */
  setClassifierResolution(modelId: string): void;
  /**
   * Make the next classifier call fail by rejecting the stream's iterator.
   * Pass `null` to clear. Failure mode: rejection from the async iterator;
   * passing `null` after the test is good practice.
   */
  setClassifierFailure(error: Error | null): void;
}

/** Discriminated union — narrows on `client.isMock` without casts. */
export type AIClient = RealAIClient | MockAIClient;
