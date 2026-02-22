import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, ModalOverlay, ModalActions } from '@hushbox/ui';

interface LeaveConfirmationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isOwner: boolean;
  onConfirm: () => void;
}

export function LeaveConfirmationModal({
  open,
  onOpenChange,
  isOwner,
  onConfirm,
}: Readonly<LeaveConfirmationModalProps>): React.JSX.Element {
  return (
    <ModalOverlay open={open} onOpenChange={onOpenChange} ariaLabel="Leave Conversation">
      <div
        data-testid="leave-confirmation-modal"
        className="bg-background flex w-[90vw] max-w-md flex-col rounded-lg border p-6 shadow-lg"
      >
        <h2 data-testid="leave-confirmation-title" className="mb-4 text-lg font-semibold">
          Leave Conversation?
        </h2>

        <Alert data-testid="leave-confirmation-warning" className="mb-4">
          <AlertTriangle />
          <span>
            {isOwner
              ? 'As the owner, leaving will delete all messages and remove all members.'
              : "You will lose access to this conversation's messages."}
          </span>
        </Alert>

        <ModalActions
          cancel={{
            label: 'Cancel',
            onClick: () => {
              onOpenChange(false);
            },
            testId: 'leave-confirmation-cancel',
          }}
          primary={{
            label: 'Leave',
            variant: 'destructive',
            onClick: () => {
              onConfirm();
              onOpenChange(false);
            },
            testId: 'leave-confirmation-confirm',
          }}
        />
      </div>
    </ModalOverlay>
  );
}
