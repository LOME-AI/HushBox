import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ERROR_CODE_CLASSIFIER_FAILED, ERROR_CODE_STREAM_ERROR } from '@hushbox/shared';
import {
  createSSEEventWriter,
  writeStreamErrorFromException,
  type SSEStream,
} from './stream-handler.js';

function createMockStream(): SSEStream & {
  events: { event: string; data: string }[];
  triggerAbort: () => void;
} {
  const events: { event: string; data: string }[] = [];
  let abortHandler: (() => void) | null = null;

  return {
    events,
    writeSSE: vi.fn().mockImplementation((e: { event: string; data: string }) => {
      events.push(e);
      return Promise.resolve();
    }),
    onAbort: (handler: () => void) => {
      abortHandler = handler;
    },
    triggerAbort: () => {
      abortHandler?.();
    },
  };
}

describe('createSSEEventWriter', () => {
  describe('event writing', () => {
    it('writes start event with userMessageId and models array', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeStart({
        userMessageId: 'user-123',
        models: [{ modelId: 'openai/gpt-4o', assistantMessageId: 'assistant-456' }],
      });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'start',
        data: JSON.stringify({
          userMessageId: 'user-123',
          models: [{ modelId: 'openai/gpt-4o', assistantMessageId: 'assistant-456' }],
        }),
      });
    });

    it('writes start event with multiple models', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeStart({
        userMessageId: 'user-123',
        models: [
          { modelId: 'openai/gpt-4o', assistantMessageId: 'asst-1' },
          { modelId: 'anthropic/claude', assistantMessageId: 'asst-2' },
        ],
      });

      expect(stream.events).toHaveLength(1);
      const parsed = JSON.parse(stream.events[0]!.data);
      expect(parsed.models).toHaveLength(2);
    });

    it('writes model-tagged token event with model id and content', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeModelToken({ modelId: 'openai/gpt-4o', content: 'Hello' });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'token',
        data: JSON.stringify({ modelId: 'openai/gpt-4o', content: 'Hello' }),
      });
    });

    it('writes error event with message and code', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeError({ message: 'Something went wrong', code: 'STREAM_ERROR' });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'error',
        data: JSON.stringify({ message: 'Something went wrong', code: 'STREAM_ERROR' }),
      });
    });

    it('writes done event with epoch-based metadata', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeDone({
        userMessageId: 'msg-user-001',
        assistantMessageId: 'msg-asst-002',
        userSequence: 1,
        aiSequence: 2,
        epochNumber: 0,
        cost: '0.00100000',
      });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'done',
        data: JSON.stringify({
          userMessageId: 'msg-user-001',
          assistantMessageId: 'msg-asst-002',
          userSequence: 1,
          aiSequence: 2,
          epochNumber: 0,
          cost: '0.00100000',
        }),
      });
    });

    it('serializes all DoneEventData fields correctly', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      const doneData = {
        userMessageId: 'uid-abc',
        assistantMessageId: 'aid-xyz',
        userSequence: 42,
        aiSequence: 43,
        epochNumber: 5,
        cost: '1.23456789',
      };

      await writer.writeDone(doneData);

      const firstEvent = stream.events[0];
      if (!firstEvent) throw new Error('Expected at least one SSE event');
      const parsed = JSON.parse(firstEvent.data) as Record<string, unknown>;
      expect(parsed).toStrictEqual(doneData);
    });
  });

  describe('model-tagged events', () => {
    it('writes model-tagged token event', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeModelToken({ modelId: 'openai/gpt-4o', content: 'Hello' });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'token',
        data: JSON.stringify({ modelId: 'openai/gpt-4o', content: 'Hello' }),
      });
    });

    it('writes model:done event per model without cost (cost only on final done)', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeModelDone({
        modelId: 'openai/gpt-4o',
        assistantMessageId: 'asst-1',
      });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'model:done',
        data: JSON.stringify({
          modelId: 'openai/gpt-4o',
          assistantMessageId: 'asst-1',
        }),
      });
    });

    it('writes model:media:start event with assistantMessageId so the UI can attach to a specific row', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeModelMediaStart({
        modelId: 'google/imagen-4',
        assistantMessageId: 'asst-1',
        mediaType: 'image',
        mimeType: 'image/png',
      });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'model:media:start',
        data: JSON.stringify({
          modelId: 'google/imagen-4',
          assistantMessageId: 'asst-1',
          mediaType: 'image',
          mimeType: 'image/png',
        }),
      });
    });

    it('writes model:media:progress event with percent in [0, 100]', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeModelMediaProgress({
        modelId: 'google/veo-3.1',
        assistantMessageId: 'asst-1',
        percent: 30,
      });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'model:media:progress',
        data: JSON.stringify({
          modelId: 'google/veo-3.1',
          assistantMessageId: 'asst-1',
          percent: 30,
        }),
      });
    });

    it('writes model:error event per model with required code', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeModelError({
        modelId: 'anthropic/claude-3.5-sonnet',
        message: 'Model unavailable',
        code: 'STREAM_ERROR',
      });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'model:error',
        data: JSON.stringify({
          modelId: 'anthropic/claude-3.5-sonnet',
          message: 'Model unavailable',
          code: 'STREAM_ERROR',
        }),
      });
    });

    it('writes stage:start event with stageId and assistantMessageId', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeStageStart({
        stageId: 'smart-model',
        assistantMessageId: 'asst-1',
      });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'stage:start',
        data: JSON.stringify({ stageId: 'smart-model', assistantMessageId: 'asst-1' }),
      });
    });

    it('writes stage:done event with the discriminated payload', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeStageDone({
        assistantMessageId: 'asst-1',
        payload: {
          stageId: 'smart-model',
          resolvedModelId: 'anthropic/claude-opus-4.6',
          resolvedModelName: 'Claude Opus 4.6',
        },
      });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]?.event).toBe('stage:done');
      const parsed = JSON.parse(stream.events[0]!.data);
      expect(parsed.payload.stageId).toBe('smart-model');
      expect(parsed.payload.resolvedModelId).toBe('anthropic/claude-opus-4.6');
      expect(parsed.assistantMessageId).toBe('asst-1');
    });

    it('writes stage:error event with stageId and errorCode', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeStageError({
        stageId: 'smart-model',
        assistantMessageId: 'asst-1',
        errorCode: ERROR_CODE_CLASSIFIER_FAILED,
      });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]?.event).toBe('stage:error');
      const parsed = JSON.parse(stream.events[0]!.data);
      expect(parsed.errorCode).toBe(ERROR_CODE_CLASSIFIER_FAILED);
    });

    it('writes multi-model done event with models array', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      const envelopeA = {
        wrappedContentKey: 'd3JhcHBlZC1h',
        contentItems: [
          {
            id: 'ci-a',
            contentType: 'text' as const,
            position: 0,
            encryptedBlob: 'Y2lwaGVyLWE=',
            modelName: 'openai/gpt-4o',
            cost: '0.00200000',
            isSmartModel: false,
          },
        ],
      };
      const envelopeB = {
        wrappedContentKey: 'd3JhcHBlZC1i',
        contentItems: [
          {
            id: 'ci-b',
            contentType: 'text' as const,
            position: 0,
            encryptedBlob: 'Y2lwaGVyLWI=',
            modelName: 'anthropic/claude-3.5-sonnet',
            cost: '0.00300000',
            isSmartModel: false,
          },
        ],
      };

      await writer.writeDone({
        userMessageId: 'user-1',
        assistantMessageId: 'asst-1',
        userSequence: 1,
        aiSequence: 2,
        epochNumber: 1,
        cost: '0.00500000',
        models: [
          {
            modelId: 'openai/gpt-4o',
            assistantMessageId: 'asst-1',
            aiSequence: 2,
            cost: '0.00200000',
            ...envelopeA,
          },
          {
            modelId: 'anthropic/claude-3.5-sonnet',
            assistantMessageId: 'asst-2',
            aiSequence: 3,
            cost: '0.00300000',
            ...envelopeB,
          },
        ],
      });

      const firstEvent = stream.events[0];
      if (!firstEvent) throw new Error('Expected event');
      const parsed = JSON.parse(firstEvent.data) as Record<string, unknown>;
      expect(parsed['models']).toHaveLength(2);
    });

    it('skips model-tagged writes when disconnected', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      stream.triggerAbort();

      await writer.writeModelToken({ modelId: 'openai/gpt-4o', content: 'Hello' });
      await writer.writeModelDone({ modelId: 'openai/gpt-4o', assistantMessageId: 'a' });
      await writer.writeModelError({
        modelId: 'openai/gpt-4o',
        message: 'err',
        code: 'STREAM_ERROR',
      });

      expect(stream.events).toHaveLength(0);
    });
  });

  describe('wrap-once envelope payload on done event', () => {
    it('carries the user message wrapped_content_key and content items in the done event', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      const userContentItem = {
        id: 'ci-user-1',
        contentType: 'text' as const,
        position: 0,
        encryptedBlob: 'dXNlci1jaXBoZXJ0ZXh0',
        modelName: null,
        cost: null,
        isSmartModel: false,
      };

      await writer.writeDone({
        userMessageId: 'user-1',
        assistantMessageId: 'asst-1',
        userSequence: 1,
        aiSequence: 2,
        epochNumber: 1,
        cost: '0.00200000',
        userEnvelope: {
          wrappedContentKey: 'dXNlci13cmFwcGVk',
          contentItems: [userContentItem],
        },
        models: [
          {
            modelId: 'openai/gpt-4o',
            assistantMessageId: 'asst-1',
            aiSequence: 2,
            cost: '0.00200000',
            wrappedContentKey: 'YWlfd3JhcHBlZA==',
            contentItems: [
              {
                id: 'ci-ai-1',
                contentType: 'text' as const,
                position: 0,
                encryptedBlob: 'YWktY2lwaGVydGV4dA==',
                modelName: 'openai/gpt-4o',
                cost: '0.00200000',
                isSmartModel: false,
              },
            ],
          },
        ],
      });

      const firstEvent = stream.events[0];
      if (!firstEvent) throw new Error('Expected event');
      const parsed = JSON.parse(firstEvent.data) as Record<string, unknown>;

      const userEnvelope = parsed['userEnvelope'] as Record<string, unknown>;
      expect(userEnvelope['wrappedContentKey']).toBe('dXNlci13cmFwcGVk');
      expect(userEnvelope['contentItems']).toHaveLength(1);

      const models = parsed['models'] as Record<string, unknown>[];
      expect(models).toHaveLength(1);
      const first = models[0];
      if (!first) throw new Error('Expected model entry');
      expect(first['wrappedContentKey']).toBe('YWlfd3JhcHBlZA==');
      expect(first['contentItems']).toHaveLength(1);
      const items = first['contentItems'] as Record<string, unknown>[];
      const firstItem = items[0];
      if (!firstItem) throw new Error('Expected content item');
      expect(firstItem['id']).toBe('ci-ai-1');
      expect(firstItem['encryptedBlob']).toBe('YWktY2lwaGVydGV4dA==');
      expect(firstItem['modelName']).toBe('openai/gpt-4o');
    });
  });

  describe('connection tracking', () => {
    it('isConnected returns true initially', () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      expect(writer.isConnected()).toBe(true);
    });

    it('isConnected returns false after abort', () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      stream.triggerAbort();

      expect(writer.isConnected()).toBe(false);
    });

    it('marks as disconnected when writeSSE throws', async () => {
      const stream = createMockStream();
      stream.writeSSE = vi.fn().mockRejectedValue(new Error('Connection closed'));
      const writer = createSSEEventWriter(stream);

      await writer.writeModelToken({ modelId: 'openai/gpt-4o', content: 'Hello' });

      expect(writer.isConnected()).toBe(false);
    });

    it('skips writes when disconnected', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      stream.triggerAbort();

      await writer.writeModelToken({ modelId: 'openai/gpt-4o', content: 'Should not send' });

      expect(stream.events).toHaveLength(0);
    });
  });
});

