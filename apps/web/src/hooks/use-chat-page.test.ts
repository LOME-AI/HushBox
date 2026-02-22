import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatPageState } from './use-chat-page';

describe('useChatPageState', () => {
  describe('input state', () => {
    it('starts with empty input value', () => {
      const { result } = renderHook(() => useChatPageState());

      expect(result.current.inputValue).toBe('');
    });

    it('updates input value', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.setInputValue('Hello world');
      });

      expect(result.current.inputValue).toBe('Hello world');
    });

    it('clears input value', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.setInputValue('Some text');
      });
      act(() => {
        result.current.clearInput();
      });

      expect(result.current.inputValue).toBe('');
    });
  });

  describe('streaming state', () => {
    it('starts with no streaming message', () => {
      const { result } = renderHook(() => useChatPageState());

      expect(result.current.streamingMessageId).toBeNull();
      expect(result.current.streamingMessageIdRef.current).toBeNull();
    });

    it('starts streaming with a message ID', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming('msg-123');
      });

      expect(result.current.streamingMessageId).toBe('msg-123');
      expect(result.current.streamingMessageIdRef.current).toBe('msg-123');
    });

    it('stops streaming', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming('msg-123');
      });
      act(() => {
        result.current.stopStreaming();
      });

      expect(result.current.streamingMessageId).toBeNull();
      expect(result.current.streamingMessageIdRef.current).toBeNull();
    });

    it('ref is updated synchronously with startStreaming', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming('msg-456');
        expect(result.current.streamingMessageIdRef.current).toBe('msg-456');
      });
    });
  });

  describe('callback stability', () => {
    it('maintains stable callback references', () => {
      const { result, rerender } = renderHook(() => useChatPageState());

      const initialClearInput = result.current.clearInput;
      const initialStartStreaming = result.current.startStreaming;
      const initialStopStreaming = result.current.stopStreaming;

      rerender();

      expect(result.current.clearInput).toBe(initialClearInput);
      expect(result.current.startStreaming).toBe(initialStartStreaming);
      expect(result.current.stopStreaming).toBe(initialStopStreaming);
    });
  });
});
