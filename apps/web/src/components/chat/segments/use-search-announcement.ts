import * as React from 'react';
import {
  searchSettleAnnouncement,
  searchStartAnnouncement,
} from '@/components/chat/segments/web-search-labels';
import type { RowPages } from '@/components/chat/segments/web-search-sources';
import type { WebSearchEntry, WebSearchRow } from '@hushbox/shared';

/** The search row a live block speaks for, identified by its node key. */
export interface AnnouncedRow {
  readonly key: string;
  readonly row: WebSearchRow;
  readonly pages: RowPages;
}

interface Spoken {
  readonly key: string;
  /** How many of the row's searches the last start announcement covered. */
  readonly count: number;
  readonly text: string;
}

function isSearching(entry: WebSearchEntry): boolean {
  return entry.status === 'searching';
}

/** What a row says now, given what it last said (`known`, when it has spoken before). */
function milestoneOf(row: WebSearchRow, pages: RowPages, known: Spoken | undefined): string {
  if (!row.searches.some((entry) => isSearching(entry)))
    return searchSettleAnnouncement(row, pages);
  if (row.searches.length === known?.count) return known.text;
  // A row first seen mid-flight names the searches running now, not the ones
  // that already finished before this block was drawn.
  const fresh =
    known === undefined
      ? row.searches.filter((entry) => isSearching(entry))
      : row.searches.slice(known.count);
  return searchStartAnnouncement(fresh.map((entry) => entry.query));
}

/**
 * The milestone a live block's hidden status says for one search row: the
 * searches that started since it last spoke, by query and in one sentence when
 * they start together, then what the row found once it settles. A search
 * finishing inside a row that is still live says nothing, so no announcement
 * is ever made per result.
 *
 * A row first seen while its message streams is news, even when its searches
 * started and finished before it was drawn: it says what it found. A row
 * first seen in a message that is not streaming is history and says nothing
 * (''). No row at all is `undefined`, for the caller's own words.
 */
export function useSearchAnnouncement(
  target: AnnouncedRow | undefined,
  streaming: boolean
): string | undefined {
  const [spoken, setSpoken] = React.useState<Spoken | undefined>();
  if (target === undefined) return undefined;
  const { key, row, pages } = target;
  // A restarted run can reuse the key with fewer searches; that is a new row.
  const known = spoken?.key === key && spoken.count <= row.searches.length ? spoken : undefined;
  if (known === undefined && !streaming) return '';
  const text = milestoneOf(row, pages, known);
  if (row.searches.length !== known?.count) setSpoken({ key, count: row.searches.length, text });
  return text;
}
