import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { RouteErrorScreen } from './components/shared/route-error-screen';
import { queryClient } from './providers/query-provider';
import type { QueryClient } from '@tanstack/react-query';

export interface RouterContext {
  queryClient: QueryClient;
}

export const router = createRouter({
  routeTree,
  context: { queryClient },
  // Caught per route, a failure renders inside its parent's outlet, so the root
  // route and what it mounts (the Update Required modal) stay up. Without it the
  // router's global boundary replaces the whole tree.
  defaultErrorComponent: RouteErrorScreen,
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
