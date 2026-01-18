import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChatStream, GuestRateLimitError } from './use-chat-stream';
import * as guestTokenModule from '../lib/guest-token';

// Mock modules
vi.mock('../lib/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
}));

vi.mock('../lib/guest-token', () => ({
  getGuestToken: vi.fn(() => 'test-guest-token'),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

function createSSEStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      const event = events[index];
      if (event !== undefined) {
        controller.enqueue(encoder.encode(event + '\n'));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

describe('useChatStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('authenticated mode', () => {
    it('calls POST /chat/stream with conversationId and model', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","assistantMessageId":"msg-123"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream({
          conversationId: 'conv-123',
          model: 'gpt-4',
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/chat/stream',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest expect returns any
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            conversationId: 'conv-123',
            model: 'gpt-4',
          }),
        })
      );
    });

    it('does not include X-Guest-Token header in authenticated mode', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","assistantMessageId":"msg-123"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream({
          conversationId: 'conv-123',
          model: 'gpt-4',
        });
      });

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['X-Guest-Token']).toBeUndefined();
    });

    it('returns userMessageId, assistantMessageId and content on success', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-456","assistantMessageId":"msg-456"}',
        'event: token',
        'data: {"content":"Hello "}',
        'event: token',
        'data: {"content":"world!"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      let streamResult: Awaited<ReturnType<typeof result.current.startStream>> | undefined;
      await act(async () => {
        streamResult = await result.current.startStream({
          conversationId: 'conv-123',
          model: 'gpt-4',
        });
      });

      expect(streamResult).toEqual({
        userMessageId: 'user-456',
        assistantMessageId: 'msg-456',
        content: 'Hello world!',
      });
    });

    it('calls onToken callback for each token', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-789","assistantMessageId":"msg-789"}',
        'event: token',
        'data: {"content":"Hello "}',
        'event: token',
        'data: {"content":"world!"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onToken = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream(
          { conversationId: 'conv-123', model: 'gpt-4' },
          { onToken }
        );
      });

      expect(onToken).toHaveBeenCalledTimes(2);
      expect(onToken).toHaveBeenNthCalledWith(1, 'Hello ');
      expect(onToken).toHaveBeenNthCalledWith(2, 'world!');
    });

    it('sets isStreaming to true while streaming', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","assistantMessageId":"msg-123"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      expect(result.current.isStreaming).toBe(false);

      let streamPromise: Promise<unknown>;
      act(() => {
        streamPromise = result.current.startStream({
          conversationId: 'conv-123',
          model: 'gpt-4',
        });
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      await act(async () => {
        await streamPromise;
      });

      expect(result.current.isStreaming).toBe(false);
    });

    it('throws error on non-SSE content type', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: () => Promise.resolve({ error: 'Not a stream' }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            model: 'gpt-4',
          });
        })
      ).rejects.toThrow('Not a stream');
    });
  });

  describe('guest mode', () => {
    it('calls POST /guest/stream with messages and model', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","assistantMessageId":"msg-123"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('guest'));

      await act(async () => {
        await result.current.startStream({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'gpt-4',
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/guest/stream',
        expect.objectContaining({
          method: 'POST',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest expect returns any
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Guest-Token': 'test-guest-token',
          }),
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'Hello' }],
            model: 'gpt-4',
          }),
        })
      );
    });

    it('sends X-Guest-Token header from localStorage', async () => {
      const getGuestTokenSpy = vi.spyOn(guestTokenModule, 'getGuestToken');
      getGuestTokenSpy.mockReturnValue('my-unique-token');

      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","assistantMessageId":"msg-123"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('guest'));

      await act(async () => {
        await result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      expect(getGuestTokenSpy).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest expect returns any
          headers: expect.objectContaining({
            'X-Guest-Token': 'my-unique-token',
          }),
        })
      );
    });

    it('does not include credentials in guest mode', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","assistantMessageId":"msg-123"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('guest'));

      await act(async () => {
        await result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].credentials).toBeUndefined();
    });

    it('returns assistantMessageId and content on success', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","assistantMessageId":"msg-456"}',
        'event: token',
        'data: {"content":"Hello "}',
        'event: token',
        'data: {"content":"world!"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('guest'));

      let streamResult: Awaited<ReturnType<typeof result.current.startStream>> | undefined;
      await act(async () => {
        streamResult = await result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      expect(streamResult).toEqual({
        userMessageId: '',
        assistantMessageId: 'msg-456',
        content: 'Hello world!',
      });
    });

    it('calls onToken callback for each token', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","assistantMessageId":"msg-789"}',
        'event: token',
        'data: {"content":"Hello "}',
        'event: token',
        'data: {"content":"world!"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onToken = vi.fn();
      const { result } = renderHook(() => useChatStream('guest'));

      await act(async () => {
        await result.current.startStream(
          { messages: [{ role: 'user', content: 'Hi' }], model: 'gpt-4' },
          { onToken }
        );
      });

      expect(onToken).toHaveBeenCalledTimes(2);
      expect(onToken).toHaveBeenNthCalledWith(1, 'Hello ');
      expect(onToken).toHaveBeenNthCalledWith(2, 'world!');
    });

    it('sets isStreaming to true while streaming', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","assistantMessageId":"msg-123"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('guest'));

      expect(result.current.isStreaming).toBe(false);

      let streamPromise: Promise<unknown>;
      act(() => {
        streamPromise = result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      await act(async () => {
        await streamPromise;
      });

      expect(result.current.isStreaming).toBe(false);
    });
  });

  describe('guest rate limit handling', () => {
    it('throws GuestRateLimitError on 429 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            error: 'Daily limit exceeded',
            limit: 5,
            remaining: 0,
          }),
      });

      const { result } = renderHook(() => useChatStream('guest'));

      await expect(
        act(async () => {
          await result.current.startStream({
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'gpt-4',
          });
        })
      ).rejects.toThrow('Daily limit exceeded');
    });

    it('includes limit info in rate limit error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            error: 'Daily limit exceeded',
            limit: 5,
            remaining: 0,
          }),
      });

      const { result } = renderHook(() => useChatStream('guest'));

      try {
        await act(async () => {
          await result.current.startStream({
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'gpt-4',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GuestRateLimitError);
        expect((error as GuestRateLimitError).limit).toBe(5);
        expect((error as GuestRateLimitError).isRateLimited).toBe(true);
      }
    });

    it('does not throw GuestRateLimitError for 429 in authenticated mode', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            error: 'Rate limited',
          }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            model: 'gpt-4',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).not.toBeInstanceOf(GuestRateLimitError);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Rate limited');
      }
    });
  });

  describe('common error handling', () => {
    it('throws error on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Internal server error' }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            model: 'gpt-4',
          });
        })
      ).rejects.toThrow('Internal server error');
    });

    it('throws error when body is null', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: null,
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            model: 'gpt-4',
          });
        })
      ).rejects.toThrow('Response body is null');
    });

    it('throws error on stream error event', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","assistantMessageId":"msg-123"}',
        'event: error',
        'data: {"message":"Model unavailable","code":"MODEL_ERROR"}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            model: 'gpt-4',
          });
        })
      ).rejects.toThrow('Model unavailable');
    });
  });
});
