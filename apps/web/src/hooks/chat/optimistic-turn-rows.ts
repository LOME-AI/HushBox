import { adoptServerMessageId, createUserMessage } from '@/lib/chat/messages';
import { computePruneIds, type RegenerateAction } from '@/lib/chat/auth-chat-helpers';
import { chatKeys } from '@/hooks/chat/chat';
import type * as React from 'react';
import type { useQueryClient } from '@tanstack/react-query';
import type { Message, MessageResponse } from '@/lib/api/api';

interface ApplyPruneInput {
  allMsgs: Message[];
  targetMessageId: string;
  action: RegenerateAction;
  replaceAssistantId: string | undefined;
  conversationId: string;
  setRetryPrunedIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  setLocalMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  queryClient: ReturnType<typeof useQueryClient>;
}

interface AddEditedUserOptimisticInput {
  allMsgs: Message[];
  targetMessageId: string;
  userContent: string;
  conversationId: string;
  callerId: string | undefined;
  addOptimisticMessage: (message: Message) => void;
}

/**
 * Surface the edit's replacement user message in the same React commit as the
 * prune that removed the original. Without this, the edited text only appears
 * after the post-stream `invalidateQueries` refetch — a multi-second gap
 * during which the chat shows neither the old nor the new user message.
 *
 * Parent is the message preceding the edited target, mirroring the backend's
 * tree placement after edit. The row starts on a local key; the run start names
 * the id the server stores it under.
 */
export function addEditedUserOptimistic(input: AddEditedUserOptimisticInput): Message {
  const targetIndex = input.allMsgs.findIndex((m) => m.id === input.targetMessageId);
  const parentMessageId = input.allMsgs.slice(0, Math.max(targetIndex, 0)).at(-1)?.id ?? null;
  const row = createUserMessage(
    input.conversationId,
    input.userContent,
    input.callerId,
    parentMessageId
  );
  input.addOptimisticMessage(row);
  return row;
}

interface OptimisticRowOps {
  readonly addOptimisticMessage: (message: Message) => void;
  readonly removeOptimisticMessage: (messageId: string) => void;
}

/**
 * Moves an optimistic user row from the id it stands under (its local key, or
 * the id an earlier run start named) onto the id the run start named for it,
 * and returns the row as it now stands. A start naming no id leaves the row
 * where it is; the post-run refetch replaces it either way.
 */
export function adoptOptimisticUserRow(
  row: Message,
  userMessageId: string | null,
  ops: OptimisticRowOps
): Message {
  if (userMessageId === null) return row;
  const adopted = adoptServerMessageId(row, userMessageId);
  ops.removeOptimisticMessage(row.id);
  ops.addOptimisticMessage(adopted);
  return adopted;
}

/**
 * Optimistic prune for retry, edit, and regenerate-one. Applied at the top of
 * the message pipeline AND to the query cache so the stale rows disappear in
 * the same React commit, avoiding a flash of the about-to-be-replaced tiles.
 *
 * The prune scope differs by action — see {@link computePruneIds}.
 */
export function applyPrune(input: ApplyPruneInput): void {
  const {
    allMsgs,
    targetMessageId,
    action,
    replaceAssistantId,
    conversationId,
    setRetryPrunedIds,
    setLocalMessages,
    queryClient,
  } = input;

  const idsToRemove = computePruneIds(allMsgs, targetMessageId, action, replaceAssistantId);
  if (idsToRemove.size === 0) return;

  setRetryPrunedIds(idsToRemove);
  // History lives in its own query now; prune there so the about-to-be-replaced
  // rows vanish in the same commit as the render-layer prune.
  queryClient.setQueryData<MessageResponse[]>(chatKeys.messages(conversationId), (old) =>
    old ? old.filter((m) => !idsToRemove.has(m.id)) : old
  );
  setLocalMessages((previous) => previous.filter((m) => !idsToRemove.has(m.id)));
}
