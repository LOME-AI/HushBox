import * as React from 'react';
import { useAsyncAction } from '@hushbox/ui';
import { AlertTriangle } from '@hushbox/ui/icons';
import { Notice } from '@hushbox/ui/notice';
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
  testIdPrefix: string;
}

export function ConfirmationModal({
  open,
  onOpenChange,
  title,
  warning,
  confirmLabel,
  onConfirm,
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
      role="alertdialog"
      size="sm"
    >
      <Notice tone="warning" icon={AlertTriangle} data-testid={`${testIdPrefix}-warning`}>
        {warning}
      </Notice>
    </ActionModal>
  );
}
