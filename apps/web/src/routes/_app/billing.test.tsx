import { screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { requireAuth } from '@/lib/auth/auth';
import { balanceQueryOptions } from '@/hooks/billing/billing';
import { PageShell } from '@/components/shared/page-shell';
import { renderRoute, renderWithProviders } from '@/test-utils/render';
import { Route } from './billing';
import type { useStableBalance } from '@/hooks/billing/use-stable-balance';
import type { useTransactions } from '@/hooks/billing/billing';

// Mock dependencies using vi.hoisted for values referenced in vi.mock factory
const { mockUseStableBalance, mockUseTransactions, mockIsPaymentDisabled } = vi.hoisted(() => ({
  mockUseStableBalance: vi.fn(),
  mockUseTransactions: vi.fn(),
  mockIsPaymentDisabled: vi.fn(() => false),
}));

// Keep the real router (createFileRoute must run for the route file); override only useNavigate.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

vi.mock('@/lib/auth/auth', () => ({
  requireAuth: vi.fn().mockImplementation(() => Promise.resolve()),
}));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: mockUseStableBalance,
}));

vi.mock('@/hooks/billing/billing', () => ({
  useTransactions: mockUseTransactions,
  balanceQueryOptions: vi.fn(() => ({ queryKey: ['balance'], queryFn: vi.fn() })),
}));

// Keep the real platform helpers (ThemeProvider's useStatusBar needs isNative);
// override only isPaymentDisabled.
vi.mock('@/capacitor/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/capacitor/platform')>();
  return {
    ...actual,
    isPaymentDisabled: mockIsPaymentDisabled,
  };
});

vi.mock('@/components/billing/manage-online-button', () => ({
  ManageOnlineButton: () => (
    <button data-testid="manage-online-button">Manage Balance Online</button>
  ),
}));

