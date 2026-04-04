import * as React from 'react';
import { Overlay, ModalActions } from '@hushbox/ui';

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
      <div className="bg-background w-[90vw] max-w-md rounded-lg border p-6 shadow-lg">
        <h2 className="text-lg font-semibold">Delete conversation?</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          This will permanently delete &quot;{title}&quot;. This action cannot be undone.
        </p>
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
      </div>
    </Overlay>
  );
}
