import { describe, it, expect, vi } from 'vitest';
import { createSourceReader } from './source-window';
import type { SourceWindow } from '@hushbox/docket';

const WINDOW: SourceWindow = {
  path: 'apps/api/src/lib/jobs/pass.ts',
  exists: true,
  stale: false,
  requestedStart: 189,
  requestedEnd: 202,
  start: 183,
  end: 208,
  lines: ['const pass = 1;'],
};

/** The audit every peek in here is read against. */
const AUDIT = '2026-07-30';

const CITATION = { path: 'apps/api/src/lib/jobs/pass.ts', start: 189, end: 202 };

function served(body: unknown, status = 200): typeof fetch {
  return vi.fn(() => Promise.resolve(Response.json(body, { status }))) as unknown as typeof fetch;
}

describe('createSourceReader', () => {
  it('asks the server for the cited path and range', async () => {
    const fetchImpl = served(WINDOW);
    await createSourceReader(AUDIT, fetchImpl)(CITATION);

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/audits/2026-07-30/source?path=apps%2Fapi%2Fsrc%2Flib%2Fjobs%2Fpass.ts&start=189&end=202'
    );
  });

  it('hands back the window the server read', async () => {
    const outcome = await createSourceReader(AUDIT, served(WINDOW))(CITATION);

    expect(outcome).toEqual({ ok: true, window: WINDOW });
  });

  it('serves a second read of the same range from the session cache', async () => {
    const fetchImpl = served(WINDOW);
    const read = createSourceReader(AUDIT, fetchImpl);

    await read(CITATION);
    await read({ ...CITATION });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reads another range in the same file on its own', async () => {
    const fetchImpl = served(WINDOW);
    const read = createSourceReader(AUDIT, fetchImpl);

    await read(CITATION);
    await read({ ...CITATION, start: 268, end: 268 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one request between two reads that overlap', async () => {
    const fetchImpl = served(WINDOW);
    const read = createSourceReader(AUDIT, fetchImpl);

    await Promise.all([read(CITATION), read(CITATION)]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('says in words that a path outside the repository was refused', async () => {
    const outcome = await createSourceReader(
      AUDIT,
      served({ error: { code: 'outside-root', message: 'the source request was refused' } }, 400)
    )(CITATION);

    expect(outcome).toEqual({
      ok: false,
      message: 'that path resolves outside the repository, so it was not read',
    });
  });

  it('passes on any other refusal in the words the server used', async () => {
    const outcome = await createSourceReader(
      AUDIT,
      served({ error: { code: 'invalid', message: 'a positive start line is required' } }, 400)
    )(CITATION);

    expect(outcome).toEqual({ ok: false, message: 'a positive start line is required' });
  });

  it('describes a refusal it cannot read a message from', async () => {
    const outcome = await createSourceReader(AUDIT, served('nope', 500))(CITATION);

    expect(outcome).toEqual({ ok: false, message: 'the source could not be read (500)' });
  });

  it('describes a dead server', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error('connection refused'))
    ) as unknown as typeof fetch;

    expect(await createSourceReader(AUDIT, fetchImpl)(CITATION)).toEqual({
      ok: false,
      message: 'connection refused',
    });
  });

  it('describes a failure that is not an error object', async () => {
    const fetchImpl = vi.fn(() =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejecting with a non-Error is exactly the case under test
      Promise.reject('not an error')
    ) as unknown as typeof fetch;

    expect(await createSourceReader(AUDIT, fetchImpl)(CITATION)).toEqual({
      ok: false,
      message: 'the source could not be read',
    });
  });

  it('reads again after a failure rather than caching it', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(Response.json(WINDOW, { status: 200 })) as unknown as typeof fetch;
    const read = createSourceReader(AUDIT, fetchImpl);

    await read(CITATION);

    expect(await read(CITATION)).toEqual({ ok: true, window: WINDOW });
  });

  it('reads again after a refusal, so a fixed path is not held against the reader', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 'invalid' } }, { status: 400 }))
      .mockResolvedValueOnce(Response.json(WINDOW, { status: 200 })) as unknown as typeof fetch;
    const read = createSourceReader(AUDIT, fetchImpl);

    await read(CITATION);

    expect(await read(CITATION)).toEqual({ ok: true, window: WINDOW });
  });

  it('reads through the page fetch when none is injected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(WINDOW, { status: 200 })))
    );

    expect(await createSourceReader(AUDIT)(CITATION)).toEqual({ ok: true, window: WINDOW });

    vi.unstubAllGlobals();
  });
});
