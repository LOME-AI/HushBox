import { describe, it, expect, vi } from 'vitest';
import { createSSEEventWriter, type SSEStream } from './stream-handler.js';

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

    it('writes token event with content', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeToken('Hello');

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'token',
        data: JSON.stringify({ content: 'Hello' }),
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

    it('writes model:done event per model', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeModelDone({
        modelId: 'openai/gpt-4o',
        assistantMessageId: 'asst-1',
        cost: '0.00200000',
      });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'model:done',
        data: JSON.stringify({
          modelId: 'openai/gpt-4o',
          assistantMessageId: 'asst-1',
          cost: '0.00200000',
        }),
      });
    });

    it('writes model:error event per model', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeModelError({
        modelId: 'anthropic/claude-3.5-sonnet',
        message: 'Model unavailable',
        code: 'MODEL_ERROR',
      });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'model:error',
        data: JSON.stringify({
          modelId: 'anthropic/claude-3.5-sonnet',
          message: 'Model unavailable',
          code: 'MODEL_ERROR',
        }),
      });
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
      await writer.writeModelDone({ modelId: 'openai/gpt-4o', assistantMessageId: 'a', cost: '0' });
      await writer.writeModelError({ modelId: 'openai/gpt-4o', message: 'err' });

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

      await writer.writeToken('Hello');

      expect(writer.isConnected()).toBe(false);
    });

    it('skips writes when disconnected', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      stream.triggerAbort();

      await writer.writeToken('Should not send');

      expect(stream.events).toHaveLength(0);
    });
  });
});
