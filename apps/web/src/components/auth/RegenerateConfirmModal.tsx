import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { ModalOverlay, ModalActions } from '@hushbox/ui';

interface RegenerateConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function RegenerateConfirmModal({
  open,
  onOpenChange,
  onConfirm,
}: Readonly<RegenerateConfirmModalProps>): React.JSX.Element {
  return (
    <ModalOverlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Regenerate recovery phrase confirmation"
    >
      <div className="bg-background w-full max-w-sm rounded-lg border p-6 shadow-lg">
        <div className="space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
            <AlertTriangle className="h-6 w-6 text-amber-600" />
          </div>
          <div className="text-center">
            <h2 className="text-lg font-semibold">Regenerate Recovery Phrase?</h2>
            <p className="text-muted-foreground mt-2 text-sm">
              You already have a recovery phrase. If you generate a new one, your previous phrase
              will no longer work.
            </p>
          </div>
          <ModalActions
            cancel={{
              label: 'Cancel',
              onClick: () => {
                onOpenChange(false);
              },
            }}
            primary={{
              label: 'Generate New',
              variant: 'destructive',
              onClick: onConfirm,
            }}
          />
        </div>
      </div>
    </ModalOverlay>
  );
}
