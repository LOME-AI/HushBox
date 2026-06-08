import * as React from 'react';

export interface ChatPageState {
  inputValue: string;
  setInputValue: (value: string) => void;
  clearInput: () => void;

  streamingMessageIds: Set<string>;
  streamingMessageIdsRef: React.RefObject<Set<string>>;
  startStreaming: (messageIds: string[]) => void;
  // Releases only the named ids. A turn that finishes while a newer overlapping
  // turn is still streaming must not clear the newer turn's ids — callers pass
  // the ids their own turn owns, never a blanket clear.
  stopStreaming: (messageIds: string[]) => void;

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
  // Scoped like {@link stopStreaming}: releases only the named ids. This is the
  // SSE `done` release, so a prior turn's late `done` can't clear the
  // persistence tracking of an overlapping turn the user sent in the meantime.
  stopPersisting: (messageIds: string[]) => void;
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

  // Union rather than replace: a fresh turn's ids are added alongside any turn
  // still settling, so overlapping sends accumulate instead of evicting one
  // another. The refs (read here as the live source of truth, since the
  // callbacks are stable) stay in sync with the rendered sets.
  const startStreaming = React.useCallback((messageIds: string[]) => {
    const streaming = new Set(streamingMessageIdsRef.current);
    const persisting = new Set(persistingMessageIdsRef.current);
    for (const id of messageIds) {
      streaming.add(id);
      persisting.add(id);
    }
    streamingMessageIdsRef.current = streaming;
    persistingMessageIdsRef.current = persisting;
    setStreamingMessageIds(streaming);
    setPersistingMessageIds(persisting);
  }, []);

  const stopStreaming = React.useCallback((messageIds: string[]) => {
    const next = new Set(streamingMessageIdsRef.current);
    for (const id of messageIds) next.delete(id);
    streamingMessageIdsRef.current = next;
    setStreamingMessageIds(next);
  }, []);

  const stopPersisting = React.useCallback((messageIds: string[]) => {
    const next = new Set(persistingMessageIdsRef.current);
    for (const id of messageIds) next.delete(id);
    persistingMessageIdsRef.current = next;
    setPersistingMessageIds(next);
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
