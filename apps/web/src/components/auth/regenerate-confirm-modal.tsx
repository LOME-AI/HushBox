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
    <Overlay open={open} onOpenChange={onOpenChange} ariaLabel="Regenerate Recovery Phrase?">
      <OverlayContent size="sm" className="w-full items-center text-center">
        <div className="bg-warning/10 mx-auto flex h-12 w-12 items-center justify-center rounded-full">
          <AlertTriangle className="text-warning h-6 w-6" />
        </div>
        <OverlayHeader
          title="Regenerate Recovery Phrase?"
          description="You already have a recovery phrase. A new one stops the old phrase from opening your account, but does not revoke a copy of your encryption key that someone already made."
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
