import { rm } from 'node:fs/promises';
import { execa } from 'execa';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { enumerateRegistry, unreadLiveRuns } from './lib/claims/registry.js';
import { resolveGitCommonDir } from './docker-cleanup.js';

/**
 * What a caller passes to say it accepts the consequences. Printed in the
 * refusal, so the way past a refusal is never something to go looking for.
 */
export const OVERRIDE_FLAG = '--ignore-live-claims';

type RegistryReading = Awaited<ReturnType<typeof enumerateRegistry>>;
type EnumeratedClaim = RegistryReading['claims'][number];
type UnreadableClaim = RegistryReading['unreadable'][number];

/** What stands between this command and the tree it would remove. */
interface LiveWork {
  /** Runs of this checkout whose records said so. */
  readonly claims: readonly EnumeratedClaim[];
  /** Live runs whose records said nothing, this checkout's among them for all anyone knows. */
  readonly unread: readonly UnreadableClaim[];
}

export interface CleanRequest {
  /** Clean even though runs of this checkout are alive. */
  readonly ignoreLiveClaims: boolean;
  /** Which checkout's runs count as this one's. */
  readonly gitCommonDir: string;
  /** Defaults to the machine-wide registry; a test points it elsewhere. */
  readonly registryDir?: string;
}

export const COMMAND_LINE = {
  command: 'pnpm clean',
  summary: "Removes this checkout's build outputs and installed packages.",
  flags: [
    {
      flag: OVERRIDE_FLAG,
      kind: 'boolean',
      summary: 'Clean even though runs of this checkout are still alive.',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

export async function removeDirectory(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

export async function runTurboClean(): Promise<void> {
  await execa('turbo', ['clean'], { stdio: 'inherit' });
}

/**
 * Every run still holding its lock that this command could harm. A claim whose
 * lock is free belongs to a run that has finished or died, and neither can be
 * harmed by anything below.
 *
 * The checkout filter is why the unread half is carried rather than dropped:
 * the record is the only thing that says which checkout a run belongs to, so a
 * live run whose record could not be read is one this filter cannot exclude.
 * Excluding it anyway is `turbo clean` and a `node_modules` removal running
 * underneath a run that is still executing from the tree.
 */
async function liveRunsOfCheckout(request: CleanRequest): Promise<LiveWork> {
  const reading = await enumerateRegistry(request.registryDir);
  return {
    claims: reading.claims.filter(
      (found) => found.state === 'owned-live' && found.claim.gitCommonDir === request.gitCommonDir
    ),
    unread: unreadLiveRuns(reading),
  };
}

function formatClaims(live: LiveWork): string {
  return [
    ...live.claims.map(
      ({ claim }) =>
        `  ${claim.command} (slot ${String(claim.slot)}, ${claim.mode}, pid ${String(claim.pid)})`
    ),
    ...live.unread.map(
      (found) =>
        `  the run in ${found.runId}, whose record could not be read (${found.reason}), so ` +
        'nothing rules it out of this checkout'
    ),
  ].join('\n');
}

/**
 * Refuses to clean while a run of this checkout is alive.
 *
 * `turbo clean` and the removal of the repository's `node_modules` are two
 * destructive acts against the very tree a live run is executing from, and a
 * vitest or vite process whose `node_modules` disappears underneath it dies
 * where it stands. Liveness is the claim's lock, so a run that was killed
 * blocks nothing.
 */
export async function assertCleanIsSafe(request: CleanRequest): Promise<void> {
  const live = await liveRunsOfCheckout(request);
  const count = live.claims.length + live.unread.length;
  if (count === 0) return;

  if (!request.ignoreLiveClaims) {
    throw new Error(
      `Refusing to clean: ${String(count)} run(s) of this checkout are still alive, and ` +
        `\`turbo clean\` and removing \`node_modules\` would run underneath them.\n` +
        `${formatClaims(live)}\n` +
        `Wait for them to finish, or pass \`${OVERRIDE_FLAG}\` to clean anyway.`
    );
  }

  console.warn(
    `Cleaning despite ${String(count)} live run(s) of this checkout, because ` +
      `\`${OVERRIDE_FLAG}\` was passed. Expect them to fail:\n${formatClaims(live)}`
  );
}

/**
 * The checkout a claim has to name for its run to count as this one's. Without
 * it there is no way to tell this checkout's runs from another clone's, and
 * cleaning blind is the failure this guard exists to prevent.
 */
export async function requireGitCommonDir(dir: string): Promise<string> {
  const resolved = await resolveGitCommonDir(dir);
  if (resolved === null) {
    throw new Error(
      'Refusing to clean: this directory is not a git checkout, so a live run of it cannot be detected.'
    );
  }
  return resolved;
}

export async function runClean(request: CleanRequest): Promise<void> {
  await assertCleanIsSafe(request);
  await runTurboClean();
  await removeDirectory('node_modules');
}

/* v8 ignore start -- CLI entry point exercised via root clean script */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const parsed = readCommandLine(COMMAND_LINE, process.argv.slice(2));
    if (parsed === null) return;
    const gitCommonDir = await requireGitCommonDir(process.cwd());
    await runClean({ ignoreLiveClaims: parsed.flags[OVERRIDE_FLAG], gitCommonDir });
  });
}
/* v8 ignore stop */
