import * as React from 'react';

export interface ChatPageState {
  inputValue: string;
  setInputValue: (value: string) => void;
  clearInput: () => void;

  streamingMessageIds: Set<string>;
  streamingMessageIdsRef: React.RefObject<Set<string>>;
  startStreaming: (messageIds: string[]) => void;
  stopStreaming: () => void;

  // Cleared on the SSE `done` event (post-saveChatTurn commit, post-cost
  // settlement). Distinct from streamingMessageIds, which is cleared on the
  // earlier `model:done` flip — that flip is a UX optimization (re-enable
  // the input immediately) and runs BEFORE the server has persisted the
  // turn. A follow-up send during that window races against resolveParentMessageId
  // on the server and persists with the wrong parentMessageId, branching
  // the conversation tree. Tests gate on persistingMessageIds (via
  // data-streaming-count) so "wait for streaming to finish" really means
  // "wait for the server to commit." UI gates on streamingMessageIds so the
  // toolbar and input stay responsive.
  persistingMessageIds: Set<string>;
  persistingMessageIdsRef: React.RefObject<Set<string>>;
  stopPersisting: () => void;
}

const EMPTY_SET = new Set<string>();

export function useChatPageState(): ChatPageState {
  const [inputValue, setInputValue] = React.useState('');
  const [streamingMessageIds, setStreamingMessageIds] = React.useState<Set<string>>(EMPTY_SET);
  const streamingMessageIdsRef = React.useRef<Set<string>>(new Set());
  const [persistingMessageIds, setPersistingMessageIds] = React.useState<Set<string>>(EMPTY_SET);
  const persistingMessageIdsRef = React.useRef<Set<string>>(new Set());

  const clearInput = React.useCallback(() => {
    setInputValue('');
  }, []);

  const startStreaming = React.useCallback((messageIds: string[]) => {
    const ids = new Set(messageIds);
    setStreamingMessageIds(ids);
    streamingMessageIdsRef.current = ids;
    setPersistingMessageIds(ids);
    persistingMessageIdsRef.current = ids;
  }, []);

  const stopStreaming = React.useCallback(() => {
    setStreamingMessageIds(EMPTY_SET);
    streamingMessageIdsRef.current = new Set();
  }, []);

  const stopPersisting = React.useCallback(() => {
    setPersistingMessageIds(EMPTY_SET);
    persistingMessageIdsRef.current = new Set();
  }, []);

  return {
    inputValue,
    setInputValue,
    clearInput,
    streamingMessageIds,
    streamingMessageIdsRef,
    startStreaming,
    stopStreaming,
    persistingMessageIds,
    persistingMessageIdsRef,
    stopPersisting,
  };
}
