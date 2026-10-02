import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, renderHook } from '@testing-library/react';
import { usePublishedBindings } from '@/components/published-bindings';
import { PEEK_DELAY_MS, useCitationPeek } from './use-citation-peek';
import type { PeekOutcome, SourceReader } from './source-window';
import type { MockedFunction } from 'vitest';
import type { SourceWindow } from '@hushbox/docket';

const WINDOW: SourceWindow = {
  path: 'apps/api/x.ts',
  exists: true,
  stale: false,
  requestedStart: 68,
  requestedEnd: 68,
  start: 62,
  end: 74,
  lines: ['const a = 1;'],
};

function citationSpan(path: string, start: string, end = start): HTMLElement {
  const element = document.createElement('code');
  element.dataset['citationPath'] = path;
  element.dataset['citationStart'] = start;
  element.dataset['citationEnd'] = end;
  element.textContent = `${path}:${start}`;
  document.body.append(element);
  return element;
}

function served(): { read: MockedFunction<SourceReader> } {
  return { read: vi.fn<SourceReader>(() => Promise.resolve({ ok: true, window: WINDOW })) };
}

function settle(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
  });
}

describe('PEEK_DELAY_MS', () => {
  it('waits at least a quarter of a second before any read', () => {
    expect(PEEK_DELAY_MS).toBeGreaterThanOrEqual(250);
  });
});

