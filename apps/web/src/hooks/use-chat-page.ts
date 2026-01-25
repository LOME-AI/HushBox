import * as React from 'react';
import type { Document } from '@/lib/document-parser';

export interface ChatPageState {
  inputValue: string;
  setInputValue: (value: string) => void;
  clearInput: () => void;

  streamingMessageId: string | null;
  streamingMessageIdRef: React.RefObject<string | null>;
  startStreaming: (messageId: string) => void;
  stopStreaming: () => void;

  documentsByMessage: Record<string, Document[]>;
  handleDocumentsExtracted: (messageId: string, documents: Document[]) => void;
  allDocuments: Document[];
}

export function useChatPageState(): ChatPageState {
  const [inputValue, setInputValue] = React.useState('');
  const [streamingMessageId, setStreamingMessageId] = React.useState<string | null>(null);
  const [documentsByMessage, setDocumentsByMessage] = React.useState<Record<string, Document[]>>(
    {}
  );
  const streamingMessageIdRef = React.useRef<string | null>(null);

  const clearInput = React.useCallback(() => {
    setInputValue('');
  }, []);

  const startStreaming = React.useCallback((messageId: string) => {
    setStreamingMessageId(messageId);
    streamingMessageIdRef.current = messageId;
  }, []);

  const stopStreaming = React.useCallback(() => {
    setStreamingMessageId(null);
    streamingMessageIdRef.current = null;
  }, []);

  const handleDocumentsExtracted = React.useCallback((messageId: string, documents: Document[]) => {
    setDocumentsByMessage((previous) => ({ ...previous, [messageId]: documents }));
  }, []);

  const allDocuments = React.useMemo(
    () => Object.values(documentsByMessage).flat(),
    [documentsByMessage]
  );

  return {
    inputValue,
    setInputValue,
    clearInput,
    streamingMessageId,
    streamingMessageIdRef,
    startStreaming,
    stopStreaming,
    documentsByMessage,
    handleDocumentsExtracted,
    allDocuments,
  };
}
