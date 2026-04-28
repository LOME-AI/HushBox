import { describe, it, expect } from 'vitest';
import {
  collectMultiModelStreams,
  collectMultiMediaModelStreams,
  type ModelStreamEntry,
  type MediaModelStreamEntry,
} from './multi-stream.js';
import type { SSEEventWriter } from './stream-handler.js';
import type { InferenceEvent, InferenceStream } from '../services/ai/index.js';

function createMockWriter(): SSEEventWriter & {
  events: { method: string; args: unknown[] }[];
} {
  const events: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    // eslint-disable-next-line @typescript-eslint/require-await
    async (...args: unknown[]): Promise<void> => {
      events.push({ method, args });
    };

  return {
    events,
    writeStart: record('writeStart'),
    writeToken: record('writeToken'),
    writeModelToken: record('writeModelToken'),
    writeError: record('writeError'),
    writeModelDone: record('writeModelDone'),
    writeModelError: record('writeModelError'),
    writeDone: record('writeDone'),
    writeStageStart: record('writeStageStart'),
    writeStageDone: record('writeStageDone'),
    writeStageError: record('writeStageError'),
    isConnected: () => true,
  };
}

/** Create an InferenceStream that yields text-delta events then a finish event. */
function createTextStream(tokens: string[], generationId?: string): InferenceStream {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      let index = 0;
      const events: InferenceEvent[] = [
        ...tokens.map(
          (content): InferenceEvent => ({
            kind: 'text-delta',
            content,
          })
        ),
        {
          kind: 'finish',
          providerMetadata: {
            ...(generationId === undefined ? {} : { generationId }),
          },
        },
      ];
      return {
        next(): Promise<IteratorResult<InferenceEvent>> {
          if (index >= events.length) return Promise.resolve({ done: true, value: undefined });
          const value = events[index++]!;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

/** Create an InferenceStream that yields some text-delta events then throws. */
function createFailingStream(tokensBeforeError: string[], error: Error): InferenceStream {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<InferenceEvent>> {
          if (index < tokensBeforeError.length) {
            const content = tokensBeforeError[index++]!;
            return Promise.resolve({
              done: false,
              value: { kind: 'text-delta' as const, content },
            });
          }
          return Promise.reject(error);
        },
      };
    },
  };
}

describe('collectMultiModelStreams', () => {
  it('collects text content from a single model', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'anthropic/claude-sonnet-4.6',
        assistantMessageId: 'asst-1',
        stream: createTextStream(['Hello', ' world'], 'gen-1'),
      },
    ];

    const results = await collectMultiModelStreams(entries, writer);

    expect(results.size).toBe(1);
    const result = results.get('anthropic/claude-sonnet-4.6')!;
    expect(result.fullContent).toBe('Hello world');
    expect(result.generationId).toBe('gen-1');
    expect(result.error).toBeNull();
  });

  it('collects content from multiple models in parallel', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'anthropic/claude-sonnet-4.6',
        assistantMessageId: 'asst-1',
        stream: createTextStream(['A1', 'A2'], 'gen-a'),
      },
      {
        modelId: 'google/gemini-2.5-flash',
        assistantMessageId: 'asst-2',
        stream: createTextStream(['B1', 'B2'], 'gen-b'),
      },
    ];

    const results = await collectMultiModelStreams(entries, writer);

    expect(results.size).toBe(2);
    expect(results.get('anthropic/claude-sonnet-4.6')!.fullContent).toBe('A1A2');
    expect(results.get('google/gemini-2.5-flash')!.fullContent).toBe('B1B2');
  });

  it('writes model-tagged tokens to SSE writer for text-delta events', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'anthropic/claude-sonnet-4.6',
        assistantMessageId: 'asst-1',
        stream: createTextStream(['Hi']),
      },
    ];

    await collectMultiModelStreams(entries, writer);

    const tokenEvents = writer.events.filter((e) => e.method === 'writeModelToken');
    expect(tokenEvents).toHaveLength(1);
    expect(tokenEvents[0]!.args[0]).toEqual({
      modelId: 'anthropic/claude-sonnet-4.6',
      content: 'Hi',
    });
  });

  it('writes model:done for each completed model', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'anthropic/claude-sonnet-4.6',
        assistantMessageId: 'asst-1',
        stream: createTextStream(['Done']),
      },
      {
        modelId: 'google/gemini-2.5-flash',
        assistantMessageId: 'asst-2',
        stream: createTextStream(['Also done']),
      },
    ];

    await collectMultiModelStreams(entries, writer);

    const doneEvents = writer.events.filter((e) => e.method === 'writeModelDone');
    expect(doneEvents).toHaveLength(2);
    const modelIds = doneEvents.map((e) => (e.args[0] as { modelId: string }).modelId);
    expect(modelIds.toSorted((a, b) => a.localeCompare(b))).toEqual([
      'anthropic/claude-sonnet-4.6',
      'google/gemini-2.5-flash',
    ]);
  });

  it('handles partial failure — captures error per model', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'anthropic/claude-sonnet-4.6',
        assistantMessageId: 'asst-1',
        stream: createTextStream(['Good response'], 'gen-good'),
      },
      {
        modelId: 'google/gemini-2.5-flash',
        assistantMessageId: 'asst-2',
        stream: createFailingStream(['Partial'], new Error('Model unavailable')),
      },
    ];

    const results = await collectMultiModelStreams(entries, writer);

    expect(results.get('anthropic/claude-sonnet-4.6')!.error).toBeNull();
    expect(results.get('anthropic/claude-sonnet-4.6')!.fullContent).toBe('Good response');

    expect(results.get('google/gemini-2.5-flash')!.error).toBeInstanceOf(Error);
    expect(results.get('google/gemini-2.5-flash')!.error!.message).toBe('Model unavailable');
    expect(results.get('google/gemini-2.5-flash')!.fullContent).toBe('Partial');
  });

  it('writes model:error for failed models', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'anthropic/claude-sonnet-4.6',
        assistantMessageId: 'asst-1',
        stream: createFailingStream([], new Error('Timeout')),
      },
    ];

    await collectMultiModelStreams(entries, writer);

    const errorEvents = writer.events.filter((e) => e.method === 'writeModelError');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.args[0]).toEqual({
      modelId: 'anthropic/claude-sonnet-4.6',
      message: 'Timeout',
      code: 'STREAM_ERROR',
    });
  });

  it('returns empty map for empty entries', async () => {
    const writer = createMockWriter();
    const results = await collectMultiModelStreams([], writer);
    expect(results.size).toBe(0);
  });

  it('captures generationId from finish event', async () => {
    const writer = createMockWriter();
    const entries: ModelStreamEntry[] = [
      {
        modelId: 'anthropic/claude-sonnet-4.6',
        assistantMessageId: 'asst-1',
        stream: createTextStream(['Hello'], 'gen-only'),
      },
    ];

    const results = await collectMultiModelStreams(entries, writer);
    expect(results.get('anthropic/claude-sonnet-4.6')!.generationId).toBe('gen-only');
  });
});

