import * as React from 'react';
import { Overlay, Input, ModalActions } from '@hushbox/ui';
import { useFormEnterNav } from '../../hooks/use-form-enter-nav.js';

interface RenameConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onValueChange: (value: string) => void;
  onConfirm: () => void;
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

  return (
    <Overlay open={open} onOpenChange={onOpenChange} ariaLabel="Rename conversation dialog">
      <div className="bg-background w-[90vw] max-w-md rounded-lg border p-6 shadow-lg">
        <h2 className="text-lg font-semibold">Rename conversation</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Enter a new name for this conversation.
        </p>
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm();
          }}
        >
          <Input
            value={value}
            onChange={(e) => {
              onValueChange(e.target.value);
            }}
            placeholder="Conversation title"
            autoFocus
          />
          <ModalActions
            cancel={{
              label: 'Cancel',
              onClick: () => {
                onOpenChange(false);
              },
              testId: 'cancel-rename-button',
            }}
            primary={{
              label: 'Save',
              onClick: onConfirm,
              disabled: !value.trim(),
              testId: 'save-rename-button',
            }}
          />
        </form>
      </div>
    </Overlay>
  );
}
