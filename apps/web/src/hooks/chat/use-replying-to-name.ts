import * as React from 'react';
import { notifyManager, useQueryClient } from '@tanstack/react-query';
import { chatKeys } from '@/hooks/chat/chat';
import { callerIdOf, groupSenderMembers } from '@/hooks/chat/conversation-identity';
import { linkKeys } from '@/hooks/realtime/use-conversation-links';
import { memberKeys } from '@/hooks/realtime/use-conversation-members';
import { useAuthStore } from '@/lib/auth/auth';
import { replyingToOf } from '@/lib/chat/replying-to';
import type { ConversationDetailResponse } from '@/hooks/chat/chat';
import type { client } from '@/lib/api-client';
import type { Message } from '@/lib/api/api';
import type { MessageResponse } from '@hushbox/shared';
import type { InferResponseType } from 'hono/client';

export type ConversationMembersData = InferResponseType<
  (typeof client.conversations)[':conversationId']['members']['$get'],
  200
>;

export type ConversationLinksData = InferResponseType<
  (typeof client.conversations)[':conversationId']['links']['$get'],
  200
>;

/**
 * The stored parent as the one-member lookup `replyingToOf` reads. Only its
 * role and sender are read; the history read carries no plaintext.
 */
function storedAsker(
  history: readonly MessageResponse[] | undefined,
  message: Message
): ReadonlyMap<string, Message> {
  const parent = history?.find((m) => m.id === message.parentMessageId);
  if (parent?.senderType !== 'user') return new Map();
  return new Map([
    [
      parent.id,
      {
        id: parent.id,
        conversationId: message.conversationId,
        role: 'user',
        content: '',
        createdAt: message.createdAt,
        ...(parent.senderId !== null && { senderId: parent.senderId }),
      },
    ],
  ]);
}

/** The member a group reply answers, from the conversation's cached reads. */
export function useReplyingToName(message: Message): string | undefined {
  const { conversationId } = message;
  // Reads the chat page's queries straight from the cache, as a subscriber to
  // the cache rather than a query observer. An observer never fetches with a
  // skip token, but a query takes its fetch function from its latest observer,
  // so one here would break the page's own refetch of that query; and a reply
  // mounting as the virtualized list scrolls must never trigger a fetch. The
  // cache notifies synchronously, including when another component's render
  // creates an entry, so the callback is deferred as TanStack's own hooks do.
  const queryClient = useQueryClient();
  const subscribe = React.useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    [queryClient]
  );
  const detail = React.useSyncExternalStore(subscribe, () =>
    queryClient.getQueryData<ConversationDetailResponse>(chatKeys.conversation(conversationId))
  );
  const history = React.useSyncExternalStore(subscribe, () =>
    queryClient.getQueryData<MessageResponse[]>(chatKeys.messages(conversationId))
  );
  const members = React.useSyncExternalStore(subscribe, () =>
    queryClient.getQueryData<ConversationMembersData>(memberKeys.list(conversationId))
  );
  const links = React.useSyncExternalStore(subscribe, () =>
    queryClient.getQueryData<ConversationLinksData>(linkKeys.list(conversationId))
  );
  const sessionUserId = useAuthStore((s) => s.user?.id);

  return React.useMemo(() => {
    const currentUserId = callerIdOf(sessionUserId, detail?.membership);
    if (currentUserId === undefined || members === undefined) return;
    const linkList = links?.links ?? [];
    const senders = groupSenderMembers(members.members, linkList);
    return replyingToOf(message, storedAsker(history, message), {
      currentUserId,
      isGroupChat: senders !== undefined,
      members: senders ?? [],
      links: linkList,
    });
  }, [message, detail, history, members, links, sessionUserId]);
}