// ============================================================================
// Media stream helpers
// ============================================================================

function createMediaStream(
  mediaBytes: Uint8Array,
  mimeType: string,
  dimensions?: { width: number; height: number },
  generationId?: string
): InferenceStream {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      let index = 0;
      const events: InferenceEvent[] = [
        { kind: 'media-start', mediaType: 'image', mimeType },
        {
          kind: 'media-done',
          bytes: mediaBytes,
          mimeType,
          ...(dimensions !== undefined && dimensions),
        },
        {
          kind: 'finish',
          providerMetadata: {
            ...(generationId === undefined ? {} : { generationId }),
          },
        },
      ];
      return {
        next(): Promise<IteratorResult<InferenceEvent>> {
          if (index >= events.length) return Promise.resolve({ done: true, value: undefined });
          const value = events[index++]!;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

function createFailingMediaStream(error: Error): InferenceStream {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      return {
        next(): Promise<IteratorResult<InferenceEvent>> {
          return Promise.reject(error);
        },
      };
    },
  };
}

describe('collectMultiMediaModelStreams', () => {
  it('collects media bytes and metadata from a single model', async () => {
    const writer = createMockWriter();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const entries: MediaModelStreamEntry[] = [
      {
        modelId: 'google/imagen-4',
        assistantMessageId: 'asst-1',
        stream: createMediaStream(bytes, 'image/png', { width: 1024, height: 1024 }, 'gen-1'),
      },
    ];

    const results = await collectMultiMediaModelStreams(entries, writer);
    const result = results.get('google/imagen-4');
    expect(result).toBeDefined();
    expect(result!.mediaBytes).toEqual(bytes);
    expect(result!.mimeType).toBe('image/png');
    expect(result!.width).toBe(1024);
    expect(result!.height).toBe(1024);
    expect(result!.generationId).toBe('gen-1');
    expect(result!.error).toBeNull();
  });

  it('collects from multiple models in parallel', async () => {
    const writer = createMockWriter();
    const bytes1 = new Uint8Array([1, 2]);
    const bytes2 = new Uint8Array([3, 4]);
    const entries: MediaModelStreamEntry[] = [
      {
        modelId: 'google/imagen-4',
        assistantMessageId: 'asst-1',
        stream: createMediaStream(bytes1, 'image/png', { width: 512, height: 512 }),
      },
      {
        modelId: 'other/model',
        assistantMessageId: 'asst-2',
        stream: createMediaStream(bytes2, 'image/jpeg', { width: 256, height: 256 }),
      },
    ];

    const results = await collectMultiMediaModelStreams(entries, writer);
    expect(results.size).toBe(2);
    expect(results.get('google/imagen-4')!.mimeType).toBe('image/png');
    expect(results.get('other/model')!.mimeType).toBe('image/jpeg');
  });

  it('captures errors from failing streams', async () => {
    const writer = createMockWriter();
    const entries: MediaModelStreamEntry[] = [
      {
        modelId: 'bad/model',
        assistantMessageId: 'asst-1',
        stream: createFailingMediaStream(new Error('Provider error')),
      },
    ];

    const results = await collectMultiMediaModelStreams(entries, writer);
    const result = results.get('bad/model');
    expect(result!.error).toBeInstanceOf(Error);
    expect(result!.error!.message).toBe('Provider error');
    expect(result!.mediaBytes).toBeUndefined();
  });

  it('writes model:done for successful models and model:error for failed ones', async () => {
    const writer = createMockWriter();
    const entries: MediaModelStreamEntry[] = [
      {
        modelId: 'good/model',
        assistantMessageId: 'asst-1',
        stream: createMediaStream(new Uint8Array([1]), 'image/png'),
      },
      {
        modelId: 'bad/model',
        assistantMessageId: 'asst-2',
        stream: createFailingMediaStream(new Error('fail')),
      },
    ];

    const results = await collectMultiMediaModelStreams(entries, writer);
    expect(results.get('good/model')!.error).toBeNull();
    expect(results.get('bad/model')!.error).not.toBeNull();

    const doneEvents = writer.events.filter((e) => e.method === 'writeModelDone');
    const errorEvents = writer.events.filter((e) => e.method === 'writeModelError');
    expect(doneEvents).toHaveLength(1);
    expect(errorEvents).toHaveLength(1);
  });
});
