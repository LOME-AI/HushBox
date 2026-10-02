import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { formatHotkey } from '@hushbox/ui';
import { TEST_IDS } from '@/test-ids';
import { ConsoleHeader } from './console-header';
import { SHORTCUTS_COMBO } from './hooks/use-console-hotkeys';
import type { ConsoleHeaderProps } from './console-header';

const counts = {
  dashboard: 342,
  open: 331,
  questions: 11,
  blocked: 4,
  ruled: 112,
  dedicated: 0,
  denied: 92,
  progress: 116,
};

function renderHeader(props: Partial<ConsoleHeaderProps> = {}): {
  onSection: ReturnType<typeof vi.fn>;
  onQuery: ReturnType<typeof vi.fn>;
  onMode: ReturnType<typeof vi.fn>;
  onShortcuts: ReturnType<typeof vi.fn>;
} {
  const onSection = vi.fn();
  const onQuery = vi.fn();
  const onMode = vi.fn();
  const onShortcuts = vi.fn();
  render(
    <ConsoleHeader
      auditTitle="Codebase audit"
      auditName="2026-07-30"
      audits={['2026-07-30']}
      decided={208}
      total={550}
      unreadable={0}
      live
      section="open"
      counts={counts}
      onSection={onSection}
      query=""
      onQuery={onQuery}
      mode="list"
      onMode={onMode}
      onAudit={vi.fn()}
      bulkRunning={false}
      onShortcuts={onShortcuts}
      {...props}
    />
  );
  return { onSection, onQuery, onMode, onShortcuts };
}

describe('ConsoleHeader', () => {
  it('names the audit being ruled', () => {
    renderHeader();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Codebase audit');
  });

  it('shows how far through the audit the reader is', () => {
    renderHeader();

    expect(screen.getByText('208 of 550 decided')).toBeInTheDocument();
  });

  it('survives an audit with no findings at all', () => {
    renderHeader({ decided: 0, total: 0 });

    expect(screen.getByText('0 of 0 decided')).toBeInTheDocument();
  });

  it('qualifies the count with the findings it could not read, wherever that count is shown', () => {
    renderHeader({ unreadable: 1 });

    expect(screen.getByText(/208 of 550 decided/u)).toHaveTextContent(
      '208 of 550 decided, 1 unreadable'
    );
  });

  it('says nothing about unreadable findings when every one of them was read', () => {
    renderHeader();

    expect(screen.getByText('208 of 550 decided')).toBeInTheDocument();
  });

  /**
   * The qualifier is what corrects the count beside it, so a viewport that fits
   * one and not the other must not be able to show the count alone. At 375px
   * the header read `208 of 550 decid` and there was nowhere to scroll to the
   * rest: the correction was off screen while the assertion stood.
   */
  it('gives the qualifier an element of its own, so it moves as a whole', () => {
    renderHeader({ unreadable: 1 });

    expect(screen.getByText(', 1 unreadable')).toBeInTheDocument();
  });

  it('leaves nothing above the count refusing to wrap', () => {
    renderHeader({ unreadable: 1 });

    let node: HTMLElement | null = screen.getByText(', 1 unreadable');
    while (node !== null) {
      expect(node.className).not.toContain('whitespace-nowrap');
      node = node.parentElement;
    }
  });

  it('carries the section tabs and their counts', () => {
    renderHeader();

    expect(screen.getByTestId(TEST_IDS.sectionNav)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ruled/ })).toHaveTextContent('112');
  });

  it('reports a section change', () => {
    const { onSection } = renderHeader();

    fireEvent.click(screen.getByRole('button', { name: /Denied/ }));

    expect(onSection).toHaveBeenCalledWith('denied');
  });

  it('reports what the reader searched for', () => {
    const { onQuery } = renderHeader();

    fireEvent.change(screen.getByTestId(TEST_IDS.searchInput), { target: { value: 'wallet' } });

    expect(onQuery).toHaveBeenCalledWith('wallet');
  });

  it('shows the search the url arrived with', () => {
    renderHeader({ query: 'wallet' });

    expect(screen.getByTestId(TEST_IDS.searchInput)).toHaveValue('wallet');
  });

  it('offers the theme toggle', () => {
    renderHeader();

    expect(screen.getByRole('button', { name: /mode/ })).toBeInTheDocument();
  });

  it('marks the view mode in use', () => {
    renderHeader();

    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches to focus mode', () => {
    const { onMode } = renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));

    expect(onMode).toHaveBeenCalledWith('focus');
  });

  it('switches back to list mode', () => {
    const { onMode } = renderHeader({ mode: 'focus' });

    fireEvent.click(screen.getByRole('button', { name: 'List' }));

    expect(onMode).toHaveBeenCalledWith('list');
  });

  it('shows which audit is loaded', () => {
    renderHeader();

    expect(screen.getByTestId(TEST_IDS.auditSwitcher)).toHaveValue('2026-07-30');
  });

  it('stops the counts reading as current once the audit server is gone', () => {
    renderHeader({ live: false });

    expect(screen.getByRole('status')).toHaveTextContent(
      'Not live. The console lost the audit server, so what is on screen may be out of date.'
    );
  });

  it('says on screen that the console has a keyboard, and how to see it', () => {
    renderHeader();

    const control = screen.getByRole('button', { name: /keyboard shortcuts/i });
    expect(control).toHaveTextContent(formatHotkey(SHORTCUTS_COMBO, { apple: false }));
  });

  it('opens the shortcut legend from that control', () => {
    const { onShortcuts } = renderHeader();

    fireEvent.click(screen.getByRole('button', { name: /keyboard shortcuts/i }));

    expect(onShortcuts).toHaveBeenCalled();
  });

  it('says nothing about the connection while the audit is still being read', () => {
    renderHeader();

    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('routes a chosen audit out of the header', () => {
    const onAudit = vi.fn();
    renderHeader({ audits: ['2026-07-30', '2026-06-01'], onAudit });

    fireEvent.change(screen.getByTestId(TEST_IDS.auditSwitcher), {
      target: { value: '2026-06-01' },
    });

    expect(onAudit).toHaveBeenCalledWith('2026-06-01');
  });

  it('holds the audit switch while a bulk ruling is running', () => {
    renderHeader({ audits: ['2026-07-30', '2026-06-01'], onAudit: vi.fn(), bulkRunning: true });

    expect(screen.getByTestId(TEST_IDS.auditSwitcher)).toBeDisabled();
  });
});

