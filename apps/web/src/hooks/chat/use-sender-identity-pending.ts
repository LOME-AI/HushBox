import { useQuery } from '@tanstack/react-query';
import { conversationQueryOptions } from '@/hooks/chat/chat';
import { useConversationLinks } from '@/hooks/realtime/use-conversation-links';
import { useConversationMembers } from '@/hooks/realtime/use-conversation-members';

/** Whether a read has answered once: with its data, or with a first failure. */
function hasAnswered(read: { readonly data: unknown; readonly failureCount: number }): boolean {
  return read.data !== undefined || read.failureCount > 0;
}

/**
 * Whether a group conversation's senders cannot be named yet: the conversation read counts
 * more than one member, and its members read or its links read has not answered once. A
 * group made by a link is a group only through its links read, so both are waited on. A
 * first failure counts as an answer, so a read the retry policy keeps trying never holds
 * anything for the length of its retries. An unknown count holds nothing.
 */
export function useSenderIdentityPending(conversationId: string | undefined): boolean {
  const id = conversationId ?? '';
  const { data: memberCount } = useQuery({
    ...conversationQueryOptions(id),
    select: (detail) => detail.memberCount,
    enabled: id !== '',
  });
  const members = useConversationMembers(conversationId ?? null);
  const links = useConversationLinks(conversationId ?? null);
  if (memberCount === undefined || memberCount <= 1) return false;
  return !hasAnswered(members) || !hasAnswered(links);
}
