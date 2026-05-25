import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, useAsyncAction } from '@hushbox/ui';
import { ActionModal } from './action-modal';

interface ConfirmationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  warning: string;
  confirmLabel: string;
  /**
   * Confirm handler. Sync handlers close the modal immediately (legacy
   * behavior). Async handlers — Promise return values — drive the inline
   * error region on rejection and keep the modal open for retry; on resolve
   * the modal closes. This is the contract shared with `ActionModal`.
   */
  onConfirm: () => void | Promise<void>;
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
  const asyncAction = useAsyncAction();

  const handleSubmit = React.useCallback(async (): Promise<void> => {
    const maybe = onConfirm();
    // Sync handlers return void; treat them as immediate success so the modal
    // closes through ActionModal's `ok: true` branch with no error surface.
    if (maybe instanceof Promise) await maybe;
  }, [onConfirm]);

  return (
    <ActionModal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      ariaLabel={ariaLabel}
      asyncAction={asyncAction}
      primary={{
        label: confirmLabel,
        variant: 'destructive',
        onSubmit: handleSubmit,
        testId: `${testIdPrefix}-confirm`,
      }}
      cancel={{
        label: 'Cancel',
        testId: `${testIdPrefix}-cancel`,
      }}
      testId={`${testIdPrefix}-modal`}
      titleTestId={`${testIdPrefix}-title`}
    >
      <Alert data-testid={`${testIdPrefix}-warning`}>
        <AlertTriangle />
        <span>{warning}</span>
      </Alert>
    </ActionModal>
  );
}
