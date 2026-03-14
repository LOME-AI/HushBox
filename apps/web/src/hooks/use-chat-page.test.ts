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
    it('starts with no streaming messages', () => {
      const { result } = renderHook(() => useChatPageState());

      expect(result.current.streamingMessageIds.size).toBe(0);
      expect(result.current.streamingMessageIdsRef.current.size).toBe(0);
    });

    it('starts streaming with a single message ID', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['msg-123']);
      });

      expect(result.current.streamingMessageIds.has('msg-123')).toBe(true);
      expect(result.current.streamingMessageIds.size).toBe(1);
      expect(result.current.streamingMessageIdsRef.current.has('msg-123')).toBe(true);
    });

    it('starts streaming with multiple message IDs', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['msg-1', 'msg-2', 'msg-3']);
      });

      expect(result.current.streamingMessageIds.size).toBe(3);
      expect(result.current.streamingMessageIds.has('msg-1')).toBe(true);
      expect(result.current.streamingMessageIds.has('msg-2')).toBe(true);
      expect(result.current.streamingMessageIds.has('msg-3')).toBe(true);
    });

    it('stops streaming', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['msg-123']);
      });
      act(() => {
        result.current.stopStreaming();
      });

      expect(result.current.streamingMessageIds.size).toBe(0);
      expect(result.current.streamingMessageIdsRef.current.size).toBe(0);
    });

    it('ref is updated synchronously with startStreaming', () => {
      const { result } = renderHook(() => useChatPageState());

      act(() => {
        result.current.startStreaming(['msg-456']);
        expect(result.current.streamingMessageIdsRef.current.has('msg-456')).toBe(true);
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
