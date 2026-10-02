import * as React from 'react';
import { createFirstEpoch, getPublicKeyFromPrivate, encryptTextForEpoch } from '@hushbox/crypto';
import { generateChatTitle, toBase64, ROUTES, type FundingSource } from '@hushbox/shared';
import {
  adoptServerMessageIdIn,
  createAssistantMessage,
  createUserMessage,
} from '@/lib/chat/messages';
import { buildModalityConfigPayload } from '@/lib/chat/auth-chat-helpers';
import { chatKeys } from '@/hooks/chat/chat';
import { billingKeys } from '@/hooks/billing/billing';
import { setEpochKey } from '@/lib/crypto/epoch-key-cache';
import { useChatErrorStore, createChatError, MAIN_FORK_KEY } from '@/stores/chat/error';
import { turnNoticeOf } from '@/hooks/chat/turn-error';
import type { useNavigate } from '@tanstack/react-router';
import type { useQueryClient } from '@tanstack/react-query';
import type { useChatPageState } from '@/hooks/chat/use-chat-page';
import type {
  useChatStream,
  ModelResult,
  RekeyEventData,
  StartEventData,
} from '@/hooks/chat/use-chat-stream';
import type { useOptimisticMessages } from '@/hooks/chat/use-optimistic-messages';
import type { useReasoningEffort } from '@/hooks/chat/use-reasoning-effort';
import type { useTurnStreamCallbacks } from '@/hooks/chat/use-turn-stream-callbacks';
import type { getPrimaryModel } from '@/stores/model';
import type {
  useCreateConversation,
  ConversationDetailResponse,
  ConversationMembership,
} from '@/hooks/chat/chat';
import type { Message, MessageResponse } from '@/lib/api/api';

type ModalityConfigArgs = Parameters<typeof buildModalityConfigPayload>;
type TurnStreamCallbacks = ReturnType<typeof useTurnStreamCallbacks>;

interface CreateConversationFlowInput {
  readonly isCreateMode: boolean;
  readonly pendingMessage: string | null;
  readonly pendingFundingSource: FundingSource | null;
  readonly accountPrivateKey: Uint8Array | null;
  readonly clearPendingMessage: () => void;
  readonly callerId: string | undefined;
  readonly activeRef: React.RefObject<boolean>;
  readonly conversationIdRef: React.RefObject<string>;
  readonly createConversationRef: React.RefObject<
    ReturnType<typeof useCreateConversation>['mutateAsync']
  >;
  readonly setLocalMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  readonly setLocalTitle: React.Dispatch<React.SetStateAction<string | null>>;
  readonly setRealConversationId: React.Dispatch<React.SetStateAction<string | null>>;
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly queryClient: ReturnType<typeof useQueryClient>;
  readonly state: ReturnType<typeof useChatPageState>;
  readonly startStream: ReturnType<typeof useChatStream>['startStream'];
  readonly selectedModels: Parameters<typeof getPrimaryModel>[0];
  readonly webSearchEnabled: boolean;
  readonly reasoningEffort: ReturnType<typeof useReasoningEffort>['effective'];
  readonly customInstructions: string | null | undefined;
  /**
   * Whether the account's stored-instruction read is still outstanding.
   * `customInstructions` is `null` both then and when the account stores none,
   * so the first turn of a new conversation waits on this rather than going out
   * without an instruction the account does store.
   */
  readonly isInstructionsReadUnresolved: boolean;
  readonly activeModality: ModalityConfigArgs[0];
  readonly imageConfig: ModalityConfigArgs[1];
  readonly videoConfig: ModalityConfigArgs[2];
  readonly audioConfig: ModalityConfigArgs[3];
  readonly localMessageHandlers: TurnStreamCallbacks['localMessageHandlers'];
  readonly recordSmartTiles: TurnStreamCallbacks['recordSmartTiles'];
  readonly addOptimisticMessage: ReturnType<typeof useOptimisticMessages>['addOptimisticMessage'];
}

/**
 * Membership seeded into the conversation cache for a just-created
 * conversation: the creator is its owner. Replaced by the authoritative
 * `membership` the next fetch loads.
 */
