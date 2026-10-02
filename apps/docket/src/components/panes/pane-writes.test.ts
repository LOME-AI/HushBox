import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { makeFinding, makeQuestion } from '@/test-utils/finding-fixture';
import { withAuditAddress } from '@/test-utils/audit-address';
import { usePaneWrites } from './pane-writes';
import type { FindingJson } from '@hushbox/docket';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function effect(finding: FindingJson): unknown {
  return { finding, undoToken: 'token' };
}

function setup(fetchImpl: typeof globalThis.fetch): {
  put: ReturnType<typeof vi.fn>;
  result: { current: ReturnType<typeof usePaneWrites> };
} {
  const put = vi.fn();
  const { result } = renderHook(
    () =>
      usePaneWrites({ put, api: { fetch: fetchImpl, wait: () => Promise.resolve(), attempts: 2 } }),
    { wrapper: withAuditAddress }
  );
  return { put, result };
}

describe('usePaneWrites', () => {
  it('posts to the route the action names, carrying the body', async () => {
    const finding = makeFinding({ id: 'A-1' });
    const call = vi.fn(() => Promise.resolve(jsonResponse(effect(finding))));
    const { result } = setup(call as unknown as typeof globalThis.fetch);

    await act(async () => {
      await result.current.run(finding, 'ask', { text: 'which pool?' });
    });

    expect(call).toHaveBeenCalledWith(
      '/api/audits/2026-07-30/finding/A-1/ask',
      expect.objectContaining({ body: JSON.stringify({ text: 'which pool?' }) })
    );
  });

  it('puts the finding the server hands back into the pane', async () => {
    const sent = makeFinding({ id: 'A-1', questions: [makeQuestion()] });
    const returned = makeFinding({ id: 'A-1', questions: [makeQuestion({ answer: 'because' })] });
    const { put, result } = setup((() =>
      Promise.resolve(jsonResponse(effect(returned)))) as unknown as typeof globalThis.fetch);

    await act(async () => {
      await result.current.run(sent, 'withdraw', { index: 0 });
    });

    expect(put).toHaveBeenCalledWith(returned);
  });

  it('reports the write landed', async () => {
    const finding = makeFinding({ id: 'A-1' });
    const { result } = setup((() =>
      Promise.resolve(jsonResponse(effect(finding)))) as unknown as typeof globalThis.fetch);

    let landed = false;
    await act(async () => {
      landed = await result.current.run(finding, 'reopen', {});
    });

    expect(landed).toBe(true);
  });

  it('shows a refusal against the finding it belongs to and changes nothing', async () => {
    const finding = makeFinding({ id: 'A-1' });
    const { put, result } = setup((() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: 'invalid-transition', message: 'only a decided finding reopens' } },
          409
        )
      )) as unknown as typeof globalThis.fetch);

    await act(async () => {
      await result.current.run(finding, 'reopen', {});
    });

    expect(put).not.toHaveBeenCalled();
    expect(result.current.errorFor('A-1')).toBe('only a decided finding reopens');
    expect(result.current.errorFor('A-2')).toBeNull();
  });

  it('reports a refused write did not land', async () => {
    const finding = makeFinding({ id: 'A-1' });
    const { result } = setup((() =>
      Promise.resolve(
        jsonResponse({ error: { code: 'invalid-transition', message: 'no' } }, 409)
      )) as unknown as typeof globalThis.fetch);

    let landed = true;
    await act(async () => {
      landed = await result.current.run(finding, 'reopen', {});
    });

    expect(landed).toBe(false);
  });

  it('clears a stale refusal when the next write is tried', async () => {
    const finding = makeFinding({ id: 'A-1' });
    let refuse = true;
    const call = (): Promise<Response> =>
      Promise.resolve(
        refuse
          ? jsonResponse({ error: { code: 'invalid', message: 'no' } }, 400)
          : jsonResponse(effect(finding))
      );
    const { result } = setup(call as unknown as typeof globalThis.fetch);

    await act(async () => {
      await result.current.run(finding, 'reopen', {});
    });
    refuse = false;
    await act(async () => {
      await result.current.run(finding, 'reopen', {});
    });

    expect(result.current.errorFor('A-1')).toBeNull();
  });

  it('retries a refusal the server says can be retried rather than reporting it', async () => {
    const finding = makeFinding({ id: 'A-1' });
    const call = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 'locked', message: 'held by another writer', retryable: true } },
          503
        )
      )
      .mockResolvedValueOnce(jsonResponse(effect(finding)));
    const { put, result } = setup(call as unknown as typeof globalThis.fetch);

    await act(async () => {
      await result.current.run(finding, 'reopen', {});
    });

    expect(call).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledWith(finding);
    expect(result.current.errorFor('A-1')).toBeNull();
  });

  it('uses the page fetch when nothing is injected', async () => {
    const finding = makeFinding({ id: 'A-1' });
    const call = vi.fn(() => Promise.resolve(jsonResponse(effect(finding))));
    vi.spyOn(globalThis, 'fetch').mockImplementation(call as unknown as typeof globalThis.fetch);
    const put = vi.fn();
    const { result } = renderHook(() => usePaneWrites({ put }), { wrapper: withAuditAddress });

    await act(async () => {
      await result.current.run(finding, 'reopen', {});
    });

    expect(call).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