/**
 * At 375px and the largest text tier the header took 420px of an 812px
 * viewport, and nothing in it can be scrolled away, so the queue it is a header
 * for was left a row and a half.
 */
describe('ConsoleHeader on a narrow viewport', () => {
  const original = globalThis.matchMedia;

  function viewport(narrow: boolean): void {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: narrow,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: original });
    vi.restoreAllMocks();
  });

  it('leaves the header whole where there is room for it', () => {
    viewport(false);
    renderHeader();

    expect(screen.queryByRole('button', { name: 'Tools' })).not.toBeInTheDocument();
    expect(screen.getByText('208 of 550 decided')).toBeInTheDocument();
  });

  it('folds the settings away, so the height goes to the queue', () => {
    viewport(true);
    renderHeader();

    expect(screen.getByRole('button', { name: 'Tools' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('208 of 550 decided')).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.auditSwitcher)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /keyboard shortcuts/i })).not.toBeInTheDocument();
  });

  it('keeps getting around the audit in the header, because that is what a header is for', () => {
    viewport(true);
    renderHeader();

    expect(screen.getByTestId(TEST_IDS.sectionNav)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.searchInput)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'List' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('gives them back when the reader asks for them', () => {
    viewport(true);
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));

    expect(screen.getByText('208 of 550 decided')).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.auditSwitcher)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keyboard shortcuts/i })).toBeInTheDocument();
  });

  it('folds them back up', () => {
    viewport(true);
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));

    fireEvent.click(screen.getByRole('button', { name: 'Hide tools' }));

    expect(screen.queryByText('208 of 550 decided')).not.toBeInTheDocument();
  });

  // A fold that hides the console saying its numbers are stale would make the
  // narrow viewport the one place the reader is quietly lied to.
  it('never folds away the warning that the counts have stopped being current', () => {
    viewport(true);
    renderHeader({ live: false });

    expect(screen.getByRole('status')).toHaveTextContent('Not live.');
  });
});

/**
 * A viewport `width` CSS pixels wide whose primary pointer is `pointer`, as
 * `matchMedia` reports it: a max-width query matches at or below its bound,
 * and the coarse-pointer query matches only for a coarse pointer.
 */
function stubFormFactor(width: number, pointer: 'fine' | 'coarse'): void {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    const maxWidth = /\(max-width:\s*(\d+)px\)/.exec(query);
    const matches =
      maxWidth === null
        ? query === '(pointer: coarse)' && pointer === 'coarse'
        : width <= Number(maxWidth[1]);
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  });
}

describe('ConsoleHeader at each form factor', () => {
  it('folds the tools away on a phone', () => {
    stubFormFactor(390, 'coarse');
    renderHeader();

    expect(screen.getByRole('button', { name: 'Tools' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('lets the title give up its width on a phone', () => {
    stubFormFactor(390, 'coarse');
    renderHeader();

    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('flex-1', 'basis-0');
  });

  it('leaves the header whole on a tablet, whose width has room for it', () => {
    stubFormFactor(834, 'coarse');
    renderHeader();

    expect(screen.queryByRole('button', { name: 'Tools' })).not.toBeInTheDocument();
    expect(screen.getByText('208 of 550 decided')).toBeInTheDocument();
  });

  it('keeps the title at its own width on a tablet', () => {
    stubFormFactor(834, 'coarse');
    renderHeader();

    expect(screen.getByRole('heading', { level: 1 })).not.toHaveClass('flex-1');
  });

  it('leaves the header whole on a desktop', () => {
    stubFormFactor(1440, 'fine');
    renderHeader();

    expect(screen.queryByRole('button', { name: 'Tools' })).not.toBeInTheDocument();
    expect(screen.getByText('208 of 550 decided')).toBeInTheDocument();
  });

  it('keeps the title at its own width on a desktop', () => {
    stubFormFactor(1440, 'fine');
    renderHeader();

    expect(screen.getByRole('heading', { level: 1 })).not.toHaveClass('flex-1');
  });
});
