import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { TEST_IDS } from '@/test-ids';
import { PEEK_MAX_LINES, PeekContent } from './peek-content';
import type { SourceWindow } from '@hushbox/docket';

const CITATION = { path: 'apps/api/src/lib/jobs/pass.ts', start: 189, end: 189 };
const LONG_CITATION = { path: 'apps/api/src/app.ts', start: 529, end: 603 };

/** The shape of a whole-block citation: 75 cited lines with context either side. */
function longWindow(overrides: Partial<SourceWindow> = {}): SourceWindow {
  return {
    path: LONG_CITATION.path,
    exists: true,
    stale: false,
    requestedStart: 529,
    requestedEnd: 603,
    start: 523,
    end: 609,
    lines: Array.from({ length: 87 }, (_, offset) => `line ${String(523 + offset)}`),
    ...overrides,
  };
}

/**
 * The source of each painted line without its gutter number. Read from the line
 * element rather than by text query: a highlighted line is a run of token
 * elements, so its text has no single node of its own to match.
 */
function paintedLines(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-slot="code-block-line"]')].map((line) =>
    line.textContent.replace(/^\d+/, '')
  );
}

function madeWindow(overrides: Partial<SourceWindow> = {}): SourceWindow {
  return {
    path: CITATION.path,
    exists: true,
    stale: false,
    requestedStart: 189,
    requestedEnd: 189,
    start: 187,
    end: 190,
    lines: ['const a = 1;', 'const b = 2;', 'const cited = 3;', 'const d = 4;'],
    ...overrides,
  };
}

