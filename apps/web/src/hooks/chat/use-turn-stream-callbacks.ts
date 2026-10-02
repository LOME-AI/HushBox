import * as React from 'react';
import { SMART_MODEL_ID, type ResolvedReasoningEffort } from '@hushbox/shared';
import { processStartEvent } from '@/lib/chat/multi-model-stream';
import { pendingMediaInFlight, requestedMediaAspectRatio } from '@/lib/chat/auth-chat-helpers';
import { usePreInferenceActivityStore } from '@/stores/activity/pre-inference';
import type { useChatPageState } from '@/hooks/chat/use-chat-page';
import type { useOptimisticMessages } from '@/hooks/chat/use-optimistic-messages';
import type {
  StartEventData,
  ModelErrorData,
  ModelMediaStartData,
  RekeyEventData,
  StreamOptions,
} from '@/hooks/chat/use-chat-stream';
import type { Message } from '@/lib/api/api';

/** The model-store slices the media handlers read, taken from the helper that consumes them. */
type ActiveModality = Parameters<typeof pendingMediaInFlight>[0];
type ImageConfig = Parameters<typeof pendingMediaInFlight>[1];
type VideoConfig = Parameters<typeof pendingMediaInFlight>[2];

interface TurnStreamCallbacksInput {
  readonly state: ReturnType<typeof useChatPageState>;
  /** The conversation the create flow streams into, read at event time. */
  readonly conversationIdRef: React.RefObject<string>;
  readonly setLocalMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  readonly activeModality: ActiveModality;
  readonly imageConfig: ImageConfig;
  readonly videoConfig: VideoConfig;
  readonly optimistic: ReturnType<typeof useOptimisticMessages>;
}

/** The stream handler set that writes a turn's tiles into `localMessages`. */
export type LocalMessageStreamHandlers = Readonly<{
  onStart: (data: StartEventData) => void;
  onContent: (content: string, assistantMessageId: string) => void;
  onReasoningTokens: (count: number, assistantMessageId: string) => void;
  onReasoningEffort: (effort: ResolvedReasoningEffort, assistantMessageId: string) => void;
  onModelError: (data: ModelErrorData) => void;
  onModelMediaStart: (data: ModelMediaStartData) => void;
  onModelMediaProgress: (data: { assistantMessageId: string; percent: number }) => void;
  onModelMediaDone: (data: { assistantMessageId: string }) => void;
  onModelResolved: (assistantMessageId: string, modelId: string) => void;
  onRestart: (assistantMessageIds: string[]) => void;
  onRekey: (data: RekeyEventData) => void;
}>;

/** `onStart` and `onRekey` are required: every call site wraps them, so they must stay callable. */
type OptimisticStreamCallbacks = StreamOptions & {
  onStart: (data: StartEventData) => void;
  onRekey: (data: RekeyEventData) => void;
};

/** The ids of the tiles a re-execution replaced. */
function replacedTileIds(data: RekeyEventData): string[] {
  return data.previousModels.map((entry) => entry.assistantMessageId);
}

interface TurnStreamCallbacks {
  readonly recordSmartTiles: (data: StartEventData) => void;
  readonly localMessageHandlers: LocalMessageStreamHandlers;
  readonly createOptimisticStreamCallbacks: (convId: string) => OptimisticStreamCallbacks;
}

function startStreamingIfNeeded(
  assistantMessageIds: string[],
  state: { startStreaming: (ids: string[]) => void }
): void {
  if (assistantMessageIds.length > 0) {
    state.startStreaming(assistantMessageIds);
  }
}

/**
 * The two stream-callback sets a chat turn can install — one writing through the
 * optimistic-message store, one writing `localMessages` for the create flow — and
 * the Smart-tile tracking both read. They live together because that tracking is
 * one ref shared by both: apart, the ref has to travel between them.
 */
