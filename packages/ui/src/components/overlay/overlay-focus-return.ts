import * as React from 'react';

const MAIN_LANDMARK = 'main, [role="main"]';

function connected(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && element.isConnected;
}

/**
 * Carries the id of the button a menu belongs to, on an element around a menu whose list is named
 * by its own title rather than by that button, as a menu presented as a sheet is.
 */
export const MENU_TRIGGER_ID_ATTRIBUTE = 'data-menu-trigger-id';

/**
 * The button a menu item's menu belongs to, read through the menu's `aria-labelledby`, or the
 * trigger id an enclosing element carries. A menu leaves the page whole, so a detached item still
 * reaches its own menu element and whatever encloses it.
 */
function menuTrigger(item: Element | null): Element | null {
  const triggerId =
    item?.closest('[role="menu"]')?.getAttribute('aria-labelledby') ??
    item?.closest(`[${MENU_TRIGGER_ID_ATTRIBUTE}]`)?.getAttribute(MENU_TRIGGER_ID_ATTRIBUTE);
  return triggerId ? document.querySelector(`#${CSS.escape(triggerId)}`) : null;
}

/**
 * Whether the element that held focus has left the page, dropping focus to `<body>`. Focus on
 * any other element is focus the page placed itself, which a closing overlay or menu keeps.
 */
export function focusIsLost(): boolean {
  return document.activeElement === document.body;
}

function takesFocus(element: HTMLElement): boolean {
  element.focus({ preventScroll: true });
  return document.activeElement === element && element !== document.body;
}

/** A landmark is not focusable by default; it holds a `tabindex` only while it holds focus. */
function focusLandmark(landmark: HTMLElement): boolean {
  if (!landmark.hasAttribute('tabindex')) {
    landmark.setAttribute('tabindex', '-1');
    landmark.addEventListener(
      'blur',
      () => {
        landmark.removeAttribute('tabindex');
      },
      { once: true }
    );
  }
  return takesFocus(landmark);
}

/**
 * Returns focus to whatever held it when the overlay opened. When that was a menu item now
 * gone, focus goes to the menu's button; when the opener is otherwise gone, to the page's
 * main landmark. Radix returns focus only to a `Dialog.Trigger`, and an `Overlay` is always
 * controlled with none, so without this every close drops focus to `<body>`.
 *
 * The opener is read in a layout effect on `open`, which runs before the portalled
 * content mounts, so a child's `autoFocus` has not yet moved focus into the overlay.
 */
export function useOverlayFocusReturn(open: boolean): (event: Event) => void {
  const openerRef = React.useRef<Element | null>(null);

  React.useLayoutEffect(() => {
    if (open) openerRef.current = document.activeElement;
  }, [open]);

  return React.useCallback((event: Event): void => {
    event.preventDefault();
    if (!focusIsLost()) return;
    const opener = openerRef.current;
    if (connected(opener) && takesFocus(opener)) return;
    const trigger = menuTrigger(opener);
    if (connected(trigger) && takesFocus(trigger)) return;
    const main = document.querySelector(MAIN_LANDMARK);
    if (connected(main)) focusLandmark(main);
  }, []);
}
