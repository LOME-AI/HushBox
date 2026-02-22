/**
 * Server-side SSE stream handler utilities.
 *
 * Provides typed event writers for SSE streams used by chat endpoints.
 */

export interface SSEStream {
  writeSSE: (event: { event: string; data: string }) => Promise<void>;
  onAbort: (handler: () => void) => void;
}

export interface StartEventData {
  userMessageId?: string;
  assistantMessageId: string;
}

export interface ErrorEventData {
  message: string;
  code?: string;
}

export interface DoneEventData {
  userMessageId: string;
  assistantMessageId: string;
  userSequence: number;
  aiSequence: number;
  epochNumber: number;
  cost: string;
}

export interface SSEEventWriter {
  writeStart: (data: StartEventData) => Promise<void>;
  writeToken: (content: string) => Promise<void>;
  writeError: (data: ErrorEventData) => Promise<void>;
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

    writeError: async (data: ErrorEventData) => {
      await writeIfConnected('error', data);
    },

    writeDone: async (data?: DoneEventData) => {
      await writeIfConnected('done', data ?? {});
    },

    isConnected: () => connected,
  };
}
