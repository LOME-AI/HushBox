import { Outlet, createRootRoute } from '@tanstack/react-router';
import { QueryProvider } from '@/providers/query-provider';
import { ThemeProvider } from '@/providers/theme-provider';

export const Route = createRootRoute({
  component: () => (
    <ThemeProvider>
      <QueryProvider>
        <Outlet />
      </QueryProvider>
    </ThemeProvider>
  ),
});
