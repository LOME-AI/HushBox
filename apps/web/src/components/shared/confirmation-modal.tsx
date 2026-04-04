import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, ModalActions, Overlay, OverlayContent, OverlayHeader } from '@hushbox/ui';

interface ConfirmationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  warning: string;
  confirmLabel: string;
  onConfirm: () => void;
  ariaLabel: string;
  testIdPrefix: string;
}

export function ConfirmationModal({
  open,
  onOpenChange,
  title,
  warning,
  confirmLabel,
  onConfirm,
  ariaLabel,
  testIdPrefix,
}: Readonly<ConfirmationModalProps>): React.JSX.Element {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} ariaLabel={ariaLabel}>
      <OverlayContent data-testid={`${testIdPrefix}-modal`}>
        <div data-testid={`${testIdPrefix}-title`}>
          <OverlayHeader title={title} />
        </div>

        <Alert data-testid={`${testIdPrefix}-warning`}>
          <AlertTriangle />
          <span>{warning}</span>
        </Alert>

        <ModalActions
          cancel={{
            label: 'Cancel',
            onClick: () => {
              onOpenChange(false);
            },
            testId: `${testIdPrefix}-cancel`,
          }}
          primary={{
            label: confirmLabel,
            variant: 'destructive',
            onClick: () => {
              onConfirm();
              onOpenChange(false);
            },
            testId: `${testIdPrefix}-confirm`,
          }}
        />
      </OverlayContent>
    </Overlay>
  );
}
