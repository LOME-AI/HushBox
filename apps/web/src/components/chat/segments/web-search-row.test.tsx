import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { buildRenderContext } from '@/components/chat/segments/render-context';
import { SegmentList } from '@/components/chat/segments/segment-list';
import { useSegmentViewState } from '@/components/chat/segments/segment-view-state';
import type { MessageRenderFacts } from '@/components/chat/segments/render-context';
import type { Segment, WebSearchEntry, WebSearchRow } from '@hushbox/shared';

const FACTS: MessageRenderFacts = {
  messageId: 'm-1',
  isStreaming: false,
  modelName: 'Sonnet 4.5',
  reasoningTokens: undefined,
  reasoningEffort: undefined,
};

const PG_NEWS = { title: 'PostgreSQL 18 Released!', url: 'https://www.postgresql.org/about/news/' };
const PG_NOTES = { title: 'Release 18', url: 'https://www.postgresql.org/docs/18/release-18.html' };
const LWN = { title: 'PostgreSQL 18 released', url: 'https://lwn.net/Articles/1039270/' };
const EDB = { title: 'Benchmarking async I/O', url: 'https://www.enterprisedb.com/blog/aio' };

const NOTHING_SKIPPED = { limit: 0, invalidQuery: 0 };

function row(searches: WebSearchEntry[], notRun = NOTHING_SKIPPED): Segment {
  const value: WebSearchRow = { v: 1, searches, notRun };
  return { kind: 'webSearch', row: value };
}

function draw(
  tree: readonly Segment[],
  facts: Partial<MessageRenderFacts> = {}
): ReturnType<typeof render> {
  const context = buildRenderContext(tree, { ...FACTS, ...facts });
  return render(<SegmentList nodes={tree} context={context} parent="root" />);
}

function redraw(
  view: ReturnType<typeof render>,
  tree: readonly Segment[],
  facts: Partial<MessageRenderFacts> = {}
): void {
  const context = buildRenderContext(tree, { ...FACTS, ...facts });
  view.rerender(<SegmentList nodes={tree} context={context} parent="root" />);
}

