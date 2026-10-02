import * as React from 'react';
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router';
import { ErrorBoundary, SkipLink } from '@hushbox/ui';
import { A11yProvider, MotionProvider } from '@hushbox/ui/accessibility';
import { TEST_IDS } from '@hushbox/shared';
import { QueryProvider } from '@/providers/query-provider';
import { AdminNav } from '@/components/shell/admin-nav';
import { AdminTopbar } from '@/components/shell/admin-topbar';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { CommandPalette } from '@/components/palette/command-palette';
import { PaletteProvider } from '@/components/palette/palette-provider';
import { ErrorFallback } from '@/components/util/error-fallback';
import type { RouterContext } from '@/router';

/**
 * A render throw OUTSIDE a TanStack route (a shell or provider fault) bypasses
 * the router's per-route error component, so the root boundary catches it.
 */
function RootComponent(): React.JSX.Element {
  return (
    <ErrorBoundary
      fallback={({ error, reset }) => (
        <ErrorFallback title="Something went wrong" detail={error?.message} onRetry={reset} />
      )}
    >
      <MotionProvider>
        <QueryProvider>
          <A11yProvider>
            <OpModalProvider>
              <PaletteProvider>
                <div
                  data-testid={TEST_IDS.adminShell}
                  className="bg-background text-foreground flex h-dvh overflow-hidden"
                >
                  <SkipLink />
                  <AdminNav />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <AdminTopbar />
                    {/* id + tabIndex make main the skip link's focus target. */}
                    <main
                      id="main"
                      tabIndex={-1}
                      // `relative` is load-bearing: an unpositioned overflow
                      // container is not the containing block for absolutely
                      // positioned content inside it, so every `sr-only` label
                      // below the fold hands its scrollable overflow to the
                      // viewport, and following any fragment then scrolls the
                      // shell and carries the topbar off screen. The other half
                      // of the fixed-shell rule in `apps/admin/src/app.css`;
                      // held by `e2e/admin/growth-screen.spec.ts`.
                      className="relative min-h-0 flex-1 overflow-y-auto"
                    >
                      <Outlet />
                    </main>
                  </div>
                </div>
                <CommandPalette />
              </PaletteProvider>
            </OpModalProvider>
          </A11yProvider>
        </QueryProvider>
      </MotionProvider>
    </ErrorBoundary>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
});
