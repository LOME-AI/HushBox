import * as React from 'react';
import type { StageDonePayload, StageId } from '@hushbox/shared';
import type { Message } from '@/lib/api';

interface UseOptimisticMessagesResult {
  readonly optimisticMessages: Message[];
  readonly addOptimisticMessage: (message: Message) => void;
  readonly removeOptimisticMessage: (messageId: string) => void;
  readonly updateOptimisticMessageContent: (messageId: string, token: string) => void;
  readonly setOptimisticMessageError: (messageId: string, errorCode: string) => void;
  /** Mark a slot as classifying — drives the in-flight "Choosing…" placeholder. */
  readonly setOptimisticMessageStageStart: (messageId: string, stageId: StageId) => void;
  /** Apply a stage:done transformation to the slot — clears classifying, records resolution. */
  readonly setOptimisticMessageStageDone: (messageId: string, payload: StageDonePayload) => void;
  /** Clear classifying and record the stage's error code (mirrors setOptimisticMessageError). */
  readonly setOptimisticMessageStageError: (messageId: string, errorCode: string) => void;
  readonly resetOptimisticMessages: () => void;
}

export function useOptimisticMessages(): UseOptimisticMessagesResult {
  const [optimisticMessages, setOptimisticMessages] = React.useState<Message[]>([]);

  const addOptimisticMessage = React.useCallback((message: Message): void => {
    setOptimisticMessages((previous) => [...previous, message]);
  }, []);

  const removeOptimisticMessage = React.useCallback((messageId: string): void => {
    setOptimisticMessages((previous) => previous.filter((m) => m.id !== messageId));
  }, []);

  const updateOptimisticMessageContent = React.useCallback(
    (messageId: string, token: string): void => {
      setOptimisticMessages((previous) =>
        previous.map((m) => (m.id === messageId ? { ...m, content: m.content + token } : m))
      );
    },
    []
  );

  const setOptimisticMessageError = React.useCallback(
    (messageId: string, errorCode: string): void => {
      setOptimisticMessages((previous) =>
        previous.map((m) => (m.id === messageId ? { ...m, errorCode, content: '' } : m))
      );
    },
    []
  );

  const setOptimisticMessageStageStart = React.useCallback(
    (messageId: string, stageId: StageId): void => {
      setOptimisticMessages((previous) =>
        previous.map((m) => (m.id === messageId ? { ...m, classifyingStageId: stageId } : m))
      );
    },
    []
  );

  const setOptimisticMessageStageDone = React.useCallback(
    (messageId: string, payload: StageDonePayload): void => {
      setOptimisticMessages((previous) =>
        previous.map((m) => {
          if (m.id !== messageId) return m;
          // Reset classifying. Record the resolved model id (so the nametag
          // resolves like a persisted message) and the resolved name (used as
          // an immediate display fallback before useModels finds the id).
          // For Smart Model specifically, light up the "Smart" chip live.
          const next: Message = {
            ...m,
            classifyingStageId: undefined,
            modelName: payload.resolvedModelId,
            resolvedModelName: payload.resolvedModelName,
          };
          // Cast to string widens away from today's literal union so the
          // comparison reads as forward-compat against future stage types.
          if ((payload.stageId as string) === 'smart-model') {
            next.isSmartModel = true;
          }
          return next;
        })
      );
    },
    []
  );

  const setOptimisticMessageStageError = React.useCallback(
    (messageId: string, errorCode: string): void => {
      setOptimisticMessages((previous) =>
        previous.map((m) =>
          m.id === messageId ? { ...m, classifyingStageId: undefined, errorCode, content: '' } : m
        )
      );
    },
    []
  );

  const resetOptimisticMessages = React.useCallback((): void => {
    setOptimisticMessages([]);
  }, []);

  return {
    optimisticMessages,
    addOptimisticMessage,
    removeOptimisticMessage,
    updateOptimisticMessageContent,
    setOptimisticMessageError,
    setOptimisticMessageStageStart,
    setOptimisticMessageStageDone,
    setOptimisticMessageStageError,
    resetOptimisticMessages,
  };
}
