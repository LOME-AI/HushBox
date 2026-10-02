import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { PageShell } from '@/components/shared/page-shell';
import { renderRoute, renderWithProviders } from '@/test-utils/render';
import { Route } from './usage';

const { mockRequireAuth, mockBalanceQueryOptions } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(() => Promise.resolve()),
  mockBalanceQueryOptions: vi.fn(() => ({ queryKey: ['balance'], queryFn: vi.fn() })),
}));

vi.mock('@/components/usage/usage-content', () => ({
  UsageContent: (): React.JSX.Element => <div data-testid="usage-content" />,
}));

vi.mock('@/lib/auth/auth', () => ({
  requireAuth: () => mockRequireAuth(),
}));

vi.mock('@/hooks/billing/billing', () => ({
  balanceQueryOptions: () => mockBalanceQueryOptions(),
}));

interface LoaderArgs {
  context: { queryClient: { prefetchQuery: ReturnType<typeof vi.fn> } };
}

describe('/_app/usage route', () => {
  it('renders the usage content region', () => {
    renderRoute(Route);
    expect(screen.getByTestId('usage-content')).toBeInTheDocument();
  });

  it('gates the route on authentication in beforeLoad', async () => {
    const beforeLoad = Route.options.beforeLoad as (() => Promise<void>) | undefined;
    expect(beforeLoad).toBeDefined();

    await beforeLoad!();

    expect(mockRequireAuth).toHaveBeenCalledTimes(1);
  });

  it('prefetches the balance query in the loader', () => {
    const loader = Route.options.loader as ((args: LoaderArgs) => void) | undefined;
    expect(loader).toBeDefined();
    const prefetchQuery = vi.fn();

    loader!({ context: { queryClient: { prefetchQuery } } });

    expect(mockBalanceQueryOptions).toHaveBeenCalledTimes(1);
    expect(prefetchQuery).toHaveBeenCalledWith({
      queryKey: ['balance'],
      queryFn: expect.any(Function),
    });
  });
});

describe('/_app/usage page header', () => {
  function renderInShell(): void {
    const Page = Route.options.component;
    if (Page === undefined) throw new Error('the route has no component');
    renderWithProviders(
      <PageShell>
        <Page />
      </PageShell>
    );
  }

  it('renders its title as the one h1, in the page shell header', () => {
    renderInShell();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Usage');
    expect(document.querySelector('header')).toContainElement(heading);
  });

  it('draws no theme toggle of its own', () => {
    renderRoute(Route);

    expect(screen.queryByTestId(TEST_IDS.themeToggle)).not.toBeInTheDocument();
  });
});
