import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatPageState } from './use-chat-page';
import type { Document } from '@/lib/document-parser';

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

  describe('document state', () => {
    it('starts with no documents', () => {
      const { result } = renderHook(() => useChatPageState());

      expect(result.current.documentsByMessage).toEqual({});
      expect(result.current.allDocuments).toEqual([]);
    });

    it('stores documents by message ID', () => {
      const { result } = renderHook(() => useChatPageState());
      const documents: Document[] = [
        { id: 'doc-1', type: 'code', content: 'Test', title: 'Doc', lineCount: 1 },
      ];

      act(() => {
        result.current.handleDocumentsExtracted('msg-1', documents);
      });

      expect(result.current.documentsByMessage['msg-1']).toEqual(documents);
    });

    it('aggregates all documents from all messages', () => {
      const { result } = renderHook(() => useChatPageState());
      const documents1: Document[] = [
        { id: 'doc-1', type: 'code', content: 'First', title: 'Doc1', lineCount: 1 },
      ];
      const documents2: Document[] = [
        { id: 'doc-2', type: 'code', content: 'code', language: 'js', title: 'Doc2', lineCount: 1 },
      ];

      act(() => {
        result.current.handleDocumentsExtracted('msg-1', documents1);
        result.current.handleDocumentsExtracted('msg-2', documents2);
      });

      expect(result.current.allDocuments).toHaveLength(2);
      expect(result.current.allDocuments).toContainEqual(documents1[0]);
      expect(result.current.allDocuments).toContainEqual(documents2[0]);
    });

    it('replaces documents for the same message ID', () => {
      const { result } = renderHook(() => useChatPageState());
      const documents1: Document[] = [
        { id: 'doc-1', type: 'code', content: 'First', title: 'Doc1', lineCount: 1 },
      ];
      const documents2: Document[] = [
        { id: 'doc-2', type: 'code', content: 'Second', title: 'Doc2', lineCount: 1 },
      ];

      act(() => {
        result.current.handleDocumentsExtracted('msg-1', documents1);
      });
      act(() => {
        result.current.handleDocumentsExtracted('msg-1', documents2);
      });

      expect(result.current.documentsByMessage['msg-1']).toEqual(documents2);
      expect(result.current.allDocuments).toHaveLength(1);
    });
  });

  describe('callback stability', () => {
    it('maintains stable callback references', () => {
      const { result, rerender } = renderHook(() => useChatPageState());

      const initialClearInput = result.current.clearInput;
      const initialStartStreaming = result.current.startStreaming;
      const initialStopStreaming = result.current.stopStreaming;
      const initialHandleDocuments = result.current.handleDocumentsExtracted;

      rerender();

      expect(result.current.clearInput).toBe(initialClearInput);
      expect(result.current.startStreaming).toBe(initialStartStreaming);
      expect(result.current.stopStreaming).toBe(initialStopStreaming);
      expect(result.current.handleDocumentsExtracted).toBe(initialHandleDocuments);
    });
  });
});
