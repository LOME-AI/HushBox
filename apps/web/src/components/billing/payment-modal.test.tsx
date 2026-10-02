import { afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
}));

const formFactor = vi.hoisted((): { band: FormFactor['band'] } => ({ band: 'desktop' }));

vi.mock('@hushbox/ui/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hushbox/ui/platform')>()),
  useFormFactor: (): FormFactor => ({ band: formFactor.band, pointer: 'fine' }),
}));

// The processor script never finishes loading here: the modal's behaviour does
// not depend on the card fields, and a load settling after a test ends would
// update the form outside `act`.
vi.mock('../../lib/billing/helcim-loader', () => ({
  loadHelcimScript: (): Promise<void> => new Promise<void>(() => {}),
  tokenizeWithHelcim: vi.fn(),
}));

// The form's server reads, answered as not yet landed, so no request leaves the test.
vi.mock('@/hooks/billing/billing', () => ({
  useInitiatePayment: (): Pick<
    ReturnType<typeof useInitiatePayment>,
    'isPending' | 'mutateAsync'
  > => ({ isPending: false, mutateAsync: vi.fn() }),
  useBalance: (): Pick<ReturnType<typeof useBalance>, 'data' | 'refetch'> => ({
    data: undefined,
    refetch: vi.fn(),
  }),
  useTransactions: (): Pick<ReturnType<typeof useTransactions>, 'data'> => ({ data: undefined }),
  billingKeys: { transactions: () => ['billing', 'transactions'] as const },
}));

// The real form renders; the spy only exposes the props the modal hands it.
vi.mock('./payment-form', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./payment-form')>();
  return { ...actual, PaymentForm: vi.fn(actual.PaymentForm) };
});

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NOTICE_COPY, REFUSAL_CODES, TEST_IDS } from '@hushbox/shared';
import { PaymentModal } from './payment-modal';
import { PaymentForm } from './payment-form';
import type { FormFactor } from '@hushbox/ui/platform';
import type { useBalance, useInitiatePayment, useTransactions } from '@/hooks/billing/billing';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
});

const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

describe('PaymentModal', () => {
  describe('when closed', () => {
    it('does not render modal content when closed', () => {
      render(<PaymentModal open={false} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });
      expect(screen.queryByTestId(TEST_IDS.paymentModal)).not.toBeInTheDocument();
    });
  });

  describe('when open', () => {
    it('renders modal content when open', () => {
      render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });
      expect(screen.getByTestId(TEST_IDS.paymentModal)).toBeInTheDocument();
    });

    it('renders payment form inside modal', () => {
      render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });
      expect(screen.getByText('Add Credits')).toBeInTheDocument();
    });

    it('renders modal backdrop', () => {
      render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });
      expect(screen.getByTestId(TEST_IDS.overlayBackdrop)).toBeInTheDocument();
    });
  });

  describe('why the row was refused', () => {
    it.each([...REFUSAL_CODES])(
      'tells the payer why the row was refused when the reason is %s',
      (reason) => {
        render(
          <PaymentModal
            open={true}
            onOpenChange={vi.fn()}
            onSuccess={vi.fn()}
            reason={reason}
            modelName="GPT-4 Turbo"
          />,
          { wrapper }
        );

        expect(screen.getByText(NOTICE_COPY[reason].cause)).toBeInTheDocument();
      }
    );

    it('shows the model the payer clicked beside the reason', () => {
      render(
        <PaymentModal
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
          reason="insufficient_funds"
          modelName="GPT-4 Turbo"
        />,
        { wrapper }
      );

      expect(screen.getByText('GPT-4 Turbo')).toBeInTheDocument();
    });

    it('renders no model label when no model reached the modal', () => {
      render(
        <PaymentModal
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
          reason="insufficient_funds"
        />,
        { wrapper }
      );

      const cause = NOTICE_COPY.insufficient_funds.cause;
      expect(screen.getByText(cause).parentElement?.textContent).toBe(cause);
    });

    it('renders no refusal notice when the modal was opened without a reason', () => {
      render(
        <PaymentModal
          open={true}
          onOpenChange={vi.fn()}
          onSuccess={vi.fn()}
          modelName="GPT-4 Turbo"
        />,
        { wrapper }
      );

      expect(screen.queryByText('GPT-4 Turbo')).not.toBeInTheDocument();
      expect(screen.queryByText(NOTICE_COPY.insufficient_funds.cause)).not.toBeInTheDocument();
    });
  });

  describe('closing', () => {
    it('calls onOpenChange when backdrop is clicked', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(<PaymentModal open={true} onOpenChange={onOpenChange} onSuccess={vi.fn()} />, {
        wrapper,
      });

      await user.click(screen.getByTestId(TEST_IDS.overlayBackdrop));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('calls onOpenChange when Escape key is pressed', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(<PaymentModal open={true} onOpenChange={onOpenChange} onSuccess={vi.fn()} />, {
        wrapper,
      });

      await user.keyboard('{Escape}');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('closes when the payment form cancel button is clicked', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(<PaymentModal open={true} onOpenChange={onOpenChange} onSuccess={vi.fn()} />, {
        wrapper,
      });

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('opening focus', () => {
    afterEach(() => {
      formFactor.band = 'desktop';
    });

    it('focuses the dialog itself on a phone, so no field raises a keyboard', () => {
      formFactor.band = 'phone';
      render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });

      expect(document.activeElement).toBe(screen.getByRole('dialog'));
    });

    it('moves focus to a control inside the dialog on a desktop', () => {
      render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });

      const dialog = screen.getByRole('dialog');
      expect(document.activeElement).not.toBe(dialog);
      expect(dialog).toContainElement(document.activeElement as HTMLElement | null);
    });
  });

  describe('a completed charge', () => {
    it('reports the charged amount to onSuccess', () => {
      const onSuccess = vi.fn();
      render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={onSuccess} />, {
        wrapper,
      });
      const formProps = vi.mocked(PaymentForm).mock.lastCall?.[0];

      act(() => {
        formProps?.onSuccess?.({ amountNanoUsd: '20000000000' });
      });

      expect(onSuccess).toHaveBeenCalledWith({ amountNanoUsd: '20000000000' });
    });
  });
});
