import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '@/lib/auth';
import { AuthenticatedChatPage } from '@/components/chat/page/authenticated-chat-page';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { conversationQueryOptions } from '@/hooks/chat/chat';
import { keyChainQueryOptions } from '@/hooks/crypto/keys';

export interface ChatSearch {
  fork: string | undefined;
}

export const Route = createFileRoute('/_app/chat/$id')({
  beforeLoad: async () => {
    await requireAuth();
  },
  loader: ({ params, context }) => {
    // `new` is a create-mode sentinel from the welcome page send — there is
    // no real conversation or key chain to fetch yet. Letting it through hits
    // GET /api/conversations/new and GET /api/keys/new, both of which 404.
    if (params.id === 'new') return;
    // Fire-and-forget: start fetching during route transition, don't block navigation.
    // useQuery in components deduplicates with these in-flight prefetches.
    void context.queryClient.prefetchQuery(conversationQueryOptions(params.id));
    void context.queryClient.prefetchQuery(keyChainQueryOptions(params.id));
  },
  component: AuthenticatedChatWithErrorBoundary,
  validateSearch: (search: Record<string, unknown>): ChatSearch => ({
    fork: typeof search['fork'] === 'string' ? search['fork'] : undefined,
  }),
});

function AuthenticatedChatWithErrorBoundary(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <AuthenticatedChat />
    </ErrorBoundary>
  );
}

function AuthenticatedChat(): React.JSX.Element {
  const { id } = Route.useParams();
  const { fork } = Route.useSearch();

  // Key by the route conversation id so navigating between conversations
  // remounts the chat subtree, resetting all per-conversation hook state
  // (typing, presence, phantoms, forks) instead of bleeding it across.
  // `id` is `'new'` for the entire create flow — constant until the post-stream
  // navigation — so the create→real first stream is never remounted mid-flight.
  return <AuthenticatedChatPage key={id} routeConversationId={id} initialForkId={fork} />;
}
