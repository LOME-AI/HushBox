import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, Overlay, ModalActions, OverlayContent, OverlayHeader } from '@hushbox/ui';

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
    <Overlay open={open} onOpenChange={onOpenChange} ariaLabel="Leave Conversation">
      <OverlayContent data-testid="leave-confirmation-modal">
        <div data-testid="leave-confirmation-title">
          <OverlayHeader title="Leave Conversation?" />
        </div>

        <Alert data-testid="leave-confirmation-warning">
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
      </OverlayContent>
    </Overlay>
  );
}
