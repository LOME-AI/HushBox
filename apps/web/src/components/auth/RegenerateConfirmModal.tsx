import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Overlay, OverlayContent, OverlayHeader, ModalActions } from '@hushbox/ui';

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
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Regenerate recovery phrase confirmation"
    >
      <OverlayContent size="sm" className="w-full items-center text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
          <AlertTriangle className="h-6 w-6 text-amber-600" />
        </div>
        <OverlayHeader
          title="Regenerate Recovery Phrase?"
          description="You already have a recovery phrase. If you generate a new one, your previous phrase will no longer work."
        />
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
      </OverlayContent>
    </Overlay>
  );
}
