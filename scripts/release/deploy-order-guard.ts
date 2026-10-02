/**
 * Refuses a production deploy whose version is not strictly newer than the one
 * the API Worker serves, before anything is published.
 *
 * Deploys queue in one concurrency group, but GitHub does not guarantee the
 * order a group releases its pending runs in, and the native client applies
 * any server version that differs from its own, lower included. So an older
 * run reaching the front after a newer one would ship a downgrade to every
 * phone; this guard is what stops it. It fails rather than letting the deploy
 * skip its publishing steps, so a publishing step added later cannot slip past
 * it by lacking a condition.
 *
 * The live version is read off the API Worker because its deploy carries the
 * release number as the version's tag. An untagged live version predates that,
 * or was deployed by hand, and orders below any release; a Worker with no
 * deployment at all has nothing live that could be newer.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import { compareSemver } from './compute-next-version.js';
import {
  readLiveVersion,
  type WranglerAnswer,
  type WranglerRunner,
} from '../lib/wrangler/live-version.js';
import { RELEASE_TAG } from '../lib/release-references.js';

export type { WranglerAnswer, WranglerRunner } from '../lib/wrangler/live-version.js';

export interface OrderVerdict {
  readonly proceed: boolean;
  readonly reason: string;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_DIRECTORY = path.join(REPO_ROOT, 'apps', 'api');

/** Runs wrangler as installed for the API Worker, from its directory, so its configuration names the Worker. */
export async function wranglerInApiDirectory(args: readonly string[]): Promise<WranglerAnswer> {
  const result = await execa('pnpm', ['exec', 'wrangler', ...args], {
    cwd: API_DIRECTORY,
    reject: false,
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

const refuse = (reason: string): OrderVerdict => ({ proceed: false, reason });

/** Orders `ours` against the live version's tag. */
function judgeTag(tag: string | undefined, ours: string): OrderVerdict {
  if (tag === undefined || tag === '') {
    return { proceed: true, reason: `The live version is untagged; ${ours} may deploy` };
  }
  if (!RELEASE_TAG.test(tag)) {
    return refuse(`The live version is tagged "${tag}", which names no release to order against`);
  }
  if (compareSemver(tag, ours) >= 0) {
    return refuse(`Superseded: production already runs ${tag}, and this deploy is ${ours}`);
  }
  return { proceed: true, reason: `Production runs ${tag}; ${ours} is newer and may deploy` };
}

/**
 * Whether a deploy of `version` (written `X.Y.Z`) may publish, judged against
 * the API Worker's live deployment. Anything short of one version serving all
 * traffic with a readable tag is refused, because a control plane that cannot
 * be read says nothing about order.
 */
export async function judgeDeployOrder(
  version: string,
  wrangler: WranglerRunner
): Promise<OrderVerdict> {
  const ours = `v${version}`;
  if (!RELEASE_TAG.test(ours)) {
    throw new Error(`The version to deploy must be written X.Y.Z, not "${version}"`);
  }

  const live = await readLiveVersion(wrangler, []);
  switch (live.kind) {
    case 'none': {
      return { proceed: true, reason: `The API Worker has no deployment; ${ours} may deploy` };
    }
    case 'unreadable': {
      const what = live.read === 'deployment' ? 'live deployment' : 'live version';
      return refuse(`The ${what} could not be read: ${live.failure}`);
    }
    case 'split': {
      return refuse(
        'The live deployment is split across versions, so it has no one version to order this deploy against'
      );
    }
    case 'live': {
      return judgeTag(live.tag, ours);
    }
  }
}

export interface RunOptions {
  readonly version: string | undefined;
  readonly wrangler: WranglerRunner;
}

export async function main(options: RunOptions): Promise<void> {
  if (options.version === undefined || options.version === '') {
    throw new Error('VERSION is required');
  }
  const verdict = await judgeDeployOrder(options.version, options.wrangler);
  if (!verdict.proceed) throw new Error(`${verdict.reason}; nothing was published`);
  process.stdout.write(`${verdict.reason}\n`);
}

/* v8 ignore start -- CLI wiring; main() is covered via unit tests */
const scriptPath = process.argv[1] ?? '';
const isDirectExecution =
  scriptPath.endsWith('deploy-order-guard.ts') || scriptPath.endsWith('deploy-order-guard.js');
if (isDirectExecution) {
  void (async (): Promise<void> => {
    try {
      await main({ version: process.env['VERSION'], wrangler: wranglerInApiDirectory });
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
