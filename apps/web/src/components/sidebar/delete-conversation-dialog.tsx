import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ModalActions,
} from '@hushbox/ui';

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete conversation?</DialogTitle>
          <DialogDescription>
            This will permanently delete &quot;{title}&quot;. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  );
}