describe('useCitationPeek', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('reads nothing while the cursor is still sweeping across a paragraph', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS - 1);
    });

    expect(read).not.toHaveBeenCalled();
  });

  it('reads the cited range once the cursor has rested on it', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68', '74');

    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });

    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'apps/api/x.ts', start: 68, end: 74 })
    );
  });

  it('reads only the citation the cursor came to rest on', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const first = citationSpan('apps/api/first.ts', '1');
    const second = citationSpan('apps/api/second.ts', '2');

    fireEvent.pointerOver(first);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS - 50);
    });
    fireEvent.pointerOver(second);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ path: 'apps/api/second.ts' }));
  });

  it('opens the peek before the window arrives', () => {
    const { read } = served();
    const copy = vi.fn();
    const { result } = renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });

    expect(result.current.peek?.citation.path).toBe('apps/api/x.ts');
    expect(result.current.peek?.outcome).toBeNull();
  });

  it('shows the window it read', async () => {
    const { read } = served();
    const copy = vi.fn();
    const { result } = renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });
    await settle();

    expect(result.current.peek?.outcome).toEqual({ ok: true, window: WINDOW });
  });

  it('drops a window that arrives after the reader has moved on', async () => {
    const deferred: { resolve: ((outcome: PeekOutcome) => void) | null } = { resolve: null };
    const read = vi.fn<SourceReader>(
      () =>
        new Promise<PeekOutcome>((resolve) => {
          deferred.resolve = resolve;
        })
    );
    const copy = vi.fn();
    const { result } = renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });
    fireEvent.pointerOut(span);
    deferred.resolve?.({ ok: true, window: WINDOW });
    await settle();

    expect(result.current.peek).toBeNull();
  });

  it('dismisses when the pointer leaves the citation', () => {
    const { read } = served();
    const copy = vi.fn();
    const { result } = renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });
    act(() => {
      fireEvent.pointerOut(span);
    });

    expect(result.current.peek).toBeNull();
  });

  it('stays open when the pointer leaves ordinary prose beside the citation', () => {
    const { read } = served();
    const copy = vi.fn();
    const { result } = renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');
    const prose = document.createElement('p');
    document.body.append(prose);

    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });
    act(() => {
      fireEvent.pointerOut(prose);
    });

    expect(result.current.peek).not.toBeNull();
  });

  it('copies nothing when Enter is pressed away from any citation', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const prose = document.createElement('p');
    document.body.append(prose);

    fireEvent.keyDown(prose, { key: 'Enter' });

    expect(copy).not.toHaveBeenCalled();
  });

  it('drops a scheduled read when the pointer leaves before it fires', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.pointerOver(span);
    fireEvent.pointerOut(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });

    expect(read).not.toHaveBeenCalled();
  });

  it('ignores a pointer moving over ordinary prose', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const prose = document.createElement('p');
    document.body.append(prose);

    fireEvent.pointerOver(prose);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });

    expect(read).not.toHaveBeenCalled();
  });

  it('keeps one read when the pointer moves within the same citation', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });
    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('opens for a reader who reaches the citation with the keyboard', () => {
    const { read } = served();
    const copy = vi.fn();
    const { result } = renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.focusIn(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });

    expect(result.current.peek?.citation.path).toBe('apps/api/x.ts');
  });

  it('dismisses when focus leaves the citation', () => {
    const { read } = served();
    const copy = vi.fn();
    const { result } = renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.focusIn(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });
    act(() => {
      fireEvent.focusOut(span);
    });

    expect(result.current.peek).toBeNull();
  });

  it('dismisses on Escape', () => {
    const { read } = served();
    const copy = vi.fn();
    const { result } = renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(result.current.peek).toBeNull();
  });

  it('leaves the shortcut legend to describe the Escape it answers', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const legend = renderHook(() => usePublishedBindings());
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });
    legend.rerender();

    expect(legend.result.current).toEqual([]);
  });

  it('leaves the peek open for any other key', () => {
    const { read } = served();
    const copy = vi.fn();
    const { result } = renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });
    act(() => {
      fireEvent.keyDown(document, { key: 'j' });
    });

    expect(result.current.peek).not.toBeNull();
  });

  it('copies a clicked citation as its repo-relative path and line', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.click(span);

    expect(copy).toHaveBeenCalledWith('apps/api/x.ts:68');
  });

  it('copies both ends of a cited range', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68', '74');

    fireEvent.click(span);

    expect(copy).toHaveBeenCalledWith('apps/api/x.ts:68-74');
  });

  it('copies the citation a keyboard reader presses Enter on', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');
    span.tabIndex = 0;

    fireEvent.keyDown(span, { key: 'Enter' });

    expect(copy).toHaveBeenCalledWith('apps/api/x.ts:68');
  });

  it('copies the citation a keyboard reader presses Space on', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');
    span.tabIndex = 0;

    fireEvent.keyDown(span, { key: ' ' });

    expect(copy).toHaveBeenCalledWith('apps/api/x.ts:68');
  });

  it('keeps Space from scrolling the page out from under the citation', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');
    span.tabIndex = 0;

    const delivered = fireEvent.keyDown(span, { key: ' ' });

    expect(delivered).toBe(false);
  });

  it('closes a peek whose citation has left the page, such as on a step to the next finding', async () => {
    const { read } = served();
    const copy = vi.fn();
    const { result } = renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });
    await settle();
    expect(result.current.peek).not.toBeNull();

    await act(async () => {
      span.remove();
      await Promise.resolve();
    });

    expect(result.current.peek).toBeNull();
  });

  it('copies nothing when the click was not on a citation', () => {
    const { read } = served();
    const copy = vi.fn();
    renderHook(() => useCitationPeek({ read, copy }));
    const prose = document.createElement('p');
    document.body.append(prose);

    fireEvent.click(prose);

    expect(copy).not.toHaveBeenCalled();
  });

  it('closes on request, which is how an outside click dismisses it', () => {
    const { read } = served();
    const copy = vi.fn();
    const { result } = renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });
    act(() => {
      result.current.close();
    });

    expect(result.current.peek).toBeNull();
  });

  it('stops listening once the console is gone', () => {
    const { read } = served();
    const copy = vi.fn();
    const { unmount } = renderHook(() => useCitationPeek({ read, copy }));
    const span = citationSpan('apps/api/x.ts', '68');

    unmount();
    fireEvent.pointerOver(span);
    act(() => {
      vi.advanceTimersByTime(PEEK_DELAY_MS);
    });

    expect(read).not.toHaveBeenCalled();
  });
});
