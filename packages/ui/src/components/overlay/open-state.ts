import * as React from 'react';

/**
 * The value `current` held when the overlay opened, kept while it stays open and after it closes
 * until the next open reads again, so nothing rebuilds an open or closing overlay out from under
 * the reader.
 */
export function useOpenedValue<T>(open: boolean, current: T): T {
  const [latch, setLatch] = React.useState({ open, value: current });
  if (latch.open !== open) {
    setLatch({ open, value: open ? current : latch.value });
  }
  return open && !latch.open ? current : latch.value;
}

/** Open state that follows `open` when the caller controls it and holds its own otherwise. */
export function useOpenState(
  open?: boolean,
  onOpenChange?: (open: boolean) => void
): [boolean, (next: boolean) => void] {
  const [uncontrolled, setUncontrolled] = React.useState(false);
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (open === undefined) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [open, onOpenChange]
  );
  return [open ?? uncontrolled, setOpen];
}
