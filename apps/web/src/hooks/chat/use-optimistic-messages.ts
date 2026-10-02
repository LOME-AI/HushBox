import * as React from 'react';
import type { ResolvedReasoningEffort } from '@hushbox/shared';
import type { Message } from '@/lib/api/api';

interface UseOptimisticMessagesResult {
  readonly optimisticMessages: Message[];
  readonly addOptimisticMessage: (message: Message) => void;
  readonly removeOptimisticMessage: (messageId: string) => void;
  /** The message's streamed content, built from its stream events and published whole. */
  readonly setOptimisticMessageContent: (messageId: string, content: string) => void;
  readonly setOptimisticMessageError: (messageId: string, errorCode: string) => void;
  /**
   * Stamp the live billed reasoning token count (the run's finish frame) so
   * the settled thinking label shows before the persisted refetch lands.
   */
  readonly setOptimisticMessageReasoningTokens: (messageId: string, count: number) => void;
  /**
   * The level the slot's generation reasoned at, landed live off the finish
   * frame so the effort badge appears without a reload. `off` is a recorded
   * level and badges; a slot that never receives one stays badgeless.
   */
  readonly setOptimisticMessageReasoningEffort: (
    messageId: string,
    effort: ResolvedReasoningEffort
  ) => void;
  /**
   * Record a Smart tile's classifier-resolved model, sourced from the answer
   * stream's `stream-start` label. Only ever called for a tile sent as the
   * Smart Model sentinel, so it also lights the "Smart" chip.
   */
  readonly setOptimisticMessageSmartModelResolved: (
    messageId: string,
    resolution: { resolvedModelId: string; resolvedModelName: string }
  ) => void;
  /**
   * Mark a slot as actively generating media — sourced from `model:media:start`.
   * Emitted twice per media model: once pre-gateway with a placeholder mime,
   * once post-gateway with the real mime. The UI uses the first to swap to a
   * "Generating image/video/audio…" label and the second to lock in the
   * downstream element type.
   */
  readonly setOptimisticMessageMediaStart: (
    messageId: string,
    mediaType: 'image' | 'audio' | 'video',
    mimeType: string,
    aspectRatio?: string
  ) => void;
  /**
   * Update a slot's synthetic media-progress percent — sourced from
   * `model:media:progress`. Drives a 0-95% progress bar; `model:done` is the
   * authoritative 100%.
   */
  readonly setOptimisticMessageMediaProgress: (messageId: string, percent: number) => void;
  /** Clears one tile's streamed content (same-key clean re-execution). */
  readonly resetOptimisticMessageContent: (messageId: string) => void;
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

  const setOptimisticMessageContent = React.useCallback(
    (messageId: string, content: string): void => {
      setOptimisticMessages((previous) =>
        previous.map((m) => (m.id === messageId ? { ...m, content } : m))
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

  const setOptimisticMessageReasoningTokens = React.useCallback(
    (messageId: string, count: number): void => {
      setOptimisticMessages((previous) =>
        previous.map((m) => (m.id === messageId ? { ...m, reasoningTokens: count } : m))
      );
    },
    []
  );

  const setOptimisticMessageReasoningEffort = React.useCallback(
    (messageId: string, effort: ResolvedReasoningEffort): void => {
      setOptimisticMessages((previous) =>
        previous.map((m) => (m.id === messageId ? { ...m, reasoningEffort: effort } : m))
      );
    },
    []
  );

  const setOptimisticMessageSmartModelResolved = React.useCallback(
    (
      messageId: string,
      resolution: { resolvedModelId: string; resolvedModelName: string }
    ): void => {
      setOptimisticMessages((previous) =>
        previous.map((m) =>
          m.id === messageId
            ? {
                ...m,
                // The resolved id makes the nametag resolve like a persisted
                // message; the resolved name is the immediate display fallback
                // before useModels finds the id.
                modelName: resolution.resolvedModelId,
                resolvedModelName: resolution.resolvedModelName,
                isSmartModel: true,
              }
            : m
        )
      );
    },
    []
  );

  const setOptimisticMessageMediaStart = React.useCallback(
    (
      messageId: string,
      mediaType: 'image' | 'audio' | 'video',
      mimeType: string,
      aspectRatio?: string
    ): void => {
      setOptimisticMessages((previous) =>
        previous.map((m) =>
          m.id === messageId
            ? {
                ...m,
                mediaInFlight: {
                  mediaType,
                  mimeType,
                  ...(aspectRatio !== undefined && { aspectRatio }),
                },
              }
            : m
        )
      );
    },
    []
  );

  const setOptimisticMessageMediaProgress = React.useCallback(
    (messageId: string, percent: number): void => {
      setOptimisticMessages((previous) =>
        previous.map((m) => (m.id === messageId ? { ...m, mediaProgress: { percent } } : m))
      );
    },
    []
  );

  const resetOptimisticMessageContent = React.useCallback((messageId: string): void => {
    setOptimisticMessages((previous) =>
      previous.map((m) => (m.id === messageId ? { ...m, content: '' } : m))
    );
  }, []);

  const resetOptimisticMessages = React.useCallback((): void => {
    setOptimisticMessages([]);
  }, []);

  return {
    optimisticMessages,
    addOptimisticMessage,
    removeOptimisticMessage,
    setOptimisticMessageContent,
    setOptimisticMessageError,
    setOptimisticMessageReasoningTokens,
    setOptimisticMessageReasoningEffort,
    setOptimisticMessageSmartModelResolved,
    setOptimisticMessageMediaStart,
    setOptimisticMessageMediaProgress,
    resetOptimisticMessageContent,
    resetOptimisticMessages,
  };
}
