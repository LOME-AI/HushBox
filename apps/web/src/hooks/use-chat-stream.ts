import { useState, useCallback } from 'react';
import { ERROR_CODE_CONTEXT_LENGTH_EXCEEDED } from '@hushbox/shared';
import { useStreamingActivityStore } from '@/stores/streaming-activity';
import { getApiUrl } from '../lib/api';
import { getTrialToken } from '../lib/trial-token';
import { getLinkGuestAuth } from '../lib/link-guest-auth';
import {
  createSSEParser,
  readWithTimeout,
  StreamTimeoutError,
  type DoneEventData,
  type StartEventData,
  type ModelDoneData,
  type ModelErrorData,
  type ModelMediaStartData,
  type ModelMediaProgressData,
  type StageDoneEventData,
} from '../lib/sse-client';
import type {
  Modality,
  ImageConfig,
  VideoConfig,
  AudioConfig,
  StageStartPayload,
  StageErrorPayload,
} from '@hushbox/shared';

export { StreamTimeoutError } from '../lib/sse-client';

export type StreamMode = 'authenticated' | 'trial';

interface AuthenticatedStreamRequest {
  conversationId: string;
  modality?: Modality;
  models: string[];
  userMessage: {
    id: string;
    content: string;
  };
  messagesForInference: { role: 'user' | 'assistant' | 'system'; content: string }[];
  fundingSource: string;
  webSearchEnabled?: boolean;
  customInstructions?: string;
  forkId?: string;
  imageConfig?: ImageConfig;
  videoConfig?: VideoConfig;
  audioConfig?: AudioConfig;
}

interface TrialStreamMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface TrialStreamRequest {
  messages: TrialStreamMessage[];
  model: string;
}

export interface RegenerateStreamRequest {
  conversationId: string;
  targetMessageId: string;
  action: 'retry' | 'edit' | 'regenerate';
  modality: 'text' | 'image' | 'video' | 'audio';
  model: string;
  userMessage: {
    id: string;
    content: string;
  };
  messagesForInference: { role: 'user' | 'assistant' | 'system'; content: string }[];
  fundingSource: string;
  forkId?: string;
  webSearchEnabled?: boolean;
  customInstructions?: string;
  imageConfig?: ImageConfig;
  videoConfig?: VideoConfig;
  audioConfig?: AudioConfig;
}

export type StreamRequest = AuthenticatedStreamRequest | TrialStreamRequest;

export interface ModelResult {
  modelId: string;
  assistantMessageId: string;
  cost: string;
  errorCode?: string;
}

interface StreamResult {
  userMessageId: string;
  models: ModelResult[];
  /**
   * The final SSE done event payload, including the full envelope + content
   * items with download URLs for media. Consumers can use this to populate
   * local state immediately instead of waiting for a query refetch.
   */
  doneData: DoneEventData | undefined;
}

interface StreamOptions {
  onStart?: (data: StartEventData) => void;
  onToken?: (token: string, modelId: string) => void;
  onModelDone?: (data: ModelDoneData) => void;
  onModelError?: (data: ModelErrorData) => void;
  /** Notification that media generation has started for a slot — drives a "Generating…" UI hint. */
  onModelMediaStart?: (data: ModelMediaStartData) => void;
  /** Synthetic progress for long-running media (video). Drives a 0-95% bar. */
  onModelMediaProgress?: (data: ModelMediaProgressData) => void;
  /**
   * Pre-inference stage events. UI can use these to show a "Choosing the
   * best model…" placeholder for Smart Model rows, then update the nametag
   * to the resolved model name when stage:done arrives.
   */
  onStageStart?: (data: StageStartPayload) => void;
  onStageDone?: (data: StageDoneEventData) => void;
  onStageError?: (data: StageErrorPayload) => void;
  signal?: AbortSignal;
}

export class TrialRateLimitError extends Error {
  public readonly limit: number;
  public readonly remaining: number;
  public readonly isRateLimited = true;

  constructor(
    public readonly code: string,
    limit: number,
    remaining: number
  ) {
    super(code);
    this.name = 'TrialRateLimitError';
    this.limit = limit;
    this.remaining = remaining;
  }
}

export class BalanceReservedError extends Error {
  public readonly isBalanceReserved = true;

  constructor(public readonly code: string) {
    super(code);
    this.name = 'BalanceReservedError';
  }
}

export class BillingMismatchError extends Error {
  public readonly isBillingMismatch = true;

  constructor(public readonly code: string) {
    super(code);
    this.name = 'BillingMismatchError';
  }
}

