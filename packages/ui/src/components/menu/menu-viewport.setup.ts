import { TOUCH_QUERY } from '@hushbox/shared';

type ChangeListener = (event: MediaQueryListEvent) => void;

interface MediaListStub {
  readonly matches: boolean;
  readonly media: string;
  readonly addEventListener: (type: string, listener: ChangeListener) => void;
  readonly removeEventListener: (type: string, listener: ChangeListener) => void;
}

const originalMatchMedia = globalThis.matchMedia;

/** One pixel under the band: the widest window that presents a sheet. */
export const PHONE = 767;
/** The narrowest window that presents an anchored menu. */
export const DESKTOP = 768;

/**
 * Stubs `matchMedia` for a window `width` wide with the given primary pointer; returns a resize
 * that notifies the band hooks.
 */
export function installViewport(
  initialWidth: number,
  pointer: 'fine' | 'coarse' = 'fine'
): (width: number) => void {
  let width = initialWidth;
  const listeners = new Map<string, Set<ChangeListener>>();
  const matchesQuery = (query: string): boolean => {
    const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query);
    if (maxWidth?.[1] !== undefined) return width <= Number(maxWidth[1]);
    return query === TOUCH_QUERY && pointer === 'coarse';
  };
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const set = listeners.get(query) ?? new Set<ChangeListener>();
      listeners.set(query, set);
      const list: MediaListStub = {
        matches: matchesQuery(query),
        media: query,
        addEventListener: (_type: string, listener: ChangeListener): void => {
          set.add(listener);
        },
        removeEventListener: (_type: string, listener: ChangeListener): void => {
          set.delete(listener);
        },
      };
      // The band and pointer hooks read only `matches` and the change-listener pair.
      return list as MediaQueryList;
    },
  });
  return (next: number): void => {
    width = next;
    for (const [query, set] of listeners) {
      // The band and pointer listeners read only `matches`.
      const event = { matches: matchesQuery(query), media: query } as MediaQueryListEvent;
      for (const listener of set) listener(event);
    }
  };
}

/** Puts back the environment's own `matchMedia`. */
export function restoreViewport(): void {
  Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
}

/**
 * vaul animates the sheet out and Radix unmounts it on `animationend`, which the test DOM never
 * fires; with the animation stopped the sheet unmounts, and returns focus, as it closes.
 */
export function stopSheetAnimations(): () => void {
  const style = document.createElement('style');
  style.textContent =
    '[data-vaul-drawer], [data-vaul-overlay] { animation-name: none !important; }';
  document.head.append(style);
  return () => {
    style.remove();
  };
}
