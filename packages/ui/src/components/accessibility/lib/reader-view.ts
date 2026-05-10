import { Readability } from '@mozilla/readability';

export interface ExtractedArticle {
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  contentHtml: string;
  textContent: string;
  length: number;
}

/**
 * Extract main article content from a Document via Mozilla Readability.
 * Used by the marketing site's reader-view feature on blog/article pages.
 * NOTE: Readability mutates its input; pass a Document.cloneNode(true) clone.
 */
export function extractArticle(documentClone: Document): ExtractedArticle | null {
  const reader = new Readability(documentClone);
  const result = reader.parse();
  if (result === null) return null;
  return {
    title: result.title ?? null,
    byline: result.byline ?? null,
    excerpt: result.excerpt ?? null,
    contentHtml: result.content ?? '',
    textContent: result.textContent ?? '',
    length: result.length ?? 0,
  };
}

/**
 * Apply / remove chat reader-mode (CSS-driven, no extraction).
 * Sets html[data-reader-mode] which the CSS rules use to hide [data-chrome] elements.
 *
 * Boolean parameter mirrors `classList.toggle(name, force)` and the surrounding
 * accessibility store's boolean settings. Splitting into separate enable/disable
 * functions would push every caller into branching at the call site.
 */
/* eslint-disable sonarjs/no-selector-parameter -- standard DOM toggle API mirroring classList.toggle(name, force) */
export function setChatReaderMode(
  enabled: boolean,
  root: HTMLElement = document.documentElement
): void {
  if (enabled) {
    root.dataset['readerMode'] = '';
  } else {
    delete root.dataset['readerMode'];
  }
}
/* eslint-enable sonarjs/no-selector-parameter */