export class ContextCapacityError extends Error {
  public readonly isContextCapacity = true;

  constructor(public readonly code: string) {
    super(code);
    this.name = 'ContextCapacityError';
  }
}

interface ChatStreamHook {
  isStreaming: boolean;
  startStream: (request: StreamRequest, options?: StreamOptions) => Promise<StreamResult>;
  startRegenerateStream: (
    request: RegenerateStreamRequest,
    options?: StreamOptions
  ) => Promise<StreamResult>;
}

interface StreamRequestConfig {
  url: string;
  options: RequestInit;
}

function buildStreamRequest(
  mode: StreamMode,
  request: StreamRequest,
  signal?: AbortSignal
): StreamRequestConfig {
  const headers: HeadersInit = { 'Content-Type': 'application/json' };

  if (mode === 'trial') {
    headers['X-Trial-Token'] = getTrialToken();
  }

  const linkKey = getLinkGuestAuth();
  if (linkKey) {
    headers['X-Link-Public-Key'] = linkKey;
  }

  let endpoint: string;
  let body: string;
  if (mode === 'trial') {
    endpoint = '/api/trial/stream';
    body = JSON.stringify(request);
  } else {
    const authRequest = request as AuthenticatedStreamRequest;
    endpoint = `/api/chat/${authRequest.conversationId}/stream`;
    // eslint-disable-next-line sonarjs/no-unused-vars -- destructuring rest requires binding the excluded key
    const { conversationId: _conversationId, ...bodyWithoutConversationId } = authRequest;
    body = JSON.stringify(bodyWithoutConversationId);
  }

  const fetchOptions: RequestInit = {
    method: 'POST',
    headers,
    body,
    signal: signal ?? null,
  };

  if (mode === 'authenticated') {
    fetchOptions.credentials = 'include';
  }

  return { url: `${getApiUrl()}${endpoint}`, options: fetchOptions };
}

function buildRegenerateRequest(
  request: RegenerateStreamRequest,
  signal?: AbortSignal
): StreamRequestConfig {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  const linkKey = getLinkGuestAuth();
  if (linkKey) {
    headers['X-Link-Public-Key'] = linkKey;
  }

  const { conversationId, ...bodyWithoutConversationId } = request;

  return {
    url: `${getApiUrl()}/api/chat/${conversationId}/regenerate`,
    options: {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyWithoutConversationId),
      signal: signal ?? null,
      credentials: 'include',
    },
  };
}

function extractErrorCode(data: unknown): string | undefined {
  if (typeof data === 'object' && data !== null && 'code' in data) {
    const code = (data as Record<string, unknown>)['code'];
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function createTrialRateLimitError(code: string, data: unknown): TrialRateLimitError {
  const errorData = data as { details?: { limit?: number; remaining?: number } };
  return new TrialRateLimitError(
    code,
    errorData.details?.limit ?? 5,
    errorData.details?.remaining ?? 0
  );
}

function handleStreamError(mode: StreamMode, status: number, data: unknown): never {
  const code = extractErrorCode(data) ?? 'INTERNAL';
  if (mode === 'trial' && status === 429) {
    throw createTrialRateLimitError(code, data);
  }
  if (mode === 'authenticated' && status === 409) {
    throw new BillingMismatchError(code);
  }
  if (mode === 'authenticated' && status === 402 && code === 'BALANCE_RESERVED') {
    throw new BalanceReservedError(code);
  }
  throw new Error(code);
}

async function validateSSEResponse(
  response: Response
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const contentType = response.headers.get('Content-Type');
  if (!contentType?.includes('text/event-stream')) {
    const errorData: unknown = await response.json().catch(() => ({}));
    throw new Error(extractErrorCode(errorData) ?? 'INTERNAL');
  }

  if (!response.body) {
    throw new Error('Response body is null');
  }

  return response.body.getReader();
}

interface StreamState {
  error: Error | null;
  done: boolean;
  doneData: DoneEventData | null;
  startData: StartEventData | null;
  /**
   * Cost map sourced exclusively from the final `done` event's `models[].cost`.
   * Final spend is only known after the post-flight billing pass on the server.
   */
  modelCosts: Map<string, string>;
  modelErrors: Map<string, string>;
}

type SSEParser = ReturnType<typeof createSSEParser>;

async function consumeSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  parser: SSEParser,
  state: StreamState
): Promise<StreamResult> {
  const decoder = new TextDecoder();

  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- standard pattern for async iterator
    while (true) {
      const { done, value } = await readWithTimeout(reader);
      if (done) break;

      parser.processChunk(decoder.decode(value, { stream: true }));

      if (state.error) {
        throw state.error;
      }
      if (state.done) {
        break;
      }
    }

    const models: ModelResult[] = (state.startData?.models ?? []).map((m) => {
      const errorCode = state.modelErrors.get(m.modelId);
      return {
        modelId: m.modelId,
        assistantMessageId: m.assistantMessageId,
        cost: state.modelCosts.get(m.modelId) ?? '0',
        ...(errorCode && { errorCode }),
      };
    });

    return {
      userMessageId: parser.getUserMessageId(),
      models,
      doneData: state.doneData ?? undefined,
    };
  } finally {
    void (async () => {
      try {
        await reader.cancel();
      } catch {
        // Reader cleanup errors can be ignored
      }
    })();
  }
}

