import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useOptimisticMessages } from './use-optimistic-messages';
import type { Message } from '@/lib/api';

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    role: 'assistant',
    content: 'Hello',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('useOptimisticMessages', () => {
  it('starts with empty messages', () => {
    const { result } = renderHook(() => useOptimisticMessages());
    expect(result.current.optimisticMessages).toEqual([]);
  });

  it('adds a message', () => {
    const { result } = renderHook(() => useOptimisticMessages());
    const message = createMessage();

    act(() => {
      result.current.addOptimisticMessage(message);
    });

    expect(result.current.optimisticMessages).toHaveLength(1);
    expect(result.current.optimisticMessages[0]).toEqual(message);
  });

  it('removes a message by id', () => {
    const { result } = renderHook(() => useOptimisticMessages());
    const msg1 = createMessage({ id: 'msg-1' });
    const msg2 = createMessage({ id: 'msg-2' });

    act(() => {
      result.current.addOptimisticMessage(msg1);
      result.current.addOptimisticMessage(msg2);
    });

    act(() => {
      result.current.removeOptimisticMessage('msg-1');
    });

    expect(result.current.optimisticMessages).toHaveLength(1);
    expect(result.current.optimisticMessages[0]!.id).toBe('msg-2');
  });

  it('appends token to message content', () => {
    const { result } = renderHook(() => useOptimisticMessages());
    const message = createMessage({ content: 'Hello' });

    act(() => {
      result.current.addOptimisticMessage(message);
    });

    act(() => {
      result.current.updateOptimisticMessageContent('msg-1', ' world');
    });

    expect(result.current.optimisticMessages[0]!.content).toBe('Hello world');
  });

  it('sets errorCode and clears content on matching message', () => {
    const { result } = renderHook(() => useOptimisticMessages());
    const message = createMessage({ content: 'partial response' });

    act(() => {
      result.current.addOptimisticMessage(message);
    });

    act(() => {
      result.current.setOptimisticMessageError('msg-1', 'STREAM_ERROR');
    });

    expect(result.current.optimisticMessages[0]!.errorCode).toBe('STREAM_ERROR');
    expect(result.current.optimisticMessages[0]!.content).toBe('');
  });

  it('does not affect other messages when setting error', () => {
    const { result } = renderHook(() => useOptimisticMessages());
    const msg1 = createMessage({ id: 'msg-1', content: 'OK response' });
    const msg2 = createMessage({ id: 'msg-2', content: 'will fail' });

    act(() => {
      result.current.addOptimisticMessage(msg1);
      result.current.addOptimisticMessage(msg2);
    });

    act(() => {
      result.current.setOptimisticMessageError('msg-2', 'MODEL_ERROR');
    });

    expect(result.current.optimisticMessages[0]!.content).toBe('OK response');
    expect(result.current.optimisticMessages[0]!.errorCode).toBeUndefined();
    expect(result.current.optimisticMessages[1]!.errorCode).toBe('MODEL_ERROR');
    expect(result.current.optimisticMessages[1]!.content).toBe('');
  });

  it('resets all messages', () => {
    const { result } = renderHook(() => useOptimisticMessages());

    act(() => {
      result.current.addOptimisticMessage(createMessage({ id: 'msg-1' }));
      result.current.addOptimisticMessage(createMessage({ id: 'msg-2' }));
    });

    act(() => {
      result.current.resetOptimisticMessages();
    });

    expect(result.current.optimisticMessages).toEqual([]);
  });
});
