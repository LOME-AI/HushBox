import * as React from 'react';
import { Input, useAsyncAction } from '@hushbox/ui';
import { useFormEnterNav } from '../../hooks/use-form-enter-nav.js';
import { ActionModal } from '../shared/action-modal.js';

interface RenameConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onValueChange: (value: string) => void;
  onConfirm: () => void | Promise<void>;
}

export function RenameConversationDialog({
  open,
  onOpenChange,
  value,
  onValueChange,
  onConfirm,
}: Readonly<RenameConversationDialogProps>): React.JSX.Element {
  const formRef = React.useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const asyncAction = useAsyncAction();

  const handleSubmit = React.useCallback(async (): Promise<void> => {
    const maybe = onConfirm();
    if (maybe instanceof Promise) await maybe;
  }, [onConfirm]);

  return (
    <ActionModal
      open={open}
      onOpenChange={onOpenChange}
      title="Rename conversation"
      ariaLabel="Rename conversation dialog"
      asyncAction={asyncAction}
      primary={{
        label: 'Save',
        loadingLabel: 'Saving…',
        onSubmit: handleSubmit,
        disabled: !value.trim(),
        testId: 'save-rename-button',
      }}
      cancel={{
        label: 'Cancel',
        testId: 'cancel-rename-button',
      }}
      testId="rename-conversation-dialog"
    >
      <p className="text-muted-foreground text-sm">Enter a new name for this conversation.</p>
      <form
        id="rename-conversation"
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit().then(() => {
            // Form submission delegates to the same handler; we don't auto-close
            // here because ActionModal owns the success-close path.
          });
        }}
      >
        <Input
          value={value}
          onChange={(e) => {
            onValueChange(e.target.value);
          }}
          placeholder="Conversation title"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- dialog input: focus management for keyboard users opening the dialog
          autoFocus
        />
      </form>
    </ActionModal>
  );
}
