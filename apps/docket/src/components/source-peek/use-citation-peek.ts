import { useCallback, useEffect, useRef, useState } from 'react';
// The subpath, never the package barrel: a value import through the barrel
// drags `node:fs` into the browser bundle and the page renders blank.
import { citationLabel } from '@hushbox/docket/types';
import { readCitation } from './citation-target';
import type { CitationTarget } from './citation-target';
import type { PeekOutcome, SourceReader } from './source-window';

/**
 * Long enough that sweeping the cursor along a paragraph of citations reads
 * nothing, short enough that resting on one feels immediate.
 */
export const PEEK_DELAY_MS = 250;

interface PeekState {
  readonly citation: CitationTarget;
  /** `null` until the window arrives. */
  readonly outcome: PeekOutcome | null;
}

interface CitationPeekOptions {
  readonly read: SourceReader;
  readonly copy: (text: string) => void;
}

interface CitationPeek {
  readonly peek: PeekState | null;
  readonly close: () => void;
}

/**
 * The hover, focus and keyboard behavior of every citation on the page at once.
 * Listening on the document rather than on a container is what lets the layer
 * work over server-rendered markup it never owns: the finding body is placed as
 * html, so there is no React element per citation to attach to.
 */
export function useCitationPeek({ read, copy }: CitationPeekOptions): CitationPeek {
  const [peek, setPeek] = useState<PeekState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef<CitationTarget | null>(null);

  const close = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    active.current = null;
    setPeek(null);
  }, []);

  useEffect(() => {
    const open = async (target: CitationTarget): Promise<void> => {
      active.current = target;
      setPeek({ citation: target, outcome: null });
      const outcome = await read(target);
      // A window that arrives after the reader has moved on belongs to a peek
      // that is no longer on screen.
      if (active.current !== target) return;
      setPeek({ citation: target, outcome });
    };

    const enter = (event: Event): void => {
      const target = readCitation(event.target);
      if (target === null || target.element === active.current?.element) return;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void open(target);
      }, PEEK_DELAY_MS);
    };

    const leave = (event: Event): void => {
      if (readCitation(event.target) === null) return;
      close();
    };

    const keyed = (event: KeyboardEvent): void => {
      // Answered here but deliberately not offered to the shortcut legend. A
      // row naming the preview could only be read once the legend is open, and
      // opening the legend has already closed the preview: the dialog takes the
      // focus the citation held. The legend owns the Escape row instead.
      if (event.key === 'Escape') {
        close();
        return;
      }
      // Both keys, because the citation announces itself as a button and a
      // reader who hears one presses either. Space would scroll the page out
      // from under the citation it just acted on.
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = readCitation(event.target);
      if (target === null) return;
      if (event.key === ' ') event.preventDefault();
      copy(citationLabel(target));
    };

    const clicked = (event: Event): void => {
      const target = readCitation(event.target);
      if (target !== null) copy(citationLabel(target));
    };

    document.addEventListener('pointerover', enter);
    document.addEventListener('pointerout', leave);
    document.addEventListener('focusin', enter);
    document.addEventListener('focusout', leave);
    document.addEventListener('keydown', keyed);
    document.addEventListener('click', clicked);

    return () => {
      document.removeEventListener('pointerover', enter);
      document.removeEventListener('pointerout', leave);
      document.removeEventListener('focusin', enter);
      document.removeEventListener('focusout', leave);
      document.removeEventListener('keydown', keyed);
      document.removeEventListener('click', clicked);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [read, copy, close]);

  const anchor = peek?.citation.element ?? null;

  /**
   * A peek opened by hover has no pointer event coming for it once the reader
   * steps the queue from the keyboard, and the layer takes no clicks, so
   * nothing else would take it down: it would sit over the next finding showing
   * the source of the one just left. The citation leaving the page is the
   * signal, rather than the selection, because this layer never learns which
   * finding is on screen.
   */
  useEffect(() => {
    if (anchor === null) return;

    const observer = new MutationObserver(() => {
      if (!anchor.isConnected) close();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
    };
  }, [anchor, close]);

  return { peek, close };
}
