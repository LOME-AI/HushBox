import { describe, it, expect, vi } from 'vitest';
import { makeFinding } from '@/test-utils/finding-fixture';
import { REPLACES_BY_ACTION, undoLastWrite, writeFinding } from './finding-writes';
import type { FindingAction } from './finding-writes';

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** A fresh Response per call: a body may be read only once, and a retry re-reads. */
function responds(status: number, body: unknown): () => Promise<Response> {
  return () => Promise.resolve(jsonResponse(status, body));
}

/** The audit every write in here addresses. */
const AUDIT = '2026-07-30';

/** The finding as the reader has it, which is what every write is built on. */
const asRead = makeFinding({ id: 'AI-1', hash: 'version-7' });
const effect = { finding: makeFinding({ id: 'AI-1' }), undoToken: 'token-1' };
const locked = {
  error: { code: 'locked', message: 'another writer holds the file', retryable: true },
};

describe('writeFinding', () => {
  it('posts the action to the finding route and returns the write effect', async () => {
    const fetchMock = vi.fn().mockImplementation(responds(200, effect));

    const outcome = await writeFinding(
      { audit: AUDIT, finding: asRead, action: 'rule', body: { option: 'A' } },
      { fetch: fetchMock }
    );

    expect(outcome).toEqual({ ok: true, value: effect });
    expect(fetchMock).toHaveBeenCalledWith('/api/audits/2026-07-30/finding/AI-1/rule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ option: 'A', base: 'version-7' }),
    });
  });

  it('encodes a finding id that is not url safe', async () => {
    const fetchMock = vi.fn().mockImplementation(responds(200, effect));

    await writeFinding(
      { audit: AUDIT, finding: { id: 'TS-NF/1', hash: 'version-7' }, action: 'deny', body: {} },
      { fetch: fetchMock }
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/audits/2026-07-30/finding/TS-NF%2F1/deny');
  });

  it('reports the server message when the write is refused', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(409, { error: { code: 'invalid-transition', message: 'already denied' } })
      );

    const outcome = await writeFinding(
      { audit: AUDIT, finding: asRead, action: 'deny', body: {} },
      { fetch: fetchMock }
    );

    expect(outcome).toEqual({ ok: false, message: 'already denied' });
  });

  it('falls back to the status when the refusal carries no message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not json', { status: 500 }));

    const outcome = await writeFinding(
      { audit: AUDIT, finding: asRead, action: 'deny', body: {} },
      { fetch: fetchMock }
    );

    expect(outcome).toEqual({ ok: false, message: 'the write was refused (500)' });
  });

  it('falls back to the status when the refusal has no body at all', async () => {
    const fetchMock = vi.fn().mockImplementation(responds(500, null));

    const outcome = await writeFinding(
      { audit: AUDIT, finding: asRead, action: 'deny', body: {} },
      { fetch: fetchMock }
    );

    expect(outcome).toEqual({ ok: false, message: 'the write was refused (500)' });
  });

  it('reports a dead server rather than throwing', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

    const outcome = await writeFinding(
      { audit: AUDIT, finding: asRead, action: 'deny', body: {} },
      { fetch: fetchMock }
    );

    expect(outcome).toEqual({ ok: false, message: 'Failed to fetch' });
  });

  it('reports a non-error rejection', async () => {
    // non-Error rejection is exactly the case this covers.
    const fetchMock = vi.fn().mockRejectedValue('socket closed');

    const outcome = await writeFinding(
      { audit: AUDIT, finding: asRead, action: 'deny', body: {} },
      { fetch: fetchMock }
    );

    expect(outcome).toEqual({ ok: false, message: 'the write could not be sent' });
  });

  it('retries a retryable refusal instead of reporting it', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(responds(503, locked))
      .mockImplementationOnce(responds(200, effect));

    const outcome = await writeFinding(
      { audit: AUDIT, finding: asRead, action: 'rule', body: { option: 'A' } },
      { fetch: fetchMock, wait: () => Promise.resolve() }
    );

    expect(outcome).toEqual({ ok: true, value: effect });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits between retries', async () => {
    const waited: number[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(responds(503, locked))
      .mockImplementationOnce(responds(200, effect));

    await writeFinding(
      { audit: AUDIT, finding: asRead, action: 'rule', body: { option: 'A' } },
      {
        fetch: fetchMock,
        wait: (ms) => {
          waited.push(ms);
          return Promise.resolve();
        },
      }
    );

    expect(waited).toEqual([250]);
  });

  it('says it is waiting when a refusal is going to be retried', async () => {
    const onWaiting = vi.fn();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(responds(503, locked))
      .mockImplementationOnce(responds(200, effect));

    await writeFinding(
      { audit: AUDIT, finding: asRead, action: 'rule', body: { option: 'A' } },
      { fetch: fetchMock, wait: () => Promise.resolve(), onWaiting }
    );

    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  it('says nothing about waiting on a refusal it will not retry', async () => {
    const onWaiting = vi.fn();
    const fetchMock = vi
      .fn()
      .mockImplementation(
        responds(409, { error: { code: 'invalid-transition', message: 'already denied' } })
      );

    await writeFinding(
      { audit: AUDIT, finding: asRead, action: 'deny', body: {} },
      { fetch: fetchMock, onWaiting }
    );

    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('says nothing about waiting once the last attempt is spent', async () => {
    const onWaiting = vi.fn();
    const fetchMock = vi.fn().mockImplementation(responds(503, locked));

    await writeFinding(
      { audit: AUDIT, finding: asRead, action: 'rule', body: { option: 'A' } },
      { fetch: fetchMock, wait: () => Promise.resolve(), attempts: 1, onWaiting }
    );

    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('gives up on a retryable refusal that never clears', async () => {
    // A fresh Response per call: a body may only be read once, and the retry
    // loop reads every refusal it gets.
    const fetchMock = vi.fn().mockImplementation(responds(503, locked));

    const outcome = await writeFinding(
      { audit: AUDIT, finding: asRead, action: 'rule', body: { option: 'A' } },
      { fetch: fetchMock, wait: () => Promise.resolve(), attempts: 3 }
    );

    expect(outcome).toEqual({ ok: false, message: 'another writer holds the file' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a refusal that is not retryable', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(responds(404, { error: { code: 'not-found', message: 'no finding' } }));

    await writeFinding(
      { audit: AUDIT, finding: asRead, action: 'rule', body: { option: 'A' } },
      { fetch: fetchMock, wait: () => Promise.resolve() }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the version a write is built on', () => {
  async function bodySentFor(action: FindingAction, body: object): Promise<unknown> {
    const fetchMock = vi.fn().mockImplementation(responds(200, effect));
    await writeFinding(
      { audit: AUDIT, finding: asRead, action: action, body: body },
      { fetch: fetchMock }
    );
    return JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
  }

  it.each<[FindingAction, object]>([
    ['rule', { option: 'A' }],
    ['deny', {}],
    ['reopen', {}],
    ['withdraw', { index: 0 }],
    ['progress', { status: 'blocked' }],
    ['progress', { verified: true }],
  ])('names the version a %s was decided on', async (action, body) => {
    expect(await bodySentFor(action, body)).toEqual({ ...body, base: 'version-7' });
  });

  it.each<[FindingAction, object]>([
    ['ask', { text: 'Which slice owns this?' }],
    ['progress', { note: 'still waiting on the schema change' }],
  ])('leaves a %s unfenced, because it appends rather than replaces', async (action, body) => {
    expect(await bodySentFor(action, body)).toEqual(body);
  });

  // The table's type makes a new action fail typecheck until it is classified;
  // this pins that no action already there is classified by accident.
  it('classifies every action the console can post', () => {
    expect(REPLACES_BY_ACTION).toEqual({
      rule: true,
      dedicate: true,
      deny: true,
      reopen: true,
      withdraw: true,
      unblock: true,
      ask: false,
      progress: expect.any(Function),
    });
  });
});

describe('undoLastWrite', () => {
  it('posts the token to the undo route', async () => {
    const fetchMock = vi.fn().mockImplementation(responds(200, effect));

    const outcome = await undoLastWrite('token-1', { fetch: fetchMock });

    expect(outcome).toEqual({ ok: true, value: effect });
    expect(fetchMock).toHaveBeenCalledWith('/api/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'token-1' }),
    });
  });

  it('reports a refused undo', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(404, { error: { code: 'not-found', message: 'unknown undo token' } })
      );

    expect(await undoLastWrite('gone', { fetch: fetchMock })).toEqual({
      ok: false,
      message: 'unknown undo token',
    });
  });
});

describe('the defaults the console actually runs on', () => {
  it('sends through the page fetch when none is injected', async () => {
    const fetchMock = vi.fn().mockImplementation(responds(200, effect));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await writeFinding({
      audit: AUDIT,
      finding: asRead,
      action: 'rule',
      body: { option: 'A' },
    });

    expect(outcome).toEqual({ ok: true, value: effect });
    vi.unstubAllGlobals();
  });

  it('waits on a real timer between retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(responds(503, locked))
      .mockImplementationOnce(responds(200, effect));

    const pending = writeFinding(
      { audit: AUDIT, finding: asRead, action: 'rule', body: { option: 'A' } },
      { fetch: fetchMock }
    );
    await vi.advanceTimersByTimeAsync(250);

    expect(await pending).toEqual({ ok: true, value: effect });
    vi.useRealTimers();
  });
});