const OWNER_MEMBERSHIP: ConversationMembership = {
  privilege: 'owner',
  muted: false,
  pinned: false,
  accepted: true,
  visibleFromEpoch: 1,
  lastReadSeq: 0,
  // Only a link guest carries one, and a guest cannot create a conversation.
  linkId: null,
};

function navigateIfActive(
  activeRef: React.RefObject<boolean>,
  navigate: ReturnType<typeof useNavigate>,
  route: string,
  options?: { params?: Record<string, string>; state?: { fromCreate?: boolean } }
): void {
  if (activeRef.current) {
    const { params, state } = options ?? {};
    void navigate({
      to: route,
      ...(params && { params }),
      ...(params && { replace: true }),
      ...(state && { state }),
    });
  }
}

/**
 * Navigate from the `/chat/new` create flow to the real conversation once it
 * exists. The `fromCreate` history marker tells the chat route to hold its React
 * key stable across this hop so the just-created conversation is not remounted —
 * which would drop optimistic-only state (e.g. failed-model error tiles that
 * have no DB row). See resolveChatPageKey.
 */
function navigateToCreatedConversation(
  activeRef: React.RefObject<boolean>,
  navigate: ReturnType<typeof useNavigate>,
  realId: string
): void {
  navigateIfActive(activeRef, navigate, ROUTES.CHAT_ID, {
    params: { id: realId },
    state: { fromCreate: true },
  });
}

/**
 * Applies failed-branch error codes from the run result to a message set (the
 * failed model has no persisted row, so its tile keeps rendering the error).
 * Billed costs are NOT on the wire — they render from persisted data after
 * the post-run refetch.
 */
function attachModelErrorsToMessages(
  models: ModelResult[],
  setter: React.Dispatch<React.SetStateAction<Message[]>>
): void {
  for (const mr of models) {
    const code = mr.errorCode;
    if (code) {
      setter((previous) =>
        previous.map((m) =>
          m.id === mr.assistantMessageId ? { ...m, errorCode: code, content: '' } : m
        )
      );
    }
  }
}

/**
 * Whether a create-conversation response is for a newly created row (whose first
 * turn must be streamed) versus an idempotent return of an already-existing
 * conversation (seeded into cache, no re-stream). The backend outcome field is
 * `created`; reading a wrong field name is compile-silent through `fetchJson`'s
 * cast (an undefined read makes `!response.<field>` always true, so new
 * conversations would never stream their first turn), so the decision is pinned
 * as a named helper with a test over both branches.
 */
export function shouldStreamFirstTurn(response: { created: boolean }): boolean {
  return response.created;
}

/**
 * Moves the first turn's user row, and every tile under it, from the id it
 * stands under onto the id a run start named, and returns the id it now stands
 * under. A start naming no id leaves the row where it is; the post-run refetch
 * replaces it either way.
 */
function adoptFirstTurnUserRow(
  setLocalMessages: React.Dispatch<React.SetStateAction<Message[]>>,
  currentId: string,
  userMessageId: string | null
): string {
  if (userMessageId === null) return currentId;
  setLocalMessages((previous) => adoptServerMessageIdIn(previous, currentId, userMessageId));
  return userMessageId;
}

function removeLocalMessages(
  setLocalMessages: React.Dispatch<React.SetStateAction<Message[]>>,
  messageIds: readonly string[]
): void {
  const removed = new Set(messageIds);
  setLocalMessages((previous) => previous.filter((m) => !removed.has(m.id)));
}

/**
 * The `/chat/new` create flow: mint the conversation and its first epoch, stream
 * that first turn into `localMessages`, and hop to the real conversation once its
 * row exists. It runs once per create-mode mount and does nothing afterwards.
 */
