import * as React from 'react';
import { RefreshCw } from 'lucide-react';
import { Button, ModalOverlay } from '@hushbox/ui';
import { useAppVersionStore } from '@/stores/app-version';

export function UpgradeRequiredModal(): React.JSX.Element | null {
  const upgradeRequired = useAppVersionStore((s) => s.upgradeRequired);

  if (!upgradeRequired) return null;

  return (
    <ModalOverlay
      open={upgradeRequired}
      onOpenChange={() => {
        /* non-dismissable */
      }}
      ariaLabel="Update Required"
      showCloseButton={false}
    >
      <div
        data-testid="upgrade-required-modal"
        className="bg-background flex w-[90vw] max-w-sm flex-col items-center rounded-lg border p-6 text-center shadow-lg"
      >
        <RefreshCw className="text-muted-foreground mb-4 h-10 w-10" />
        <h2 data-testid="upgrade-required-title" className="mb-2 text-lg font-semibold">
          Update Required
        </h2>
        <p
          data-testid="upgrade-required-description"
          className="text-muted-foreground mb-6 text-sm"
        >
          A new version is available. Please refresh to continue.
        </p>
        <Button
          data-testid="upgrade-required-refresh"
          onClick={() => {
            globalThis.location.reload();
          }}
          className="w-full"
        >
          Refresh
        </Button>
      </div>
    </ModalOverlay>
  );
}
