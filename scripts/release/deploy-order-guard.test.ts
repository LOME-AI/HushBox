import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  judgeDeployOrder,
  main,
  wranglerInApiDirectory,
  type WranglerAnswer,
  type WranglerRunner,
} from './deploy-order-guard.js';

const LIVE_VERSION_ID = 'live-version-id';

interface Traffic {
  readonly version_id: string;
  readonly percentage: number;
}

/** A deployment as `wrangler deployments status --json` prints one. */
const deployment = (versions: readonly Traffic[]): string =>
  JSON.stringify({ id: 'deployment-id', source: 'wrangler', strategy: 'percentage', versions });

/** A version as `wrangler versions view <id> --json` prints one. */
const version = (annotations: Readonly<Record<string, string>>): string =>
  JSON.stringify({ id: LIVE_VERSION_ID, number: 7, annotations });

/** A command that exited zero having printed `stdout`. */
const printed = (stdout: string): WranglerAnswer => ({ exitCode: 0, stdout, stderr: '' });

/** A command that exited non-zero having written `stderr`. */
const exited = (stderr: string): WranglerAnswer => ({ exitCode: 1, stdout: '', stderr });

const wholly = deployment([{ version_id: LIVE_VERSION_ID, percentage: 100 }]);

/** A control plane answering the two reads the guard makes, and recording what it was asked. */
function controlPlane(
  status: string,
  view: string
): { readonly wrangler: WranglerRunner; readonly calls: string[][] } {
  const calls: string[][] = [];
  const wrangler: WranglerRunner = (args) => {
    calls.push([...args]);
    return Promise.resolve(printed(args[0] === 'deployments' ? status : view));
  };
  return { wrangler, calls };
}

const tagged = (tag: string): WranglerRunner =>
  controlPlane(wholly, version({ 'workers/tag': tag, 'workers/message': 'sha' })).wrangler;

