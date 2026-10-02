import { describe, expect, it } from 'vitest';
import { rowPageCounts } from '@hushbox/shared';
import {
  messageRowPages,
  monogramOf,
  sourceHost,
  topDomains,
} from '@/components/chat/segments/web-search-sources';
import type { WebSearchRow } from '@hushbox/shared';

const PG_NEWS = { title: 'PostgreSQL 18 Released!', url: 'https://www.postgresql.org/about/news/' };
const PG_NOTES = { title: 'Release 18', url: 'https://www.postgresql.org/docs/18/release-18.html' };
const LWN = { title: 'PostgreSQL 18 released', url: 'https://lwn.net/Articles/1039270/' };
const EDB = { title: 'Benchmarking async I/O', url: 'https://www.enterprisedb.com/blog/aio' };

function row(...searches: WebSearchRow['searches']): WebSearchRow {
  return { v: 1, searches, notRun: { limit: 0, invalidQuery: 0 } };
}

describe('sourceHost', () => {
  it('derives the domain from the URL, dropping a leading www', () => {
    expect(sourceHost('https://www.postgresql.org/docs/')).toBe('postgresql.org');
  });

  it('keeps a host with no www prefix as it is', () => {
    expect(sourceHost('http://lwn.net/Articles/1/')).toBe('lwn.net');
  });
});

describe('monogramOf', () => {
  it('takes the first letter of the domain, upper-cased', () => {
    expect(monogramOf('postgresql.org')).toBe('P');
  });

  it.each([
    ['a punycode host', 'xn--80aswg.xn--p1ai'],
    ['an IPv4 host', '192.0.2.10'],
    ['an IPv6 host', '[2001:db8::1]'],
    ['a host starting with a symbol', '_dmarc.example.com'],
  ])('gives no letter for %s, so a globe stands in', (_label, host) => {
    expect(monogramOf(host)).toBeUndefined();
  });
});

describe('messageRowPages', () => {
  it('lists each page under the first search in the message that found it', () => {
    const [pages] = messageRowPages([
      row(
        { query: 'a', status: 'done', sources: [PG_NEWS, LWN] },
        { query: 'b', status: 'done', sources: [LWN, EDB] }
      ),
    ]);
    expect(pages?.entries.map((entry) => entry.firstFound.map((s) => s.url))).toEqual([
      [PG_NEWS.url, LWN.url],
      [EDB.url],
    ]);
  });

  it('counts a page an earlier search in the same row found as found earlier', () => {
    const [pages] = messageRowPages([
      row(
        { query: 'a', status: 'done', sources: [PG_NEWS] },
        { query: 'b', status: 'done', sources: [PG_NEWS, EDB] }
      ),
    ]);
    expect(pages?.entries.map((entry) => entry.foundEarlier)).toEqual([0, 1]);
  });

  it('counts a page an earlier row found as found earlier, across the message', () => {
    const pages = messageRowPages([
      row({ query: 'a', status: 'done', sources: [PG_NEWS, PG_NOTES] }),
      row({ query: 'b', status: 'done', sources: [PG_NOTES, LWN] }),
    ]);
    expect(pages[1]?.firstFound).toBe(1);
    expect(pages[1]?.entries[0]?.foundEarlier).toBe(1);
    expect(pages[1]?.entries[0]?.firstFound.map((s) => s.url)).toEqual([LWN.url]);
  });

  it('agrees with the shared per-message count for every row', () => {
    const rows = [
      row(
        { query: 'a', status: 'done', sources: [PG_NEWS, LWN] },
        { query: 'b', status: 'done', sources: [LWN, EDB, LWN] }
      ),
      row({ query: 'c', status: 'done', sources: [PG_NEWS, PG_NOTES] }),
      row({ query: 'd', status: 'failed' }),
    ];
    const pages = messageRowPages(rows);
    const shared = rowPageCounts(rows);
    expect(pages.map((p) => p.firstFound)).toEqual(shared.map((c) => c.firstFound));
    expect(pages.map((p) => p.entries.reduce((sum, e) => sum + e.firstFound.length, 0))).toEqual(
      shared.map((c) => c.firstFound)
    );
  });

  it('carries each first-found page with its derived domain', () => {
    const [pages] = messageRowPages([row({ query: 'a', status: 'done', sources: [PG_NEWS] })]);
    expect(pages?.entries[0]?.firstFound[0]).toEqual({ ...PG_NEWS, host: 'postgresql.org' });
  });

  it('gives an entry with no sources an empty list', () => {
    const [pages] = messageRowPages([row({ query: 'a', status: 'searching' })]);
    expect(pages?.entries[0]).toEqual({
      entry: { query: 'a', status: 'searching' },
      firstFound: [],
      foundEarlier: 0,
    });
  });
});

describe('topDomains', () => {
  it('orders domains by how many first-found pages each gave, ties by first appearance', () => {
    const [pages] = messageRowPages([
      row({ query: 'a', status: 'done', sources: [LWN, PG_NEWS, EDB, PG_NOTES] }),
    ]);
    if (pages === undefined) throw new Error('one row in, one row out');
    expect(topDomains(pages)).toEqual({ top: ['postgresql.org', 'lwn.net'], more: 1 });
  });

  it('names no domain for a row that found no new page', () => {
    const [pages] = messageRowPages([row({ query: 'a', status: 'done', sources: [] })]);
    if (pages === undefined) throw new Error('one row in, one row out');
    expect(topDomains(pages)).toEqual({ top: [], more: 0 });
  });
});
