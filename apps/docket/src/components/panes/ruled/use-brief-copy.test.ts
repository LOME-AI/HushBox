import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { withAuditAddress } from '@/test-utils/audit-address';
import { useBriefCopy } from './use-brief-copy';

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const findings = [makeFinding({ id: 'A-1' }), makeFinding({ id: 'A-2' })];

describe('useBriefCopy', () => {
  it('asks the server for exactly the findings the pane shows', async () => {
    const call = vi.fn(() => Promise.resolve(jsonResponse({ text: 'the brief' })));
    const { result } = renderHook(
      () => useBriefCopy({ fetch: call as unknown as typeof globalThis.fetch }),
      { wrapper: withAuditAddress }
    );

    await act(async () => {
      await result.current.copy(findings);
    });

    expect(call).toHaveBeenCalledWith('/api/audits/2026-07-30/brief?ids=A-1%2CA-2');
  });

  it('encodes an id that needs it', async () => {
    const call = vi.fn(() => Promise.resolve(jsonResponse({ text: 'the brief' })));
    const { result } = renderHook(
      () => useBriefCopy({ fetch: call as unknown as typeof globalThis.fetch }),
      { wrapper: withAuditAddress }
    );

    await act(async () => {
      await result.current.copy([makeFinding({ id: 'UI-8 CLEAN' })]);
    });

    expect(call).toHaveBeenCalledWith('/api/audits/2026-07-30/brief?ids=UI-8+CLEAN');
  });

  it('puts what the server wrote on the clipboard', async () => {
    const { result } = renderHook(
      () =>
        useBriefCopy({
          fetch: (() =>
            Promise.resolve(
              jsonResponse({ text: 'A-1  medium' })
            )) as unknown as typeof globalThis.fetch,
        }),
      { wrapper: withAuditAddress }
    );

    await act(async () => {
      await result.current.copy(findings);
    });

    expect(writeText).toHaveBeenCalledWith('A-1  medium');
  });

  it('reports the copy landed', async () => {
    const { result } = renderHook(
      () =>
        useBriefCopy({
          fetch: (() =>
            Promise.resolve(jsonResponse({ text: 'x' }))) as unknown as typeof globalThis.fetch,
        }),
      { wrapper: withAuditAddress }
    );

    await act(async () => {
      await result.current.copy(findings);
    });

    await waitFor(() => {
      expect(result.current.status).toBe('copied');
    });
  });

  it('is working while the brief is being fetched', async () => {
    let release: (() => void) | undefined;
    const call = (): Promise<Response> =>
      new Promise<Response>((resolve) => {
        release = () => {
          resolve(jsonResponse({ text: 'x' }));
        };
      });
    const { result } = renderHook(
      () => useBriefCopy({ fetch: call as unknown as typeof globalThis.fetch }),
      { wrapper: withAuditAddress }
    );

    act(() => {
      void result.current.copy(findings);
    });
    await waitFor(() => {
      expect(result.current.status).toBe('working');
    });

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('copied');
    });
  });

  it('surfaces the reason the server refused', async () => {
    const { result } = renderHook(
      () =>
        useBriefCopy({
          fetch: (() =>
            Promise.resolve(
              jsonResponse({ error: { code: 'not-found', message: 'no finding "A-9"' } }, 404)
            )) as unknown as typeof globalThis.fetch,
        }),
      { wrapper: withAuditAddress }
    );

    await act(async () => {
      await result.current.copy(findings);
    });

    expect(result.current.status).toBe('failed');
    expect(result.current.message).toBe('no finding "A-9"');
  });

  it('falls back to the status when the refusal carries no message', async () => {
    const { result } = renderHook(
      () =>
        useBriefCopy({
          fetch: (() =>
            Promise.resolve(jsonResponse({}, 500))) as unknown as typeof globalThis.fetch,
        }),
      { wrapper: withAuditAddress }
    );

    await act(async () => {
      await result.current.copy(findings);
    });

    expect(result.current.message).toBe('the brief could not be built (500)');
  });

  it('falls back to the status when the refusal is not readable at all', async () => {
    const unreadable = {
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('not json')),
    } as unknown as Response;
    const { result } = renderHook(
      () =>
        useBriefCopy({
          fetch: (() => Promise.resolve(unreadable)) as unknown as typeof globalThis.fetch,
        }),
      { wrapper: withAuditAddress }
    );

    await act(async () => {
      await result.current.copy(findings);
    });

    expect(result.current.message).toBe('the brief could not be built (502)');
  });

  it('reports a server that never answered', async () => {
    const { result } = renderHook(
      () =>
        useBriefCopy({
          fetch: (() =>
            Promise.reject(new Error('connection refused'))) as unknown as typeof globalThis.fetch,
        }),
      { wrapper: withAuditAddress }
    );

    await act(async () => {
      await result.current.copy(findings);
    });

    expect(result.current.message).toBe('connection refused');
  });

  it('reports a rejection that was not an error', async () => {
    const { result } = renderHook(
      () =>
        useBriefCopy({
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the branch under test is a rejection that is not an Error
          fetch: (() => Promise.reject('nope')) as unknown as typeof globalThis.fetch,
        }),
      { wrapper: withAuditAddress }
    );

    await act(async () => {
      await result.current.copy(findings);
    });

    expect(result.current.message).toBe('the brief could not be fetched');
  });

  it('says so when the clipboard refuses what the server sent', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const { result } = renderHook(
      () =>
        useBriefCopy({
          fetch: (() =>
            Promise.resolve(jsonResponse({ text: 'x' }))) as unknown as typeof globalThis.fetch,
        }),
      { wrapper: withAuditAddress }
    );

    await act(async () => {
      await result.current.copy(findings);
    });

    expect(result.current.status).toBe('failed');
    expect(result.current.message).toBe('The clipboard refused the brief.');
  });

  it('does not call the server for an empty set', async () => {
    const call = vi.fn(() => Promise.resolve(jsonResponse({ text: 'x' })));
    const { result } = renderHook(
      () => useBriefCopy({ fetch: call as unknown as typeof globalThis.fetch }),
      { wrapper: withAuditAddress }
    );

    await act(async () => {
      await result.current.copy([]);
    });

    expect(call).not.toHaveBeenCalled();
  });

  it('uses the page fetch when nothing is injected', async () => {
    const call = vi.fn(() => Promise.resolve(jsonResponse({ text: 'x' })));
    vi.spyOn(globalThis, 'fetch').mockImplementation(call as unknown as typeof globalThis.fetch);
    const { result } = renderHook(() => useBriefCopy(), { wrapper: withAuditAddress });

    await act(async () => {
      await result.current.copy(findings);
    });

    expect(call).toHaveBeenCalled();
  });
});
