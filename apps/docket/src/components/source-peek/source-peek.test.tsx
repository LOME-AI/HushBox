import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TEST_IDS } from '@/test-ids';
import { withAuditAddress } from '@/test-utils/audit-address';
import { SourcePeek } from './source-peek';
import type { PeekOutcome } from './source-window';
import type { SourceWindow } from '@hushbox/docket';

const WINDOW: SourceWindow = {
  path: 'apps/api/src/lib/jobs/pass.ts',
  exists: true,
  stale: false,
  requestedStart: 189,
  requestedEnd: 189,
  start: 188,
  end: 190,
  lines: ['before', 'const cited = 3;', 'after'],
};

function citationMarkup(): string {
  return [
    '<p>evidence in ',
    '<code data-citation-path="apps/api/src/lib/jobs/pass.ts"',
    ' data-citation-start="189" data-citation-end="189">',
    'apps/api/src/lib/jobs/pass.ts:189</code>',
    '</p>',
  ].join('');
}

let prose: HTMLElement | null = null;

function renderPeek(props: Parameters<typeof SourcePeek>[0] = {}): HTMLElement {
  prose = document.createElement('div');
  prose.innerHTML = citationMarkup();
  document.body.append(prose);
  render(<SourcePeek {...props} />, { wrapper: withAuditAddress });
  return prose.querySelector('code')!;
}

const read = vi.fn(
  (): Promise<PeekOutcome> => Promise.resolve({ ok: true, window: WINDOW })
) as unknown as () => Promise<PeekOutcome>;

describe('SourcePeek', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    prose?.remove();
    prose = null;
  });

  /**
   * The peek has no reader of its own in the console; the audit on screen is
   * what says which repository the cited path is read out of.
   */
  it('reads its own audit when the console hands it no reader', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json(WINDOW, { status: 200 }));
    const citation = renderPeek();

    fireEvent.pointerOver(citation);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/audits/2026-07-30/source?path=apps%2Fapi%2Fsrc%2Flib%2Fjobs%2Fpass.ts&start=189&end=189'
      );
    });
  });

  it('shows nothing until the reader rests on a citation', () => {
    renderPeek({ read, copy: vi.fn() });

    expect(screen.queryByTestId(TEST_IDS.sourcePeek)).not.toBeInTheDocument();
  });

  it('shows the cited code once the reader rests on a citation', async () => {
    const citation = renderPeek({ read, copy: vi.fn() });

    fireEvent.pointerOver(citation);

    await waitFor(() => {
      // Highlighted source is a run of token elements, so the line has no
      // single node of its own to match.
      expect(screen.getByTestId(TEST_IDS.sourcePeek)).toHaveTextContent('const cited = 3;');
    });
  });

  it('dismisses the peek when the pointer leaves the citation', async () => {
    const citation = renderPeek({ read, copy: vi.fn() });

    fireEvent.pointerOver(citation);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.sourcePeek)).toBeInTheDocument();
    });
    fireEvent.pointerOut(citation);

    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.sourcePeek)).not.toBeInTheDocument();
    });
  });

  it('dismisses the peek the popover asks to close, such as on Escape', async () => {
    const citation = renderPeek({ read, copy: vi.fn() });

    fireEvent.pointerOver(citation);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.sourcePeek)).toBeInTheDocument();
    });
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.sourcePeek)).not.toBeInTheDocument();
    });
  });

  it('leaves the wrapper Radix positions the peek in click-transparent', async () => {
    const citation = renderPeek({ read, copy: vi.fn() });

    fireEvent.pointerOver(citation);
    const peek = await screen.findByTestId(TEST_IDS.sourcePeek);
    const wrapper = peek.closest<HTMLElement>('[data-radix-popper-content-wrapper]');

    expect(wrapper?.style.pointerEvents).toBe('none');
  });

  it('bounds its height against the viewport, as it already bounds its width', async () => {
    const citation = renderPeek({ read, copy: vi.fn() });

    fireEvent.pointerOver(citation);
    const peek = await screen.findByTestId(TEST_IDS.sourcePeek);

    expect(peek.parentElement?.className).toContain(
      'max-h-[min(85vh,var(--radix-popover-content-available-height))]'
    );
  });

  it('puts every citation on the page into the tab order', () => {
    const citation = renderPeek({ read, copy: vi.fn() });

    expect(citation.getAttribute('tabindex')).toBe('0');
  });

  it('copies the citation the reader clicked', () => {
    const copy = vi.fn();
    const citation = renderPeek({ read, copy });

    fireEvent.click(citation);

    expect(copy).toHaveBeenCalledWith('apps/api/src/lib/jobs/pass.ts:189');
  });

  it('copies to the clipboard when nothing is injected', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const citation = renderPeek({ read });

    fireEvent.click(citation);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('apps/api/src/lib/jobs/pass.ts:189');
    });
  });

  it('reads through the console API when no reader is injected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(WINDOW, { status: 200 })))
    );
    const citation = renderPeek();

    fireEvent.pointerOver(citation);

    await waitFor(() => {
      // Highlighted source is a run of token elements, so the line has no
      // single node of its own to match.
      expect(screen.getByTestId(TEST_IDS.sourcePeek)).toHaveTextContent('const cited = 3;');
    });
    vi.unstubAllGlobals();
  });
});
