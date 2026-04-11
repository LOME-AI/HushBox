import { createRouter } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { routeTree } from './routeTree.gen';
import { queryClient } from './providers/query-provider';

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
}