async function executeStream(
  config: StreamRequestConfig,
  errorMode: StreamMode,
  options?: StreamOptions
): Promise<StreamResult> {
  const response = await fetch(config.url, config.options);

  if (!response.ok) {
    const data: unknown = await response.json();
    handleStreamError(errorMode, response.status, data);
  }

  const reader = await validateSSEResponse(response);
  const streamState: StreamState = {
    error: null,
    done: false,
    doneData: null,
    startData: null,
    modelCosts: new Map(),
    modelErrors: new Map(),
  };

  const parser = createSSEParser({
    onStart: (data) => {
      streamState.startData = data;
      options?.onStart?.(data);
    },
    onToken: (tokenData) => {
      options?.onToken?.(tokenData.content, tokenData.modelId);
    },
    onModelDone: (data) => {
      options?.onModelDone?.(data);
    },
    onModelError: (data) => {
      streamState.modelErrors.set(data.modelId, data.code);
      options?.onModelError?.(data);
    },
    onModelMediaStart: (data) => {
      options?.onModelMediaStart?.(data);
    },
    onModelMediaProgress: (data) => {
      options?.onModelMediaProgress?.(data);
    },
    onStageStart: (data) => {
      options?.onStageStart?.(data);
    },
    onStageDone: (data) => {
      options?.onStageDone?.(data);
    },
    onStageError: (data) => {
      options?.onStageError?.(data);
    },
    onError: (errorData) => {
      streamState.error =
        errorData.code === ERROR_CODE_CONTEXT_LENGTH_EXCEEDED
          ? new ContextCapacityError(errorData.code)
          : new Error(errorData.message);
    },
    onDone: (doneData) => {
      streamState.done = true;
      streamState.doneData = doneData;
      for (const m of doneData.models ?? []) {
        streamState.modelCosts.set(m.modelId, m.cost);
      }
    },
  });

  try {
    return await consumeSSEStream(reader, parser, streamState);
  } catch (error: unknown) {
    if (error instanceof StreamTimeoutError) {
      // Re-throw a fresh StreamTimeoutError so callers see the same class name
      // regardless of how the error propagated, but preserve the original via
      // `Error.cause` so debugging tools and stack-trace inspection still get
      // the original failure context.
      throw new StreamTimeoutError(error.message, { cause: error });
    }
    throw error;
  }
}

export function useChatStream(mode: StreamMode): ChatStreamHook {
  const [isStreaming, setIsStreaming] = useState(false);

  const startStream = useCallback(
    async (request: StreamRequest, options?: StreamOptions): Promise<StreamResult> => {
      setIsStreaming(true);
      useStreamingActivityStore.getState().startStream();
      try {
        const config = buildStreamRequest(mode, request, options?.signal);
        return await executeStream(config, mode, options);
      } finally {
        setIsStreaming(false);
        // Note: endStream() is NOT called here. The caller is responsible for
        // calling useStreamingActivityStore.getState().endStream() after all
        // post-stream work (query invalidations, state updates) completes.
        // This prevents a "baton drop" where settled=true fires between the
        // stream ending and the post-stream work starting.
      }
    },
    [mode]
  );

  const startRegenerateStream = useCallback(
    async (request: RegenerateStreamRequest, options?: StreamOptions): Promise<StreamResult> => {
      setIsStreaming(true);
      useStreamingActivityStore.getState().startStream();
      try {
        const config = buildRegenerateRequest(request, options?.signal);
        return await executeStream(config, 'authenticated', options);
      } finally {
        setIsStreaming(false);
      }
    },
    []
  );

  return { isStreaming, startStream, startRegenerateStream };
}
