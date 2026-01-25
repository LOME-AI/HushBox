import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock dependencies using vi.hoisted for values referenced in vi.mock factory
const { mockUseStableBalance, mockUseTransactions, mockUseStability } = vi.hoisted(() => ({
  mockUseStableBalance: vi.fn(),
  mockUseTransactions: vi.fn(),
  mockUseStability: vi.fn(),
}));

// Mock tanstack router
vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual('@tanstack/react-router');
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    createFileRoute: () => () => ({ component: () => null }),
  };
});

// Mock auth
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn().mockImplementation(() => Promise.resolve()),
}));

// Mock stable balance hook
vi.mock('@/hooks/use-stable-balance', () => ({
  useStableBalance: mockUseStableBalance,
}));

// Mock billing hooks (for useTransactions)
vi.mock('@/hooks/billing', () => ({
  useTransactions: mockUseTransactions,
}));

// Mock stability provider
vi.mock('@/providers/stability-provider', () => ({
  useStability: mockUseStability,
}));

// Import after mocks
import { BillingPage } from './billing';

function createWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('BillingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseStability.mockReturnValue({
      isAuthStable: true,
      isBalanceStable: true,
      isAppStable: true,
    });
  });

  describe('balance display', () => {
    it('displays balance with 4 decimal places', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '25.12345678',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: { transactions: [], nextCursor: null },
        isLoading: false,
      });

      render(<BillingPage />, { wrapper: createWrapper() });

      expect(screen.getByTestId('balance-display')).toHaveTextContent('$25.1235');
    });
  });

  describe('transaction skeleton loading', () => {
    it('renders skeleton rows with matching structure when loading', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: null,
        isLoading: true,
      });

      render(<BillingPage />, { wrapper: createWrapper() });

      // Find the skeleton container - it should have 5 skeleton rows
      const skeletonRows = screen.getAllByTestId('transaction-skeleton-row');
      expect(skeletonRows).toHaveLength(5);

      // Each skeleton row should have two-column structure
      // Left side: two skeleton blocks (description + date)
      // Right side: two skeleton blocks (amount + balance)
      for (const row of skeletonRows) {
        const skeletonBlocks = within(row).getAllByTestId('skeleton-block');
        expect(skeletonBlocks.length).toBe(4); // 2 left + 2 right
      }
    });

    it('skeleton rows have fixed height matching data rows', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: null,
        isLoading: true,
      });

      render(<BillingPage />, { wrapper: createWrapper() });

      const skeletonRows = screen.getAllByTestId('transaction-skeleton-row');

      // Each skeleton row should have h-16 class for consistent height
      for (const row of skeletonRows) {
        expect(row.className).toContain('h-16');
      }
    });
  });

  describe('transaction data rows', () => {
    it('renders transaction data with correct structure', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '25.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: {
          transactions: [
            {
              id: 'tx-1',
              amount: '10.00000000',
              balanceAfter: '10.00000000',
              type: 'deposit',
              description: 'Deposit of $10.00',
              createdAt: '2024-01-01T12:00:00Z',
            },
          ],
        },
        isLoading: false,
      });

      render(<BillingPage />, { wrapper: createWrapper() });

      // Should show the transaction
      expect(screen.getByText('Deposit of $10.00')).toBeInTheDocument();
      expect(screen.getByText('+$10.00')).toBeInTheDocument();
    });
  });

  describe('fixed height container', () => {
    it('has fixed height container for transaction list when loading', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: null,
        isLoading: true,
      });

      render(<BillingPage />, { wrapper: createWrapper() });

      const container = screen.getByTestId('transaction-list-container');
      expect(container.className).toMatch(/h-\[/); // Should have fixed height class
    });

    it('has same fixed height container for transaction list when loaded', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: {
          transactions: [
            {
              id: 'tx-1',
              amount: '10.00000000',
              balanceAfter: '10.00000000',
              type: 'deposit',
              description: 'Deposit of $10.00',
              createdAt: '2024-01-01T12:00:00Z',
            },
          ],
          nextCursor: null,
        },
        isLoading: false,
      });

      render(<BillingPage />, { wrapper: createWrapper() });

      const container = screen.getByTestId('transaction-list-container');
      expect(container.className).toMatch(/h-\[/); // Should have fixed height class
    });
  });

  describe('pagination', () => {
    it('disables next button when nextCursor is null', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: {
          transactions: Array.from({ length: 5 }, (_, index) => ({
            id: `tx-${String(index)}`,
            amount: '10.00000000',
            balanceAfter: '10.00000000',
            type: 'deposit',
            description: `Deposit ${String(index)}`,
            createdAt: '2024-01-01T12:00:00Z',
          })),
          nextCursor: null, // No more pages
        },
        isLoading: false,
      });

      render(<BillingPage />, { wrapper: createWrapper() });

      // Next button should be disabled even with 5 items because nextCursor is null
      const nextButton = screen.getByRole('button', { name: /next/i });
      expect(nextButton).toBeDisabled();
    });

    it('enables next button when nextCursor is present', () => {
      mockUseStableBalance.mockReturnValue({
        displayBalance: '10.00000000',
        isStable: true,
        refetch: vi.fn(),
      });
      mockUseTransactions.mockReturnValue({
        data: {
          transactions: Array.from({ length: 5 }, (_, index) => ({
            id: `tx-${String(index)}`,
            amount: '10.00000000',
            balanceAfter: '10.00000000',
            type: 'deposit',
            description: `Deposit ${String(index)}`,
            createdAt: '2024-01-01T12:00:00Z',
          })),
          nextCursor: '2024-01-01T00:00:00Z', // More pages available
        },
        isLoading: false,
      });

      render(<BillingPage />, { wrapper: createWrapper() });

      // Next button should be enabled because nextCursor is present
      const nextButton = screen.getByRole('button', { name: /next/i });
      expect(nextButton).not.toBeDisabled();
    });
  });
});
