import * as React from 'react';
import { ModalOverlay } from '@lome-chat/ui';
import { PaymentForm } from './payment-form';
import { useIsMobile } from '@/hooks/use-is-mobile';

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
  const isMobile = useIsMobile();

  const handleSuccess = (newBalance: string): void => {
    onSuccess(newBalance);
  };

  const handleCancel = (): void => {
    onOpenChange(false);
  };

  // Prevent auto-focus on mobile to avoid triggering keyboard
  const handleOpenAutoFocus = React.useCallback(
    (event: Event) => {
      if (isMobile) {
        event.preventDefault();
      }
    },
    [isMobile]
  );

  if (!open) return null;

  return (
    <ModalOverlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Add credits"
      onOpenAutoFocus={handleOpenAutoFocus}
    >
      <div data-testid="payment-modal">
        <PaymentForm onSuccess={handleSuccess} onCancel={handleCancel} />
      </div>
    </ModalOverlay>
  );
}
