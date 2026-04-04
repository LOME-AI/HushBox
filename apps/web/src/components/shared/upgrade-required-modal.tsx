import * as React from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import { Button, Overlay } from '@hushbox/ui';
import { useAppVersionStore } from '@/stores/app-version';
import { isNative } from '@/capacitor/platform';
import { checkForUpdate, applyUpdate } from '@/capacitor/live-update';

export function UpgradeRequiredModal(): React.JSX.Element | null {
  const upgradeRequired = useAppVersionStore((s) => s.upgradeRequired);
  const [isUpdating, setIsUpdating] = React.useState(false);

  if (!upgradeRequired) return null;

  const handleRefresh = (): void => {
    if (!isNative()) {
      globalThis.location.reload();
      return;
    }

    setIsUpdating(true);
    void (async (): Promise<void> => {
      try {
        const result = await checkForUpdate();
        if (result.updateAvailable && result.serverVersion) {
          await applyUpdate(result.serverVersion);
        }
      } finally {
        setIsUpdating(false);
      }
    })();
  };

  return (
    <Overlay
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
          onClick={handleRefresh}
          disabled={isUpdating}
          className="w-full"
        >
          {isUpdating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Updating...
            </>
          ) : (
            'Refresh'
          )}
        </Button>
      </div>
    </Overlay>
  );
}
