import * as React from 'react';
import { ModalOverlay } from '@lome-chat/ui';
import { PaymentForm } from './payment-form';

interface PaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (newBalance: string) => void;
}

export function PaymentModal({
  open,
  onOpenChange,
  onSuccess,
}: PaymentModalProps): React.JSX.Element | null {
  const handleSuccess = (newBalance: string): void => {
    onSuccess(newBalance);
    onOpenChange(false);
  };

  const handleCancel = (): void => {
    onOpenChange(false);
  };

  if (!open) return null;

  return (
    <ModalOverlay open={open} onOpenChange={onOpenChange}>
      <div data-testid="payment-modal">
        <PaymentForm onSuccess={handleSuccess} onCancel={handleCancel} />
      </div>
    </ModalOverlay>
  );
}
