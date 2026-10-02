import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { BillingContent } from './billing-content';
import type { BalanceTransactionResponse } from '@hushbox/shared';
import type { useStableBalance } from '@/hooks/billing/use-stable-balance';
import type { useTransactions } from '@/hooks/billing/billing';
import type { CompletedCharge } from '@/components/billing/payment-form';

type StableBalance = ReturnType<typeof useStableBalance>;
type TransactionsQuery = ReturnType<typeof useTransactions>;

const { mockUseStableBalance, mockUseTransactions, mockRefetchBalance, mockIsPaymentDisabled } =
  vi.hoisted(() => ({
    mockUseStableBalance: vi.fn<(options?: { enabled?: boolean }) => StableBalance>(),
    mockUseTransactions: vi.fn<(params: object) => TransactionsQuery>(),
    mockRefetchBalance: vi.fn<StableBalance['refetch']>(),
    mockIsPaymentDisabled: vi.fn<() => boolean>(() => false),
  }));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: (options?: { enabled?: boolean }): StableBalance =>
    mockUseStableBalance(options),
}));

vi.mock('@/hooks/billing/billing', () => ({
  useTransactions: (params: object): TransactionsQuery => mockUseTransactions(params),
}));

vi.mock('@/capacitor/platform', () => ({
  isPaymentDisabled: (): boolean => mockIsPaymentDisabled(),
}));

vi.mock('@/components/billing/manage-online-button', () => ({
  ManageOnlineButton: (): React.JSX.Element => <button type="button">Manage Balance Online</button>,
}));

// Stub the payment modal so opening it never boots the HelcimPay.js flow; its
// buttons complete a charge of a named amount through the real `onSuccess` contract.
vi.mock('@/components/billing/payment-modal', () => ({
  PaymentModal: ({
    open,
    onOpenChange,
    onSuccess,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: (charge: CompletedCharge) => void;
  }): React.JSX.Element | null =>
    open ? (
      <div data-testid="payment-modal-stub">
        <button
          type="button"
          onClick={() => {
            onSuccess({ amountNanoUsd: '20000000000' });
          }}
        >
          charge-20
        </button>
        <button
          type="button"
          onClick={() => {
            onSuccess({ amountNanoUsd: '10500000000' });
          }}
        >
          charge-10.50
        </button>
        <button
          type="button"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          close-payment
        </button>
      </div>
    ) : null,
}));

function tx(overrides: Partial<BalanceTransactionResponse>): BalanceTransactionResponse {
  const base: BalanceTransactionResponse = {
    id: Math.random().toString(36).slice(2),
    type: 'deposit',
    amount: '10000000000',
    balanceAfter: '100000000000',
    createdAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
  };
  return { ...base, ...overrides };
}

function stableBalance(displayBalance: string, isStable = true): StableBalance {
  // A partial query result stands in for TanStack's full one: the component reads
  // these three fields, and the rest plays no part in what the card draws.
  return { displayBalance, isStable, refetch: mockRefetchBalance } as unknown as StableBalance;
}

function setTransactions(
  transactions: BalanceTransactionResponse[] | undefined,
  extra?: { isLoading?: boolean; nextCursor?: string | null }
): void {
  const data =
    transactions === undefined
      ? undefined
      : { transactions, nextCursor: extra?.nextCursor ?? null };
  // A partial query result stands in for TanStack's full one, as in `stableBalance`.
  mockUseTransactions.mockReturnValue({
    data,
    isLoading: extra?.isLoading ?? false,
  } as unknown as TransactionsQuery);
}

function callerActions({ openPayment }: { openPayment: () => void }): React.JSX.Element {
  return (
    <>
      <a href="#x">Caller action</a>
      <button type="button" onClick={openPayment}>
        Caller buys more
      </button>
    </>
  );
}

async function completeCharge(label: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Add Credits' }));
  await user.click(screen.getByRole('button', { name: label }));
}

