import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCopyToClipboard } from './use-copy-to-clipboard';

const writeText = vi.fn<(text: string) => Promise<void>>();
const execCommand = vi.fn<(command: string) => boolean>();

function stubClipboard(): void {
  vi.stubGlobal('navigator', { clipboard: { writeText } });
}

function stubNoClipboard(): void {
  vi.stubGlobal('navigator', {});
}

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue();
  execCommand.mockReset().mockReturnValue(true);
  Object.defineProperty(document, 'execCommand', {
    value: execCommand,
    configurable: true,
    writable: true,
  });
  stubClipboard();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'execCommand');
});

describe('useCopyToClipboard', () => {
  it('writes the text through the clipboard API and reports copied', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy('hb-123');
    });

    expect(writeText).toHaveBeenCalledWith('hb-123');
    expect(result.current.copied).toBe(true);
  });

  it('resolves true on a successful copy', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    let resolved = false;
    await act(async () => {
      resolved = await result.current.copy('hb-123');
    });

    expect(resolved).toBe(true);
  });

  it('clears copied after the default reset delay', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy('hb-123');
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.copied).toBe(false);
  });

  it('honors a caller-supplied reset delay', async () => {
    const { result } = renderHook(() => useCopyToClipboard({ resetAfterMs: 500 }));

    await act(async () => {
      await result.current.copy('hb-123');
    });

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.copied).toBe(false);
  });

  it('restarts the reset window on a second copy', async () => {
    const { result } = renderHook(() => useCopyToClipboard({ resetAfterMs: 500 }));

    await act(async () => {
      await result.current.copy('first');
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    await act(async () => {
      await result.current.copy('second');
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(result.current.copied).toBe(true);
  });

  it('copies a multi-kilobyte string in full', async () => {
    const block = Array.from({ length: 400 }, (_, index) => `Question ${String(index)}?`).join(
      '\n'
    );
    expect(block.length).toBeGreaterThan(4000);
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy(block);
    });

    expect(writeText).toHaveBeenCalledWith(block);
  });

  it('falls back to a text selection copy when the clipboard API is absent', async () => {
    stubNoClipboard();
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy('hb-123');
    });

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(result.current.copied).toBe(true);
  });

  it('leaves no fallback node behind in the document', async () => {
    stubNoClipboard();
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy('hb-123');
    });

    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('falls back when the clipboard API rejects', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy('hb-123');
    });

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(result.current.copied).toBe(true);
  });

  it('reports failure and stays uncopied when every path fails', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    execCommand.mockReturnValue(false);
    const { result } = renderHook(() => useCopyToClipboard());

    let resolved = true;
    await act(async () => {
      resolved = await result.current.copy('hb-123');
    });

    expect(resolved).toBe(false);
    expect(result.current.copied).toBe(false);
  });

  it('reports failure when the fallback itself throws', async () => {
    stubNoClipboard();
    execCommand.mockImplementation(() => {
      throw new Error('unsupported');
    });
    const { result } = renderHook(() => useCopyToClipboard());

    let resolved = true;
    await act(async () => {
      resolved = await result.current.copy('hb-123');
    });

    expect(resolved).toBe(false);
  });

  it('cancels the pending reset on unmount', async () => {
    const { result, unmount } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy('hb-123');
    });
    unmount();

    expect(() => {
      vi.advanceTimersByTime(2000);
    }).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
