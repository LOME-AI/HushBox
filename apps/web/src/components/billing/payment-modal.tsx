import * as React from 'react';
import { Overlay, OverlayContent } from '@hushbox/ui/overlay';
import { useFormFactor } from '@hushbox/ui/platform';
import { NOTICE_COPY, TEST_IDS } from '@hushbox/shared';
import { PaymentForm, type CompletedCharge } from './payment-form';
import type { RefusalCode } from '@hushbox/shared';

interface PaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (charge: CompletedCharge) => void;
  /** The model of the row that was refused, when a refused row opened this modal. */
  modelName?: string | undefined;
  /**
   * Why the row the payer clicked was refused. Every refusal reaches this modal
   * when there is a session, so the sentence has to come from the reason: most
   * of them are not about money at all, and the payer is owed the same words the
   * signed-out visitor gets rather than a payment form with no explanation.
   */
  reason?: RefusalCode | undefined;
}

export function PaymentModal({
  open,
  onOpenChange,
  onSuccess,
  modelName,
  reason,
}: Readonly<PaymentModalProps>): React.JSX.Element | null {
  const isMobile = useFormFactor().band === 'phone';
  const [chargeLanded, setChargeLanded] = React.useState(false);

  const handleSuccess = (charge: CompletedCharge): void => {
    setChargeLanded(true);
    onSuccess(charge);
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

  // Closing unmounts the form, so its state resets; this flag lives above that
  // boundary and would otherwise suppress the next refusal's notice too.
  React.useEffect(() => {
    if (!open) setChargeLanded(false);
  }, [open]);

  if (!open) return null;

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Add credits"
      onOpenAutoFocus={handleOpenAutoFocus}
    >
      <div data-testid={TEST_IDS.paymentModal} className="flex flex-col gap-2">
        {reason !== undefined && !chargeLanded && (
          // The one home for refusal copy, so this door says the same thing the
          // row's own notice says rather than a second wording of it. The name is
          // a label above that sentence, as on the picker row, never composed
          // into it: a sentence naming the model would be copy this vocabulary
          // does not hold.
          //
          // A refusal notice above a success confirmation is stale context
          // whatever the reason was, so it goes when the charge lands;
          // `onSuccess` fires on the same state that swaps the form for its
          // success card, so the two can never be on screen at once.
          <OverlayContent className="gap-1 py-4">
            {modelName !== undefined && (
              <span className="text-foreground text-sm font-medium">{modelName}</span>
            )}
            <p className="text-muted-foreground text-sm">{NOTICE_COPY[reason].cause}</p>
          </OverlayContent>
        )}
        <PaymentForm onSuccess={handleSuccess} onCancel={handleCancel} />
      </div>
    </Overlay>
  );
}