describe('BillingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('balance display', () => {
    it('displays the balance in dollars and cents', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '25123456780',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: { transactions: [], nextCursor: null },
        isLoading: false,
      });

      renderRoute(Route);

      expect(screen.getByTestId(TEST_IDS.balanceDisplay)).toHaveTextContent('$25.12');
    });
  });

  describe('transaction loading', () => {
    it('holds the purchase history as a busy region while it loads', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10000000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: null,
        isLoading: true,
      });

      renderRoute(Route);

      expect(screen.getByRole('group', { name: 'Purchase history' })).toHaveAttribute(
        'aria-busy',
        'true'
      );
    });
  });

  describe('transaction data rows', () => {
    it('renders transaction data with correct structure', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '25000000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: {
          transactions: [
            {
              id: 'tx-1',
              amount: '10000000000',
              balanceAfter: '10000000000',
              type: 'deposit',
              description: 'Deposit of $10.00',
              createdAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
            },
          ],
        },
        isLoading: false,
      });

      renderRoute(Route);

      expect(screen.getByText('Deposit of $10.00')).toBeInTheDocument();
      expect(screen.getByText('+$10.00')).toBeInTheDocument();
    });
  });

  describe('reserved list height', () => {
    it('reserves the list height while loading', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10000000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: null,
        isLoading: true,
      });

      renderRoute(Route);

      expect(screen.getByTestId(TEST_IDS.transactionListContainer)).toHaveClass('min-h-80');
    });

    it('reserves the same list height once loaded', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10000000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: {
          transactions: [
            {
              id: 'tx-1',
              amount: '10000000000',
              balanceAfter: '10000000000',
              type: 'deposit',
              description: 'Deposit of $10.00',
              createdAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
            },
          ],
          nextCursor: null,
        },
        isLoading: false,
      });

      renderRoute(Route);

      expect(screen.getByTestId(TEST_IDS.transactionListContainer)).toHaveClass('min-h-80');
    });
  });

  describe('pagination', () => {
    it('disables next button when nextCursor is null', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10000000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: {
          transactions: Array.from({ length: 5 }, (_, index) => ({
            id: `tx-${String(index)}`,
            amount: '10000000000',
            balanceAfter: '10000000000',
            type: 'deposit',
            description: `Deposit ${String(index)}`,
            createdAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
          })),
          nextCursor: null, // No more pages
        },
        isLoading: false,
      });

      renderRoute(Route);

      const nextButton = screen.getByRole('button', { name: /next/i });
      expect(nextButton).toBeDisabled();
    });

    it('enables next button when nextCursor is present', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10000000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: {
          transactions: Array.from({ length: 5 }, (_, index) => ({
            id: `tx-${String(index)}`,
            amount: '10000000000',
            balanceAfter: '10000000000',
            type: 'deposit',
            description: `Deposit ${String(index)}`,
            createdAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
          })),
          nextCursor: isoAt(TEST_DAY_START), // More pages available
        },
        isLoading: false,
      });

      renderRoute(Route);

      const nextButton = screen.getByRole('button', { name: /next/i });
      expect(nextButton).not.toBeDisabled();
    });
  });

  describe('platform-conditional billing', () => {
    beforeEach(() => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10000000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: { transactions: [], nextCursor: null },
        isLoading: false,
      });
    });

    it('shows Add Credits button when payments are enabled', () => {
      mockIsPaymentDisabled.mockReturnValue(false);

      renderRoute(Route);

      expect(screen.getByRole('button', { name: /add credits/i })).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.manageOnlineButton)).not.toBeInTheDocument();
    });

    it('shows Manage Balance Online button when payments are disabled', () => {
      mockIsPaymentDisabled.mockReturnValue(true);

      renderRoute(Route);

      expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /add credits/i })).not.toBeInTheDocument();
    });

    it('hides PaymentModal when payments are disabled', () => {
      mockIsPaymentDisabled.mockReturnValue(true);

      renderRoute(Route);

      expect(screen.queryByTestId(TEST_IDS.paymentModal)).not.toBeInTheDocument();
    });
  });

  describe('surface', () => {
    it('renders the billing content on the app surface', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10000000000',
        isStable: true,
        refetch: vi.fn(),
      } satisfies Partial<ReturnType<typeof useStableBalance>>);
      mockUseTransactions.mockReturnValue({
        data: { transactions: [], nextCursor: null },
        isLoading: false,
      } satisfies Partial<ReturnType<typeof useTransactions>>);

      renderRoute(Route);

      expect(mockUseStableBalance).toHaveBeenCalledWith(undefined);
    });
  });

  describe('route data lifecycle', () => {
    it('gates the route on authentication in beforeLoad', async () => {
      const beforeLoad = Route.options.beforeLoad as (() => Promise<void>) | undefined;
      expect(beforeLoad).toBeDefined();

      await beforeLoad!();

      expect(requireAuth).toHaveBeenCalledTimes(1);
    });

    it('prefetches the balance query in the loader', () => {
      const loader = Route.options.loader as
        | ((args: {
            context: { queryClient: { prefetchQuery: ReturnType<typeof vi.fn> } };
          }) => void)
        | undefined;
      expect(loader).toBeDefined();
      const prefetchQuery = vi.fn();

      loader!({ context: { queryClient: { prefetchQuery } } });

      expect(balanceQueryOptions).toHaveBeenCalledTimes(1);
      expect(prefetchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['balance'] })
      );
    });
  });
});

describe('/_app/billing page header', () => {
  beforeEach(() => {
    mockUseStableBalance.mockReturnValue({
      displayBalance: '10000000000',
      isStable: true,
      refetch: vi.fn(),
    });
    mockUseTransactions.mockReturnValue({
      data: { transactions: [], nextCursor: null },
      isLoading: false,
    });
  });

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
    expect(heading).toHaveTextContent('Billing');
    expect(document.querySelector('header')).toContainElement(heading);
  });

  it('draws no theme toggle of its own', () => {
    renderRoute(Route);

    expect(screen.queryByTestId(TEST_IDS.themeToggle)).not.toBeInTheDocument();
  });
});