beforeEach(() => {
  useSegmentViewState.setState({ open: new Set() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WebSearchRow while searching', () => {
  const LIVE = [row([{ query: 'postgresql 18 release notes', status: 'searching' }])];

  it('says it is searching, with dots, and offers nothing to open', () => {
    const { container } = draw(LIVE, { isStreaming: true });
    const found = screen.getByTestId(TEST_IDS.webSearchRow);
    expect(found).toHaveTextContent('Searching the web');
    expect(within(found).queryByRole('button')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.animate-dot-pulse')).toHaveLength(3);
  });

  it('sets its dots inside the label, so a wrapped label carries them after its last word', () => {
    draw(LIVE, { isStreaming: true });
    const words = within(screen.getByTestId(TEST_IDS.webSearchRow)).getByText('Searching the web');
    expect(words.querySelectorAll('.animate-dot-pulse')).toHaveLength(3);
  });

  it('lists each running query with its status, hidden from assistive tech', () => {
    draw(LIVE, { isStreaming: true });
    const lines = screen.getByTestId(TEST_IDS.webSearchRowQueries);
    expect(lines).toHaveTextContent('postgresql 18 release notes·Searching');
    expect(lines).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps at most three query lines in view, anchored to the newest', () => {
    draw(LIVE, { isStreaming: true });
    const lines = screen.getByTestId(TEST_IDS.webSearchRowQueries);
    expect(lines.className).toContain('max-h-[4.5rem]');
    expect(lines.className).toContain('justify-end');
    expect(lines.className).toContain('overflow-hidden');
  });

  it('fades the oldest line once a fourth query runs', () => {
    const searches: WebSearchEntry[] = ['a', 'b', 'c', 'd'].map((query) => ({
      query,
      status: 'searching',
    }));
    draw([row(searches)], { isStreaming: true });
    expect(screen.getByTestId(TEST_IDS.webSearchRowQueries).style.maskImage).toContain(
      'linear-gradient'
    );
  });

  it('draws no fade while three or fewer queries run', () => {
    draw(LIVE, { isStreaming: true });
    expect(screen.getByTestId(TEST_IDS.webSearchRowQueries)).not.toHaveAttribute('style');
  });

  it('raises a query line in when its search starts, and never a line it was drawn with', () => {
    const view = draw([row([{ query: 'a', status: 'searching' }])], { isStreaming: true });
    redraw(
      view,
      [
        row([
          { query: 'a', status: 'searching' },
          { query: 'b', status: 'searching' },
        ]),
      ],
      { isStreaming: true }
    );
    const [first, second] = screen.getByTestId(TEST_IDS.webSearchRowQueries).children;
    expect((first as HTMLElement).style.opacity).not.toBe('0');
    expect((second as HTMLElement).style.opacity).toBe('0');
  });

  it('counts finished searches out of all of them', () => {
    draw(
      [
        row([
          { query: 'a', status: 'done', sources: [PG_NEWS] },
          { query: 'b', status: 'searching' },
        ]),
      ],
      { isStreaming: true }
    );
    expect(screen.getByTestId(TEST_IDS.webSearchRow)).toHaveTextContent(
      'Searching the web · 1 of 2 done'
    );
  });

  it('announces the search it starts, with its query', () => {
    draw(LIVE, { isStreaming: true });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Searching the web for postgresql 18 release notes'
    );
  });

  it('announces parallel starts as one sentence', () => {
    draw(
      [
        row([
          { query: 'a', status: 'searching' },
          { query: 'b', status: 'searching' },
        ]),
      ],
      { isStreaming: true }
    );
    expect(screen.getByRole('status')).toHaveTextContent('Searching the web for a and b');
  });

  it('announces a search whose start and result land in one render', () => {
    draw([row([{ query: 'q', status: 'done', sources: [PG_NEWS, LWN] }])], { isStreaming: true });
    expect(screen.getByRole('status').textContent).toBe('Searched the web, 2 sources');
  });

  it('announces a search that joins the row by its own query', () => {
    const view = draw([row([{ query: 'a', status: 'searching' }])], { isStreaming: true });
    redraw(
      view,
      [
        row([
          { query: 'a', status: 'done', sources: [PG_NEWS] },
          { query: 'b', status: 'searching' },
        ]),
      ],
      { isStreaming: true }
    );
    expect(screen.getByRole('status').textContent).toBe('Searching the web for b');
  });

  it('spells out a failed search when the row settles', () => {
    const view = draw(
      [
        row([
          { query: 'a', status: 'searching' },
          { query: 'b', status: 'searching' },
        ]),
      ],
      { isStreaming: true }
    );
    redraw(
      view,
      [
        row([
          { query: 'a', status: 'done', sources: [PG_NEWS] },
          { query: 'b', status: 'failed' },
        ]),
      ],
      { isStreaming: true }
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Searched the web, 1 source, 1 search failed'
    );
  });

  it('announces once when its searches settle', () => {
    const view = draw(LIVE, { isStreaming: true });
    redraw(
      view,
      [row([{ query: 'postgresql 18 release notes', status: 'done', sources: [PG_NEWS, LWN] }])],
      { isStreaming: true }
    );
    expect(screen.getByRole('status')).toHaveTextContent('Searched the web, 2 sources');
  });
});

describe('WebSearchRow settled', () => {
  const SETTLED = [
    row([
      { query: 'postgresql 18 release notes', status: 'done', sources: [PG_NEWS, LWN, PG_NOTES] },
      { query: 'postgres 18 async io', status: 'done', sources: [EDB, PG_NEWS] },
    ]),
  ];

  it('rests as a closed disclosure naming the new sources and where they came from', () => {
    draw(SETTLED);
    const toggle = screen.getByTestId(TEST_IDS.webSearchRowToggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Searched the web · 4 sources');
    expect(toggle).toHaveTextContent('from postgresql.org, lwn.net +1 more');
  });

  it('names further sites in the plural when there are several', () => {
    draw([
      row([
        {
          query: 'q',
          status: 'done',
          sources: [
            PG_NEWS,
            LWN,
            EDB,
            { title: 'Crunchy', url: 'https://www.crunchydata.com/blog/pg18' },
          ],
        },
      ]),
    ]);
    expect(screen.getByTestId(TEST_IDS.webSearchRowToggle)).toHaveAccessibleName(
      'Searched the web, 4 sources, from postgresql.org, lwn.net and 2 more sites'
    );
  });

  it('spells its name with commas and the domain count in words', () => {
    draw(SETTLED);
    expect(screen.getByTestId(TEST_IDS.webSearchRowToggle)).toHaveAccessibleName(
      'Searched the web, 4 sources, from postgresql.org, lwn.net and 1 more site'
    );
  });

  it('names no domains for a row that found nothing', () => {
    draw([row([{ query: 'q', status: 'done', sources: [] }])]);
    const toggle = screen.getByTestId(TEST_IDS.webSearchRowToggle);
    expect(toggle).toHaveTextContent(/^Searched the web · no results$/);
    expect(toggle).toHaveAccessibleName('Searched the web, no results');
  });

  it('adds no live region when it is read from history', () => {
    draw(SETTLED);
    expect(screen.queryByRole('status', { hidden: true })).not.toBeInTheDocument();
  });

  it('wires aria-controls to a panel that resolves while collapsed', () => {
    draw(SETTLED);
    const controls = screen.getByTestId(TEST_IDS.webSearchRowToggle).getAttribute('aria-controls');
    expect(document.querySelector(`[id="${controls ?? ''}"]`)).toHaveAttribute('hidden');
  });

  it('opens to every query, its status and the pages it found first', () => {
    draw(SETTLED);
    fireEvent.click(screen.getByTestId(TEST_IDS.webSearchRowToggle));
    const panel = screen.getByTestId(TEST_IDS.webSearchRowPanel);
    expect(panel).toHaveTextContent('postgresql 18 release notes · 3 results');
    expect(panel).toHaveTextContent('postgres 18 async io · 2 results');
    expect(within(panel).getAllByTestId(TEST_IDS.webSearchSource)).toHaveLength(4);
    expect(panel).toHaveTextContent('+1 found by an earlier search');
  });

  it('shows each source as its title and derived domain, with no remote image', () => {
    draw(SETTLED);
    fireEvent.click(screen.getByTestId(TEST_IDS.webSearchRowToggle));
    const [first] = screen.getAllByTestId(TEST_IDS.webSearchSource);
    expect(first).toHaveTextContent('PostgreSQL 18 Released!');
    expect(first).toHaveTextContent('postgresql.org');
    expect(screen.getByTestId(TEST_IDS.webSearchRowPanel).querySelector('img')).toBeNull();
  });

  it('marks a source with the first letter of its domain', () => {
    draw(SETTLED);
    fireEvent.click(screen.getByTestId(TEST_IDS.webSearchRowToggle));
    const [first] = screen.getAllByTestId(TEST_IDS.webSearchSource);
    expect(first?.firstElementChild).toHaveTextContent('P');
  });

  it('leaves the mark empty for a second page in a row from the same site', () => {
    draw([row([{ query: 'q', status: 'done', sources: [PG_NEWS, PG_NOTES] }])]);
    fireEvent.click(screen.getByTestId(TEST_IDS.webSearchRowToggle));
    const [, second] = screen.getAllByTestId(TEST_IDS.webSearchSource);
    expect(second?.firstElementChild).toBeEmptyDOMElement();
  });

  it('draws a globe rather than a letter for a punycode host', () => {
    draw([
      row([
        {
          query: 'q',
          status: 'done',
          sources: [{ title: 'Report', url: 'https://xn--80aswg.xn--p1ai/r' }],
        },
      ]),
    ]);
    fireEvent.click(screen.getByTestId(TEST_IDS.webSearchRowToggle));
    const [source] = screen.getAllByTestId(TEST_IDS.webSearchSource);
    expect(source?.firstElementChild?.querySelector('svg')).not.toBeNull();
  });

  it('falls back to the domain for a page with no title', () => {
    draw([
      row([{ query: 'q', status: 'done', sources: [{ title: '', url: 'https://lwn.net/a' }] }]),
    ]);
    fireEvent.click(screen.getByTestId(TEST_IDS.webSearchRowToggle));
    const [source] = screen.getAllByTestId(TEST_IDS.webSearchSource);
    expect(source).toHaveAccessibleName('lwn.net lwn.net');
  });

  it('writes a footnote for each search that failed, stopped or never ran', () => {
    draw([
      row(
        [
          { query: 'a', status: 'done', sources: [PG_NEWS] },
          { query: 'b', status: 'failed' },
        ],
        { limit: 2, invalidQuery: 0 }
      ),
    ]);
    fireEvent.click(screen.getByTestId(TEST_IDS.webSearchRowToggle));
    const panel = screen.getByTestId(TEST_IDS.webSearchRowPanel);
    expect(panel).toHaveTextContent('1 search failed');
    expect(panel).toHaveTextContent('2 more searches were skipped');
  });

  it('carries no billing wording in any state', () => {
    draw([
      row(
        [
          { query: 'a', status: 'done', sources: [PG_NEWS] },
          { query: 'b', status: 'failed' },
          { query: 'c', status: 'interrupted' },
        ],
        { limit: 1, invalidQuery: 1 }
      ),
    ]);
    fireEvent.click(screen.getByTestId(TEST_IDS.webSearchRowToggle));
    expect(screen.getByTestId(TEST_IDS.webSearchRow).textContent).not.toMatch(
      /\$|charg|bill|cost|pric|fee|free/i
    );
  });

  it('stays open, going live in place, when another search joins it', () => {
    const view = draw([row([{ query: 'a', status: 'done', sources: [PG_NEWS] }])], {
      isStreaming: true,
    });
    fireEvent.click(screen.getByTestId(TEST_IDS.webSearchRowToggle));
    redraw(
      view,
      [
        row([
          { query: 'a', status: 'done', sources: [PG_NEWS] },
          { query: 'b', status: 'searching' },
        ]),
      ],
      { isStreaming: true }
    );
    const toggle = screen.getByTestId(TEST_IDS.webSearchRowToggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('Searching the web · 1 of 2 done');
    expect(screen.getByTestId(TEST_IDS.webSearchRowPanel)).toHaveTextContent('b · Searching');
  });

  it('keeps its dots inside the label while it is open and live', () => {
    const view = draw([row([{ query: 'a', status: 'done', sources: [PG_NEWS] }])], {
      isStreaming: true,
    });
    fireEvent.click(screen.getByTestId(TEST_IDS.webSearchRowToggle));
    redraw(
      view,
      [
        row([
          { query: 'a', status: 'done', sources: [PG_NEWS] },
          { query: 'b', status: 'searching' },
        ]),
      ],
      { isStreaming: true }
    );
    const toggle = screen.getByTestId(TEST_IDS.webSearchRowToggle);
    const words = within(toggle).getByText('Searching the web · 1 of 2 done');
    expect(words.querySelectorAll('.animate-dot-pulse')).toHaveLength(3);
  });
});

describe('WebSearchRow opening a source', () => {
  const SETTLED = [row([{ query: 'q', status: 'done', sources: [LWN] }])];

  function openSource(): void {
    draw(SETTLED);
    fireEvent.click(screen.getByTestId(TEST_IDS.webSearchRowToggle));
    fireEvent.click(screen.getByTestId(TEST_IDS.webSearchSource));
  }

  it('asks before leaving, showing the whole address', () => {
    openSource();
    const dialog = screen.getByTestId(TEST_IDS.externalLinkDialog);
    expect(dialog).toHaveTextContent('Open external link?');
    expect(dialog).toHaveTextContent(LWN.url);
  });

  it('opens the page in a new tab with no referrer', () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null);
    openSource();
    fireEvent.click(screen.getByTestId(TEST_IDS.externalLinkOpenButton));
    expect(open).toHaveBeenCalledWith(LWN.url, '_blank', 'noopener,noreferrer');
  });

  it('opens nothing until the reader confirms', () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null);
    openSource();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('WebSearchRow nested in reasoning', () => {
  it('neither pulses nor announces on its own', () => {
    const tree: readonly Segment[] = [
      {
        kind: 'reasoning',
        children: [{ kind: 'text', text: 't' }, row([{ query: 'a', status: 'searching' }])],
      },
      { kind: 'text', text: 'answer' },
    ];
    const context = buildRenderContext(tree, { ...FACTS, isStreaming: true });
    const nested = tree[0];
    if (nested?.kind !== 'reasoning') throw new Error('the fixture opens with reasoning');
    const { container } = render(
      <SegmentList nodes={nested.children} context={context} parent="reasoning" />
    );
    expect(screen.getByTestId(TEST_IDS.webSearchRow)).toHaveTextContent('Searching the web');
    expect(container.querySelectorAll('.animate-dot-pulse')).toHaveLength(0);
    expect(screen.queryByRole('status', { hidden: true })).not.toBeInTheDocument();
  });
});
