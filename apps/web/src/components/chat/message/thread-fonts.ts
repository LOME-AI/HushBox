/**
 * How long a hidden thread waits for the document's fonts once its rows first show. Past it the
 * thread is revealed and a late face swaps in under the reader, so the wait can never leave a
 * thread hidden.
 */
const FONT_WAIT_MS = 2000;

/** A hidden thread's wait on the document's fonts, from when its rows first show. */
export interface ThreadFontWait {
  /** Whether a reveal waits: the document is loading fonts and the wait has not run out. */
  readonly holds: () => boolean;
  /** Stops telling the caller anything. */
  readonly release: () => void;
}

/**
 * Starts the wait and calls `onSettle` whenever it may have ended: a font load finished or
 * failed, or the wait ran out. The faces waited on are whichever the document is loading, which
 * is what the hidden rows' own layout requested, so no list of faces is kept here.
 */
export function waitForThreadFonts(onSettle: () => void): ThreadFontWait {
  // Test DOMs have no FontFaceSet; there the thread never waits, so nothing is armed.
  if (!('fonts' in document)) return { holds: () => false, release: () => undefined };
  const fonts = document.fonts;
  let ranOut = false;
  const settle = (): void => {
    onSettle();
  };
  fonts.addEventListener('loadingdone', settle);
  fonts.addEventListener('loadingerror', settle);
  const timer = globalThis.setTimeout(() => {
    ranOut = true;
    onSettle();
  }, FONT_WAIT_MS);
  return {
    holds: () => !ranOut && fonts.status === 'loading',
    release: () => {
      globalThis.clearTimeout(timer);
      fonts.removeEventListener('loadingdone', settle);
      fonts.removeEventListener('loadingerror', settle);
    },
  };
}