export function useTurnStreamCallbacks({
  state,
  conversationIdRef,
  setLocalMessages,
  activeModality,
  imageConfig,
  videoConfig,
  optimistic,
}: TurnStreamCallbacksInput): TurnStreamCallbacks {
  const {
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
  } = optimistic;

  const handleStreamStart = React.useCallback(
    (data: StartEventData) => {
      const { messages, assistantMessageIds } = processStartEvent(
        data,
        conversationIdRef.current,
        data.userMessageId
      );
      // First message of a new conversation: stamp the media backdrop hint at
      // creation, the same as the optimistic flow, so it shows the animation
      // from the first frame instead of the text "is generating…" indicator.
      const mediaInFlight = pendingMediaInFlight(activeModality, imageConfig, videoConfig);
      const stamped = mediaInFlight ? messages.map((m) => ({ ...m, mediaInFlight })) : messages;
      setLocalMessages((previous) => [...previous, ...stamped]);
      startStreamingIfNeeded(assistantMessageIds, state);
    },
    [state, activeModality, imageConfig, videoConfig]
  );

  const handleStreamContent = React.useCallback((content: string, assistantMessageId: string) => {
    setLocalMessages((previous) =>
      previous.map((m) => (m.id === assistantMessageId ? { ...m, content } : m))
    );
  }, []);

  const handleStreamReasoningTokens = React.useCallback(
    (count: number, assistantMessageId: string) => {
      setLocalMessages((previous) =>
        previous.map((m) => (m.id === assistantMessageId ? { ...m, reasoningTokens: count } : m))
      );
    },
    []
  );

  const handleStreamReasoningEffort = React.useCallback(
    (effort: ResolvedReasoningEffort, assistantMessageId: string) => {
      setLocalMessages((previous) =>
        previous.map((m) => (m.id === assistantMessageId ? { ...m, reasoningEffort: effort } : m))
      );
    },
    []
  );

  const handleStreamModelError = React.useCallback((data: ModelErrorData) => {
    setLocalMessages((previous) =>
      previous.map((m) =>
        m.id === data.assistantMessageId ? { ...m, errorCode: data.code, content: '' } : m
      )
    );
  }, []);

  /**
   * Tracks which tiles of the active turn were sent as the Smart Model
   * sentinel, so `stream-start`'s resolved model id can flip the tile's
   * nametag and light the "Smart" chip.
   */
  const smartTileIdsRef = React.useRef(new Set<string>());

  const recordSmartTiles = React.useCallback((data: StartEventData) => {
    smartTileIdsRef.current = new Set(
      data.models
        .filter((entry) => entry.modelId === SMART_MODEL_ID)
        .map((entry) => entry.assistantMessageId)
    );
  }, []);

  const handleStreamModelResolved = React.useCallback(
    (assistantMessageId: string, modelId: string) => {
      if (!smartTileIdsRef.current.has(assistantMessageId)) return;
      // The resolved label is the observable end of the pre-inference
      // classifier stage — advance the monotonic stage counter here (the
      // E2E readiness signal), once per Smart tile resolution.
      usePreInferenceActivityStore.getState().markStageSeen();
      setLocalMessages((previous) =>
        previous.map((m) =>
          m.id === assistantMessageId
            ? { ...m, modelName: modelId, resolvedModelName: modelId, isSmartModel: true }
            : m
        )
      );
    },
    []
  );

  /** A same-key clean re-execution restarted the answer: reset tile content. */
  const handleStreamRestart = React.useCallback((assistantMessageIds: string[]) => {
    const ids = new Set(assistantMessageIds);
    setLocalMessages((previous) =>
      previous.map((m) => (ids.has(m.id) ? { ...m, content: '' } : m))
    );
  }, []);

  /**
   * A same-key re-execution named new ids: its tiles start over, empty, under
   * the fresh answer ids and the user message id it named, and the tiles they
   * replace stop streaming.
   */
  const handleStreamRekey = React.useCallback(
    (data: RekeyEventData) => {
      const replaced = replacedTileIds(data);
      const replacedSet = new Set(replaced);
      state.stopStreaming(replaced);
      state.stopPersisting(replaced);
      setLocalMessages((previous) => previous.filter((m) => !replacedSet.has(m.id)));
      handleStreamStart(data);
    },
    [state, handleStreamStart]
  );

  // Media handlers for the new-chat flow (mutate localMessages, mirroring the
  // optimistic setters). `media-start` refines the creation-time mime;
  // `media-progress` drives the video bar; `media-done` is the authoritative
  // 100% — the wire never says it.
  const handleStreamMediaStart = React.useCallback(
    (data: ModelMediaStartData) => {
      const aspectRatio = requestedMediaAspectRatio(data.mediaType, imageConfig, videoConfig);
      setLocalMessages((previous) =>
        previous.map((m) =>
          m.id === data.assistantMessageId
            ? {
                ...m,
                mediaInFlight: {
                  mediaType: data.mediaType,
                  mimeType: data.mimeType,
                  ...(aspectRatio !== undefined && { aspectRatio }),
                },
              }
            : m
        )
      );
    },
    [imageConfig, videoConfig]
  );

  const handleStreamMediaProgress = React.useCallback(
    (data: { assistantMessageId: string; percent: number }) => {
      setLocalMessages((previous) =>
        previous.map((m) =>
          m.id === data.assistantMessageId ? { ...m, mediaProgress: { percent: data.percent } } : m
        )
      );
    },
    []
  );

  const handleStreamMediaDone = React.useCallback((data: { assistantMessageId: string }) => {
    setLocalMessages((previous) =>
      previous.map((m) =>
        m.id === data.assistantMessageId ? { ...m, mediaProgress: { percent: 100 } } : m
      )
    );
  }, []);

  const createOptimisticStreamCallbacks = React.useCallback(
    (convId: string) => {
      // The assistant tile ids this turn owns. Captured in onStart so the
      // completion callbacks release ONLY this turn's tracking — a turn that
      // settles while a newer overlapping turn is mid-flight must never clear
      // the newer turn's streaming/persisting ids.
      let turnAssistantIds: string[] = [];
      const onStart = (data: StartEventData): void => {
        const { messages, assistantMessageIds } = processStartEvent(
          data,
          convId,
          data.userMessageId
        );
        recordSmartTiles(data);
        turnAssistantIds = assistantMessageIds;
        // Stamp the media backdrop hint from the first frame so a media turn
        // never flashes the text "thinking" indicator before media-start.
        const mediaInFlight = pendingMediaInFlight(activeModality, imageConfig, videoConfig);
        for (const msg of messages) {
          addOptimisticMessage(mediaInFlight ? { ...msg, mediaInFlight } : msg);
        }
        startStreamingIfNeeded(assistantMessageIds, state);
      };
      return {
        onStart,
        // The optimistic store has no operation that moves a row to a new id or
        // parent, so each replaced tile is dropped and the turn started again,
        // empty, under the ids the re-execution named.
        onRekey: (data: RekeyEventData) => {
          const replaced = replacedTileIds(data);
          for (const id of replaced) removeOptimisticMessage(id);
          state.stopStreaming(replaced);
          state.stopPersisting(replaced);
          onStart(data);
        },
        onContent: (content: string, assistantMessageId: string) => {
          setOptimisticMessageContent(assistantMessageId, content);
        },
        onReasoningTokens: (count: number, assistantMessageId: string) => {
          setOptimisticMessageReasoningTokens(assistantMessageId, count);
        },
        onReasoningEffort: (effort: ResolvedReasoningEffort, assistantMessageId: string) => {
          setOptimisticMessageReasoningEffort(assistantMessageId, effort);
        },
        onModelResolved: (assistantMessageId: string, modelId: string) => {
          if (!smartTileIdsRef.current.has(assistantMessageId)) return;
          // The resolved label ends the pre-inference classifier stage —
          // advance the monotonic stage counter (the E2E readiness signal).
          usePreInferenceActivityStore.getState().markStageSeen();
          // The resolved model replaces the "Smart Model" nametag and lights
          // the Smart chip.
          setOptimisticMessageSmartModelResolved(assistantMessageId, {
            resolvedModelId: modelId,
            resolvedModelName: modelId,
          });
        },
        onRestart: (assistantMessageIds: string[]) => {
          for (const id of assistantMessageIds) resetOptimisticMessageContent(id);
        },
        onModelError: (data: ModelErrorData) => {
          setOptimisticMessageError(data.assistantMessageId, data.code);
        },
        onModelMediaStart: (data: ModelMediaStartData) => {
          const aspectRatio = requestedMediaAspectRatio(data.mediaType, imageConfig, videoConfig);
          setOptimisticMessageMediaStart(
            data.assistantMessageId,
            data.mediaType,
            data.mimeType,
            aspectRatio
          );
        },
        // Synthetic video progress: the wire sweeps 10..90 then heartbeats 95.
        onModelMediaProgress: (data: { assistantMessageId: string; percent: number }) => {
          setOptimisticMessageMediaProgress(data.assistantMessageId, data.percent);
        },
        // The wire never says 100 — media-done flips the synthetic bar to its
        // terminal state ahead of the persisted refetch.
        onModelMediaDone: (data: { assistantMessageId: string }) => {
          setOptimisticMessageMediaProgress(data.assistantMessageId, 100);
        },
        // Token streaming has ended for every model in this turn (terminal
        // stream events all arrived). The run is still settling server-side,
        // but the user has seen all the tokens — re-enable the input and let
        // `resolveMessageActions` show the toolbar now.
        onAllModelsComplete: () => {
          state.stopStreaming(turnAssistantIds);
        },
        // run-finished — settlement committed (or the turn is over either
        // way). Clear the persistence-tracking set so the next send doesn't
        // race against an in-flight commit and resolve the wrong
        // parentMessageId.
        onAllStreamsSettled: () => {
          state.stopPersisting(turnAssistantIds);
        },
      };
    },
    [
      state,
      addOptimisticMessage,
      removeOptimisticMessage,
      setOptimisticMessageContent,
      setOptimisticMessageError,
      setOptimisticMessageReasoningTokens,
      setOptimisticMessageReasoningEffort,
      setOptimisticMessageMediaStart,
      setOptimisticMessageMediaProgress,
      setOptimisticMessageSmartModelResolved,
      resetOptimisticMessageContent,
      recordSmartTiles,
      activeModality,
      imageConfig,
      videoConfig,
    ]
  );

  const localMessageHandlers: LocalMessageStreamHandlers = React.useMemo(
    () => ({
      onStart: handleStreamStart,
      onContent: handleStreamContent,
      onReasoningTokens: handleStreamReasoningTokens,
      onReasoningEffort: handleStreamReasoningEffort,
      onModelError: handleStreamModelError,
      onModelMediaStart: handleStreamMediaStart,
      onModelMediaProgress: handleStreamMediaProgress,
      onModelMediaDone: handleStreamMediaDone,
      onModelResolved: handleStreamModelResolved,
      onRestart: handleStreamRestart,
      onRekey: handleStreamRekey,
    }),
    [
      handleStreamStart,
      handleStreamContent,
      handleStreamReasoningTokens,
      handleStreamReasoningEffort,
      handleStreamModelError,
      handleStreamMediaStart,
      handleStreamMediaProgress,
      handleStreamMediaDone,
      handleStreamModelResolved,
      handleStreamRestart,
      handleStreamRekey,
    ]
  );

  return { recordSmartTiles, localMessageHandlers, createOptimisticStreamCallbacks };
}