describe('PeekContent', () => {
  it('sets the peek, border included, to the width of a code column, never wider than the window', () => {
    render(<PeekContent citation={CITATION} outcome={{ ok: true, window: madeWindow() }} />);

    expect(screen.getByTestId(TEST_IDS.sourcePeek)).toHaveClass('w-[calc(min(46rem,90vw)-2px)]');
  });

  it('heads the peek with the repo-relative path', () => {
    render(<PeekContent citation={CITATION} outcome={{ ok: true, window: madeWindow() }} />);

    expect(screen.getByText('apps/api/src/lib/jobs/pass.ts')).toBeInTheDocument();
  });

  it('shows the cited line in its surrounding context', () => {
    const { container } = render(
      <PeekContent citation={CITATION} outcome={{ ok: true, window: madeWindow() }} />
    );

    expect(paintedLines(container)).toContain('const a = 1;');
    expect(paintedLines(container)).toContain('const cited = 3;');
  });

  it('numbers the lines from where the window starts, not from one', () => {
    render(<PeekContent citation={CITATION} outcome={{ ok: true, window: madeWindow() }} />);

    expect(screen.getByText('187')).toBeInTheDocument();
    expect(screen.getByText('190')).toBeInTheDocument();
  });

  it('highlights the cited line', () => {
    const { container } = render(
      <PeekContent citation={CITATION} outcome={{ ok: true, window: madeWindow() }} />
    );

    const highlighted = container.querySelectorAll('[data-highlighted="true"]');

    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toHaveTextContent('const cited = 3;');
  });

  it('says the file moved on since the audit was written', () => {
    render(
      <PeekContent
        citation={CITATION}
        outcome={{ ok: true, window: madeWindow({ stale: true }) }}
      />
    );

    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent(
      'changed after the audit was written'
    );
  });

  it('still shows the code it read for a file that moved on', () => {
    const { container } = render(
      <PeekContent
        citation={CITATION}
        outcome={{ ok: true, window: madeWindow({ stale: true }) }}
      />
    );

    expect(paintedLines(container)).toContain('const cited = 3;');
  });

  it('says nothing about staleness for a file the audit still matches', () => {
    render(<PeekContent citation={CITATION} outcome={{ ok: true, window: madeWindow() }} />);

    expect(screen.queryByTestId(TEST_IDS.sourcePeekNotice)).not.toBeInTheDocument();
  });

  it('says a cited file is gone rather than showing an error', () => {
    render(
      <PeekContent
        citation={CITATION}
        outcome={{ ok: true, window: madeWindow({ exists: false, lines: [] }) }}
      />
    );

    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent(
      'no longer in the working tree'
    );
  });

  it('shows no code block for a file that is gone', () => {
    const { container } = render(
      <PeekContent
        citation={CITATION}
        outcome={{ ok: true, window: madeWindow({ exists: false, lines: [] }) }}
      />
    );

    expect(container.querySelector('[data-slot="code-block"]')).toBeNull();
  });

  it('surfaces a refusal to the reader rather than dropping it', () => {
    render(
      <PeekContent
        citation={CITATION}
        outcome={{ ok: false, message: 'that path resolves outside the repository' }}
      />
    );

    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent(
      'that path resolves outside the repository'
    );
  });

  it('paints no more lines than a peek can hold, however long the cited range', () => {
    const { container } = render(
      <PeekContent citation={LONG_CITATION} outcome={{ ok: true, window: longWindow() }} />
    );

    expect(container.querySelectorAll('[data-slot="code-block-line"]')).toHaveLength(
      PEEK_MAX_LINES
    );
  });

  it('spends the box on the cited lines when the citation outgrows it', () => {
    const { container } = render(
      <PeekContent citation={LONG_CITATION} outcome={{ ok: true, window: longWindow() }} />
    );

    const painted = [...container.querySelectorAll('[data-slot="code-block-line"]')].map(
      (line) => line.textContent
    );

    expect(painted[0]).toContain('line 527');
    expect(painted.at(-1)).toContain('line 539');
  });

  it('keeps context above the cited line even when the citation outgrows the box', () => {
    const { container } = render(
      <PeekContent citation={LONG_CITATION} outcome={{ ok: true, window: longWindow() }} />
    );

    const painted = [...container.querySelectorAll('[data-slot="code-block-line"]')];
    const cited = painted.findIndex(
      (line) => (line as HTMLElement).dataset['highlighted'] === 'true'
    );

    expect(cited).toBe(2);
  });

  it('keeps every context line when the cited range fits the box', () => {
    const { container } = render(
      <PeekContent
        citation={LONG_CITATION}
        outcome={{ ok: true, window: longWindow({ requestedEnd: 533 }) }}
      />
    );

    const painted = [...container.querySelectorAll('[data-slot="code-block-line"]')].map(
      (line) => line.textContent
    );

    expect(painted[0]).toContain('line 523');
  });

  it('keeps the cited line in the lines it does paint', () => {
    const { container } = render(
      <PeekContent citation={LONG_CITATION} outcome={{ ok: true, window: longWindow() }} />
    );

    const highlighted = container.querySelectorAll('[data-highlighted="true"]');

    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toHaveTextContent('line 529');
  });

  it('tells the reader which lines it is showing of the range the citation names', () => {
    render(<PeekContent citation={LONG_CITATION} outcome={{ ok: true, window: longWindow() }} />);

    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent(
      'Showing lines 527 to 539; the citation names 529 to 603.'
    );
  });

  it('carries the drift notice alongside the range it is showing', () => {
    render(
      <PeekContent
        citation={LONG_CITATION}
        outcome={{ ok: true, window: longWindow({ stale: true }) }}
      />
    );

    const notice = screen.getByTestId(TEST_IDS.sourcePeekNotice);

    expect(notice).toHaveTextContent('changed after the audit was written');
    expect(notice).toHaveTextContent('Showing lines 527 to 539');
  });

  it('says nothing about the range when the whole citation is on screen', () => {
    render(<PeekContent citation={CITATION} outcome={{ ok: true, window: madeWindow() }} />);

    expect(screen.queryByTestId(TEST_IDS.sourcePeekNotice)).not.toBeInTheDocument();
  });

  it('colors the code by the language the cited path names', () => {
    const { container } = render(
      <PeekContent citation={CITATION} outcome={{ ok: true, window: madeWindow() }} />
    );

    expect(container.querySelector('[data-code-token="keyword"]')).toHaveTextContent('const');
  });

  it('keeps every character of a line it colors', () => {
    const { container } = render(
      <PeekContent citation={CITATION} outcome={{ ok: true, window: madeWindow() }} />
    );

    expect(paintedLines(container)).toContain('const cited = 3;');
  });

  it('leaves a file it has no grammar for as plain text', () => {
    const { container } = render(
      <PeekContent
        citation={{ ...CITATION, path: 'packages/db/drizzle/0001_init.bin' }}
        outcome={{ ok: true, window: madeWindow() }}
      />
    );

    expect(container.querySelector('[data-code-token]')).toBeNull();
    expect(paintedLines(container)).toContain('const cited = 3;');
  });

  it('names the file it is reading while the read is in flight', () => {
    render(<PeekContent citation={CITATION} outcome={null} />);

    expect(screen.getByTestId(TEST_IDS.sourcePeek)).toHaveTextContent(
      'apps/api/src/lib/jobs/pass.ts'
    );
  });
});

