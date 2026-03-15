import * as React from 'react';
import type { Message } from '@/lib/api';

interface UseOptimisticMessagesResult {
  readonly optimisticMessages: Message[];
  readonly addOptimisticMessage: (message: Message) => void;
  readonly removeOptimisticMessage: (messageId: string) => void;
  readonly updateOptimisticMessageContent: (messageId: string, token: string) => void;
  readonly setOptimisticMessageError: (messageId: string, errorCode: string) => void;
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

  const resetOptimisticMessages = React.useCallback((): void => {
    setOptimisticMessages([]);
  }, []);

  return {
    optimisticMessages,
    addOptimisticMessage,
    removeOptimisticMessage,
    updateOptimisticMessageContent,
    setOptimisticMessageError,
    resetOptimisticMessages,
  };
}
