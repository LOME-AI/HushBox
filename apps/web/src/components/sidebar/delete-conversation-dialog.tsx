import * as React from 'react';
import { Overlay, OverlayContent, OverlayHeader, ModalActions } from '@hushbox/ui';

interface DeleteConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onConfirm: () => void;
}

export function DeleteConversationDialog({
  open,
  onOpenChange,
  title,
  onConfirm,
}: Readonly<DeleteConversationDialogProps>): React.JSX.Element {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} ariaLabel="Delete conversation dialog">
      <OverlayContent>
        <OverlayHeader
          title="Delete conversation?"
          description={
            <>This will permanently delete &quot;{title}&quot;. This action cannot be undone.</>
          }
        />
        <ModalActions
          cancel={{
            label: 'Cancel',
            onClick: () => {
              onOpenChange(false);
            },
            testId: 'cancel-delete-button',
          }}
          primary={{
            label: 'Delete',
            variant: 'destructive',
            onClick: onConfirm,
            testId: 'confirm-delete-button',
          }}
        />
      </OverlayContent>
    </Overlay>
  );
}
