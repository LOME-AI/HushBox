import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { useAuditSnapshot } from './use-audit-snapshot';
import type { Snapshot } from '@/server/audit-service';

const snapshot: Snapshot = {
  audit: {
    layout_version: 1,
    date: '2026-07-30',
    title: 'Codebase audit',
    scope: 'The whole repository',
    body: '',
  },
  name: '2026-07-30',
  findings: [makeFinding({ id: 'A-1' })],
  validation: [],
  audits: ['2026-07-30'],
};

describe('useAuditSnapshot', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(snapshot, { status: 200 })))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts out loading', () => {
    const { result } = renderHook(() => useAuditSnapshot(null));

    expect(result.current.status).toBe('loading');
  });

  it('hands over the audit once it arrives', async () => {
    const { result } = renderHook(() => useAuditSnapshot(null));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.status === 'ready' && result.current.snapshot.name).toBe('2026-07-30');
  });

  it('reports a refused request rather than rendering an empty audit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 500 })))
    );

    const { result } = renderHook(() => useAuditSnapshot(null));

    await waitFor(() => {
      expect(result.current.status).toBe('failed');
    });
  });

  it('reports a dead server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connection refused')))
    );

    const { result } = renderHook(() => useAuditSnapshot(null));

    await waitFor(() => {
      expect(result.current.status === 'failed' && result.current.message).toBe(
        'connection refused'
      );
    });
  });

  it('reports a failure it cannot read a message from', async () => {
    vi.stubGlobal(
      'fetch',
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejecting with a non-Error is exactly the case under test
      vi.fn(() => Promise.reject('not an error object'))
    );

    const { result } = renderHook(() => useAuditSnapshot(null));

    await waitFor(() => {
      expect(result.current.status === 'failed' && result.current.message).toBe('unknown');
    });
  });

  it('stays quiet when the request is dropped rather than refused', async () => {
    let rejectFetch: ((reason: Error) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            rejectFetch = reject;
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          })
      )
    );

    const { result, unmount } = renderHook(() => useAuditSnapshot(null));
    unmount();
    await Promise.resolve();

    expect(rejectFetch).not.toBeNull();
    expect(result.current.status).toBe('loading');
  });

  it('drops the request when the console unmounts first', async () => {
    const abort = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        init.signal?.addEventListener('abort', abort);
        return new Promise<Response>(() => {});
      })
    );

    const { unmount } = renderHook(() => useAuditSnapshot(null));
    unmount();

    await waitFor(() => {
      expect(abort).toHaveBeenCalledTimes(1);
    });
  });

  it('reads the audit the address bar names', async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(Response.json(snapshot, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAuditSnapshot('2026-09-01'));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/audits/2026-09-01/audit']);
  });

  it('reads the served audit when the address bar names none', async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(Response.json(snapshot, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAuditSnapshot(null));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/audit']);
  });

  it('reads the new audit when the one on screen changes', async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(Response.json(snapshot, { status: 200 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = renderHook(({ audit }: { audit: string }) => useAuditSnapshot(audit), {
      initialProps: { audit: '2026-07-30' },
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    rerender({ audit: '2026-09-01' });

    await waitFor(() => {
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        '/api/audits/2026-07-30/audit',
        '/api/audits/2026-09-01/audit',
      ]);
    });
  });

  it('drops the request the audit it moved off had in flight', async () => {
    const aborted: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        init.signal?.addEventListener('abort', () => {
          aborted.push(url);
        });
        return new Promise<Response>(() => {});
      })
    );

    const { rerender } = renderHook(({ audit }: { audit: string }) => useAuditSnapshot(audit), {
      initialProps: { audit: '2026-07-30' },
    });
    rerender({ audit: '2026-09-01' });

    await waitFor(() => {
      expect(aborted).toEqual(['/api/audits/2026-07-30/audit']);
    });
  });

  it('goes back to loading while the audit it moved to is read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url === '/api/audits/2026-07-30/audit'
          ? Promise.resolve(Response.json(snapshot, { status: 200 }))
          : new Promise<Response>(() => {})
      )
    );

    const { result, rerender } = renderHook(
      ({ audit }: { audit: string }) => useAuditSnapshot(audit),
      { initialProps: { audit: '2026-07-30' } }
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    rerender({ audit: '2026-09-01' });

    expect(result.current.status).toBe('loading');
  });
});
