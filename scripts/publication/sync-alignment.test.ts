import { describe, expect, it, vi } from 'vitest';
import {
  ALIGNMENT_ATTEMPTS,
  awaitAlignment,
  isAligned,
  readAlignment,
  readMainHead,
} from './sync-alignment.js';

const REPOSITORIES = {
  publicRepo: 'owner/pub',
  stagingRepo: 'owner/staging',
  recordsRepo: 'owner/records',
};

/** Synthetic object ids, distinct so a call carrying the wrong one is visible. */
const PUBLIC_HEAD = '1'.repeat(40);
const STAGING_HEAD = '2'.repeat(40);

interface StubbedResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

const ref = (sha: string): StubbedResponse => ({
  ok: true,
  status: 200,
  body: { object: { sha } },
});
const compare = (status: string): StubbedResponse => ({ ok: true, status: 200, body: { status } });
const missing: StubbedResponse = { ok: false, status: 404, body: {} };

/**
 * A fetch stub routed by URL rather than by call order, so a test asserting
 * which repository was asked cannot be satisfied by asking the other one twice.
 * Every request is recorded, in order, for the ordering assertions.
 */
function routedFetch(routes: Readonly<Record<string, StubbedResponse>>): {
  readonly fetchImpl: typeof fetch;
  readonly urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = ((url: string) => {
    urls.push(url);
    const match = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    if (match === undefined) throw new Error(`the alignment check asked an unrouted URL`);
    const [, response] = match;
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      json: (): Promise<unknown> => Promise.resolve(response.body),
    } as Response);
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

/** The routes of a healthy pass: each repository answers its own head. */
const alignedRoutes = (status = 'ahead'): Record<string, StubbedResponse> => ({
  'repos/owner/pub/git/ref/heads/main': ref(PUBLIC_HEAD),
  'repos/owner/staging/git/ref/heads/main': ref(STAGING_HEAD),
  'repos/owner/staging/compare/': compare(status),
});

describe('isAligned', () => {
  it('accepts staging holding exactly what public holds', () => {
    expect(isAligned('identical')).toBe(true);
  });

  it('accepts staging being ahead, which is the ordinary steady state', () => {
    expect(isAligned('ahead')).toBe(true);
  });

  it('refuses staging missing a public commit', () => {
    expect(isAligned('behind')).toBe(false);
  });

  it('refuses a history that has forked', () => {
    expect(isAligned('diverged')).toBe(false);
  });

  it('refuses staging not holding the public head at all', () => {
    expect(isAligned('absent')).toBe(false);
  });

  it('refuses a status it does not recognise rather than reading it as a pass', () => {
    expect(isAligned('something-new')).toBe(false);
  });
});

describe('readMainHead', () => {
  it('asks the named repository for its own branch, addressing it by path', async () => {
    const { fetchImpl } = routedFetch({ 'repos/owner/pub/git/ref/heads/main': ref(PUBLIC_HEAD) });

    await expect(readMainHead(fetchImpl, 'token', 'owner/pub')).resolves.toBe(PUBLIC_HEAD);
  });

  it('refuses a repository whose branch cannot be resolved', async () => {
    const { fetchImpl } = routedFetch({ 'repos/owner/pub': missing });

    await expect(readMainHead(fetchImpl, 'token', 'owner/pub')).rejects.toThrow('404');
  });

  it('refuses an answer carrying no object id rather than guessing one', async () => {
    const { fetchImpl } = routedFetch({
      'repos/owner/pub': { ok: true, status: 200, body: { object: {} } },
    });

    await expect(readMainHead(fetchImpl, 'token', 'owner/pub')).rejects.toThrow('no object id');
  });
});

describe('readAlignment', () => {
  /**
   * The gate's whole value is that the two sides are two repositories. A
   * question that resolved both inside one of them would answer `identical`
   * forever, so this asserts the compare carries two DIFFERENT object ids, each
   * fetched from its own repository's path.
   */
  it('resolves each repository head in its own repository, never both in one', async () => {
    const { fetchImpl, urls } = routedFetch(alignedRoutes());

    await readAlignment(fetchImpl, 'token', REPOSITORIES);

    expect(urls).toContain('https://api.github.com/repos/owner/pub/git/ref/heads/main');
    expect(urls).toContain('https://api.github.com/repos/owner/staging/git/ref/heads/main');
    expect(urls).toContain(
      `https://api.github.com/repos/owner/staging/compare/${PUBLIC_HEAD}...${STAGING_HEAD}`
    );
  });

  it('asks the staging repository, so no ref grammar can re-point the question', async () => {
    const { fetchImpl, urls } = routedFetch(alignedRoutes());

    await readAlignment(fetchImpl, 'token', REPOSITORIES);

    const comparison = urls.find((url) => url.includes('/compare/'));
    expect(comparison?.startsWith('https://api.github.com/repos/owner/staging/')).toBe(true);
  });

  it('reads staging before public, so a mid-check publication errs towards refusing', async () => {
    const { fetchImpl, urls } = routedFetch(alignedRoutes());

    await readAlignment(fetchImpl, 'token', REPOSITORIES);

    expect(urls.slice(0, 2)).toEqual([
      'https://api.github.com/repos/owner/staging/git/ref/heads/main',
      'https://api.github.com/repos/owner/pub/git/ref/heads/main',
    ]);
  });

  it('reports the status the comparison answered with', async () => {
    const { fetchImpl } = routedFetch(alignedRoutes('behind'));

    await expect(readAlignment(fetchImpl, 'token', REPOSITORIES)).resolves.toBe('behind');
  });

  it('reads staging not holding the public commit at all as a wait, not an error', async () => {
    const { fetchImpl } = routedFetch({
      ...alignedRoutes(),
      'repos/owner/staging/compare/': missing,
    });

    await expect(readAlignment(fetchImpl, 'token', REPOSITORIES)).resolves.toBe('absent');
  });

  it('refuses a comparison that failed for any other reason', async () => {
    const { fetchImpl } = routedFetch({
      ...alignedRoutes(),
      'repos/owner/staging/compare/': { ok: false, status: 401, body: {} },
    });

    await expect(readAlignment(fetchImpl, 'token', REPOSITORIES)).rejects.toThrow('401');
  });

  it('refuses an answer carrying no status rather than guessing one', async () => {
    const { fetchImpl } = routedFetch({
      ...alignedRoutes(),
      'repos/owner/staging/compare/': { ok: true, status: 200, body: {} },
    });

    await expect(readAlignment(fetchImpl, 'token', REPOSITORIES)).rejects.toThrow('no status');
  });
});

describe('awaitAlignment', () => {
  it('passes as soon as the two are aligned', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const { fetchImpl } = routedFetch(alignedRoutes('identical'));

    await expect(awaitAlignment(fetchImpl, 'token', REPOSITORIES, sleep)).resolves.toBe(
      'identical'
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits between attempts while the sync has not caught up', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const statuses = ['behind', 'ahead'];
    const { fetchImpl } = routedFetch({
      ...alignedRoutes(),
      'repos/owner/staging/compare/': compare('behind'),
    });
    const sequenced = ((url: string) => {
      if (url.includes('/compare/')) {
        const status = statuses.shift() ?? 'ahead';
        return Promise.resolve({
          ok: true,
          status: 200,
          json: (): Promise<unknown> => Promise.resolve({ status }),
        } as Response);
      }
      return fetchImpl(url);
    }) as unknown as typeof fetch;

    await expect(awaitAlignment(sequenced, 'token', REPOSITORIES, sleep)).resolves.toBe('ahead');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('fails closed once the attempts are spent rather than letting the merge proceed', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const { fetchImpl } = routedFetch(alignedRoutes('behind'));

    await expect(awaitAlignment(fetchImpl, 'token', REPOSITORIES, sleep)).rejects.toThrow('behind');
    expect(sleep).toHaveBeenCalledTimes(ALIGNMENT_ATTEMPTS - 1);
  });
});
