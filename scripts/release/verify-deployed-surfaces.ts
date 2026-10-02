/**
 * Proves, after a production deploy and before its release is tagged, that
 * every static surface serves the version the deploy published.
 *
 * A public surface is read over HTTPS: its `build.json` must come back as JSON
 * naming this exact version. A status alone proves nothing, because Pages
 * answers a path it does not hold with its HTML fallback at 200. A Worker
 * surface is read on the control plane: one version must carry all its
 * traffic, tagged with this release. The admin surface is not public, and
 * Access admits no service token to read it with, so what is proven over HTTPS
 * there is the wall itself: an unauthenticated request is redirected to this
 * account's Access team. An admin that answers 200 has lost its wall.
 */
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { accessTeamHost } from '@hushbox/shared';

import { wranglerInApiDirectory } from './deploy-order-guard.js';
import { readLiveVersion, type WranglerRunner } from '../lib/wrangler/live-version.js';
import { SURFACES, SURFACE_ORIGINS, type OriginVariable } from '../lib/deployed-surfaces.js';
import { BUILD_IDENTITY_FILE, readBuildIdentity } from '../stamp-build-identity.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** How many times a public stamp is read before the probe gives up, and the wait between reads. */
export const POLL_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 5000;

export interface ProbeTargets {
  readonly version: string;
  /** Appended as the query of every stamp read, so no cache can answer for the origin. */
  readonly runId: string;
  readonly accessTeamDomain: string;
  /** Each surface's origin, by the registry variable that names it. */
  readonly origins: Readonly<Partial<Record<OriginVariable, string>>>;
}

