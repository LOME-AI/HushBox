import { describe, it, expect, vi } from 'vitest';

// PaymentForm's real success path runs the full HelcimPay.js tokenization +
// polling flow (exercised in payment-form.test.tsx). Here we stub it to a pair
// of trigger buttons so PaymentModal's own onSuccess/onCancel forwarding is
// verified in isolation.
vi.mock('./payment-form', () => ({
  PaymentForm: ({
    onSuccess,
    onCancel,
  }: {
    onSuccess?: () => void;
    onCancel?: () => void;
  }): React.JSX.Element => (
    <div>
      <button type="button" onClick={() => onSuccess?.()}>
        trigger-success
      </button>
      <button type="button" onClick={() => onCancel?.()}>
        trigger-cancel
      </button>
    </div>
  ),
}));

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NOTICE_COPY } from '@hushbox/shared';
import { PaymentModal } from './payment-modal';

// The stub's success button stands for the real form's terminal success: both
// of PaymentForm's success paths set `paymentState` to `'success'` — the state
// that swaps the form for its success card — and call `onSuccess` in that same
// branch, so nothing can reach the success card without this callback firing.
describe('PaymentModal success wiring', () => {
  it('forwards the payment form success to its own onSuccess prop', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    render(<PaymentModal open={true} onOpenChange={vi.fn()} onSuccess={onSuccess} />);

    await user.click(screen.getByText('trigger-success'));

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('stops saying the balance was short once the charge lands', async () => {
    const user = userEvent.setup();
    render(
      <PaymentModal
        open={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
        reason="insufficient_funds"
        modelName="GPT-4 Turbo"
      />
    );
    expect(screen.getByText(NOTICE_COPY.insufficient_funds.cause)).toBeInTheDocument();

    await user.click(screen.getByText('trigger-success'));

    expect(screen.queryByText(NOTICE_COPY.insufficient_funds.cause)).not.toBeInTheDocument();
    expect(screen.queryByText('GPT-4 Turbo')).not.toBeInTheDocument();
  });

  it('says why the row was refused again when a later refusal reopens the modal', async () => {
    const user = userEvent.setup();
    const props = {
      onOpenChange: vi.fn(),
      onSuccess: vi.fn(),
      reason: 'insufficient_funds',
      modelName: 'GPT-4 Turbo',
    } as const;
    const { rerender } = render(<PaymentModal open={true} {...props} />);

    await user.click(screen.getByText('trigger-success'));
    rerender(<PaymentModal open={false} {...props} />);
    rerender(<PaymentModal open={true} {...props} />);

    expect(screen.getByText(NOTICE_COPY.insufficient_funds.cause)).toBeInTheDocument();
  });
});
