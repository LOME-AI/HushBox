'use client';

import * as React from 'react';

interface OverlayChrome {
  /** The dialog fills the viewport, drawing no radius, border or shadow. */
  fullscreen: boolean;
  /** Places the dialog near the top of the viewport until the returned release runs. */
  claimTopPlacement: () => () => void;
}

/** What the dialog renderer tells the content it holds; a sheet provides none. */
const OverlayChromeContext = React.createContext<OverlayChrome | null>(null);

function useOverlayChrome(): OverlayChrome | null {
  return React.useContext(OverlayChromeContext);
}

type DialogPlacement = 'center' | 'top' | 'fullscreen';

/** The chrome a dialog renderer provides, and where the content's claims place the dialog. */
function useDialogChrome(fullscreen: boolean): {
  chrome: OverlayChrome;
  placement: DialogPlacement;
} {
  // Counted rather than a flag: one step's content can hand over to the next in one commit.
  const [topClaims, setTopClaims] = React.useState(0);
  const claimTopPlacement = React.useCallback((): (() => void) => {
    setTopClaims((count) => count + 1);
    return () => {
      setTopClaims((count) => count - 1);
    };
  }, []);
  const chrome = React.useMemo(
    () => ({ fullscreen, claimTopPlacement }),
    [fullscreen, claimTopPlacement]
  );
  if (fullscreen) return { chrome, placement: 'fullscreen' };
  return { chrome, placement: topClaims > 0 ? 'top' : 'center' };
}

export { OverlayChromeContext, useDialogChrome, useOverlayChrome };
