import { joinWithAnd } from '@/lib/utils/join-with-and';
import type { RowPages } from '@/components/chat/segments/web-search-sources';
import type { WebSearchEntry, WebSearchRow } from '@hushbox/shared';

/**
 * The words a search row and its parent's one-liner say. Every count is
 * derived from the row and the message's page counts; no billing wording
 * appears in any of them.
 */

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

interface StatusCounts {
  readonly searching: number;
  readonly done: number;
  readonly failed: number;
  readonly interrupted: number;
  /** Sources returned across the done searches, repeats included. */
  readonly returned: number;
}

function statusCounts(rows: readonly WebSearchRow[]): StatusCounts {
  const counts = { searching: 0, done: 0, failed: 0, interrupted: 0, returned: 0 };
  for (const entry of rows.flatMap((row) => row.searches)) {
    counts[entry.status] += 1;
    counts.returned += entry.sources?.length ?? 0;
  }
  return counts;
}

function notRunTotal(rows: readonly WebSearchRow[]): number {
  return rows.reduce((sum, row) => sum + row.notRun.limit + row.notRun.invalidQuery, 0);
}

function progress(row: WebSearchRow): string | undefined {
  const total = row.searches.length;
  if (total < 2) return undefined;
  const settled = row.searches.filter((entry) => entry.status !== 'searching').length;
  return `${String(settled)} of ${String(total)} done`;
}

function isLive(row: WebSearchRow): boolean {
  return row.searches.some((entry) => entry.status === 'searching');
}

export interface SearchRowLabel {
  readonly live: boolean;
  /** Shown joined by " · " and spoken joined by ", ". */
  readonly parts: readonly string[];
}

/** The row's own one-liner. */
export function searchRowLabel(row: WebSearchRow, pages: RowPages): SearchRowLabel {
  if (isLive(row)) {
    const detail = progress(row);
    return { live: true, parts: ['Searching the web', ...(detail === undefined ? [] : [detail])] };
  }
  return settledRowLabel(row, pages);
}

function settledRowLabel(row: WebSearchRow, pages: RowPages): SearchRowLabel {
  const counts = statusCounts([row]);
  const failed = counts.failed > 0 ? [`${String(counts.failed)} failed`] : [];
  const stopped = counts.interrupted > 0 ? [`${String(counts.interrupted)} stopped`] : [];
  if (pages.firstFound > 0) {
    return {
      live: false,
      parts: [
        'Searched the web',
        plural(pages.firstFound, 'source', 'sources'),
        ...failed,
        ...stopped,
      ],
    };
  }
  if (counts.done > 0) {
    const found = counts.returned > 0 ? 'no new sources' : 'no results';
    return { live: false, parts: ['Searched the web', found, ...failed, ...stopped] };
  }
  if (counts.failed > 0) return { live: false, parts: ['Web search failed', ...stopped] };
  if (counts.interrupted > 0) return { live: false, parts: ['Search stopped'] };
  return { live: false, parts: ['Web search skipped'] };
}

/** What a live block's status says when searches start: each by its query, in one sentence. */
export function searchStartAnnouncement(queries: readonly string[]): string {
  return `Searching the web for ${joinWithAnd(queries)}`;
}

/**
 * What a live block's status says when a row settles: the row's own label,
 * read with commas, its failed and stopped counts spelled out as searches.
 */
export function searchSettleAnnouncement(row: WebSearchRow, pages: RowPages): string {
  const counts = statusCounts([row]);
  const spelled = new Map([
    [`${String(counts.failed)} failed`, `${plural(counts.failed, 'search', 'searches')} failed`],
    [
      `${String(counts.interrupted)} stopped`,
      `${plural(counts.interrupted, 'search', 'searches')} stopped`,
    ],
  ]);
  return settledRowLabel(row, pages)
    .parts.map((part) => spelled.get(part) ?? part)
    .join(', ');
}

export interface RowWithPages {
  readonly row: WebSearchRow;
  readonly pages: RowPages;
}

/** The compact fragment a container's one-liner appends for the search rows it holds. */
export function searchFragment(rows: readonly RowWithPages[]): readonly string[] {
  if (rows.length === 0) return [];
  const values = rows.map((entry) => entry.row);
  const counts = statusCounts(values);
  const firstFound = rows.reduce((sum, entry) => sum + entry.pages.firstFound, 0);
  const failed = counts.failed > 0 ? [`${String(counts.failed)} failed`] : [];
  const stopped = counts.interrupted > 0 ? [`${String(counts.interrupted)} stopped`] : [];
  if (firstFound > 0) {
    return [`Searched ${plural(firstFound, 'source', 'sources')}`, ...failed, ...stopped];
  }
  if (counts.done > 0) {
    const found = counts.returned > 0 ? 'Searched, no new sources' : 'Searched, no results';
    return [found, ...failed, ...stopped];
  }
  if (counts.failed > 0) return ['Search failed', ...stopped];
  if (counts.interrupted > 0) return ['Search stopped'];
  if (notRunTotal(values) > 0) return ['Search skipped'];
  return [];
}

/** What a live container says the model is doing while this row searches, if it is. */
export function searchLiveActivity(row: WebSearchRow): string | undefined {
  if (!isLive(row)) return undefined;
  const detail = progress(row);
  return detail === undefined ? 'searching the web' : `searching the web · ${detail}`;
}

/** One search's status beside its query. */
export function searchQueryStatus(entry: WebSearchEntry): string {
  switch (entry.status) {
    case 'searching': {
      return 'Searching';
    }
    case 'failed': {
      return 'Failed';
    }
    case 'interrupted': {
      return 'Stopped';
    }
    case 'done': {
      const count = entry.sources?.length ?? 0;
      return count === 0 ? 'No results' : plural(count, 'result', 'results');
    }
  }
}

/** One plain sentence per condition a reader of the open row should know about. */
export function searchFootnotes(row: WebSearchRow): readonly string[] {
  const counts = statusCounts([row]);
  const notes: string[] = [];
  if (counts.failed > 0) {
    notes.push(
      `${plural(counts.failed, 'search', 'searches')} failed: the search service returned an error or did not respond. Regenerate to try again.`
    );
  }
  if (counts.interrupted > 0) {
    notes.push(
      `${plural(counts.interrupted, 'search was', 'searches were')} stopped before results came back.`
    );
  }
  if (row.notRun.limit > 0) {
    notes.push(
      `${plural(row.notRun.limit, 'more search was', 'more searches were')} skipped because this answer reached its search limit.`
    );
  }
  if (row.notRun.invalidQuery > 0) {
    notes.push(
      row.notRun.invalidQuery === 1
        ? "1 search was skipped because the model's query was empty or too long."
        : `${String(row.notRun.invalidQuery)} searches were skipped because the model's queries were empty or too long.`
    );
  }
  return notes;
}
