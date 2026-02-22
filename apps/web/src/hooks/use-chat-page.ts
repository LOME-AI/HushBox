import * as React from 'react';

export interface ChatPageState {
  inputValue: string;
  setInputValue: (value: string) => void;
  clearInput: () => void;

  streamingMessageId: string | null;
  streamingMessageIdRef: React.RefObject<string | null>;
  startStreaming: (messageId: string) => void;
  stopStreaming: () => void;
}

export function useChatPageState(): ChatPageState {
  const [inputValue, setInputValue] = React.useState('');
  const [streamingMessageId, setStreamingMessageId] = React.useState<string | null>(null);
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

  return {
    inputValue,
    setInputValue,
    clearInput,
    streamingMessageId,
    streamingMessageIdRef,
    startStreaming,
    stopStreaming,
  };
}
