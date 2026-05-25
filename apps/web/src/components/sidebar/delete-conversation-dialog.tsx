import * as React from 'react';
import { useAsyncAction } from '@hushbox/ui';
import { ActionModal } from '../shared/action-modal.js';

interface DeleteConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onConfirm: () => void | Promise<void>;
}

export function DeleteConversationDialog({
  open,
  onOpenChange,
  title,
  onConfirm,
}: Readonly<DeleteConversationDialogProps>): React.JSX.Element {
  const asyncAction = useAsyncAction();

  const handleSubmit = React.useCallback(async (): Promise<void> => {
    const maybe = onConfirm();
    if (maybe instanceof Promise) await maybe;
  }, [onConfirm]);

  return (
    <ActionModal
      open={open}
      onOpenChange={onOpenChange}
      title="Delete conversation?"
      ariaLabel="Delete conversation dialog"
      asyncAction={asyncAction}
      primary={{
        label: 'Delete',
        loadingLabel: 'Deleting…',
        variant: 'destructive',
        onSubmit: handleSubmit,
        testId: 'confirm-delete-button',
      }}
      cancel={{
        label: 'Cancel',
        testId: 'cancel-delete-button',
      }}
      testId="delete-conversation-dialog"
    >
      <p className="text-muted-foreground text-sm">
        This will permanently delete &quot;{title}&quot;. This action cannot be undone.
      </p>
    </ActionModal>
  );
}