describe('writeStreamErrorFromException', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('writes an error event with STREAM_ERROR code and the Error message', async () => {
    const stream = createMockStream();
    const writer = createSSEEventWriter(stream);

    await writeStreamErrorFromException(writer, new Error('saveChatTurn exploded'));

    expect(stream.events).toHaveLength(1);
    expect(stream.events[0]).toEqual({
      event: 'error',
      data: JSON.stringify({
        message: 'saveChatTurn exploded',
        code: ERROR_CODE_STREAM_ERROR,
      }),
    });
  });

  it('writes a fallback message for non-Error throws', async () => {
    const stream = createMockStream();
    const writer = createSSEEventWriter(stream);

    await writeStreamErrorFromException(writer, 'string-thrown');

    expect(stream.events).toHaveLength(1);
    const parsed = JSON.parse(stream.events[0]?.data ?? '{}') as { message: string; code: string };
    expect(parsed.code).toBe(ERROR_CODE_STREAM_ERROR);
    expect(parsed.message).toBe('Stream processing failed');
  });

  it('logs the original exception to console.error for server-side observability', async () => {
    const stream = createMockStream();
    const writer = createSSEEventWriter(stream);
    const err = new Error('boom');

    await writeStreamErrorFromException(writer, err);

    expect(consoleSpy).toHaveBeenCalledWith('sse stream: uncaught exception', err);
  });

  it('silently no-ops when the writer is already disconnected', async () => {
    const stream = createMockStream();
    const writer = createSSEEventWriter(stream);
    stream.triggerAbort();

    await writeStreamErrorFromException(writer, new Error('after-disconnect'));

    expect(stream.events).toHaveLength(0);
  });
});