export function useCreateConversationFlow({
  isCreateMode,
  pendingMessage,
  pendingFundingSource,
  accountPrivateKey,
  clearPendingMessage,
  callerId,
  activeRef,
  conversationIdRef,
  createConversationRef,
  setLocalMessages,
  setLocalTitle,
  setRealConversationId,
  navigate,
  queryClient,
  state,
  startStream,
  selectedModels,
  webSearchEnabled,
  reasoningEffort,
  customInstructions,
  isInstructionsReadUnresolved,
  activeModality,
  imageConfig,
  videoConfig,
  audioConfig,
  localMessageHandlers,
  recordSmartTiles,
  addOptimisticMessage,
}: CreateConversationFlowInput): void {
  const creationStartedRef = React.useRef(false);

  React.useEffect(() => {
    if (
      !isCreateMode ||
      !pendingMessage ||
      creationStartedRef.current ||
      !accountPrivateKey ||
      isInstructionsReadUnresolved
    ) {
      return;
    }
    creationStartedRef.current = true;

    const conversationId = crypto.randomUUID();
    conversationIdRef.current = conversationId;

    const userMessage = createUserMessage(conversationId, pendingMessage, callerId, null);
    setLocalMessages([userMessage]);

    const createConversationAndStream = async (): Promise<void> => {
      try {
        const accountPublicKey = getPublicKeyFromPrivate(accountPrivateKey);
        const epoch = createFirstEpoch([accountPublicKey], conversationId, 1);
        const ownerWrap = epoch.memberWraps[0];
        if (!ownerWrap) throw new Error('createFirstEpoch returned no member wraps');

        const titleText = generateChatTitle(pendingMessage);
        const encryptedTitleBytes = encryptTextForEpoch(epoch.epochPublicKey, titleText, {
          conversationId,
          epochNumber: 1,
        });

        const response = await createConversationRef.current({
          id: conversationId,
          title: toBase64(encryptedTitleBytes),
          epochPublicKey: toBase64(epoch.epochPublicKey),
          confirmationHash: toBase64(epoch.confirmationHash),
          memberWrap: toBase64(ownerWrap.wrap),
        });

        const realId = response.conversation.id;

        if (!shouldStreamFirstTurn(response)) {
          // Idempotent: conversation existed — seed the conversation cache; the
          // separate history query loads any prior messages on mount.
          queryClient.setQueryData<ConversationDetailResponse>(chatKeys.conversation(realId), {
            conversation: response.conversation,
            membership: OWNER_MEMBERSHIP,
            forks: [],
          });
          clearPendingMessage();
          setRealConversationId(realId);
          navigateToCreatedConversation(activeRef, navigate, realId);
          return;
        }

        setEpochKey(realId, 1, epoch.epochPrivateKey);

        const realUserMessage = createUserMessage(realId, pendingMessage, callerId, null);
        setLocalMessages([realUserMessage]);
        setLocalTitle(titleText);
        clearPendingMessage();
        setRealConversationId(realId);

        // Navigate to the real conversation as soon as its row exists, before
        // the stream settles — otherwise a slow stream parks the page at
        // /chat/new. Seed the conversation cache first so chrome (title,
        // members) is populated and the early route flip doesn't flash; local
        // (optimistic) messages bridge the message list until the post-stream
        // refetch lands (computeRenderState keeps showing them through the
        // decrypt). The component key holds across this hop (fromCreate) and
        // creationStartedRef stops the create effect from re-firing when
        // isCreateMode flips false.
        queryClient.setQueryData<ConversationDetailResponse>(chatKeys.conversation(realId), {
          conversation: response.conversation,
          membership: OWNER_MEMBERSHIP,
          forks: [],
        });
        queryClient.setQueryData<MessageResponse[]>(chatKeys.messages(realId), []);
        navigateToCreatedConversation(activeRef, navigate, realId);

        await executeStreamAndFinalize(
          realId,
          realUserMessage,
          response.conversation,
          pendingFundingSource ?? 'personal_balance'
        );
      } catch (error: unknown) {
        console.error('createConversationAndStream failed:', error);
        navigateIfActive(activeRef, navigate, ROUTES.CHAT);
      }
    };

    const executeStreamAndFinalize = async (
      realId: string,
      userRow: Message,
      conversationObject: import('@/lib/api/api').Conversation,
      fundingSource: FundingSource
    ): Promise<void> => {
      const message = userRow.content;
      // Assistant tile ids for this first turn, captured from `start` and
      // replaced on a re-key. Scopes the explicit stop calls below so they
      // release only this turn: a second send during the create→navigate
      // window keeps its own tracking.
      const newChatAssistantIds: string[] = [];
      // The id the user row stands under: its local key until a run start names
      // the server's, then each new id a same-key re-execution names.
      const firstTurnRow = { id: userRow.id };
      try {
        const streamResult = await startStream(
          {
            conversationId: realId,
            modality: activeModality,
            models: selectedModels.map((m) => m.id),
            userMessage: { content: message },
            messagesForInference: [{ role: 'user', content: message }],
            fundingSource,
            webSearchEnabled,
            ...(reasoningEffort !== undefined && { reasoningEffort }),
            ...(customInstructions != null && { customInstructions }),
            ...buildModalityConfigPayload(activeModality, imageConfig, videoConfig, audioConfig),
          },
          {
            onStart: (data: StartEventData) => {
              firstTurnRow.id = adoptFirstTurnUserRow(
                setLocalMessages,
                firstTurnRow.id,
                data.userMessageId
              );
              localMessageHandlers.onStart(data);
              recordSmartTiles(data);
              // for-loop, not .map: a nested arrow here would exceed the
              // function-nesting depth lint rule at this call site.
              for (const m of data.models) newChatAssistantIds.push(m.assistantMessageId);
            },
            onContent: localMessageHandlers.onContent,
            onReasoningTokens: localMessageHandlers.onReasoningTokens,
            onReasoningEffort: localMessageHandlers.onReasoningEffort,
            onModelError: localMessageHandlers.onModelError,
            onModelMediaStart: localMessageHandlers.onModelMediaStart,
            onModelMediaProgress: localMessageHandlers.onModelMediaProgress,
            onModelMediaDone: localMessageHandlers.onModelMediaDone,
            onModelResolved: localMessageHandlers.onModelResolved,
            onRestart: localMessageHandlers.onRestart,
            onRekey: (data: RekeyEventData) => {
              firstTurnRow.id = adoptFirstTurnUserRow(
                setLocalMessages,
                firstTurnRow.id,
                data.userMessageId
              );
              localMessageHandlers.onRekey(data);
              recordSmartTiles(data);
              newChatAssistantIds.length = 0;
              for (const m of data.models) newChatAssistantIds.push(m.assistantMessageId);
            },
          }
        );

        attachModelErrorsToMessages(streamResult.models, setLocalMessages);

        // Preserve errored model messages as optimistic so they survive the
        // localMessages → API messages mode transition after navigation.
        // Failed models have no DB row, so they'd disappear without this.
        for (const mr of streamResult.models) {
          if (mr.errorCode) {
            const errorMsg = createAssistantMessage(
              realId,
              mr.assistantMessageId,
              mr.modelId,
              streamResult.userMessageId
            );
            addOptimisticMessage({ ...errorMsg, errorCode: mr.errorCode, content: '' });
          }
        }

        // Seed cache so useConversation sees the conversation immediately.
        queryClient.setQueryData<ConversationDetailResponse>(chatKeys.conversation(realId), {
          conversation: conversationObject,
          membership: OWNER_MEMBERSHIP,
          forks: [],
        });
        queryClient.setQueryData<MessageResponse[]>(chatKeys.messages(realId), []);
        await queryClient.invalidateQueries({ queryKey: chatKeys.conversation(realId) });
        void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });

        // This call site uses hand-written callbacks instead of
        // createOptimisticStreamCallbacks, so the wrapper has no caller-provided
        // onAllStreamsSettled to fire. Persistence cleanup is explicit here.
        state.stopStreaming(newChatAssistantIds);
        state.stopPersisting(newChatAssistantIds);
      } catch (streamError: unknown) {
        console.error('Stream failed:', streamError);
        state.stopStreaming(newChatAssistantIds);
        state.stopPersisting(newChatAssistantIds);
        // Drop this turn's assistant placeholders so an empty row does not sit
        // between the user's message and the failure tile.
        removeLocalMessages(setLocalMessages, newChatAssistantIds);
        // New-chat flow has no fork yet — error belongs on the main slot.
        useChatErrorStore
          .getState()
          .setError(
            MAIN_FORK_KEY,
            createChatError({ notice: turnNoticeOf(streamError), failedContent: message })
          );
      }
    };

    void createConversationAndStream();
  }, [
    isCreateMode,
    pendingMessage,
    pendingFundingSource,
    accountPrivateKey,
    clearPendingMessage,
    localMessageHandlers,
    recordSmartTiles,
    selectedModels,
    webSearchEnabled,
    reasoningEffort,
    customInstructions,
    isInstructionsReadUnresolved,
    startStream,
    queryClient,
    navigate,
    state,
  ]);
}
