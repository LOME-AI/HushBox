import { useMemo } from 'react';
import { useConversationLinks } from '@/hooks/realtime/use-conversation-links.js';
import { useConversationMembers } from '@/hooks/realtime/use-conversation-members.js';

type MembersRead = NonNullable<ReturnType<typeof useConversationMembers>['data']>;
type LinksRead = NonNullable<ReturnType<typeof useConversationLinks>['data']>;

export interface NamingReads {
  roster: MembersRead['members'];
  links: LinksRead['links'];
}

/**
 * The roster and the links that name each budget row, read the same way wherever a budget
 * row is named. Both reads are the group chat's, served from the query cache; either one
 * unread is empty, and a null scope asks nothing.
 */
export function useNamingReads(scope: string | null): NamingReads {
  const links = useConversationLinks(scope).data?.links;
  const roster = useConversationMembers(scope).data?.members;
  return useMemo(() => ({ roster: roster ?? [], links: links ?? [] }), [links, roster]);
}
