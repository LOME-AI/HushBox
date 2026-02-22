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
    it('writes start event with userMessageId and assistantMessageId', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeStart({ userMessageId: 'user-123', assistantMessageId: 'assistant-456' });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'start',
        data: JSON.stringify({ userMessageId: 'user-123', assistantMessageId: 'assistant-456' }),
      });
    });

    it('writes start event with only assistantMessageId for trial users', async () => {
      const stream = createMockStream();
      const writer = createSSEEventWriter(stream);

      await writer.writeStart({ assistantMessageId: 'assistant-456' });

      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toEqual({
        event: 'start',
        data: JSON.stringify({ assistantMessageId: 'assistant-456' }),
      });
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