export interface ProbeSeams {
  readonly fetch: typeof fetch;
  readonly wrangler: WranglerRunner;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

/** Reads the stamp once, answering why it is not this version's, or undefined when it is. */
async function readStampOnce(
  url: URL,
  version: string,
  seams: ProbeSeams
): Promise<string | undefined> {
  let response: Response;
  try {
    response = await seams.fetch(url, {
      redirect: 'manual',
      headers: { 'cache-control': 'no-cache' },
    });
  } catch (error: unknown) {
    return `${url.href} could not be fetched: ${String(error)}`;
  }
  if (response.status !== 200) return `${url.href} answered ${String(response.status)}`;
  const type = response.headers.get('content-type') ?? '(none)';
  if (!type.startsWith('application/json')) {
    return `${url.href} answered content type ${type}, not JSON`;
  }
  try {
    const served = readBuildIdentity(await response.text());
    return served === version ? undefined : `${url.href} serves ${served}, not ${version}`;
  } catch (error: unknown) {
    return `${url.href}: ${String(error)}`;
  }
}

/**
 * Polls `origin`'s stamp until it names this version, allowing for edge
 * propagation, and answers the last reason it did not, or undefined once it does.
 */
export async function probeBuildIdentity(
  origin: string,
  targets: ProbeTargets,
  seams: ProbeSeams
): Promise<string | undefined> {
  const url = new URL(`/${BUILD_IDENTITY_FILE}?${targets.runId}`, origin);
  for (let attempt = 1; ; attempt += 1) {
    const failure = await readStampOnce(url, targets.version, seams);
    if (failure === undefined) return undefined;
    if (attempt === POLL_ATTEMPTS) return `${failure} after ${String(POLL_ATTEMPTS)} attempts`;
    await seams.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Checks that one version carries all of the Worker's traffic, read through
 * the configuration in `directory`, and is tagged with this release; answers
 * why not, or undefined when it is.
 */
export async function checkWorkerTag(
  directory: string,
  version: string,
  wrangler: WranglerRunner
): Promise<string | undefined> {
  const live = await readLiveVersion(wrangler, ['--cwd', directory]);
  switch (live.kind) {
    case 'none': {
      return 'the Worker has no deployments';
    }
    case 'unreadable': {
      return live.failure;
    }
    case 'split': {
      return 'the live deployment is split, so no one version serves it';
    }
    case 'live': {
      if (live.tag === undefined) {
        return `the live version ${live.versionId} carries no tag`;
      }
      return live.tag === `v${version}`
        ? undefined
        : `the live version is tagged ${live.tag}, not v${version}`;
    }
  }
}

/**
 * Checks that an unauthenticated request for `origin` is redirected to the
 * Access team's own host, answering why not, or undefined when it is.
 */
export async function checkAccessWall(
  origin: string,
  teamDomain: string,
  fetcher: typeof fetch
): Promise<string | undefined> {
  const url = new URL('/', origin);
  let response: Response;
  try {
    response = await fetcher(url, { redirect: 'manual' });
  } catch (error: unknown) {
    return `${url.href} could not be fetched: ${String(error)}`;
  }
  if (response.status < 300 || response.status >= 400) {
    return `${url.href} answered ${String(response.status)} to an unauthenticated request instead of the Access redirect`;
  }
  const location = response.headers.get('location');
  if (location === null) return `${url.href} redirected with no location`;
  const host = new URL(location, url).host;
  const team = accessTeamHost(teamDomain);
  return host === team ? undefined : `${url.href} redirected to ${host}, not ${team}`;
}

/** Every check one surface is owed, answering its failures. */
async function checkSurface(
  directory: string,
  surface: (typeof SURFACES)[keyof typeof SURFACES],
  targets: ProbeTargets,
  seams: ProbeSeams
): Promise<string[]> {
  const origin = targets.origins[surface.origin];
  if (origin === undefined) return [`${directory}: no origin was given for ${surface.origin}`];
  const checks = [
    surface.public
      ? probeBuildIdentity(origin, targets, seams)
      : checkAccessWall(origin, targets.accessTeamDomain, seams.fetch),
  ];
  if (surface.worker) {
    const configured = path.join(REPO_ROOT, ...directory.split('/'));
    checks.push(checkWorkerTag(configured, targets.version, seams.wrangler));
  }
  const failures = await Promise.all(checks);
  return failures
    .filter((failure): failure is string => failure !== undefined)
    .map((failure) => `${directory}: ${failure}`);
}

/** Every failure across every surface, each prefixed with its surface's directory. */
export async function verifyDeployedSurfaces(
  targets: ProbeTargets,
  seams: ProbeSeams
): Promise<string[]> {
  const perSurface = await Promise.all(
    Object.entries(SURFACES).map(([directory, surface]) =>
      checkSurface(directory, surface, targets, seams)
    )
  );
  return perSurface.flat();
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value === '') throw new Error(`${key} is required`);
  return value;
}

export async function main(env: NodeJS.ProcessEnv, seams: ProbeSeams): Promise<void> {
  const targets: ProbeTargets = {
    version: required(env, 'VERSION'),
    runId: required(env, 'GITHUB_RUN_ID'),
    accessTeamDomain: required(env, 'CF_ACCESS_TEAM_DOMAIN'),
    origins: Object.fromEntries(
      SURFACE_ORIGINS.map((variable) => [variable, required(env, variable)])
    ),
  };
  const failures = await verifyDeployedSurfaces(targets, seams);
  if (failures.length > 0) {
    throw new Error(`Not every surface serves v${targets.version}:\n${failures.join('\n')}`);
  }
  process.stdout.write(`Every deployed surface serves v${targets.version}\n`);
}

/* v8 ignore start -- CLI wiring; main() is covered via unit tests */
const scriptPath = process.argv[1] ?? '';
const isDirectExecution =
  scriptPath.endsWith('verify-deployed-surfaces.ts') ||
  scriptPath.endsWith('verify-deployed-surfaces.js');
if (isDirectExecution) {
  void (async (): Promise<void> => {
    try {
      await main(process.env, {
        fetch,
        wrangler: wranglerInApiDirectory,
        sleep: async (milliseconds) => {
          await delay(milliseconds);
        },
      });
    } catch (error: unknown) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
