import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';

import { Spinner } from './spinner';

interface ButtonFrameProps extends React.ComponentProps<'button'> {
  loading?: boolean | undefined;
  loadingLabel?: string | undefined;
  block?: boolean | undefined;
  asChild?: boolean | undefined;
}

const LABEL_CELL = 'col-start-1 row-start-1 inline-flex items-center justify-center gap-[inherit]';

// Both labels share one grid cell, and the one not shown is `invisible`, so it keeps
// its space but leaves the accessibility tree: the button is as wide in either state.
function labelsFor(
  children: React.ReactNode,
  loading: boolean,
  loadingLabel: string | undefined
): React.JSX.Element {
  const idle = children;
  const busy = (
    <>
      <Spinner />
      {loadingLabel ?? children}
    </>
  );
  return (
    <span data-slot="button-label" className="grid gap-[inherit]">
      <span data-slot="button-visible" className={LABEL_CELL}>
        {loading ? busy : idle}
      </span>
      <span data-slot="button-reservation" aria-hidden="true" className={`invisible ${LABEL_CELL}`}>
        {loading ? idle : busy}
      </span>
    </span>
  );
}

/**
 * The behaviour every button shares: an `aria-disabled` or loading button refuses
 * clicks (and so never submits its form) while staying focusable, a loading button
 * holds its width and reports busy, and a block button carries the mark the width
 * rule reads.
 */
function ButtonFrame({
  asChild = false,
  loading,
  loadingLabel,
  block = false,
  onClick,
  children,
  ...props
}: Readonly<ButtonFrameProps>): React.JSX.Element {
  const Comp = asChild ? Slot : 'button';
  const ariaDisabled = props['aria-disabled'];
  const refused = loading === true || ariaDisabled === true || ariaDisabled === 'true';

  return (
    <Comp
      data-slot="button"
      {...props}
      {...(block && { 'data-block': '' })}
      {...(loading === true && { 'aria-busy': true })}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        if (refused) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {asChild || loading === undefined ? children : labelsFor(children, loading, loadingLabel)}
    </Comp>
  );
}

export { ButtonFrame, type ButtonFrameProps };