describe('BillingContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPaymentDisabled.mockReturnValue(false);
    mockUseStableBalance.mockReturnValue(stableBalance('25500000000'));
    setTransactions([tx({ type: 'deposit', amount: '20000000000' })]);
  });

  describe('balance card', () => {
    it('titles the card as a level-2 heading', () => {
      render(<BillingContent surface="app" />);
      expect(screen.getByRole('heading', { level: 2, name: 'Current Balance' })).toBeVisible();
    });

    it('shows the formatted balance when stable', () => {
      render(<BillingContent surface="app" />);
      expect(screen.getByTestId(TEST_IDS.balanceDisplay)).toHaveTextContent('$25.50');
    });

    it('puts the sign ahead of the currency symbol for a negative balance', () => {
      mockUseStableBalance.mockReturnValue(stableBalance('-500000000'));
      render(<BillingContent surface="app" />);
      expect(screen.getByTestId(TEST_IDS.balanceDisplay)).toHaveTextContent('-$0.50');
    });

    it('holds a busy placeholder in place of the amount while the balance loads', () => {
      mockUseStableBalance.mockReturnValue(stableBalance('0', false));
      render(<BillingContent surface="app" />);
      expect(screen.queryByTestId(TEST_IDS.balanceDisplay)).not.toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Current balance' })).toHaveAttribute(
        'aria-busy',
        'true'
      );
    });

    it('draws Add Credits as a block button', () => {
      render(<BillingContent surface="app" />);
      expect(screen.getByRole('button', { name: 'Add Credits' })).toHaveAttribute('data-block');
    });

    it('places Add Credits after the amount', () => {
      render(<BillingContent surface="app" />);
      const amount = screen.getByTestId(TEST_IDS.balanceDisplay);
      const addCredits = screen.getByRole('button', { name: 'Add Credits' });
      expect(amount.compareDocumentPosition(addCredits) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });

    it('offers Manage Balance Online in place of Add Credits when payment is disabled', () => {
      mockIsPaymentDisabled.mockReturnValue(true);
      render(<BillingContent surface="app" />);
      expect(screen.queryByRole('button', { name: 'Add Credits' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Manage Balance Online' })).toBeVisible();
    });

    it('mounts no payment modal when payment is disabled', () => {
      mockIsPaymentDisabled.mockReturnValue(true);
      render(<BillingContent surface="app" />);
      expect(screen.queryByTestId('payment-modal-stub')).not.toBeInTheDocument();
    });
  });

  describe('payment modal', () => {
    it('opens the payment modal when Add Credits is clicked', async () => {
      const user = userEvent.setup();
      render(<BillingContent surface="app" />);

      expect(screen.queryByTestId('payment-modal-stub')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Add Credits' }));

      expect(screen.getByTestId('payment-modal-stub')).toBeInTheDocument();
    });

    it('refetches the balance after a successful payment', async () => {
      render(<BillingContent surface="app" />);
      await completeCharge('charge-20');
      expect(mockRefetchBalance).toHaveBeenCalled();
    });
  });

  describe('surface', () => {
    it('reads the balance through the app stability gate on the app surface', () => {
      render(<BillingContent surface="app" />);
      expect(mockUseStableBalance).toHaveBeenCalledWith(undefined);
    });

    it('reads the balance directly on the portal surface', () => {
      render(<BillingContent surface="portal" />);
      expect(mockUseStableBalance).toHaveBeenCalledWith({ enabled: true });
    });
  });

  describe('added line on the portal', () => {
    it('shows no added line before a purchase completes', () => {
      render(<BillingContent surface="portal" />);
      expect(screen.queryByTestId(TEST_IDS.balanceAdded)).not.toBeInTheDocument();
    });

    it('states the charged amount once a purchase completes', async () => {
      render(<BillingContent surface="portal" />);
      await completeCharge('charge-20');
      expect(screen.getByTestId(TEST_IDS.balanceAdded)).toHaveTextContent(
        '+$20.00 added to your balance'
      );
    });

    it('announces the added line as a status', async () => {
      render(<BillingContent surface="portal" />);
      await completeCharge('charge-20');
      expect(screen.getByTestId(TEST_IDS.balanceAdded)).toHaveAttribute('role', 'status');
    });

    it('states the sum of every purchase in the visit after two charges', async () => {
      render(<BillingContent surface="portal" />);
      await completeCharge('charge-20');
      await userEvent.setup().click(screen.getByRole('button', { name: 'charge-10.50' }));
      expect(screen.getByTestId(TEST_IDS.balanceAdded)).toHaveTextContent(
        '+$30.50 added to your balance'
      );
    });

    it('shows no added line on the app surface after a purchase', async () => {
      render(<BillingContent surface="app" />);
      await completeCharge('charge-20');
      expect(screen.queryByTestId(TEST_IDS.balanceAdded)).not.toBeInTheDocument();
    });

    it('keeps Add Credits in place of the caller actions before a purchase', () => {
      render(<BillingContent surface="portal" purchasedActions={callerActions} />);
      expect(screen.getByRole('button', { name: 'Add Credits' })).toBeVisible();
      expect(screen.queryByRole('link', { name: 'Caller action' })).not.toBeInTheDocument();
    });

    it('draws the caller actions in place of Add Credits after a purchase', async () => {
      render(<BillingContent surface="portal" purchasedActions={callerActions} />);
      await completeCharge('charge-20');
      expect(screen.getByRole('link', { name: 'Caller action' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Add Credits' })).not.toBeInTheDocument();
    });

    it('opens the payment modal from a caller action that calls openPayment', async () => {
      const user = userEvent.setup();
      render(<BillingContent surface="portal" purchasedActions={callerActions} />);
      await completeCharge('charge-20');
      await user.click(screen.getByRole('button', { name: 'close-payment' }));
      expect(screen.queryByTestId('payment-modal-stub')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Caller buys more' }));

      expect(screen.getByTestId('payment-modal-stub')).toBeInTheDocument();
    });

    it('keeps Add Credits after a purchase when the caller passes no actions', async () => {
      render(<BillingContent surface="portal" />);
      await completeCharge('charge-20');
      expect(screen.getByRole('button', { name: 'Add Credits' })).toBeVisible();
    });

    it('ignores caller actions on the app surface after a purchase', async () => {
      render(<BillingContent surface="app" purchasedActions={callerActions} />);
      await completeCharge('charge-20');
      expect(screen.queryByRole('link', { name: 'Caller action' })).not.toBeInTheDocument();
    });
  });

  describe('purchase history', () => {
    it('titles the card as a level-2 heading', () => {
      render(<BillingContent surface="app" />);
      expect(screen.getByRole('heading', { level: 2, name: 'Purchase History' })).toBeVisible();
    });

    it('holds a busy placeholder while the purchases load', () => {
      setTransactions([], { isLoading: true });
      render(<BillingContent surface="app" />);
      expect(screen.getByRole('group', { name: 'Purchase history' })).toHaveAttribute(
        'aria-busy',
        'true'
      );
    });

    it('draws every loading mark through the foundation skeleton', () => {
      mockUseStableBalance.mockReturnValue(stableBalance('0', false));
      setTransactions([], { isLoading: true });
      const { container } = render(<BillingContent surface="app" />);
      const pulsing = [...container.querySelectorAll<HTMLElement>('.animate-pulse')];
      expect(pulsing.length).toBeGreaterThan(0);
      expect(pulsing.filter((mark) => mark.dataset['slot'] !== 'skeleton')).toEqual([]);
    });

    it('reserves five rows of height in the list container', () => {
      render(<BillingContent surface="app" />);
      expect(screen.getByTestId(TEST_IDS.transactionListContainer)).toHaveClass('min-h-80');
    });

    it('shows an empty state when there are no purchases on the first page', () => {
      setTransactions([]);
      render(<BillingContent surface="app" />);
      expect(screen.getByText('No purchases yet')).toBeInTheDocument();
    });

    it('shows the empty state when the purchase read returns nothing', () => {
      setTransactions(undefined);
      render(<BillingContent surface="app" />);
      expect(screen.getByText('No purchases yet')).toBeInTheDocument();
    });

    it('titles a deposit row with its amount', () => {
      render(<BillingContent surface="app" />);
      expect(
        within(screen.getByTestId(TEST_IDS.transactionRow)).getByText('Deposit of $20.00')
      ).toBeVisible();
    });

    it('dates a row by day with no time of day', () => {
      render(<BillingContent surface="app" />);
      const row = screen.getByTestId(TEST_IDS.transactionRow);
      expect(within(row).getByText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/)).toBeVisible();
    });

    it('credits the amount at the row end', () => {
      render(<BillingContent surface="app" />);
      expect(
        within(screen.getByTestId(TEST_IDS.transactionRow)).getByText('+$20.00')
      ).toBeVisible();
    });

    it('draws no balance-after line', () => {
      render(<BillingContent surface="app" />);
      expect(screen.getByTestId(TEST_IDS.transactionRow)).not.toHaveTextContent('Balance:');
    });

    it('renders labels for every transaction kind', () => {
      setTransactions([
        tx({ type: 'charge', model: 'gpt-4', inputCharacters: 100, outputCharacters: 50 }),
        tx({ type: 'charge' }),
        tx({ type: 'deposit', amount: '15000000000' }),
        tx({ type: 'refund', amount: '5000000000' }),
        tx({ type: 'clawback' }),
        tx({ type: 'promo' }),
      ]);
      render(<BillingContent surface="app" />);

      expect(screen.getByText('AI response: gpt-4 (150 chars)')).toBeInTheDocument();
      expect(screen.getByText('AI response: unknown (0 chars)')).toBeInTheDocument();
      expect(screen.getByText('Deposit of $15.00')).toBeInTheDocument();
      expect(screen.getByText('Refund of $5.00')).toBeInTheDocument();
      expect(screen.getByText('Balance adjustment')).toBeInTheDocument();
      expect(screen.getByText('Promotional credit')).toBeInTheDocument();
    });

    it('falls back to the raw kind for a kind it has no label for', () => {
      // A kind the web build does not know yet, as a newer server could send it; the
      // wire enum cannot name one, so the fixture asserts it.
      setTransactions([tx({ type: 'mystery_type' as BalanceTransactionResponse['type'] })]);
      render(<BillingContent surface="app" />);
      expect(screen.getByText('mystery_type')).toBeInTheDocument();
    });
  });

  describe('pager', () => {
    it('disables Previous on the first page', () => {
      setTransactions([tx({})], { nextCursor: 'cursor-2' });
      render(<BillingContent surface="app" />);
      expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    });

    it('enables Next when more pages exist', () => {
      setTransactions([tx({})], { nextCursor: 'cursor-2' });
      render(<BillingContent surface="app" />);
      expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    });

    it('disables Next on the last page', () => {
      render(<BillingContent surface="app" />);
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    });

    it('labels the page between Previous and Next', () => {
      render(<BillingContent surface="app" />);
      const previous = screen.getByRole('button', { name: 'Previous' });
      const row = previous.parentElement;
      expect(row?.textContent).toBe('PreviousPage 1Next');
    });

    it('sets the page label on a line as tall as the small buttons, touch floor included', () => {
      render(<BillingContent surface="app" />);
      const row = screen.getByRole('button', { name: 'Previous' }).parentElement;
      expect(row?.parentElement).toHaveClass('leading-8', 'pointer-coarse:leading-11');
    });

    it('keeps Previous and Next as the row buttons the page label does not join', () => {
      render(<BillingContent surface="app" />);
      const row = screen.getByRole('button', { name: 'Previous' }).parentElement;
      expect([...(row?.children ?? [])].map((child) => child.textContent)).toEqual([
        'Previous',
        'Next',
      ]);
    });

    it('advances to the next page and re-queries with the new offset', async () => {
      const user = userEvent.setup();
      setTransactions([tx({})], { nextCursor: 'cursor-2' });
      render(<BillingContent surface="app" />);

      await user.click(screen.getByRole('button', { name: 'Next' }));

      expect(screen.getByText('Page 2')).toBeInTheDocument();
      expect(mockUseTransactions).toHaveBeenLastCalledWith(
        expect.objectContaining({ limit: 5, offset: 5, type: 'deposit' })
      );
    });

    it('goes back to the previous page', async () => {
      const user = userEvent.setup();
      setTransactions([tx({})], { nextCursor: 'cursor-2' });
      render(<BillingContent surface="app" />);

      await user.click(screen.getByRole('button', { name: 'Next' }));
      await user.click(screen.getByRole('button', { name: 'Previous' }));

      expect(screen.getByText('Page 1')).toBeInTheDocument();
    });

    it('keeps the pager on a later page that came back empty', async () => {
      const user = userEvent.setup();
      setTransactions([tx({})], { nextCursor: 'cursor-2' });
      const { rerender } = render(<BillingContent surface="app" />);
      setTransactions([]);
      await user.click(screen.getByRole('button', { name: 'Next' }));
      rerender(<BillingContent surface="app" />);

      expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
    });

    it('draws no pager when there are no purchases', () => {
      setTransactions([]);
      render(<BillingContent surface="app" />);
      expect(screen.queryByRole('button', { name: 'Previous' })).not.toBeInTheDocument();
    });
  });

  describe('money card', () => {
    it('titles the breakdown as a level-2 heading', () => {
      render(<BillingContent surface="app" />);
      expect(
        screen.getByRole('heading', { level: 2, name: 'Where does my money go?' })
      ).toBeVisible();
    });

    it('breaks down a 100 dollar deposit', () => {
      render(<BillingContent surface="app" />);
      expect(screen.getByRole('img', { name: /^Service Value about \d+%/ })).toBeVisible();
    });

    it('notes that actual costs vary', () => {
      render(<BillingContent surface="app" />);
      expect(
        screen.getByText('Actual costs vary based on your model selection and usage patterns.')
      ).toBeVisible();
    });
  });
});
