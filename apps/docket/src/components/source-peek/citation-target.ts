// The subpath, never the package barrel: a value import through the barrel
// drags `node:fs` into the browser bundle and the page renders blank.
import { CITATION_ATTRIBUTES } from '@hushbox/docket/types';

/** A cited range, as the renderer marked it on the code span. */
export interface Citation {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

export interface CitationTarget extends Citation {
  readonly element: HTMLElement;
}

/** Every citation the peek layer can act on, wherever the body was placed. */
export const CITATION_SELECTOR = `[${CITATION_ATTRIBUTES.path}]`;

function lineNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * The citation an event landed on, or nothing. Only the renderer writes these
 * attributes, so an unresolvable citation never reaches here: it stays plain
 * text rather than offering a peek that cannot be served.
 */
export function readCitation(target: EventTarget | null): CitationTarget | null {
  if (!(target instanceof HTMLElement)) return null;

  const path = target.getAttribute(CITATION_ATTRIBUTES.path);
  const start = lineNumber(target.getAttribute(CITATION_ATTRIBUTES.start));
  const end = lineNumber(target.getAttribute(CITATION_ATTRIBUTES.end));
  if (path === null || start === null || end === null) return null;

  return { element: target, path, start, end };
}

/**
 * One window per path and range. The key carries no audit because the reader
 * holding the cache (`createSourceReader`) is built per audit.
 */
export function citationKey(citation: Citation): string {
  return `${citation.path}:${String(citation.start)}-${String(citation.end)}`;
}
