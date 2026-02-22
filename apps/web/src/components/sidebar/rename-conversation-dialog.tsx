import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  ModalActions,
} from '@hushbox/ui';
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename conversation</DialogTitle>
          <DialogDescription>Enter a new name for this conversation.</DialogDescription>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  );
}
