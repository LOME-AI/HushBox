import * as React from 'react';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { requireAuth } from '@/lib/auth';
import { AuthenticatedChatPage } from '@/components/chat/page/authenticated-chat-page';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { conversationQueryOptions } from '@/hooks/chat/chat';
import { keyChainQueryOptions } from '@/hooks/crypto/keys';
import { resolveChatPageKey } from '@/lib/chat/auth-chat-helpers';

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
  const { state } = useLocation();

  // Key by the conversation id so switching conversations remounts the chat
  // subtree, resetting all per-conversation state (typing, presence, phantoms,
  // forks). The one exception is the create→real hop: after the first message
  // the hook navigates `/chat/new` → `/chat/<realId>` (marked `fromCreate`) for
  // the SAME just-created conversation. Remounting there would discard
  // optimistic-only state with no DB row — notably failed-model error tiles —
  // so the key is held stable across exactly that transition. Adjust-state-in-
  // render keeps it concurrent-safe (no effect, no render-time ref mutation).
  const [keyState, setKeyState] = React.useState({ prevId: id, key: id });
  const next = resolveChatPageKey(keyState, id, state.fromCreate === true);
  if (next !== keyState) setKeyState(next);

  return <AuthenticatedChatPage key={next.key} routeConversationId={id} initialForkId={fork} />;
}
