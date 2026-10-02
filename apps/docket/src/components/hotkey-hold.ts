import { useEffect, useSyncExternalStore } from 'react';

/**
 * A dialog traps focus, but a shortcut registered on the window never consults
 * focus, so without a hold the console keeps taking keystrokes underneath an
 * open dialog: the queue steps, a digit rules the finding, and the dialog
 * raised to ask about that very decision cannot stop either.
 *
 * The count is module state rather than context because the shortcuts are
 * registered above every dialog in the tree — a provider that enclosed both
 * would have to be mounted at the app root, which is exactly the wiring a modal
 * added later would be built without.
 */
let holds = 0;
const listeners = new Set<() => void>();

function held(): boolean {
  return holds > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Takes the console's shortcuts away for as long as the caller's dialog is
 * open. Counted, not a flag: a dialog raised over another one must not hand the
 * shortcuts back when it alone closes. The release is the effect's cleanup, so
 * a dialog that is unmounted rather than closed releases it too.
 *
 * A modal built on anything other than `ConfirmDialog` must call this itself or
 * the console goes on taking keystrokes underneath it.
 * Detecting an open `[role="dialog"]` from the DOM instead was rejected: the
 * source peek is a popover, so it already carries that role whenever it is
 * open, and it is not a modal — it opens on hovering or focusing a citation and
 * has to leave the console's keys live, `j` included.
 */
export function useHotkeyHold(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    holds += 1;
    announce();
    return () => {
      holds -= 1;
      announce();
    };
  }, [open]);
}

/** True while any dialog holds the shortcuts. */
export function useHotkeysHeld(): boolean {
  return useSyncExternalStore(subscribe, held);
}
