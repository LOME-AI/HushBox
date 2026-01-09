import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaymentModal } from './payment-modal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
      expect(screen.queryByTestId('payment-modal')).not.toBeInTheDocument();
    });
  });

  describe('when open', () => {
    it('renders modal content when open', () => {
      render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });
      expect(screen.getByTestId('payment-modal')).toBeInTheDocument();
    });

    it('renders payment form inside modal', () => {
      render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });
      expect(screen.getByText('Add Credits')).toBeInTheDocument();
    });

    it('renders modal backdrop', () => {
      render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={vi.fn()} />, { wrapper });
      expect(screen.getByTestId('modal-overlay-backdrop')).toBeInTheDocument();
    });
  });

  describe('closing', () => {
    it('calls onOpenChange when backdrop is clicked', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(<PaymentModal open={true} onOpenChange={onOpenChange} onSuccess={vi.fn()} />, {
        wrapper,
      });

      await user.click(screen.getByTestId('modal-overlay-backdrop'));
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
  });
});
