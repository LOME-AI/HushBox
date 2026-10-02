import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  POLL_ATTEMPTS,
  checkAccessWall,
  checkWorkerTag,
  main,
  probeBuildIdentity,
  verifyDeployedSurfaces,
  type ProbeSeams,
  type ProbeTargets,
} from './verify-deployed-surfaces.js';

import type { WranglerAnswer, WranglerRunner } from '../lib/wrangler/live-version.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const VERSION = '1.2.3';
const RUN_ID = '4242';
const TEAM = 'example-team';
const ORIGIN = 'https://surface.example';
const LIVE_VERSION_ID = 'live-version-id';
const byName = (left: string, right: string): number => left.localeCompare(right);

const ORIGINS = {
  FRONTEND_URL: 'https://web.example',
  SANDBOX_ORIGIN_URL: 'https://sandbox.example',
  ADMIN_URL: 'https://admin.example',
};

const TARGETS: ProbeTargets = {
  version: VERSION,
  runId: RUN_ID,
  accessTeamDomain: TEAM,
  origins: ORIGINS,
};

const json = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const html = (): Response =>
  new Response('<!doctype html><html></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
const notFound = (): Response => new Response('not found', { status: 404 });
const redirect = (location: string | null): Response =>
  new Response(null, { status: 302, headers: location === null ? {} : { location } });

const STAMP = `{"version":"${VERSION}"}`;
const ACCESS_LOGIN = `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/login/admin.example`;

/** The URL a string or request input names. */
const requestUrl = (input: string | Request): string =>
  typeof input === 'string' ? input : input.url;

/** A fetch answering each call from `answer`, and recording the URLs and options it was handed. */
function fetchAnswering(answer: (url: string, call: number) => Response | Error): {
  readonly fetch: ProbeSeams['fetch'];
  readonly urls: string[];
  readonly inits: (RequestInit | undefined)[];
} {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetch: ProbeSeams['fetch'] = (input, init) => {
    const url = input instanceof URL ? input.href : requestUrl(input);
    urls.push(url);
    inits.push(init);
    const answered = answer(url, urls.length);
    return answered instanceof Error ? Promise.reject(answered) : Promise.resolve(answered);
  };
  return { fetch, urls, inits };
}

const printed = (stdout: string): WranglerAnswer => ({ exitCode: 0, stdout, stderr: '' });
const exited = (stderr: string): WranglerAnswer => ({ exitCode: 1, stdout: '', stderr });

interface Traffic {
  readonly version_id: string;
  readonly percentage: number;
}
const deployment = (versions: readonly Traffic[]): string => JSON.stringify({ versions });
const wholly = deployment([{ version_id: LIVE_VERSION_ID, percentage: 100 }]);
const tagged = (tag: string): string =>
  JSON.stringify({ id: LIVE_VERSION_ID, annotations: { 'workers/tag': tag } });

/** A control plane answering the two reads, and recording what it was asked. */
function controlPlane(
  status: WranglerAnswer,
  view: WranglerAnswer
): { readonly wrangler: WranglerRunner; readonly calls: string[][] } {
  const calls: string[][] = [];
  const wrangler: WranglerRunner = (args) => {
    calls.push([...args]);
    return Promise.resolve(args[0] === 'deployments' ? status : view);
  };
  return { wrangler, calls };
}

const live = (tag: string): WranglerRunner =>
  controlPlane(printed(wholly), printed(tagged(tag))).wrangler;

const noSleep = (): Promise<void> => Promise.resolve();

function seams(overrides: Partial<ProbeSeams>): ProbeSeams {
  return {
    fetch: fetchAnswering(() => json(STAMP)).fetch,
    wrangler: live(`v${VERSION}`),
    sleep: noSleep,
    ...overrides,
  };
}

describe('probeBuildIdentity', () => {
  it('passes an origin serving this version as JSON', async () => {
    const failure = await probeBuildIdentity(ORIGIN, TARGETS, seams({}));

    expect(failure).toBeUndefined();
  });

  it('asks for the stamp with the run id as its query, so no cache answers for it', async () => {
    const { fetch, urls } = fetchAnswering(() => json(STAMP));

    await probeBuildIdentity(ORIGIN, TARGETS, seams({ fetch }));

    expect(urls).toEqual([`${ORIGIN}/build.json?${RUN_ID}`]);
  });

  it('follows no redirect, so only the origin itself can answer', async () => {
    const { fetch, inits } = fetchAnswering(() => json(STAMP));

    await probeBuildIdentity(ORIGIN, TARGETS, seams({ fetch }));

    expect(inits[0]?.redirect).toBe('manual');
  });

  it('fails an HTML page answered at 200, which is what a fallback serves for a missing file', async () => {
    const failure = await probeBuildIdentity(
      ORIGIN,
      TARGETS,
      seams({ fetch: fetchAnswering(() => html()).fetch })
    );

    expect(failure).toContain('text/html');
  });

  it('fails JSON served without a JSON content type', async () => {
    const plain = new Response(STAMP, { status: 200, headers: { 'content-type': 'text/plain' } });

    const failure = await probeBuildIdentity(
      ORIGIN,
      TARGETS,
      seams({ fetch: fetchAnswering(() => plain.clone()).fetch })
    );

    expect(failure).toContain('text/plain');
  });

  it('fails an answer declaring no content type', async () => {
    const failure = await probeBuildIdentity(
      ORIGIN,
      TARGETS,
      seams({ fetch: fetchAnswering(() => new Response(null, { status: 200 })).fetch })
    );

    expect(failure).toContain('(none)');
  });

  it('fails an origin serving another version, naming it', async () => {
    const failure = await probeBuildIdentity(
      ORIGIN,
      TARGETS,
      seams({ fetch: fetchAnswering(() => json('{"version":"1.2.2"}')).fetch })
    );

    expect(failure).toContain('1.2.2');
  });

  it('fails a JSON answer that is not a stamp', async () => {
    const failure = await probeBuildIdentity(
      ORIGIN,
      TARGETS,
      seams({ fetch: fetchAnswering(() => json('{"ok":true}')).fetch })
    );

    expect(failure).toContain('shape');
  });

  it('polls an absent file up to its bound, then fails', async () => {
    const { fetch, urls } = fetchAnswering(() => notFound());
    const sleep = vi.fn(noSleep);

    const failure = await probeBuildIdentity(ORIGIN, TARGETS, seams({ fetch, sleep }));

    expect(failure).toContain('404');
    expect(urls).toHaveLength(POLL_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(POLL_ATTEMPTS - 1);
  });

  it('fails a redirect rather than reading wherever it points', async () => {
    const failure = await probeBuildIdentity(
      ORIGIN,
      TARGETS,
      seams({ fetch: fetchAnswering(() => redirect(`${ORIGIN}/`)).fetch })
    );

    expect(failure).toContain('302');
  });

  it('fails an origin that never answers, naming the error', async () => {
    const failure = await probeBuildIdentity(
      ORIGIN,
      TARGETS,
      seams({ fetch: fetchAnswering(() => new Error('getaddrinfo ENOTFOUND')).fetch })
    );

    expect(failure).toContain('ENOTFOUND');
  });

  it('passes once the edge stops serving the previous version', async () => {
    const { fetch, urls } = fetchAnswering((_url, call) =>
      call < 3 ? json('{"version":"1.2.2"}') : json(STAMP)
    );

    const failure = await probeBuildIdentity(ORIGIN, TARGETS, seams({ fetch }));

    expect(failure).toBeUndefined();
    expect(urls).toHaveLength(3);
  });
});

describe('checkWorkerTag', () => {
  const directory = path.join(REPO_ROOT, 'apps', 'admin');

  it('passes a Worker wholly on the version tagged with this release', async () => {
    expect(await checkWorkerTag(directory, VERSION, live(`v${VERSION}`))).toBeUndefined();
  });

  it("reads the control plane through the surface's own configuration", async () => {
    const { wrangler, calls } = controlPlane(printed(wholly), printed(tagged(`v${VERSION}`)));

    await checkWorkerTag(directory, VERSION, wrangler);

    expect(calls).toEqual([
      ['deployments', 'status', '--json', '--cwd', directory],
      ['versions', 'view', LIVE_VERSION_ID, '--json', '--cwd', directory],
    ]);
  });

  it('fails a Worker whose live version carries another tag, naming it', async () => {
    const failure = await checkWorkerTag(directory, VERSION, live('v1.2.2'));

    expect(failure).toContain('v1.2.2');
  });

  it('fails a Worker whose live version carries no tag', async () => {
    const { wrangler } = controlPlane(
      printed(wholly),
      printed(JSON.stringify({ id: LIVE_VERSION_ID }))
    );

    expect(await checkWorkerTag(directory, VERSION, wrangler)).toContain('no tag');
  });

  it('fails a deployment split across versions', async () => {
    const split = deployment([
      { version_id: LIVE_VERSION_ID, percentage: 90 },
      { version_id: 'other', percentage: 10 },
    ]);
    const { wrangler } = controlPlane(printed(split), printed(tagged(`v${VERSION}`)));

    expect(await checkWorkerTag(directory, VERSION, wrangler)).toContain('split');
  });

  it('fails a deployment that sends the version less than all traffic', async () => {
    const partial = deployment([{ version_id: LIVE_VERSION_ID, percentage: 50 }]);
    const { wrangler } = controlPlane(printed(partial), printed(tagged(`v${VERSION}`)));

    expect(await checkWorkerTag(directory, VERSION, wrangler)).toContain('split');
  });

  it('fails a Worker with no deployment', async () => {
    const { wrangler } = controlPlane(
      exited('The Worker hushbox-admin has no deployments.'),
      printed('')
    );

    expect(await checkWorkerTag(directory, VERSION, wrangler)).toContain('no deployments');
  });

  it('fails a deployment answer of an unexpected shape', async () => {
    const { wrangler } = controlPlane(printed('{"versions":"all"}'), printed(''));

    expect(await checkWorkerTag(directory, VERSION, wrangler)).toContain('unexpected shape');
  });

  it('fails a version that cannot be read', async () => {
    const { wrangler } = controlPlane(printed(wholly), exited('Authentication error'));

    expect(await checkWorkerTag(directory, VERSION, wrangler)).toContain('Authentication error');
  });

  it('fails a control plane that could not be reached at all', async () => {
    const wrangler: WranglerRunner = () => Promise.reject(new Error('spawn pnpm ENOENT'));

    expect(await checkWorkerTag(directory, VERSION, wrangler)).toContain('ENOENT');
  });

  it('fails an answer that is not JSON', async () => {
    const { wrangler } = controlPlane(printed('not json'), printed(''));

    expect(await checkWorkerTag(directory, VERSION, wrangler)).toContain('failed');
  });
});

describe('checkAccessWall', () => {
  it('passes an origin that redirects to the Access team domain', async () => {
    const { fetch } = fetchAnswering(() => redirect(ACCESS_LOGIN));

    expect(await checkAccessWall(ORIGIN, TEAM, fetch)).toBeUndefined();
  });

  it('asks for the root without following the redirect', async () => {
    const { fetch, urls, inits } = fetchAnswering(() => redirect(ACCESS_LOGIN));

    await checkAccessWall(ORIGIN, TEAM, fetch);

    expect(urls).toEqual([`${ORIGIN}/`]);
    expect(inits[0]?.redirect).toBe('manual');
  });

  it('fails an origin answering 200, which means it is public', async () => {
    const { fetch } = fetchAnswering(() => html());

    expect(await checkAccessWall(ORIGIN, TEAM, fetch)).toContain('200');
  });

  it('fails a redirect to a host that is not Access', async () => {
    const { fetch } = fetchAnswering(() => redirect('https://elsewhere.example/login'));

    expect(await checkAccessWall(ORIGIN, TEAM, fetch)).toContain('elsewhere.example');
  });

  it("fails a redirect to another team's Access host", async () => {
    const { fetch } = fetchAnswering(() =>
      redirect('https://other-team.cloudflareaccess.com/cdn-cgi/access/login/admin.example')
    );

    expect(await checkAccessWall(ORIGIN, TEAM, fetch)).toContain('other-team.cloudflareaccess.com');
  });

  it('fails a redirect naming no location', async () => {
    const { fetch } = fetchAnswering(() => redirect(null));

    expect(await checkAccessWall(ORIGIN, TEAM, fetch)).toContain('no location');
  });

  it('fails an origin that never answers, naming the error', async () => {
    const { fetch } = fetchAnswering(() => new Error('getaddrinfo ENOTFOUND'));

    expect(await checkAccessWall(ORIGIN, TEAM, fetch)).toContain('ENOTFOUND');
  });
});

/** A fetch answering each surface the way a healthy deploy does. */
const healthyFetch = (url: string): Response =>
  url.startsWith(ORIGINS.ADMIN_URL) ? redirect(ACCESS_LOGIN) : json(STAMP);

describe('verifyDeployedSurfaces', () => {
  it('reports nothing when every surface serves this version', async () => {
    const failures = await verifyDeployedSurfaces(
      TARGETS,
      seams({ fetch: fetchAnswering(healthyFetch).fetch })
    );

    expect(failures).toEqual([]);
  });

  it('reads the stamp off every public surface', async () => {
    const { fetch, urls } = fetchAnswering(healthyFetch);

    await verifyDeployedSurfaces(TARGETS, seams({ fetch }));

    expect(urls.filter((url) => url.includes('/build.json')).toSorted(byName)).toEqual(
      [
        `${ORIGINS.FRONTEND_URL}/build.json?${RUN_ID}`,
        `${ORIGINS.SANDBOX_ORIGIN_URL}/build.json?${RUN_ID}`,
      ].toSorted(byName)
    );
  });

  it('reads the control plane of every Worker surface', async () => {
    const { wrangler, calls } = controlPlane(printed(wholly), printed(tagged(`v${VERSION}`)));

    await verifyDeployedSurfaces(
      TARGETS,
      seams({ fetch: fetchAnswering(healthyFetch).fetch, wrangler })
    );

    const directories = calls
      .filter((call) => call[0] === 'deployments')
      .map((call) => call.at(-1) ?? '')
      .toSorted(byName);
    expect(directories).toEqual([
      path.join(REPO_ROOT, 'apps', 'admin'),
      path.join(REPO_ROOT, 'apps', 'sandbox'),
    ]);
  });

  it('names the surface each failure belongs to', async () => {
    const failures = await verifyDeployedSurfaces(
      TARGETS,
      seams({ fetch: fetchAnswering(() => html()).fetch })
    );

    expect(failures.map((failure) => failure.split(':')[0] ?? '').toSorted(byName)).toEqual([
      'apps/admin',
      'apps/sandbox',
      'apps/web',
    ]);
  });

  it('fails a surface whose origin was not given, naming the variable', async () => {
    const failures = await verifyDeployedSurfaces(
      {
        ...TARGETS,
        origins: {
          FRONTEND_URL: ORIGINS.FRONTEND_URL,
          SANDBOX_ORIGIN_URL: ORIGINS.SANDBOX_ORIGIN_URL,
        },
      },
      seams({ fetch: fetchAnswering(healthyFetch).fetch })
    );

    expect(failures).toEqual(['apps/admin: no origin was given for ADMIN_URL']);
  });
});

describe('main', () => {
  const ENVIRONMENT: NodeJS.ProcessEnv = {
    VERSION,
    GITHUB_RUN_ID: RUN_ID,
    CF_ACCESS_TEAM_DOMAIN: TEAM,
    ...ORIGINS,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports success when every surface serves this version', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await main(ENVIRONMENT, seams({ fetch: fetchAnswering(healthyFetch).fetch }));

    expect(write).toHaveBeenCalledWith(expect.stringContaining(`v${VERSION}`));
  });

  it('refuses the release, listing every surface that failed', async () => {
    await expect(
      main(ENVIRONMENT, seams({ fetch: fetchAnswering(() => html()).fetch }))
    ).rejects.toThrow(/apps\/web[\s\S]*apps\/sandbox|apps\/sandbox[\s\S]*apps\/web/);
  });

  it.each(['VERSION', 'GITHUB_RUN_ID', 'CF_ACCESS_TEAM_DOMAIN', 'FRONTEND_URL', 'ADMIN_URL'])(
    'refuses to run without %s',
    async (key) => {
      const environment = { ...ENVIRONMENT, [key]: '' };

      await expect(main(environment, seams({}))).rejects.toThrow(`${key} is required`);
    }
  );
});
