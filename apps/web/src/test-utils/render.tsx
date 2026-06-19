import * as React from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TouchDeviceOverrideContext } from '@hushbox/ui';
import { A11yProvider, MotionProvider } from '@hushbox/ui/accessibility';
import { StabilityProvider } from '@/providers/stability-provider';
import { ThemeProvider } from '@/providers/theme-provider';

/**
 * Shared real-provider render harness. Mirrors the app's `__root.tsx` provider
 * stack (touch override -> motion -> theme -> query -> stability -> a11y) so
 * tests exercise the same context wiring users get, rather than a hand-rolled
 * stub of `@tanstack/react-query`. Each call gets a fresh QueryClient with
 * retries off so a failing query never blocks a test on backoff.
 *
 * `StabilityProvider` is the app's real export here, but `test-setup.ts`
 * globally mocks it to a pass-through that returns a stable state — so the
 * harness never fires the live session/balance queries.
 */
function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

type RenderWithProvidersResult = ReturnType<typeof render> & { queryClient: QueryClient };

export function renderWithProviders(ui: React.ReactElement): RenderWithProvidersResult {
  const queryClient = createTestQueryClient();

  function AllProviders({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
    return (
      <TouchDeviceOverrideContext value={null}>
        <MotionProvider>
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <StabilityProvider>
                <A11yProvider>{children}</A11yProvider>
              </StabilityProvider>
            </QueryClientProvider>
          </ThemeProvider>
        </MotionProvider>
      </TouchDeviceOverrideContext>
    );
  }

  return Object.assign(render(ui, { wrapper: AllProviders }), { queryClient });
}
