import { describe, expect, it } from 'vitest';
import { TOOL_CALL_CAP_MAX } from '../affordability/tool-loop.ts';
import {
  WEB_SEARCH_ROW_MAX_CHARS,
  WEB_SEARCH_STORED_QUERY_MAX_CHARS,
  WebSearchRow,
  rowPageCounts,
  storedSearchQuery,
} from './web-search-row.ts';

const row = (...sourceLists: (readonly string[])[]): WebSearchRow => ({
  v: 1,
  searches: sourceLists.map((urls, index) => ({
    query: `q${String(index)}`,
    status: 'done',
    sources: urls.map((url) => ({ title: url, url })),
  })),
  notRun: { limit: 0, invalidQuery: 0 },
});

describe('WebSearchRow', () => {
  it('parses a row with sources, every status and not-run counts', () => {
    const value = {
      v: 1,
      searches: [
        { query: 'a', status: 'done', sources: [{ title: 'T', url: 'https://a.example/' }] },
        { query: 'b', status: 'searching' },
        { query: 'c', status: 'failed' },
        { query: 'd', status: 'interrupted' },
      ],
      notRun: { limit: 1, invalidQuery: 2 },
    };
    expect(WebSearchRow.parse(value)).toEqual(value);
  });

  it('rejects a source whose url is not http(s)', () => {
    const value = {
      v: 1,
      searches: [
        { query: 'a', status: 'done', sources: [{ title: 'T', url: 'javascript:alert(1)' }] },
      ],
      notRun: { limit: 0, invalidQuery: 0 },
    };
    expect(WebSearchRow.safeParse(value).success).toBe(false);
  });

  it('rejects a stored query over the stored-query limit', () => {
    const value = {
      v: 1,
      searches: [{ query: 'a'.repeat(WEB_SEARCH_STORED_QUERY_MAX_CHARS + 1), status: 'done' }],
      notRun: { limit: 0, invalidQuery: 0 },
    };
    expect(WebSearchRow.safeParse(value).success).toBe(false);
  });

  it('rejects an unknown version', () => {
    const value = { v: 2, searches: [], notRun: { limit: 0, invalidQuery: 0 } };
    expect(WebSearchRow.safeParse(value).success).toBe(false);
  });

  it('carries no stored page counts', () => {
    expect(
      Object.keys(WebSearchRow.shape.searches.element.shape).toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['query', 'sources', 'status']);
  });
});

describe('storedSearchQuery', () => {
  it('keeps a short query unchanged', () => {
    expect(storedSearchQuery('weather')).toBe('weather');
  });

  it('cuts a long query to the stored-query limit', () => {
    expect(storedSearchQuery('a'.repeat(500))).toBe('a'.repeat(WEB_SEARCH_STORED_QUERY_MAX_CHARS));
  });

  it('never splits a surrogate pair at the cut', () => {
    const query = `${'a'.repeat(WEB_SEARCH_STORED_QUERY_MAX_CHARS - 1)}😀`;
    expect(storedSearchQuery(query)).toBe('a'.repeat(WEB_SEARCH_STORED_QUERY_MAX_CHARS - 1));
  });
});

describe('WEB_SEARCH_ROW_MAX_CHARS', () => {
  it('holds the tool-call cap of maximally escaped queries with every source dropped', () => {
    // With every source dropped, each stored query can still grow sixfold under
    // JSON escaping.
    const control = String.fromCodePoint(1);
    const fullRow: WebSearchRow = {
      v: 1,
      searches: Array.from({ length: TOOL_CALL_CAP_MAX }, () => ({
        query: control.repeat(WEB_SEARCH_STORED_QUERY_MAX_CHARS),
        status: 'interrupted' as const,
      })),
      notRun: { limit: 9_999_999, invalidQuery: 9_999_999 },
    };
    expect(JSON.stringify(fullRow).length).toBeLessThanOrEqual(WEB_SEARCH_ROW_MAX_CHARS);
  });
});

describe('rowPageCounts', () => {
  it('counts every page of the first row as first found', () => {
    expect(rowPageCounts([row(['https://a/', 'https://b/'])])).toEqual([
      { firstFound: 2, foundEarlier: 0 },
    ]);
  });

  it('reports the pages a later row shares with an earlier row', () => {
    expect(
      rowPageCounts([row(['https://a/', 'https://b/']), row(['https://b/', 'https://c/'])])
    ).toEqual([
      { firstFound: 2, foundEarlier: 0 },
      { firstFound: 1, foundEarlier: 1 },
    ]);
  });

  it('counts a page found twice within one row once', () => {
    expect(rowPageCounts([row(['https://a/'], ['https://a/', 'https://b/'])])).toEqual([
      { firstFound: 2, foundEarlier: 0 },
    ]);
  });

  it('counts a row whose every page was found earlier as zero first found', () => {
    expect(rowPageCounts([row(['https://a/']), row(['https://a/'])])).toEqual([
      { firstFound: 1, foundEarlier: 0 },
      { firstFound: 0, foundEarlier: 1 },
    ]);
  });

  it('counts a row with no sources as zero', () => {
    const empty: WebSearchRow = {
      v: 1,
      searches: [{ query: 'q', status: 'failed' }],
      notRun: { limit: 0, invalidQuery: 0 },
    };
    expect(rowPageCounts([empty])).toEqual([{ firstFound: 0, foundEarlier: 0 }]);
  });
});
