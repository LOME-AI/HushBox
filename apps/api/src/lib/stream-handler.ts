/**
 * Server-side SSE stream handler utilities.
 *
 * Provides typed event writers for SSE streams used by chat endpoints.
 */

export interface SSEStream {
  writeSSE: (event: { event: string; data: string }) => Promise<void>;
  onAbort: (handler: () => void) => void;
}

export interface StartModelEntry {
  modelId: string;
  assistantMessageId: string;
}

export interface StartEventData {
  userMessageId: string;
  models: StartModelEntry[];
}

export interface ErrorEventData {
  message: string;
  code?: string;
}

export interface ModelDoneEventData {
  modelId: string;
  assistantMessageId: string;
  cost: string;
}

export interface ModelErrorEventData {
  modelId: string;
  message: string;
  code?: string;
}

export interface TokenEventData {
  modelId: string;
  content: string;
}

/**
 * A single content item delivered in the SSE done event.
 * Mirrors the write-path shape of a row inserted into `content_items` under
 * the wrap-once envelope model. Text items carry `encryptedBlob` (base64);
 * media items carry only metadata (Step 1 text-only, but the shape is ready
 * for image/audio/video in later steps).
 */
export interface DoneContentItem {
  id: string;
  contentType: 'text' | 'image' | 'audio' | 'video';
  position: number;
  /** Base64-encoded symmetric ciphertext under the message's content key. Text items only. */
  encryptedBlob?: string | null;
  /** Presigned GET URL for media items. Populated by the strategy after R2 upload. */
  downloadUrl?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  modelName: string | null;
  cost: string | null;
  isSmartModel: boolean;
}

/**
 * The wrap-once envelope for a single persisted message, delivered in the SSE
 * done event. Clients unwrap `wrappedContentKey` once with their epoch private
 * key and decrypt every content item with the resulting content key.
 */
export interface DoneMessageEnvelope {
  /** Base64-encoded ECIES-wrapped content key for the message. */
  wrappedContentKey: string;
  contentItems: DoneContentItem[];
}

export interface DoneModelEntry extends DoneMessageEnvelope {
  modelId: string;
  assistantMessageId: string;
  aiSequence: number;
  cost: string;
}

export interface DoneEventData {
  userMessageId: string;
  assistantMessageId: string;
  userSequence?: number;
  aiSequence: number;
  epochNumber: number;
  cost: string;
  /** Envelope for the user message itself (sender_type='user'). */
  userEnvelope?: DoneMessageEnvelope;
  models?: DoneModelEntry[];
}

export interface SSEEventWriter {
  writeStart: (data: StartEventData) => Promise<void>;
  writeToken: (content: string) => Promise<void>;
  writeModelToken: (data: TokenEventData) => Promise<void>;
  writeError: (data: ErrorEventData) => Promise<void>;
  writeModelDone: (data: ModelDoneEventData) => Promise<void>;
  writeModelError: (data: ModelErrorEventData) => Promise<void>;
  writeDone: (data?: DoneEventData) => Promise<void>;
  isConnected: () => boolean;
}

/**
 * Create a typed SSE event writer with connection tracking.
 *
 * Handles:
 * - Typed event writing (start, token, error, done)
 * - Connection state tracking via onAbort
 * - Graceful handling of write failures
 */
export function createSSEEventWriter(stream: SSEStream): SSEEventWriter {
  let connected = true;

  stream.onAbort(() => {
    connected = false;
  });

  async function writeIfConnected(event: string, data: unknown): Promise<void> {
    if (!connected) {
      return;
    }

    try {
      await stream.writeSSE({ event, data: JSON.stringify(data) });
    } catch {
      connected = false;
    }
  }

  return {
    writeStart: async (data: StartEventData) => {
      await writeIfConnected('start', data);
    },

    writeToken: async (content: string) => {
      await writeIfConnected('token', { content });
    },

    writeModelToken: async (data: TokenEventData) => {
      await writeIfConnected('token', data);
    },

    writeError: async (data: ErrorEventData) => {
      await writeIfConnected('error', data);
    },

    writeModelDone: async (data: ModelDoneEventData) => {
      await writeIfConnected('model:done', data);
    },

    writeModelError: async (data: ModelErrorEventData) => {
      await writeIfConnected('model:error', data);
    },

    writeDone: async (data?: DoneEventData) => {
      await writeIfConnected('done', data ?? {});
    },

    isConnected: () => connected,
  };
}