/**
 * A box shorter than the code it holds. Every line is `lineHeight` tall, the
 * first one ends at `firstLineBottom`, and everything else in the peek reports
 * the box the reader sees, which is where the code is cut off.
 */
function boxEndingAt(clipBottom: number, firstLineBottom = 60, lineHeight = 20): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ): DOMRect {
    const line = this.closest('[data-slot="code-block-line"]');
    if (line === null) return { bottom: clipBottom } as DOMRect;
    const index = [...(line.parentElement?.children ?? [])].indexOf(line);
    return { bottom: firstLineBottom + index * lineHeight } as DOMRect;
  });
}

describe('PeekContent, in a box shorter than the code', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the lines the box has room for, not the lines it painted', () => {
    boxEndingAt(200);

    render(<PeekContent citation={LONG_CITATION} outcome={{ ok: true, window: longWindow() }} />);

    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent(
      'Showing lines 527 to 534; the citation names 529 to 603.'
    );
  });

  it('paints no line the box has no room for', () => {
    boxEndingAt(200);

    const { container } = render(
      <PeekContent citation={LONG_CITATION} outcome={{ ok: true, window: longWindow() }} />
    );

    expect(paintedLines(container)).toContain('line 534');
    expect(paintedLines(container)).not.toContain('line 535');
  });

  it('says so in the singular when the box holds one line', () => {
    boxEndingAt(60);

    render(<PeekContent citation={LONG_CITATION} outcome={{ ok: true, window: longWindow() }} />);

    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent(
      'Showing line 527; the citation names 529 to 603.'
    );
  });

  it('claims nothing at all when the box holds no line', () => {
    boxEndingAt(40);

    render(<PeekContent citation={LONG_CITATION} outcome={{ ok: true, window: longWindow() }} />);

    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent(
      'There is no room to show it here; the citation names 529 to 603.'
    );
  });

  it('says so when the box stops short of the cited line itself', () => {
    boxEndingAt(80);

    render(<PeekContent citation={CITATION} outcome={{ ok: true, window: madeWindow() }} />);

    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent(
      'Showing lines 187 to 188; the citation names 189 to 189.'
    );
  });

  it('claims nothing about a range for a file that has no lines to show', () => {
    boxEndingAt(200);

    render(
      <PeekContent citation={CITATION} outcome={{ ok: true, window: madeWindow({ lines: [] }) }} />
    );

    expect(screen.queryByTestId(TEST_IDS.sourcePeekNotice)).not.toBeInTheDocument();
  });

  it('re-reads the box when the box changes size', () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe(): void {
          // The test drives the callback itself.
        }
        disconnect(): void {
          // Nothing to disconnect.
        }
      }
    );
    boxEndingAt(300);
    render(<PeekContent citation={LONG_CITATION} outcome={{ ok: true, window: longWindow() }} />);
    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent('527 to 539');

    boxEndingAt(200);
    act(() => {
      for (const observed of observers) observed([], {} as ResizeObserver);
    });

    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent('527 to 534');
    vi.unstubAllGlobals();
  });

  it('does not widen the window again when the box grows under an open peek', () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe(): void {
          // The test drives the callback itself.
        }
        disconnect(): void {
          // Nothing to disconnect.
        }
      }
    );
    boxEndingAt(200);
    render(<PeekContent citation={LONG_CITATION} outcome={{ ok: true, window: longWindow() }} />);
    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent('527 to 534');

    boxEndingAt(900);
    act(() => {
      for (const observed of observers) observed([], {} as ResizeObserver);
    });

    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent('527 to 534');
    vi.unstubAllGlobals();
  });
});

