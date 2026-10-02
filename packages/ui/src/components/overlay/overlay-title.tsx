'use client';

import * as React from 'react';

type OverlayTitlePrimitive = React.ComponentType<{
  asChild?: boolean;
  className?: string;
  children?: React.ReactNode;
}>;

interface OverlayTitleContextValue {
  /** The variant's dialog-title primitive — Radix's for the dialog, vaul's for the sheet. */
  Title: OverlayTitlePrimitive;
  /** Registers a visible heading as the dialog's name for as long as it stays mounted. */
  claimTitle: () => () => void;
  claimed: boolean;
}

const OverlayTitleContext = React.createContext<OverlayTitleContextValue | null>(null);

interface OverlayTitleProviderProps {
  Title: OverlayTitlePrimitive;
  /** Names the dialog only while no visible heading is mounted. */
  ariaLabel: string;
  children: React.ReactNode;
}

/**
 * Routes the dialog's accessible name to the visible `OverlayTitle` a consumer renders,
 * falling back to `ariaLabel` for overlays that show no heading at all.
 *
 * The claim rides a layout effect so the fallback and a visible heading are never mounted
 * in the same commit: both are the dialog title primitive, which carries the single id the
 * dialog is named by, and two of them would collide on it.
 */
function OverlayTitleProvider({
  Title,
  ariaLabel,
  children,
}: Readonly<OverlayTitleProviderProps>): React.JSX.Element {
  const [claims, setClaims] = React.useState(0);

  // Counted rather than a flag: a step transition unmounts the outgoing heading and mounts
  // the incoming one in one commit, and a flag would land on whichever effect ran last.
  const claimTitle = React.useCallback((): (() => void) => {
    setClaims((count) => count + 1);
    return () => {
      setClaims((count) => count - 1);
    };
  }, []);

  const claimed = claims > 0;
  const value = React.useMemo(() => ({ Title, claimTitle, claimed }), [Title, claimTitle, claimed]);

  return (
    <OverlayTitleContext value={value}>
      {!claimed && <Title className="sr-only">{ariaLabel}</Title>}
      {children}
    </OverlayTitleContext>
  );
}

type OverlayTitleProps = React.ComponentPropsWithoutRef<'h2'>;

/**
 * A modal's visible heading, which inside an `Overlay` is also the dialog's accessible
 * name — one element, so a sighted reader and a screen-reader user are told the same thing.
 * Outside an `Overlay` it is a plain heading.
 */
function OverlayTitle({
  className,
  children,
  ...props
}: Readonly<OverlayTitleProps>): React.JSX.Element {
  const context = React.useContext(OverlayTitleContext);
  const claimTitle = context?.claimTitle;

  React.useLayoutEffect(() => claimTitle?.(), [claimTitle]);

  const heading = (
    <h2 className={className} {...props}>
      {children}
    </h2>
  );

  if (context?.claimed !== true) return heading;
  const { Title } = context;
  return <Title asChild>{heading}</Title>;
}

export { OverlayTitle, OverlayTitleProvider };
