import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { queryClient } from './providers/query-provider';
import type { QueryClient } from '@tanstack/react-query';

export interface RouterContext {
  queryClient: QueryClient;
}

export const router = createRouter({
  routeTree,
  context: { queryClient },
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }

  // Set only on the hook-driven create→real navigation (`/chat/new` →
  // `/chat/<realId>`) so the chat route can hold its React key stable across
  // that one hop instead of remounting and discarding optimistic-only state.
  // See resolveChatPageKey in lib/chat/auth-chat-helpers.ts.
  interface HistoryState {
    fromCreate?: boolean;
  }
}
