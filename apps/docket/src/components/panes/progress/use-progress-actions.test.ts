import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { withAuditAddress } from '@/test-utils/audit-address';
import { useProgressActions } from './use-progress-actions';
import type { Mock } from 'vitest';

const FINDING = makeFinding({ id: 'A-1', state: 'ruled' });
const WRITTEN = makeFinding({
  id: 'A-1',
  state: 'ruled',
  progress: { status: 'done', updated: '2026-07-31', verified: false, notes: [] },
});

/** A fresh Response per call: a body may be read only once, and a retry re-reads. */
function responds(status: number, body: unknown): () => Promise<Response> {
  return () => Promise.resolve(Response.json(body, { status }));
}

const WROTE = responds(200, { finding: WRITTEN, undoToken: 't' });
const REFUSED = responds(409, { error: { code: 'conflict', message: 'the file changed' } });
const LOCKED = responds(503, {
  error: { code: 'locked', message: 'held by a writer', retryable: true },
});

function setup(call: () => Promise<Response> = WROTE): {
  actions: ReturnType<typeof useProgressActions>;
  put: ReturnType<typeof vi.fn>;
  fetchMock: Mock<typeof globalThis.fetch>;
} {
  const put = vi.fn();
  const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(call);
  const rendered = renderHook(
    () => useProgressActions({ put, api: { fetch: fetchMock, wait: () => Promise.resolve() } }),
    { wrapper: withAuditAddress }
  );
  return {
    get actions() {
      return rendered.result.current;
    },
    put,
    fetchMock,
  };
}

describe('useProgressActions', () => {
  it('writes the status the reader chose', async () => {
    const harness = setup();

    act(() => {
      harness.actions.setStatus(FINDING, 'done');
    });

    await waitFor(() => {
      expect(harness.fetchMock).toHaveBeenCalledWith(
        '/api/audits/2026-07-30/finding/A-1/progress',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'done', base: 'hash' }),
        })
      );
    });
  });

  it('puts the finding the server wrote back into the board', async () => {
    const harness = setup();

    act(() => {
      harness.actions.setStatus(FINDING, 'done');
    });

    await waitFor(() => {
      expect(harness.put).toHaveBeenCalledWith(WRITTEN);
    });
  });

  it('appends a note', async () => {
    const harness = setup();

    act(() => {
      harness.actions.addNote(FINDING, 'waiting on the schema change');
    });

    await waitFor(() => {
      expect(harness.fetchMock).toHaveBeenCalledWith(
        '/api/audits/2026-07-30/finding/A-1/progress',
        expect.objectContaining({ body: JSON.stringify({ note: 'waiting on the schema change' }) })
      );
    });
  });

  it('records the reader verifying a finished item', async () => {
    const harness = setup();

    act(() => {
      harness.actions.setVerified(FINDING, true);
    });

    await waitFor(() => {
      expect(harness.fetchMock).toHaveBeenCalledWith(
        '/api/audits/2026-07-30/finding/A-1/progress',
        expect.objectContaining({ body: JSON.stringify({ verified: true, base: 'hash' }) })
      );
    });
  });

  it('keeps a refusal against the finding it belongs to', async () => {
    const harness = setup(REFUSED);

    act(() => {
      harness.actions.setStatus(FINDING, 'done');
    });

    await waitFor(() => {
      expect(harness.actions.errorFor('A-1')).toBe('the file changed');
    });
  });

  it('reports nothing for a finding that did not fail', async () => {
    const harness = setup(REFUSED);

    act(() => {
      harness.actions.setStatus(FINDING, 'done');
    });

    await waitFor(() => {
      expect(harness.actions.errorFor('A-1')).not.toBeNull();
    });
    expect(harness.actions.errorFor('A-2')).toBeNull();
  });

  it('leaves the board alone when the write is refused', async () => {
    const harness = setup(REFUSED);

    act(() => {
      harness.actions.setStatus(FINDING, 'done');
    });

    await waitFor(() => {
      expect(harness.actions.errorFor('A-1')).not.toBeNull();
    });
    expect(harness.put).not.toHaveBeenCalled();
  });

  it('drops the old refusal when the next write is sent', async () => {
    const harness = setup();
    harness.fetchMock.mockImplementationOnce(REFUSED);

    act(() => {
      harness.actions.setStatus(FINDING, 'done');
    });
    await waitFor(() => {
      expect(harness.actions.errorFor('A-1')).not.toBeNull();
    });

    act(() => {
      harness.actions.setStatus(FINDING, 'blocked');
    });

    await waitFor(() => {
      expect(harness.actions.errorFor('A-1')).toBeNull();
    });
  });

  it('retries a refusal the server says can be retried', async () => {
    const harness = setup();
    harness.fetchMock.mockImplementationOnce(LOCKED);

    act(() => {
      harness.actions.setStatus(FINDING, 'done');
    });

    await waitFor(() => {
      expect(harness.put).toHaveBeenCalledWith(WRITTEN);
    });
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('goes to the progress route when nothing is injected', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ finding: WRITTEN, undoToken: 't' }, { status: 200 }));
    const { result } = renderHook(() => useProgressActions({ put: vi.fn() }), {
      wrapper: withAuditAddress,
    });

    act(() => {
      result.current.setStatus(FINDING, 'done');
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/audits/2026-07-30/finding/A-1/progress',
        expect.anything()
      );
    });
    fetchSpy.mockRestore();
  });
});
