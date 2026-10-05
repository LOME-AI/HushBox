import * as React from 'react';
import { Navigate } from '@tanstack/react-router';
import { ROUTES, historyCharacterCount, stripReplayHistory, SMART_MODEL_ID } from '@hushbox/shared';
import { useFormFactor } from '@hushbox/ui/platform';
import { ChatLayout } from '@/components/chat/layout/chat-layout';
import { createTrialMessage } from '@/lib/chat/messages';
import { buildMessagesForRegeneration } from '@/lib/chat/regeneration';
import { placeTurnNotice } from '@/lib/chat/auth-chat-helpers';
import { trialRefusalFor } from '@/lib/chat/trial-refusals';
import { turnNoticeForCode, turnNoticeText } from '@/lib/chat/turn-notice';
import { useChatPageState } from '@/hooks/chat/use-chat-page';
import { useChatStream } from '@/hooks/chat/use-chat-stream';
import { useTrialChatStore } from '@/stores/chat/trial-chat';
import { useModelStore, getPrimaryModel } from '@/stores/model';
import { useChatErrorStore, createChatError, MAIN_FORK_KEY } from '@/stores/chat/error';
import { useChatEditStore } from '@/stores/chat/edit';
import { useSession } from '@/lib/auth/auth';
import { useReasoningEffort } from '@/hooks/chat/use-reasoning-effort';
import type { PromptInputRef } from '@/components/chat/input/prompt-input';
import type { TrialStreamRequest } from '@/hooks/chat/use-chat-stream';
import type { Message } from '@/lib/api/api';
import type { TrialMessage } from '@/stores/chat/trial-chat';

/**
 * Trial messages lack parentMessageId, so resolve assistant targets to
 * the preceding user message by position (mirrors resolveRegenerateTarget
 * which uses parentMessageId for authenticated messages).
 */
function resolveTrialTarget(
  messages: { id: string; role: string }[],
  targetMessageId: string
): { resolvedId: string; targetRole: string } {
  const target = messages.find((m) => m.id === targetMessageId);
  if (!target) return { resolvedId: targetMessageId, targetRole: 'user' };

  if (target.role === 'assistant') {
    const targetIndex = messages.findIndex((m) => m.id === targetMessageId);
    const precedingUser = messages.slice(0, targetIndex).findLast((m) => m.role === 'user');
    return { resolvedId: precedingUser?.id ?? targetMessageId, targetRole: 'assistant' };
  }

  return { resolvedId: targetMessageId, targetRole: target.role };
}

/** The row a regenerate cuts after, chosen by the target's role rather than the action. */
function lastKeptId(
  messages: { id: string }[],
  targetMessageId: string,
  targetRole: string
): string | undefined {
  if (targetRole !== 'assistant') return targetMessageId;
  const targetIndex = messages.findIndex((m) => m.id === targetMessageId);
  return targetIndex > 0 ? messages[targetIndex - 1]?.id : undefined;
}

/**
 * A trial run as it was posted. A trial stores nothing and spends a quota slot on every
 * POST whatever its key, so a retry runs this request again under a fresh key.
 */
interface TrialAttempt {
  request: TrialStreamRequest;
  /** The thread while the run is in flight: its question added, or its cut and edit applied. */
  rows: TrialMessage[];
  /** The thread a failed regenerate or edit puts back; null for a send, whose question stays. */
  restore: TrialMessage[] | null;
  /**
   * An edit's edited question, under an id of its own: the edit rewrites its row in place
   * and the restore puts the old text back under that row's id. Null for a send or retry.
   */
  question: TrialMessage | null;
}

function editedQuestion(editedContent: string | undefined): TrialMessage | null {
  return editedContent ? createTrialMessage('user', editedContent) : null;
}

/** The notice sits after the failed attempt's question and that question's reply. */
function withFailedAttempt(
  messages: Message[],
  notice: Message,
  attempt: TrialAttempt | null
): Message[] {
  const anchorId = attempt?.rows.findLast((m) => m.role === 'user')?.id ?? null;
  return placeTurnNotice(messages, notice, attempt?.question ?? null, anchorId);
}

