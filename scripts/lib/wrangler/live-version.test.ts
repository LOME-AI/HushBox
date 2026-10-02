import { describe, expect, it } from 'vitest';

import { readLiveVersion, type WranglerAnswer, type WranglerRunner } from './live-version.js';

const LIVE_VERSION_ID = 'live-version-id';

interface Traffic {
  readonly version_id: string;
  readonly percentage: number;
}

/** A deployment as `wrangler deployments status --json` prints one. */
const deployment = (versions: readonly Traffic[]): string =>
  JSON.stringify({ id: 'deployment-id', versions });

/** A version as `wrangler versions view <id> --json` prints one. */
const version = (annotations: Readonly<Record<string, string>>): string =>
  JSON.stringify({ id: LIVE_VERSION_ID, annotations });

const printed = (stdout: string): WranglerAnswer => ({ exitCode: 0, stdout, stderr: '' });
const exited = (stderr: string): WranglerAnswer => ({ exitCode: 1, stdout: '', stderr });

const wholly = deployment([{ version_id: LIVE_VERSION_ID, percentage: 100 }]);

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

describe('readLiveVersion', () => {
  it('reads the tag of the one version serving all traffic', async () => {
    const { wrangler } = controlPlane(
      printed(wholly),
      printed(version({ 'workers/tag': 'v1.2.3' }))
    );

    expect(await readLiveVersion(wrangler, [])).toEqual({
      kind: 'live',
      versionId: LIVE_VERSION_ID,
      tag: 'v1.2.3',
    });
  });

  it('reads a live version carrying no tag as untagged', async () => {
    const { wrangler } = controlPlane(printed(wholly), printed(JSON.stringify({ id: 'x' })));

    expect(await readLiveVersion(wrangler, [])).toEqual({
      kind: 'live',
      versionId: LIVE_VERSION_ID,
      tag: undefined,
    });
  });

  it('reads the version the deployment names, appending the extra arguments to each read', async () => {
    const { wrangler, calls } = controlPlane(printed(wholly), printed(version({})));

    await readLiveVersion(wrangler, ['--cwd', 'apps/admin']);

    expect(calls).toEqual([
      ['deployments', 'status', '--json', '--cwd', 'apps/admin'],
      ['versions', 'view', LIVE_VERSION_ID, '--json', '--cwd', 'apps/admin'],
    ]);
  });

  it("reads wrangler's own no-deployment sentence as a Worker with no deployment", async () => {
    const { wrangler } = controlPlane(
      exited('X [ERROR] The Worker hushbox-api has no deployments.'),
      printed('')
    );

    expect(await readLiveVersion(wrangler, [])).toEqual({ kind: 'none' });
  });

  it('reads a reworded no-deployment sentence as unreadable', async () => {
    const { wrangler } = controlPlane(
      exited('X [ERROR] The Worker hushbox-api has no deployment.'),
      printed('')
    );

    expect(await readLiveVersion(wrangler, [])).toMatchObject({ kind: 'unreadable' });
  });

  it('reads the no-deployment sentence from the version read as unreadable', async () => {
    const { wrangler } = controlPlane(
      printed(wholly),
      exited('X [ERROR] The Worker hushbox-api has no deployments.')
    );

    expect(await readLiveVersion(wrangler, [])).toMatchObject({
      kind: 'unreadable',
      read: 'version',
    });
  });

  it('names the deployment read and its error when that read fails', async () => {
    const { wrangler } = controlPlane(exited('Authentication error'), printed(''));

    const live = await readLiveVersion(wrangler, []);

    expect(live).toMatchObject({ kind: 'unreadable', read: 'deployment' });
    expect(live.kind === 'unreadable' ? live.failure : '').toContain('Authentication error');
  });

  it('reads a deployment split across versions as split', async () => {
    const split = deployment([
      { version_id: LIVE_VERSION_ID, percentage: 90 },
      { version_id: 'other', percentage: 10 },
    ]);
    const { wrangler } = controlPlane(printed(split), printed(version({})));

    expect(await readLiveVersion(wrangler, [])).toEqual({ kind: 'split' });
  });

  it('reads one version serving less than all traffic as split', async () => {
    const partial = deployment([{ version_id: LIVE_VERSION_ID, percentage: 50 }]);
    const { wrangler } = controlPlane(printed(partial), printed(version({})));

    expect(await readLiveVersion(wrangler, [])).toEqual({ kind: 'split' });
  });

  it('reads a deployment of an unexpected shape as unreadable', async () => {
    const { wrangler } = controlPlane(printed('{"id":"deployment-id"}'), printed(''));

    const live = await readLiveVersion(wrangler, []);

    expect(live.kind === 'unreadable' ? live.failure : '').toContain('unexpected shape');
  });

  it('reads an answer that is not JSON as unreadable', async () => {
    const { wrangler } = controlPlane(printed('Deployment ID: abc'), printed(''));

    expect(await readLiveVersion(wrangler, [])).toMatchObject({ kind: 'unreadable' });
  });

  it('reads a wrangler that could not start as unreadable, naming why', async () => {
    const wrangler: WranglerRunner = () => Promise.reject(new Error('spawn pnpm ENOENT'));

    const live = await readLiveVersion(wrangler, []);

    expect(live.kind === 'unreadable' ? live.failure : '').toContain('spawn pnpm ENOENT');
  });
});
