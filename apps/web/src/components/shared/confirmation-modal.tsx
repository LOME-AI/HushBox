import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, ModalActions, ModalOverlay } from '@hushbox/ui';

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
    <ModalOverlay open={open} onOpenChange={onOpenChange} ariaLabel={ariaLabel}>
      <div
        data-testid={`${testIdPrefix}-modal`}
        className="bg-background flex w-[90vw] max-w-md flex-col rounded-lg border p-6 shadow-lg"
      >
        <h2 data-testid={`${testIdPrefix}-title`} className="mb-4 text-lg font-semibold">
          {title}
        </h2>

        <Alert data-testid={`${testIdPrefix}-warning`} className="mb-4">
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
      </div>
    </ModalOverlay>
  );
}
