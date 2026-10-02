/** One keyset page: the rows to return, and the cursor a next page rides on. */
export interface KeysetPage<T> {
  readonly rows: readonly T[];
  readonly nextCursor: string | null;
}

/**
 * Turns a peeked keyset read into a page. The caller queries `limit + 1` rows;
 * the extra row is the only evidence that another page exists, so it is the
 * peek that decides the cursor and never `rows.length === limit` — a page that
 * happens to be exactly full is the last page as often as not, and cursoring on
 * it costs the client a request that returns nothing.
 *
 * Rows must be ordered by the same key the cursor rides (a uuidv7 id, so id
 * order is creation order).
 */
export function buildKeysetPage<T extends { readonly id: string }>(
  rows: readonly T[],
  limit: number
): KeysetPage<T> {
  if (rows.length <= limit) {
    return { rows, nextCursor: null };
  }
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { rows: page, nextCursor: last === undefined ? null : last.id };
}
