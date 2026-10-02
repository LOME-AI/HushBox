import { describe, expect, it } from 'vitest';
import {
  searchFootnotes,
  searchFragment,
  searchLiveActivity,
  searchQueryStatus,
  searchRowLabel,
  searchSettleAnnouncement,
  searchStartAnnouncement,
} from '@/components/chat/segments/web-search-labels';
import { messageRowPages } from '@/components/chat/segments/web-search-sources';
import type { RowPages } from '@/components/chat/segments/web-search-sources';
import type { WebSearchEntry, WebSearchRow } from '@hushbox/shared';

const A = { title: 'A', url: 'https://a.example/' };
const B = { title: 'B', url: 'https://b.example/' };
const C = { title: 'C', url: 'https://c.example/' };

const NOTHING_SKIPPED = { limit: 0, invalidQuery: 0 };

function row(searches: WebSearchEntry[], notRun = NOTHING_SKIPPED): WebSearchRow {
  return { v: 1, searches, notRun };
}

function pagesOf(value: WebSearchRow, earlier: WebSearchRow[] = []): RowPages {
  const pages = messageRowPages([...earlier, value]).at(-1);
  if (pages === undefined) throw new Error('one row in, one row out');
  return pages;
}

function label(value: WebSearchRow, earlier: WebSearchRow[] = []): string {
  return searchRowLabel(value, pagesOf(value, earlier)).parts.join(' · ');
}

describe('searchRowLabel', () => {
  it('says it is searching while a search runs', () => {
    const value = row([{ query: 'q', status: 'searching' }]);
    expect(searchRowLabel(value, pagesOf(value))).toEqual({
      live: true,
      parts: ['Searching the web'],
    });
  });

  it('counts finished searches out of all of them when several run', () => {
    expect(
      label(
        row([
          { query: 'a', status: 'done', sources: [A] },
          { query: 'b', status: 'searching' },
        ])
      )
    ).toBe('Searching the web · 1 of 2 done');
  });

  it('names the new sources the row found once every search settled', () => {
    const value = row([{ query: 'a', status: 'done', sources: [A, B] }]);
    expect(searchRowLabel(value, pagesOf(value))).toEqual({
      live: false,
      parts: ['Searched the web', '2 sources'],
    });
  });

  it('speaks of one source in the singular', () => {
    expect(label(row([{ query: 'a', status: 'done', sources: [A] }]))).toBe(
      'Searched the web · 1 source'
    );
  });

  it('adds the failed and stopped searches beside the sources found', () => {
    expect(
      label(
        row([
          { query: 'a', status: 'done', sources: [A] },
          { query: 'b', status: 'failed' },
          { query: 'c', status: 'interrupted' },
        ])
      )
    ).toBe('Searched the web · 1 source · 1 failed · 1 stopped');
  });

  it('says no results when the searches came back empty', () => {
    expect(label(row([{ query: 'a', status: 'done', sources: [] }]))).toBe(
      'Searched the web · no results'
    );
  });

  it('says no new sources when every page was found by an earlier search', () => {
    const earlier = row([{ query: 'x', status: 'done', sources: [A] }]);
    expect(label(row([{ query: 'a', status: 'done', sources: [A] }]), [earlier])).toBe(
      'Searched the web · no new sources'
    );
  });

  it('says the search failed when nothing else ran', () => {
    expect(label(row([{ query: 'a', status: 'failed' }]))).toBe('Web search failed');
  });

  it('keeps a stop beside a failure when nothing was found', () => {
    expect(
      label(
        row([
          { query: 'a', status: 'failed' },
          { query: 'b', status: 'interrupted' },
        ])
      )
    ).toBe('Web search failed · 1 stopped');
  });

  it('says the search was stopped when that is all that happened', () => {
    expect(label(row([{ query: 'a', status: 'interrupted' }]))).toBe('Search stopped');
  });

  it('says the search was skipped when nothing ran', () => {
    expect(label(row([], { limit: 0, invalidQuery: 1 }))).toBe('Web search skipped');
  });
});

describe('searchFragment', () => {
  function fragment(...values: WebSearchRow[]): readonly string[] {
    const pages = messageRowPages(values);
    return searchFragment(
      values.map((value, index) => {
        const rowPages = pages[index];
        if (rowPages === undefined) throw new Error('one pages entry per row');
        return { row: value, pages: rowPages };
      })
    );
  }

  it('totals the distinct new pages across every row it covers', () => {
    expect(
      fragment(
        row([{ query: 'a', status: 'done', sources: [A, B] }]),
        row([{ query: 'b', status: 'done', sources: [B, C] }])
      )
    ).toEqual(['Searched 3 sources']);
  });

  it('adds a failure count beside the sources found', () => {
    expect(
      fragment(
        row([
          { query: 'a', status: 'done', sources: [A] },
          { query: 'b', status: 'failed' },
        ])
      )
    ).toEqual(['Searched 1 source', '1 failed']);
  });

  it('says no results when every search came back empty', () => {
    expect(fragment(row([{ query: 'a', status: 'done', sources: [] }]))).toEqual([
      'Searched, no results',
    ]);
  });

  it('says no new sources when an earlier row in the message found every page', () => {
    const later = row([{ query: 'a', status: 'done', sources: [A] }]);
    const pages = pagesOf(later, [row([{ query: 'x', status: 'done', sources: [A] }])]);
    expect(searchFragment([{ row: later, pages }])).toEqual(['Searched, no new sources']);
  });

  it('says the search failed, stopped or was skipped when nothing was found', () => {
    expect(fragment(row([{ query: 'a', status: 'failed' }]))).toEqual(['Search failed']);
    expect(fragment(row([{ query: 'a', status: 'interrupted' }]))).toEqual(['Search stopped']);
    expect(fragment(row([], { limit: 1, invalidQuery: 0 }))).toEqual(['Search skipped']);
  });

  it('contributes nothing for no rows', () => {
    expect(searchFragment([])).toEqual([]);
  });
});

