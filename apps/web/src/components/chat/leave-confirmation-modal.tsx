import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, useAsyncAction } from '@hushbox/ui';
import type { ErrorCode } from '@hushbox/shared';
import { ActionModal } from '../shared/action-modal.js';

interface LeaveConfirmationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isOwner: boolean;
  onConfirm: () => void | Promise<void>;
}

// Owner leave deletes the conversation (no rotation); non-owner leave runs
// `executeWithRotation` which can race against concurrent member edits.
const LEAVE_ERROR_CODES = [
  'STALE_EPOCH',
  'WRAP_SET_MISMATCH',
] as const satisfies readonly ErrorCode[];

export function LeaveConfirmationModal({
  open,
  onOpenChange,
  isOwner,
  onConfirm,
}: Readonly<LeaveConfirmationModalProps>): React.JSX.Element {
  const asyncAction = useAsyncAction();

  const handleSubmit = React.useCallback(async (): Promise<void> => {
    const maybe = onConfirm();
    if (maybe instanceof Promise) await maybe;
  }, [onConfirm]);

  return (
    <ActionModal
      open={open}
      onOpenChange={onOpenChange}
      title="Leave Conversation?"
      ariaLabel="Leave Conversation"
      asyncAction={asyncAction}
      primary={{
        label: 'Leave',
        loadingLabel: 'Leaving…',
        variant: 'destructive',
        onSubmit: handleSubmit,
        testId: 'leave-confirmation-confirm',
      }}
      cancel={{
        label: 'Cancel',
        testId: 'leave-confirmation-cancel',
      }}
      testId="leave-confirmation-modal"
      titleTestId="leave-confirmation-title"
      devSimulateCodes={LEAVE_ERROR_CODES}
    >
      <Alert data-testid="leave-confirmation-warning">
        <AlertTriangle />
        <span>
          {isOwner
            ? 'As the owner, leaving will delete all messages and remove all members.'
            : "You will lose access to this conversation's messages."}
        </span>
      </Alert>
    </ActionModal>
  );
}
