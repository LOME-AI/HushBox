import * as React from 'react';
import { useAsyncAction } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
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
        onSubmit: async () => {
          await onConfirm();
        },
        testId: TEST_IDS.confirmDeleteButton,
      }}
      cancel={{
        label: 'Cancel',
        testId: TEST_IDS.cancelDeleteButton,
      }}
      testId={TEST_IDS.deleteConversationDialog}
    >
      <p className="text-muted-foreground text-sm">
        This will permanently delete &quot;{title}&quot;. This action cannot be undone.
      </p>
    </ActionModal>
  );
}