describe('searchLiveActivity', () => {
  it('names searching while one search runs', () => {
    expect(searchLiveActivity(row([{ query: 'a', status: 'searching' }]))).toBe(
      'searching the web'
    );
  });

  it('carries the progress of several searches', () => {
    expect(
      searchLiveActivity(
        row([
          { query: 'a', status: 'done', sources: [] },
          { query: 'b', status: 'searching' },
        ])
      )
    ).toBe('searching the web · 1 of 2 done');
  });

  it('names nothing once every search settled', () => {
    expect(searchLiveActivity(row([{ query: 'a', status: 'done', sources: [] }]))).toBeUndefined();
  });
});

describe('searchQueryStatus', () => {
  it.each([
    [{ query: 'q', status: 'searching' } satisfies WebSearchEntry, 'Searching'],
    [{ query: 'q', status: 'failed' } satisfies WebSearchEntry, 'Failed'],
    [{ query: 'q', status: 'interrupted' } satisfies WebSearchEntry, 'Stopped'],
    [{ query: 'q', status: 'done', sources: [] } satisfies WebSearchEntry, 'No results'],
    [{ query: 'q', status: 'done' } satisfies WebSearchEntry, 'No results'],
    [{ query: 'q', status: 'done', sources: [A] } satisfies WebSearchEntry, '1 result'],
    [{ query: 'q', status: 'done', sources: [A, B] } satisfies WebSearchEntry, '2 results'],
  ])('reads %o as %s', (entry, expected) => {
    expect(searchQueryStatus(entry)).toBe(expected);
  });
});

describe('searchFootnotes', () => {
  it('writes one plain sentence per condition, in a fixed order', () => {
    expect(
      searchFootnotes(
        row(
          [
            { query: 'a', status: 'failed' },
            { query: 'b', status: 'interrupted' },
          ],
          { limit: 2, invalidQuery: 1 }
        )
      )
    ).toEqual([
      '1 search failed: the search service returned an error or did not respond. Regenerate to try again.',
      '1 search was stopped before results came back.',
      '2 more searches were skipped because this answer reached its search limit.',
      "1 search was skipped because the model's query was empty or too long.",
    ]);
  });

  it('speaks in the plural for several of a kind', () => {
    expect(
      searchFootnotes(
        row(
          [
            { query: 'a', status: 'failed' },
            { query: 'b', status: 'failed' },
            { query: 'c', status: 'interrupted' },
            { query: 'd', status: 'interrupted' },
          ],
          { limit: 1, invalidQuery: 2 }
        )
      )
    ).toEqual([
      '2 searches failed: the search service returned an error or did not respond. Regenerate to try again.',
      '2 searches were stopped before results came back.',
      '1 more search was skipped because this answer reached its search limit.',
      "2 searches were skipped because the model's queries were empty or too long.",
    ]);
  });

  it('writes nothing for a row where every search succeeded', () => {
    expect(searchFootnotes(row([{ query: 'a', status: 'done', sources: [A] }]))).toEqual([]);
  });
});

describe('searchStartAnnouncement', () => {
  it('names the one search that started by its query', () => {
    expect(searchStartAnnouncement(['postgres 18'])).toBe('Searching the web for postgres 18');
  });

  it('names two searches that started together in one sentence', () => {
    expect(searchStartAnnouncement(['a', 'b'])).toBe('Searching the web for a and b');
  });

  it('lists three or more searches with a final "and"', () => {
    expect(searchStartAnnouncement(['a', 'b', 'c'])).toBe('Searching the web for a, b and c');
  });
});

describe('searchSettleAnnouncement', () => {
  it('says how many sources a settled row found', () => {
    const value = row([{ query: 'q', status: 'done', sources: [A, B, C] }]);
    expect(searchSettleAnnouncement(value, pagesOf(value))).toBe('Searched the web, 3 sources');
  });

  it('spells out a failed search beside what the others found', () => {
    const value = row([
      { query: 'q', status: 'done', sources: [A, B] },
      { query: 'r', status: 'failed' },
    ]);
    expect(searchSettleAnnouncement(value, pagesOf(value))).toBe(
      'Searched the web, 2 sources, 1 search failed'
    );
  });

  it('spells out stopped searches in the plural', () => {
    const value = row([
      { query: 'q', status: 'done', sources: [A] },
      { query: 'r', status: 'interrupted' },
      { query: 's', status: 'interrupted' },
    ]);
    expect(searchSettleAnnouncement(value, pagesOf(value))).toBe(
      'Searched the web, 1 source, 2 searches stopped'
    );
  });

  it('says a row whose every search failed failed', () => {
    const value = row([{ query: 'q', status: 'failed' }]);
    expect(searchSettleAnnouncement(value, pagesOf(value))).toBe('Web search failed');
  });
});
