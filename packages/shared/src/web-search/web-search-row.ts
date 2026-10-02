import { z } from 'zod';
import { isHttpUrl } from './web-search-contract.ts';

/**
 * The stored record of a run of searches: one row per maximal run of searches
 * with no content between them. A row stores each search's query, its status
 * and the title and URL of every page it found. Snippets, ages and site names
 * are never stored, and page counts are derived at render time from the URLs
 * ({@link rowPageCounts}), never stored.
 */

/** A stored query is cut to this many UTF-16 units, on a code-point boundary. */
export const WEB_SEARCH_STORED_QUERY_MAX_CHARS = 200;

/**
 * The storage allowance for every search row body in one message together. The
 * serializer drops sources, last row first, until the rows fit. A message holds
 * at most `TOOL_CALL_CAP_MAX` searches, and that many maximally escaped
 * queries still fit with every source dropped, which a test pins.
 */
export const WEB_SEARCH_ROW_MAX_CHARS = 16_000;

/** `searching` exists only in live text; settling turns it into `interrupted`. */
export const WEB_SEARCH_ENTRY_STATUSES = ['searching', 'done', 'failed', 'interrupted'] as const;

export const WebSearchSource = z.object({
  title: z.string(),
  url: z.string().refine(isHttpUrl, { message: 'url is not http(s)' }),
});

export type WebSearchSource = z.infer<typeof WebSearchSource>;

export const WebSearchEntry = z.object({
  query: z.string().max(WEB_SEARCH_STORED_QUERY_MAX_CHARS),
  status: z.enum(WEB_SEARCH_ENTRY_STATUSES),
  sources: z.array(WebSearchSource).optional(),
});

export type WebSearchEntry = z.infer<typeof WebSearchEntry>;

export const WebSearchRow = z.object({
  v: z.literal(1),
  searches: z.array(WebSearchEntry),
  /** Calls the model made that never ran: refused by the dispatch cap, or rejected input. */
  notRun: z.object({
    limit: z.number().int().nonnegative(),
    invalidQuery: z.number().int().nonnegative(),
  }),
});

export type WebSearchRow = z.infer<typeof WebSearchRow>;

/** A query cut to the stored limit without splitting a surrogate pair. */
export function storedSearchQuery(query: string): string {
  if (query.length <= WEB_SEARCH_STORED_QUERY_MAX_CHARS) return query;
  let cut = '';
  for (const codePoint of query) {
    if (cut.length + codePoint.length > WEB_SEARCH_STORED_QUERY_MAX_CHARS) break;
    cut += codePoint;
  }
  return cut;
}

export interface RowPageCounts {
  /** Distinct pages in this row that no earlier row in the message found. */
  readonly firstFound: number;
  /** Distinct pages in this row that an earlier row in the message already found. */
  readonly foundEarlier: number;
}

/**
 * Per-message page counts, one per row, over rows given in document order
 * (pre-order across every depth). A page is its URL, counted once per message.
 */
export function rowPageCounts(rows: readonly WebSearchRow[]): readonly RowPageCounts[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const urls = new Set(row.searches.flatMap((entry) => (entry.sources ?? []).map((s) => s.url)));
    let foundEarlier = 0;
    for (const url of urls) {
      if (seen.has(url)) foundEarlier += 1;
    }
    for (const url of urls) seen.add(url);
    return { firstFound: urls.size - foundEarlier, foundEarlier };
  });
}