/**
 * A window whose last line is cited, so the notice appears only once the box
 * has cut something off — which is what makes the peek's own notice part of the
 * layout it is measuring.
 */
function citedToTheEnd(): SourceWindow {
  return madeWindow({ requestedStart: 189, requestedEnd: 190 });
}

/**
 * A box that never changes size, holding content that does: the notice the peek
 * writes takes a line of its own, so every code line sits lower once it is
 * there than it did when the box was measured without it. A `max-height` clip
 * behaves exactly this way, which is why watching the box alone cannot see it.
 */
function boxWhoseNoticePushesTheCodeDown(
  clipBottom: number,
  firstLineBottom = 60,
  lineHeight = 20,
  noticeHeight = 20
): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ): DOMRect {
    const line = this.closest('[data-slot="code-block-line"]');
    if (line === null) return { bottom: clipBottom } as DOMRect;
    const index = [...(line.parentElement?.children ?? [])].indexOf(line);
    const pushed =
      document.querySelector(`[data-testid="${TEST_IDS.sourcePeekNotice}"]`) === null
        ? 0
        : noticeHeight;
    return { bottom: firstLineBottom + pushed + index * lineHeight } as DOMRect;
  });
}

/** A resize observer the test drives, remembering what each one was asked to watch. */
function trackedResizeObservers(): (element: Element) => void {
  const watchers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly watcher: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.watcher = { callback, targets: [] };
        watchers.push(this.watcher);
      }
      observe(target: Element): void {
        this.watcher.targets.push(target);
      }
      disconnect(): void {
        this.watcher.targets.length = 0;
      }
    }
  );
  return (element: Element): void => {
    act(() => {
      for (const watcher of watchers)
        if (watcher.targets.includes(element)) watcher.callback([], {} as ResizeObserver);
    });
  };
}

describe('PeekContent, in a box whose content settles below where it was measured', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('re-reads the box against the layout its own notice made', () => {
    boxWhoseNoticePushesTheCodeDown(100);

    render(<PeekContent citation={CITATION} outcome={{ ok: true, window: citedToTheEnd() }} />);

    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent(
      'Showing lines 187 to 188; the citation names 189 to 190.'
    );
  });

  it('paints no line its own notice pushed past the foot of the box', () => {
    boxWhoseNoticePushesTheCodeDown(100);

    const { container } = render(
      <PeekContent citation={CITATION} outcome={{ ok: true, window: citedToTheEnd() }} />
    );

    expect(paintedLines(container)).toContain('const b = 2;');
    expect(paintedLines(container)).not.toContain('const cited = 3;');
  });

  it('re-reads the box when the code grows inside a box that cannot', () => {
    const notifyObserversOf = trackedResizeObservers();
    boxEndingAt(300);
    render(<PeekContent citation={LONG_CITATION} outcome={{ ok: true, window: longWindow() }} />);
    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent('527 to 539');

    // The box is untouched; only what it holds got taller.
    boxEndingAt(300, 60, 40);
    notifyObserversOf(screen.getByTestId(TEST_IDS.sourcePeek));

    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent('527 to 533');
  });
});

describe('PeekContent, in a box that shrinks with nothing else moving', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('re-reads the box when the box shrinks around code that did not move', () => {
    const notifyObserversOf = trackedResizeObservers();
    boxEndingAt(300);
    // The clipping box is the peek's parent, which is the element the popover
    // resizes when the room above the citation changes.
    const { container } = render(
      <PeekContent citation={LONG_CITATION} outcome={{ ok: true, window: longWindow() }} />
    );
    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent('527 to 539');

    // The code is untouched, and nothing re-renders: only the box got shorter.
    boxEndingAt(200);
    notifyObserversOf(container);

    expect(screen.getByTestId(TEST_IDS.sourcePeekNotice)).toHaveTextContent('527 to 534');
  });
});
