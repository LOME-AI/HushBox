import { useQuery } from '@tanstack/react-query';
import { normalizeUsername } from '@hushbox/shared';
import { client, fetchJson } from '../lib/api-client.js';

export function useUserSearch(
  query: string,
  options?: { excludeConversationId?: string }
): ReturnType<typeof useQuery> {
  const normalizedQuery = normalizeUsername(query);
  return useQuery({
    queryKey: ['user-search', normalizedQuery, options?.excludeConversationId],
    queryFn: () =>
      fetchJson(
        client.api.users.search.$post({
          json: { query: normalizedQuery, excludeConversationId: options?.excludeConversationId },
        })
      ),
    enabled: normalizedQuery.length >= 2,
  });
}
