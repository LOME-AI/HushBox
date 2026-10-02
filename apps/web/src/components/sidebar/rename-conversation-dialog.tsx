import * as React from 'react';
import { Input, useAsyncAction } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav.js';
import { ActionModal } from '../shared/action-modal.js';

interface RenameConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onValueChange: (value: string) => void;
  onConfirm: () => Promise<unknown>;
}

export function RenameConversationDialog({
  open,
  onOpenChange,
  value,
  onValueChange,
  onConfirm,
}: Readonly<RenameConversationDialogProps>): React.JSX.Element {
  const formRef = React.useRef<HTMLFormElement>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  useFormEnterNav(formRef);
  const asyncAction = useAsyncAction();

  return (
    <ActionModal
      open={open}
      onOpenChange={onOpenChange}
      title="Rename conversation"
      asyncAction={asyncAction}
      primary={{
        label: 'Save',
        loadingLabel: 'Saving…',
        onSubmit: async () => {
          await onConfirm();
        },
        disabled: !value.trim(),
        testId: TEST_IDS.saveRenameButton,
        type: 'submit',
        form: 'rename-conversation',
      }}
      cancel={{
        label: 'Cancel',
        testId: TEST_IDS.cancelRenameButton,
      }}
      testId={TEST_IDS.renameConversationDialog}
      initialFocus={nameRef}
    >
      <p className="text-muted-foreground text-sm">Enter a new name for this conversation.</p>
      <form
        id="rename-conversation"
        ref={formRef}
        onSubmit={(e) => {
          // Both Enter-key and primary-button submission route through
          // ActionModal's onClick handler (via the button's `type=submit form=`
          // linkage). The form's native submit fires too; preventDefault stops
          // a page navigation and ActionModal owns the close-on-success path.
          e.preventDefault();
        }}
      >
        <Input
          ref={nameRef}
          value={value}
          onChange={(e) => {
            onValueChange(e.target.value);
          }}
          placeholder="Conversation title"
        />
      </form>
    </ActionModal>
  );
}
