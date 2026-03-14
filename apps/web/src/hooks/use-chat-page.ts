import * as React from 'react';

export interface ChatPageState {
  inputValue: string;
  setInputValue: (value: string) => void;
  clearInput: () => void;

  streamingMessageIds: Set<string>;
  streamingMessageIdsRef: React.RefObject<Set<string>>;
  startStreaming: (messageIds: string[]) => void;
  stopStreaming: () => void;
}

const EMPTY_SET = new Set<string>();

export function useChatPageState(): ChatPageState {
  const [inputValue, setInputValue] = React.useState('');
  const [streamingMessageIds, setStreamingMessageIds] = React.useState<Set<string>>(EMPTY_SET);
  const streamingMessageIdsRef = React.useRef<Set<string>>(new Set());

  const clearInput = React.useCallback(() => {
    setInputValue('');
  }, []);

  const startStreaming = React.useCallback((messageIds: string[]) => {
    const ids = new Set(messageIds);
    setStreamingMessageIds(ids);
    streamingMessageIdsRef.current = ids;
  }, []);

  const stopStreaming = React.useCallback(() => {
    setStreamingMessageIds(EMPTY_SET);
    streamingMessageIdsRef.current = new Set();
  }, []);

  return {
    inputValue,
    setInputValue,
    clearInput,
    streamingMessageIds,
    streamingMessageIdsRef,
    startStreaming,
    stopStreaming,
  };
}
