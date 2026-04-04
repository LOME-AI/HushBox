import * as React from 'react';
import { Overlay, OverlayContent, OverlayHeader, Input, ModalActions } from '@hushbox/ui';
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
      <OverlayContent>
        <OverlayHeader
          title="Rename conversation"
          description="Enter a new name for this conversation."
        />
        <form
          id="rename-conversation"
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
        </form>
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
            type: 'submit',
            form: 'rename-conversation',
            testId: 'save-rename-button',
          }}
        />
      </OverlayContent>
    </Overlay>
  );
}
