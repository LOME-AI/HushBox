import { useEffect } from 'react';
import { CITATION_SELECTOR } from './citation-target';

/**
 * Citations arrive as server-rendered html, so there is no React element to put
 * a `tabIndex` on. Setting it here is what makes the peek reachable without a
 * pointer; the focus ring stays the browser's own, which needs no stylesheet to
 * be visible.
 *
 * Every mutation triggers one document-wide query rather than a walk of the
 * added nodes: the query is native and the console holds one audit, so the
 * simpler rule is the cheaper one to keep right.
 */
export function useCitationTabStops(): void {
  useEffect(() => {
    const apply = (): void => {
      for (const element of document.querySelectorAll(`${CITATION_SELECTOR}:not([tabindex])`)) {
        element.setAttribute('tabindex', '0');
      }
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
    };
  }, []);
}