describe('judgeDeployOrder', () => {
  it('proceeds when the live version carries no tag', async () => {
    const { wrangler } = controlPlane(wholly, version({}));

    const { proceed } = await judgeDeployOrder('1.2.3', wrangler);

    expect(proceed).toBe(true);
  });

  it('proceeds when the live version is tagged lower', async () => {
    const { proceed } = await judgeDeployOrder('1.2.3', tagged('v1.2.2'));

    expect(proceed).toBe(true);
  });

  it('proceeds when only a higher component outranks a lower one', async () => {
    const { proceed } = await judgeDeployOrder('2.0.0', tagged('v1.9.9'));

    expect(proceed).toBe(true);
  });

  it('refuses a version equal to the live one, naming it', async () => {
    const verdict = await judgeDeployOrder('1.2.3', tagged('v1.2.3'));

    expect(verdict.proceed).toBe(false);
    expect(verdict.reason).toContain('v1.2.3');
  });

  it('refuses a version lower than the live one, naming the live one', async () => {
    const verdict = await judgeDeployOrder('1.2.3', tagged('v1.3.0'));

    expect(verdict.proceed).toBe(false);
    expect(verdict.reason).toContain('production already runs v1.3.0');
  });

  it('proceeds when the control plane answers that the Worker has no deployment', async () => {
    const wrangler: WranglerRunner = () =>
      Promise.resolve(exited('X [ERROR] The Worker hushbox-api has no deployments.'));

    const { proceed } = await judgeDeployOrder('1.2.3', wrangler);

    expect(proceed).toBe(true);
  });

  it('refuses when the deployment cannot be read', async () => {
    const wrangler: WranglerRunner = () => Promise.resolve(exited('Authentication error'));

    const verdict = await judgeDeployOrder('1.2.3', wrangler);

    expect(verdict.proceed).toBe(false);
    expect(verdict.reason).toContain('Authentication error');
  });

  it('refuses when the live version cannot be read', async () => {
    const wrangler: WranglerRunner = (args) =>
      args[0] === 'deployments'
        ? Promise.resolve(printed(wholly))
        : Promise.resolve(exited('version not found'));

    const verdict = await judgeDeployOrder('1.2.3', wrangler);

    expect(verdict.proceed).toBe(false);
    expect(verdict.reason).toContain('version not found');
  });

  it('refuses an API error on the deployments endpoint, which names deployments but no absence', async () => {
    const wrangler: WranglerRunner = () =>
      Promise.resolve(
        exited(
          'X [ERROR] A request to the Cloudflare API (/accounts/account-id/workers/scripts/hushbox-api/deployments) failed.\n\n' +
            '  This Worker does not exist on your account. [code: 10007]'
        )
      );

    const { proceed } = await judgeDeployOrder('1.2.3', wrangler);

    expect(proceed).toBe(false);
  });

  it('refuses a sentence reworded from the one wrangler prints for no deployment', async () => {
    const wrangler: WranglerRunner = () =>
      Promise.resolve(exited('X [ERROR] The Worker hushbox-api has no deployment.'));

    const { proceed } = await judgeDeployOrder('1.2.3', wrangler);

    expect(proceed).toBe(false);
  });

  it('refuses another wrangler message about no deployments, which is not the Worker having none', async () => {
    const wrangler: WranglerRunner = () =>
      Promise.resolve(
        exited(
          'X [ERROR] There are currently no deployments for the Preview "main". Please create a Preview deployment.'
        )
      );

    const { proceed } = await judgeDeployOrder('1.2.3', wrangler);

    expect(proceed).toBe(false);
  });

  it('refuses the no-deployment sentence when it comes from reading the live version', async () => {
    const wrangler: WranglerRunner = (args) =>
      Promise.resolve(
        args[0] === 'deployments'
          ? printed(wholly)
          : exited('X [ERROR] The Worker hushbox-api has no deployments.')
      );

    const { proceed } = await judgeDeployOrder('1.2.3', wrangler);

    expect(proceed).toBe(false);
  });

  it('refuses when wrangler could not be started at all', async () => {
    const wrangler: WranglerRunner = () => Promise.reject(new Error('spawn pnpm ENOENT'));

    const verdict = await judgeDeployOrder('1.2.3', wrangler);

    expect(verdict.proceed).toBe(false);
    expect(verdict.reason).toContain('spawn pnpm ENOENT');
  });

  it('refuses a deployment answer that is not JSON', async () => {
    const { wrangler } = controlPlane('Deployment ID: abc', version({}));

    const { proceed } = await judgeDeployOrder('1.2.3', wrangler);

    expect(proceed).toBe(false);
  });

  it('refuses a deployment answer missing its versions', async () => {
    const { wrangler } = controlPlane(JSON.stringify({ id: 'deployment-id' }), version({}));

    const { proceed } = await judgeDeployOrder('1.2.3', wrangler);

    expect(proceed).toBe(false);
  });

  it('refuses a version answer that is not JSON', async () => {
    const { wrangler } = controlPlane(wholly, 'not json');

    const { proceed } = await judgeDeployOrder('1.2.3', wrangler);

    expect(proceed).toBe(false);
  });

  it('refuses a deployment split across two versions', async () => {
    const split = deployment([
      { version_id: LIVE_VERSION_ID, percentage: 90 },
      { version_id: 'other-version-id', percentage: 10 },
    ]);
    const { wrangler } = controlPlane(split, version({ 'workers/tag': 'v1.0.0' }));

    const verdict = await judgeDeployOrder('1.2.3', wrangler);

    expect(verdict.proceed).toBe(false);
    expect(verdict.reason).toContain('split');
  });

  it('refuses a single version serving less than all traffic', async () => {
    const partial = deployment([{ version_id: LIVE_VERSION_ID, percentage: 50 }]);
    const { wrangler } = controlPlane(partial, version({ 'workers/tag': 'v1.0.0' }));

    const { proceed } = await judgeDeployOrder('1.2.3', wrangler);

    expect(proceed).toBe(false);
  });

  it('refuses a live tag that names no release, since it cannot be ordered', async () => {
    const verdict = await judgeDeployOrder('1.2.3', tagged('hotfix'));

    expect(verdict.proceed).toBe(false);
    expect(verdict.reason).toContain('hotfix');
  });

  it('reads the version the deployment names', async () => {
    const { wrangler, calls } = controlPlane(wholly, version({}));

    await judgeDeployOrder('1.2.3', wrangler);

    expect(calls).toEqual([
      ['deployments', 'status', '--json'],
      ['versions', 'view', LIVE_VERSION_ID, '--json'],
    ]);
  });

  it('throws on a version of its own that is not written X.Y.Z', async () => {
    await expect(judgeDeployOrder('v1.2.3', tagged('v1.0.0'))).rejects.toThrow('X.Y.Z');
  });
});

describe('main', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('states why the deploy may proceed', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await main({ version: '1.2.3', wrangler: tagged('v1.2.2') });

    expect(write).toHaveBeenCalledWith('Production runs v1.2.2; v1.2.3 is newer and may deploy\n');
  });

  it('throws the refusal, stating that nothing was published', async () => {
    await expect(main({ version: '1.2.3', wrangler: tagged('v1.2.3') })).rejects.toThrow(
      'nothing was published'
    );
  });

  it('throws when no version is given', async () => {
    await expect(main({ version: undefined, wrangler: tagged('v1.0.0') })).rejects.toThrow(
      'VERSION'
    );
  });

  it('throws when the version given is empty', async () => {
    await expect(main({ version: '', wrangler: tagged('v1.0.0') })).rejects.toThrow('VERSION');
  });
});

describe('wranglerInApiDirectory', () => {
  it("answers the installed wrangler's standard output and a zero exit", async () => {
    const answer = await wranglerInApiDirectory(['--version']);

    expect({ exitCode: answer.exitCode, version: /\d+\.\d+\.\d+/.test(answer.stdout) }).toEqual({
      exitCode: 0,
      version: true,
    });
  }, 60_000);

  it("answers wrangler's non-zero exit and its error output rather than throwing", async () => {
    const answer = await wranglerInApiDirectory(['no-such-command']);

    expect(answer.exitCode).not.toBe(0);
    expect(answer.stderr).not.toBe('');
  }, 60_000);
});
