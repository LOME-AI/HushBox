import { rowPageCounts } from '@hushbox/shared';
import type { WebSearchEntry, WebSearchRow } from '@hushbox/shared';

/**
 * What a search row shows of the pages it found, derived at render time from
 * the stored titles and URLs. A page is its URL and is counted once per
 * message, under the first search in document order that found it; the counts
 * come from the shared per-message derivation, and this adds only the
 * per-search split a row's open list needs.
 */

export interface SourceView {
  readonly title: string;
  readonly url: string;
  /** The URL's hostname without a leading `www.`. Derived, never stored. */
  readonly host: string;
}

interface EntryPages {
  readonly entry: WebSearchEntry;
  /** Pages this search found first in the message, in the order it returned them. */
  readonly firstFound: readonly SourceView[];
  /** Pages this search returned that an earlier search in the message already found. */
  readonly foundEarlier: number;
}

export interface RowPages {
  /** Distinct pages in this row that no earlier row found. */
  readonly firstFound: number;
  /** One per search in the row, in the row's order. */
  readonly entries: readonly EntryPages[];
}

export function sourceHost(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

const IPV4_HOST = /^\d{1,3}(\.\d{1,3}){3}$/;
const PUNYCODE_LABEL = /(^|\.)xn--/;
const ALPHANUMERIC_START = /^[a-z0-9]/i;

/**
 * The letter a source's monogram shows, or `undefined` where a letter would
 * mislead: an address, a punycode host (whose first letter is not the site's),
 * or a host that does not start with a letter or digit.
 */
export function monogramOf(host: string): string | undefined {
  if (IPV4_HOST.test(host) || host.startsWith('[') || PUNYCODE_LABEL.test(host)) return;
  if (!ALPHANUMERIC_START.test(host)) return;
  return host.charAt(0).toUpperCase();
}

/** Every row's pages, for rows in document order (pre-order across every depth). */
export function messageRowPages(rows: readonly WebSearchRow[]): readonly RowPages[] {
  const counts = rowPageCounts(rows);
  const seen = new Set<string>();
  return rows.map((row, index) => ({
    /* v8 ignore next -- the shared derivation returns one count per row, so the index always resolves */
    firstFound: counts[index]?.firstFound ?? 0,
    entries: row.searches.map((entry) => {
      const firstFound: SourceView[] = [];
      let foundEarlier = 0;
      for (const source of entry.sources ?? []) {
        if (seen.has(source.url)) {
          foundEarlier += 1;
          continue;
        }
        seen.add(source.url);
        firstFound.push({ title: source.title, url: source.url, host: sourceHost(source.url) });
      }
      return { entry, firstFound, foundEarlier };
    }),
  }));
}

export interface TopDomains {
  readonly top: readonly string[];
  /** Distinct further domains beyond the named ones. */
  readonly more: number;
}

/** The row's two most frequent domains among its first-found pages, ties by first appearance. */
export function topDomains(pages: RowPages): TopDomains {
  const frequency = new Map<string, number>();
  for (const entry of pages.entries) {
    for (const source of entry.firstFound) {
      frequency.set(source.host, (frequency.get(source.host) ?? 0) + 1);
    }
  }
  const ranked = [...frequency.entries()]
    .map(([host, count], order) => ({ host, count, order }))
    .toSorted((a, b) => b.count - a.count || a.order - b.order)
    .map((entry) => entry.host);
  return { top: ranked.slice(0, 2), more: Math.max(0, ranked.length - 2) };
}
