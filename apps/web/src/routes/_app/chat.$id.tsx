import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '@/lib/auth';
import { AuthenticatedChatPage } from '@/components/chat/authenticated-chat-page';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { conversationQueryOptions } from '@/hooks/chat';
import { keyChainQueryOptions } from '@/hooks/keys';

export interface ChatSearch {
  fork: string | undefined;
}

export const Route = createFileRoute('/_app/chat/$id')({
  beforeLoad: async () => {
    await requireAuth();
  },
  loader: ({ params, context }) => {
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

  return <AuthenticatedChatPage routeConversationId={id} initialForkId={fork} />;
}
