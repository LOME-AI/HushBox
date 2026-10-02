import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSearchAnnouncement } from '@/components/chat/segments/use-search-announcement';
import { messageRowPages } from '@/components/chat/segments/web-search-sources';
import type { AnnouncedRow } from '@/components/chat/segments/use-search-announcement';
import type { WebSearchEntry } from '@hushbox/shared';

function target(searches: WebSearchEntry[]): AnnouncedRow {
  const row = { v: 1 as const, searches, notRun: { limit: 0, invalidQuery: 0 } };
  const [pages] = messageRowPages([row]);
  if (pages === undefined) throw new Error('one row in, one row out');
  return { key: 'webSearch:0', row, pages };
}

describe('useSearchAnnouncement', () => {
  it('leaves the words to the caller when there is no row', () => {
    const { result } = renderHook(() => useSearchAnnouncement(undefined, true));
    expect(result.current).toBeUndefined();
  });

  it('names the searches of a restarted run that reuses the key, as a new row', () => {
    const { result, rerender } = renderHook(
      ({ searches }: { searches: WebSearchEntry[] }) =>
        useSearchAnnouncement(target(searches), true),
      {
        initialProps: {
          searches: [
            { query: 'a', status: 'searching' },
            { query: 'b', status: 'searching' },
          ] satisfies WebSearchEntry[],
        },
      }
    );
    rerender({ searches: [{ query: 'c', status: 'searching' }] });
    expect(result.current).toBe('Searching the web for c');
  });
});

describe('useSearchAnnouncement in a message that is not streaming', () => {
  it('says nothing for a row read from history', () => {
    const settled = target([{ query: 'q', status: 'done', sources: [] }]);
    const { result } = renderHook(() => useSearchAnnouncement(settled, false));
    expect(result.current).toBe('');
  });
});
