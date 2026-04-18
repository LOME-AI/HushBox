import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useChatStream,
  TrialRateLimitError,
  BalanceReservedError,
  BillingMismatchError,
  ContextCapacityError,
} from './use-chat-stream';
import * as trialTokenModule from '../lib/trial-token';
import { useStreamingActivityStore } from '@/stores/streaming-activity';

// Mock modules
vi.mock('../lib/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
}));

vi.mock('../lib/trial-token', () => ({
  getTrialToken: vi.fn(() => 'test-trial-token'),
}));

// Mock fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function createSSEStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      const event = events[index];
      if (event === undefined) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(event + '\n'));
        index++;
      }
    },
  });
}

describe('useChatStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStreamingActivityStore.setState({ activeStreams: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('authenticated mode', () => {
    it('calls POST /api/chat/:conversationId/stream with models in body', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
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
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/api/chat/conv-123/stream',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',

          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          }),
        })
      );
    });

    it('includes webSearchEnabled in request body when provided', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
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
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
          webSearchEnabled: true,
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/api/chat/conv-123/stream',
        expect.objectContaining({
          body: JSON.stringify({
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
            webSearchEnabled: true,
          }),
        })
      );
    });

    it('does not include X-Trial-Token header in authenticated mode', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
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
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers['X-Trial-Token']).toBeUndefined();
    });

    it('returns userMessageId and models array on success', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-456","models":[{"modelId":"gpt-4","assistantMessageId":"msg-456"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello "}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"world!"}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"msg-456","cost":"0.00150000"}',
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
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(streamResult).toEqual(
        expect.objectContaining({
          userMessageId: 'user-456',
          models: [{ modelId: 'gpt-4', assistantMessageId: 'msg-456', cost: '0.00150000' }],
        })
      );
    });

    it('calls onToken callback for each token with modelId', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-789","models":[{"modelId":"gpt-4","assistantMessageId":"msg-789"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello "}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"world!"}',
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
          {
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          },
          { onToken }
        );
      });

      expect(onToken).toHaveBeenCalledTimes(2);
      expect(onToken).toHaveBeenNthCalledWith(1, 'Hello ', 'gpt-4');
      expect(onToken).toHaveBeenNthCalledWith(2, 'world!', 'gpt-4');
    });

    it('calls onStart callback with StartEventData containing models array', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onStart = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream(
          {
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          },
          { onStart }
        );
      });

      expect(onStart).toHaveBeenCalledWith({
        userMessageId: 'user-123',
        models: [{ modelId: 'gpt-4', assistantMessageId: 'msg-123' }],
      });
    });

    it('sets isStreaming to true while streaming', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
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
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      await act(async () => {
        await streamPromise;
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });

    it('throws error on non-SSE content type', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: () => Promise.resolve({ code: 'INTERNAL' }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        })
      ).rejects.toThrow('INTERNAL');
    });
  });

  describe('trial mode', () => {
    it('calls POST /api/trial/stream with messages and model', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      await act(async () => {
        await result.current.startStream({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'gpt-4',
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/api/trial/stream',
        expect.objectContaining({
          method: 'POST',

          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Trial-Token': 'test-trial-token',
          }),
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'Hello' }],
            model: 'gpt-4',
          }),
        })
      );
    });

    it('sends X-Trial-Token header from localStorage', async () => {
      const getTrialTokenSpy = vi.spyOn(trialTokenModule, 'getTrialToken');
      getTrialTokenSpy.mockReturnValue('my-unique-token');

      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      await act(async () => {
        await result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      expect(getTrialTokenSpy).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Trial-Token': 'my-unique-token',
          }),
        })
      );
    });

    it('does not include credentials in trial mode', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      await act(async () => {
        await result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].credentials).toBeUndefined();
    });

    it('returns models array on success', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","models":[{"modelId":"gpt-4","assistantMessageId":"msg-456"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello "}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"world!"}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"msg-456","cost":"0.00100000"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      let streamResult: Awaited<ReturnType<typeof result.current.startStream>> | undefined;
      await act(async () => {
        streamResult = await result.current.startStream({
          messages: [{ role: 'user', content: 'Hi' }],
          model: 'gpt-4',
        });
      });

      expect(streamResult).toEqual(
        expect.objectContaining({
          userMessageId: '',
          models: [{ modelId: 'gpt-4', assistantMessageId: 'msg-456', cost: '0.00100000' }],
        })
      );
    });

    it('calls onToken callback for each token with modelId', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","models":[{"modelId":"gpt-4","assistantMessageId":"msg-789"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello "}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"world!"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onToken = vi.fn();
      const { result } = renderHook(() => useChatStream('trial'));

      await act(async () => {
        await result.current.startStream(
          { messages: [{ role: 'user', content: 'Hi' }], model: 'gpt-4' },
          { onToken }
        );
      });

      expect(onToken).toHaveBeenCalledTimes(2);
      expect(onToken).toHaveBeenNthCalledWith(1, 'Hello ', 'gpt-4');
      expect(onToken).toHaveBeenNthCalledWith(2, 'world!', 'gpt-4');
    });

    it('sets isStreaming to true while streaming', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('trial'));

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

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });
  });

  describe('trial rate limit handling', () => {
    it('throws TrialRateLimitError on 429 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            code: 'DAILY_LIMIT_EXCEEDED',
            details: { limit: 5, remaining: 0 },
          }),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      await expect(
        act(async () => {
          await result.current.startStream({
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'gpt-4',
          });
        })
      ).rejects.toThrow('DAILY_LIMIT_EXCEEDED');
    });

    it('includes limit info in rate limit error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            code: 'DAILY_LIMIT_EXCEEDED',
            details: { limit: 5, remaining: 0 },
          }),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      try {
        await act(async () => {
          await result.current.startStream({
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'gpt-4',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TrialRateLimitError);
        expect((error as TrialRateLimitError).code).toBe('DAILY_LIMIT_EXCEEDED');
        expect((error as TrialRateLimitError).limit).toBe(5);
        expect((error as TrialRateLimitError).isRateLimited).toBe(true);
      }
    });

    it('does not throw TrialRateLimitError for 429 in authenticated mode', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () =>
          Promise.resolve({
            code: 'RATE_LIMITED',
          }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).not.toBeInstanceOf(TrialRateLimitError);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('RATE_LIMITED');
      }
    });
  });

  describe('balance reserved error handling', () => {
    it('throws BalanceReservedError on authenticated 402 with speculative balance message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: () =>
          Promise.resolve({
            code: 'BALANCE_RESERVED',
          }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BalanceReservedError);
        expect((error as BalanceReservedError).code).toBe('BALANCE_RESERVED');
        expect((error as BalanceReservedError).isBalanceReserved).toBe(true);
      }
    });

    it('throws regular Error on authenticated 402 without speculative balance message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: () =>
          Promise.resolve({
            code: 'INSUFFICIENT_BALANCE',
          }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).not.toBeInstanceOf(BalanceReservedError);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('INSUFFICIENT_BALANCE');
      }
    });

    it('does not throw BalanceReservedError for trial 402', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: () =>
          Promise.resolve({
            code: 'BALANCE_RESERVED',
          }),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      try {
        await act(async () => {
          await result.current.startStream({
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'gpt-4',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).not.toBeInstanceOf(BalanceReservedError);
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe('billing mismatch error handling', () => {
    it('throws BillingMismatchError on authenticated 409 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            code: 'BILLING_MISMATCH',
          }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BillingMismatchError);
        expect((error as BillingMismatchError).code).toBe('BILLING_MISMATCH');
        expect((error as BillingMismatchError).isBillingMismatch).toBe(true);
      }
    });

    it('does not throw BillingMismatchError for trial 409', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            code: 'CONFLICT',
          }),
      });

      const { result } = renderHook(() => useChatStream('trial'));

      try {
        await act(async () => {
          await result.current.startStream({
            messages: [{ role: 'user', content: 'Hi' }],
            model: 'gpt-4',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).not.toBeInstanceOf(BillingMismatchError);
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe('context capacity error handling', () => {
    it('throws ContextCapacityError on context_length_exceeded SSE error', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: error',
        'data: {"message":"This conversation exceeds the model\'s memory limit. Start a new conversation or switch to a model with a larger context window.","code":"CONTEXT_LENGTH_EXCEEDED"}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ContextCapacityError);
        expect((error as ContextCapacityError).code).toBe('CONTEXT_LENGTH_EXCEEDED');
        expect((error as ContextCapacityError).isContextCapacity).toBe(true);
      }
    });

    it('throws regular Error on non-capacity SSE error', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
        'event: error',
        'data: {"message":"Model unavailable","code":"MODEL_ERROR"}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).not.toBeInstanceOf(ContextCapacityError);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Model unavailable');
      }
    });
  });

  describe('startRegenerateStream', () => {
    it('calls POST /api/chat/:conversationId/regenerate with regeneration fields', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-regen"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"New response"}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"msg-regen","cost":"0.00100000"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      let streamResult:
        | Awaited<ReturnType<typeof result.current.startRegenerateStream>>
        | undefined;
      await act(async () => {
        streamResult = await result.current.startRegenerateStream({
          conversationId: 'conv-123',
          targetMessageId: 'msg-target',
          action: 'retry',
          model: 'gpt-4',
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8787/api/chat/conv-123/regenerate',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            targetMessageId: 'msg-target',
            action: 'retry',
            model: 'gpt-4',
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          }),
        })
      );

      expect(streamResult).toEqual(
        expect.objectContaining({
          userMessageId: 'user-123',
          models: [{ modelId: 'gpt-4', assistantMessageId: 'msg-regen', cost: '0.00100000' }],
        })
      );
    });

    it('sets isStreaming during regeneration', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
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
        streamPromise = result.current.startRegenerateStream({
          conversationId: 'conv-123',
          targetMessageId: 'msg-target',
          action: 'regenerate',
          model: 'gpt-4',
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(true);
      });

      await act(async () => {
        await streamPromise;
      });

      await waitFor(() => {
        expect(result.current.isStreaming).toBe(false);
      });
    });
  });

  describe('common error handling', () => {
    it('throws error on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ code: 'INTERNAL' }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        })
      ).rejects.toThrow('INTERNAL');
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
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        })
      ).rejects.toThrow('Response body is null');
    });

    it('throws error on stream error event', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
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
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        })
      ).rejects.toThrow('Model unavailable');
    });
  });

  describe('multi-model streaming', () => {
    it('returns multiple models in result when start event has multiple models', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-1","models":[{"modelId":"gpt-4","assistantMessageId":"asst-1"},{"modelId":"claude-3","assistantMessageId":"asst-2"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello"}',
        'event: token',
        'data: {"modelId":"claude-3","content":"Hi"}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"asst-1","cost":"0.00200000"}',
        'event: model:done',
        'data: {"modelId":"claude-3","assistantMessageId":"asst-2","cost":"0.00300000"}',
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
          conversationId: 'conv-1',
          models: ['gpt-4', 'claude-3'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(streamResult).toEqual(
        expect.objectContaining({
          userMessageId: 'user-1',
          models: [
            { modelId: 'gpt-4', assistantMessageId: 'asst-1', cost: '0.00200000' },
            { modelId: 'claude-3', assistantMessageId: 'asst-2', cost: '0.00300000' },
          ],
        })
      );
    });

    it('calls onToken with correct modelId for interleaved tokens', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-1","models":[{"modelId":"gpt-4","assistantMessageId":"asst-1"},{"modelId":"claude-3","assistantMessageId":"asst-2"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"A"}',
        'event: token',
        'data: {"modelId":"claude-3","content":"X"}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"B"}',
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
          {
            conversationId: 'conv-1',
            models: ['gpt-4', 'claude-3'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          },
          { onToken }
        );
      });

      expect(onToken).toHaveBeenCalledTimes(3);
      expect(onToken).toHaveBeenNthCalledWith(1, 'A', 'gpt-4');
      expect(onToken).toHaveBeenNthCalledWith(2, 'X', 'claude-3');
      expect(onToken).toHaveBeenNthCalledWith(3, 'B', 'gpt-4');
    });

    it('calls onModelDone for each completed model', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-1","models":[{"modelId":"gpt-4","assistantMessageId":"asst-1"},{"modelId":"claude-3","assistantMessageId":"asst-2"}]}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"asst-1","cost":"0.002"}',
        'event: model:done',
        'data: {"modelId":"claude-3","assistantMessageId":"asst-2","cost":"0.003"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onModelDone = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream(
          {
            conversationId: 'conv-1',
            models: ['gpt-4', 'claude-3'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          },
          { onModelDone }
        );
      });

      expect(onModelDone).toHaveBeenCalledTimes(2);
      expect(onModelDone).toHaveBeenNthCalledWith(1, {
        modelId: 'gpt-4',
        assistantMessageId: 'asst-1',
        cost: '0.002',
      });
      expect(onModelDone).toHaveBeenNthCalledWith(2, {
        modelId: 'claude-3',
        assistantMessageId: 'asst-2',
        cost: '0.003',
      });
    });

    it('calls onModelError when a model fails', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-1","models":[{"modelId":"gpt-4","assistantMessageId":"asst-1"},{"modelId":"claude-3","assistantMessageId":"asst-2"}]}',
        'event: model:done',
        'data: {"modelId":"gpt-4","assistantMessageId":"asst-1","cost":"0.002"}',
        'event: model:error',
        'data: {"modelId":"claude-3","message":"Model unavailable"}',
        'event: done',
        'data: {}',
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: createSSEStream(sseEvents),
      });

      const onModelError = vi.fn();
      const onModelDone = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await act(async () => {
        await result.current.startStream(
          {
            conversationId: 'conv-1',
            models: ['gpt-4', 'claude-3'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          },
          { onModelDone, onModelError }
        );
      });

      expect(onModelDone).toHaveBeenCalledTimes(1);
      expect(onModelError).toHaveBeenCalledTimes(1);
      expect(onModelError).toHaveBeenCalledWith({
        modelId: 'claude-3',
        message: 'Model unavailable',
      });
    });

    it('defaults cost to 0 for models without model:done event', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-1","models":[{"modelId":"gpt-4","assistantMessageId":"asst-1"}]}',
        'event: token',
        'data: {"modelId":"gpt-4","content":"Hello"}',
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
          conversationId: 'conv-1',
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(streamResult).toEqual(
        expect.objectContaining({
          userMessageId: 'user-1',
          models: [{ modelId: 'gpt-4', assistantMessageId: 'asst-1', cost: '0' }],
        })
      );
    });
  });

  describe('streaming activity store integration', () => {
    it('increments global stream counter on start (caller responsible for endStream)', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
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
          models: ['gpt-4'],
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      // Stream started but endStream not called — caller owns the lifecycle
      expect(useStreamingActivityStore.getState().activeStreams).toBe(1);

      // Caller calls endStream after post-stream work
      useStreamingActivityStore.getState().endStream();
      expect(useStreamingActivityStore.getState().activeStreams).toBe(0);
    });

    it('keeps stream counter incremented even on stream error (caller must endStream)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ code: 'INTERNAL' }),
      });

      const { result } = renderHook(() => useChatStream('authenticated'));

      try {
        await act(async () => {
          await result.current.startStream({
            conversationId: 'conv-123',
            models: ['gpt-4'],
            userMessage: { id: 'msg-1', content: 'Hello' },
            messagesForInference: [{ role: 'user', content: 'Hello' }],
            fundingSource: 'personal_balance',
          });
        });
      } catch {
        // Expected error
      }

      expect(result.current.isStreaming).toBe(false);
      // Counter still 1 — caller calls endStream in their error handler
      expect(useStreamingActivityStore.getState().activeStreams).toBe(1);

      useStreamingActivityStore.getState().endStream();
      expect(useStreamingActivityStore.getState().activeStreams).toBe(0);
    });

    it('increments global stream counter during regeneration (caller responsible for endStream)', async () => {
      const sseEvents = [
        'event: start',
        'data: {"userMessageId":"user-123","models":[{"modelId":"gpt-4","assistantMessageId":"msg-123"}]}',
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
        await result.current.startRegenerateStream({
          conversationId: 'conv-123',
          targetMessageId: 'msg-target',
          action: 'retry',
          model: 'gpt-4',
          userMessage: { id: 'msg-1', content: 'Hello' },
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          fundingSource: 'personal_balance',
        });
      });

      expect(useStreamingActivityStore.getState().activeStreams).toBe(1);

      useStreamingActivityStore.getState().endStream();
      expect(useStreamingActivityStore.getState().activeStreams).toBe(0);
    });
  });
});