export function TrialChatPage(): React.JSX.Element {
  const state = useChatPageState();
  const isPhone = useFormFactor().band === 'phone';
  const promptInputRef = React.useRef<PromptInputRef>(null);
  const creationStartedRef = React.useRef(false);
  const [creationStarted, setCreationStarted] = React.useState(false);

  const { data: session, isPending: isSessionPending } = useSession();
  const isAuthenticated = !isSessionPending && Boolean(session?.user);

  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  const { isStreaming, startStream } = useChatStream('trial');
  const { editingMessageId, startEditing, clearEditing } = useChatEditStore();

  const {
    messages: trialMessages,
    pendingMessage: trialPendingMessage,
    isRateLimited,
    addMessage: addTrialMessage,
    updateMessageContent: updateTrialMessageContent,
    clearPendingMessage: clearTrialPendingMessage,
    setRateLimited,
    removeMessagesAfter,
    removeMessage,
    setMessages: setTrialMessages,
    setMessageSmartModelResolved,
  } = useTrialChatStore();
  const [failedAttempt, setFailedAttempt] = React.useState<TrialAttempt | null>(null);

  // Trial chats are linear (no forks), so every read/write keys off
  // MAIN_FORK_KEY. Same store, single slot in practice.
  const chatError = useChatErrorStore((s) => s.errorsByFork[MAIN_FORK_KEY] ?? null);

  React.useEffect(() => {
    useChatErrorStore.getState().clearAll();
    return () => {
      useChatErrorStore.getState().clearAll();
    };
  }, []);

  // A refusal disables only the page whose thread shows its tile; once that page
  // is left, the landing's composer and stack must read as a fresh load does.
  React.useEffect(() => {
    return () => {
      setRateLimited(false);
    };
  }, [setRateLimited]);

  // The store is read when the failure lands: this callback's render predates the row
  // the failing send added, so its `trialMessages` would keep the previous question.
  const handleStreamError = React.useCallback(
    (error: unknown): void => {
      const failedContent =
        useTrialChatStore.getState().messages.findLast((m) => m.role === 'user')?.content ?? '';
      const refusal = trialRefusalFor(error);
      if (refusal) {
        useChatErrorStore
          .getState()
          .setError(MAIN_FORK_KEY, createChatError({ notice: refusal.notice, failedContent }));
        if (refusal.disablesComposer) {
          setRateLimited(true);
        }
      } else {
        console.error('Trial chat error:', error);
        useChatErrorStore.getState().setError(
          MAIN_FORK_KEY,
          createChatError({
            notice: turnNoticeForCode('INTERNAL'),
            failedContent,
          })
        );
      }
    },
    [setRateLimited]
  );

  const primaryModelId = getPrimaryModel(selectedModels).id;
  // The trial effort menu GREYS the levels the trial ceiling cannot fund — it
  // hides nothing, for any tier — so a stored preference naming one is lowered
  // by the producer below to the nearest enabled rung BELOW it, and to `auto`
  // when none is enabled below. What rides here is the lowered value.
  const { effective: reasoningEffort } = useReasoningEffort();

  const trialRequest = React.useCallback(
    (messages: TrialStreamRequest['messages']): TrialStreamRequest => ({
      messages,
      model: primaryModelId,
      ...(reasoningEffort !== undefined && { reasoningEffort }),
    }),
    [primaryModelId, reasoningEffort]
  );

  const executeStream = React.useCallback(
    async (
      request: TrialStreamRequest,
      restore: TrialMessage[] | null,
      question: TrialMessage | null = null
    ): Promise<void> => {
      const rows = useTrialChatStore.getState().messages;
      const placeholderIds: string[] = [];
      try {
        await startStream(request, {
          onStart: ({ models }) => {
            const firstModel = models[0];
            if (!firstModel?.assistantMessageId) return;
            placeholderIds.push(firstModel.assistantMessageId);
            const assistantMessage = createTrialMessage(
              'assistant',
              '',
              firstModel.assistantMessageId,
              firstModel.modelId
            );
            addTrialMessage(assistantMessage);
            state.startStreaming([firstModel.assistantMessageId]);
          },
          onContent: (content, assistantMessageId) => {
            updateTrialMessageContent(assistantMessageId, content);
          },
          // Smart Model: the answer stream's `stream-start` carries the
          // classifier-resolved model id. Record it so the nametag shows the
          // resolved name instead of the "smart-model" placeholder. Plain
          // model sends already carry their own id — no relabel needed.
          onModelResolved: (assistantMessageId, modelId) => {
            if (request.model !== SMART_MODEL_ID) return;
            setMessageSmartModelResolved(assistantMessageId, {
              resolvedModelId: modelId,
              resolvedModelName: modelId,
            });
          },
          // A same-key clean re-execution restarted the answer over the
          // reconnected socket: clear the partial so tokens do not double.
          onRestart: (assistantMessageIds) => {
            for (const id of assistantMessageIds) {
              useTrialChatStore.getState().updateMessageContent(id, '');
            }
          },
          // Wrapper's finally fires this on error/abort too — single
          // cleanup path for persistingMessageIds regardless of outcome.
          onAllStreamsSettled: () => {
            state.stopPersisting(placeholderIds);
          },
        });

        state.stopStreaming(placeholderIds);
      } catch (error) {
        state.stopStreaming(placeholderIds);
        // Stream threw after `start` fired: drop the assistant placeholder so
        // it doesn't render as an invisible empty bubble whose action toolbar
        // floats above the chat-error tile.
        for (const id of placeholderIds) {
          removeMessage(id);
        }
        handleStreamError(error);
        if (restore !== null) setTrialMessages(restore);
        setFailedAttempt({ request, rows, restore, question });
      }
    },
    [
      startStream,
      addTrialMessage,
      updateTrialMessageContent,
      state,
      handleStreamError,
      removeMessage,
      setTrialMessages,
      setMessageSmartModelResolved,
    ]
  );

  const handleTrialFirstMessage = React.useCallback(
    async (content: string): Promise<void> => {
      clearTrialPendingMessage();
      useChatErrorStore.getState().clearError(MAIN_FORK_KEY);

      const userMessage = createTrialMessage('user', content);
      addTrialMessage(userMessage);

      await executeStream(trialRequest([{ role: 'user' as const, content }]), null);
    },
    [clearTrialPendingMessage, addTrialMessage, executeStream, trialRequest]
  );

  React.useEffect(() => {
    if (trialPendingMessage && !creationStartedRef.current && !isStreaming) {
      creationStartedRef.current = true;
      setCreationStarted(true);
      void handleTrialFirstMessage(trialPendingMessage);
    }
  }, [trialPendingMessage, isStreaming, handleTrialFirstMessage]);

  /**
   * Regenerate on the turn notice runs the failed attempt again as it was posted: the same
   * text, history, model and effort, with the thread it showed while running.
   */
  const retryFailedAttempt = React.useCallback(
    async (attempt: TrialAttempt): Promise<void> => {
      useChatErrorStore.getState().clearError(MAIN_FORK_KEY);
      setTrialMessages(attempt.rows);
      await executeStream(attempt.request, attempt.restore, attempt.question);
    },
    [setTrialMessages, executeStream]
  );

  const handleTrialRegenerate = React.useCallback(
    async (targetMessageId: string, editedContent?: string): Promise<void> => {
      if (isStreaming || isRateLimited) return;
      if (chatError?.id === targetMessageId) {
        if (failedAttempt !== null) await retryFailedAttempt(failedAttempt);
        return;
      }
      if (!trialMessages.some((m) => m.id === targetMessageId)) return;

      const { resolvedId, targetRole } = resolveTrialTarget(trialMessages, targetMessageId);

      useChatErrorStore.getState().clearError(MAIN_FORK_KEY);

      const effectiveAction = editedContent ? ('edit' as const) : ('retry' as const);
      const inferenceMessages = buildMessagesForRegeneration(
        trialMessages,
        resolvedId,
        effectiveAction,
        editedContent
      );
      const apiMessages = inferenceMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      const keptThroughId = lastKeptId(trialMessages, targetMessageId, targetRole);
      if (keptThroughId !== undefined) removeMessagesAfter(keptThroughId);
      if (editedContent) updateTrialMessageContent(resolvedId, editedContent);

      await executeStream(trialRequest(apiMessages), trialMessages, editedQuestion(editedContent));
    },
    [
      isStreaming,
      isRateLimited,
      chatError,
      failedAttempt,
      retryFailedAttempt,
      trialMessages,
      removeMessagesAfter,
      updateTrialMessageContent,
      executeStream,
      trialRequest,
    ]
  );

  const handleTrialSubmit = React.useCallback(async () => {
    const content = state.inputValue.trim();
    if (!content || isStreaming || isRateLimited) return;

    if (editingMessageId) {
      void handleTrialRegenerate(editingMessageId, content);
      clearEditing();
      return;
    }

    useChatErrorStore.getState().clearError(MAIN_FORK_KEY);
    state.clearInput();
    if (!isPhone) {
      promptInputRef.current?.focus();
    }

    const userMessage = createTrialMessage('user', content);
    addTrialMessage(userMessage);

    const apiMessages = [...trialMessages, userMessage].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    await executeStream(trialRequest(apiMessages), null);
  }, [
    state,
    isStreaming,
    isRateLimited,
    isPhone,
    trialMessages,
    addTrialMessage,
    executeStream,
    trialRequest,
    editingMessageId,
    clearEditing,
    handleTrialRegenerate,
  ]);

  const handleEdit = React.useCallback(
    (messageId: string, content: string): void => {
      startEditing(messageId, content);
      state.setInputValue(content);
    },
    [startEditing, state]
  );

  const handleCancelEdit = React.useCallback((): void => {
    clearEditing();
    state.setInputValue('');
  }, [clearEditing, state]);

  if (!isSessionPending && isAuthenticated) {
    return <Navigate to={ROUTES.CHAT} />;
  }

  if (!trialPendingMessage && trialMessages.length === 0 && !creationStarted) {
    return <Navigate to={ROUTES.CHAT} />;
  }

  // Counted over the trimmed replay, matching the bytes the trial send carries
  // and the trial gate on the server prices.
  const historyCharacters = historyCharacterCount(stripReplayHistory(trialMessages));

  const displayMessages: Message[] = chatError
    ? withFailedAttempt(
        trialMessages as Message[],
        {
          id: chatError.id,
          conversationId: 'trial',
          role: 'assistant',
          content: turnNoticeText(chatError.notice),
          turnNotice: chatError.notice,
          createdAt: new Date().toISOString(),
          modelName: primaryModelId,
        },
        failedAttempt
      )
    : (trialMessages as Message[]);

  return (
    <ChatLayout
      messages={displayMessages}
      streamingMessageIds={state.streamingMessageIds}
      persistingMessageIds={state.persistingMessageIds}
      inputValue={state.inputValue}
      onInputChange={state.setInputValue}
      onSubmit={() => void handleTrialSubmit()}
      inputDisabled={isRateLimited}
      isProcessing={isStreaming}
      historyCharacters={historyCharacters}
      isAuthenticated={false}
      promptInputRef={promptInputRef}
      errorMessageId={chatError?.id}
      onRegenerate={(messageId: string) => void handleTrialRegenerate(messageId)}
      onEdit={handleEdit}
      isEditing={editingMessageId !== null}
      onCancelEdit={handleCancelEdit}
    />
  );
}
