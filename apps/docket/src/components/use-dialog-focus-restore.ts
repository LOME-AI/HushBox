import { useRef } from 'react';

interface DialogFocusRestore {
  /**
   * Radix `onOpenAutoFocus`: mount-autofocus fires at the last moment before
   * focus enters the dialog, so this reads the control the reader activated.
   */
  readonly captureOpener: () => void;
  /** Radix `onCloseAutoFocus`: where focus goes once the dialog is gone. */
  readonly restoreFocus: (event: Event) => void;
}

/**
 * Everywhere focus can go when the dialog closes, nearest first: the opener, the
 * region the dialog was mounted in, and what each of those sits inside. `<body>`
 * is deliberately absent — landing there is the failure the trail exists to
 * prevent, so an empty trail means there is nothing to restore to.
 *
 * The region is in the trail because the opener cannot be relied on: some
 * callers unmount it in the very click that opens the dialog, so
 * `document.activeElement` is already `<body>` by the time Radix reports the
 * open, and others destroy it while the dialog is up.
 */
function focusTrail(...starts: readonly (Element | null)[]): readonly HTMLElement[] {
  const trail: HTMLElement[] = [];
  for (const start of starts) {
    let node = start;
    while (node instanceof HTMLElement) {
      if (node === document.body) break;
      trail.push(node);
      node = node.parentElement;
    }
  }
  return trail;
}

/**
 * Focus return for a controlled dialog. Radix restores focus to a
 * `DialogTrigger`; a dialog the console opens from a shortcut or a handler has
 * none, so without this every close drops focus to `<body>` and resets the tab
 * sequence to the top of the document.
 *
 * `fallback` is a second place to land for a caller whose opener can be gone
 * before the dialog is: it is asked for the element only at close, because what
 * survives is not known when the dialog opens.
 */
export function useDialogFocusRestore(fallback?: () => Element | null): DialogFocusRestore {
  const trailRef = useRef<readonly HTMLElement[]>([]);

  // Whether focus actually landed is the only reliable test of a destination.
  // `focus()` is a silent no-op on a control the action just disabled, and
  // approving every recommendation leaves its own button in place, disabled — so
  // asking the element what it is would mean enumerating every way it can refuse.
  const settleFocus = (): void => {
    for (const node of trailRef.current) {
      if (!node.isConnected) continue;

      node.focus();
      if (document.activeElement !== node) {
        // A surviving container is not focusable until given a tab index.
        node.tabIndex = -1;
        node.focus();
      }
      if (document.activeElement !== node) {
        node.removeAttribute('tabindex');
        continue;
      }

      watchFocus(node);
      return;
    }
  };

  // A confirmed action usually writes asynchronously, so the control focus just
  // landed on can still be re-rendered away or disabled after the fact — a
  // reopen removes its own row once the write returns. Both engines report that
  // as focus falling to `<body>`, and only a DOM watch catches it: Chromium
  // fires `focusout` on removal, happy-dom does not, and both fire the observer.
  // It stops on the reader's next deliberate focus, which is what keeps it
  // short-lived.
  function watchFocus(node: HTMLElement): void {
    // Only a landing that was actually lost is re-settled. Re-settling on every
    // mutation instead walks the trail again while focus is still fine, and the
    // caller's own re-render then races it: measured, the deny path ends on
    // `<body>` that way.
    const observer = new MutationObserver(() => {
      if (document.activeElement === node) return;
      stop();
      settleFocus();
    });

    function stop(): void {
      observer.disconnect();
      document.removeEventListener('focusin', stop);
    }

    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    document.addEventListener('focusin', stop);
  }

  return {
    captureOpener: (): void => {
      trailRef.current = focusTrail(document.activeElement, fallback?.() ?? null);
    },
    restoreFocus: (event: Event): void => {
      event.preventDefault();
      settleFocus();
    },
  };
}
