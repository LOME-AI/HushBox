import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { TEST_DATABASE_VARIABLE, applyTestDatabaseName } from '@hushbox/db/test-db';
import { CLASSIFICATION_VARIABLES, Mode, getDestinations, type EnvMode } from '@hushbox/shared';
import { envConfig } from '@hushbox/shared/env.config';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { generatedEnvPaths, stackModeFor } from './generate-env.js';
import { registerRun } from './lib/claims/registry.js';
import { spawnLongLived } from './lib/spawn/long-lived.js';
import { SERVICES, SERVICE_KEYS, portFor, type StackMode } from './lib/stack/port-plan.js';
import {
  ENV_MODE_VARIABLE,
  envModeFrom,
  envModeOrDefault,
  stackModeFrom,
  writesStackFiles,
} from './lib/stack/stack-mode.js';
import { stackSlotFrom } from './lib/stack/stack-slot.js';
import { resolveGitCommonDir } from './docker-cleanup.js';

// Re-exposed from their home beside the port plan so the wrapper's own callers
// keep one door onto the mode a run loads; a Vite config, which cannot import
// this file, takes the same ones from those modules directly. Forwarding, not
// declaring: there is one slot reader and one selector reader in the
// repository, and this is a door onto each rather than a second of either.
export { ENV_MODE_VARIABLE, envModeFrom, stackModeFrom } from './lib/stack/stack-mode.js';
export { STACK_SLOT_VARIABLE, stackSlotFrom } from './lib/stack/stack-slot.js';

/**
 * The flag naming the env mode a command runs under, spelled as `ensure-stack`
 * spells it so the two wrappers of one stack agree. It carries an env mode
 * rather than a stack because that is what every caller already has to hand;
 * {@link stackModeFor} is what turns one into the other.
 */
export const ENV_MODE_FLAG = '--env-mode';

export const NODE_OPTION_FLAG = '--no-experimental-webstorage';

/**
 * The variable a run publishes its checkout's identity in, so every command it
 * spawns names the same clone the run claim was attributed to.
 * `docker-compose.yml` interpolates it into the label every container of the
 * project carries, which is how a compose project keeps an account of its clone
 * that outlives the checkout.
 */
export const CLONE_DIR_VARIABLE = 'HB_CLONE_DIR';

function isEnvMode(value: string): value is EnvMode {
  return (Object.values(Mode) as string[]).includes(value);
}

/**
 * Reads a leading `--env-mode <mode>` off the wrapper's own arguments.
 *
 * Only a leading occurrence is the wrapper's. Everything from the command word
 * on belongs to the child, which is free to take a flag of the same name — and
 * `ensure-stack`, one of the commands run through here, does.
 */
export function parseEnvModeSelection(argv: readonly string[]): {
  envMode: EnvMode | undefined;
  rest: string[];
} {
  if (argv[0] !== ENV_MODE_FLAG) return { envMode: undefined, rest: [...argv] };
  const modes = Object.values(Mode).join(', ');
  const requested = argv[1];
  if (requested === undefined) {
    throw new Error(`with-env: ${ENV_MODE_FLAG} needs a mode. Valid: ${modes}.`);
  }
  if (!isEnvMode(requested)) {
    throw new Error(`with-env: ${ENV_MODE_FLAG}="${requested}" names no mode. Valid: ${modes}.`);
  }
  return { envMode: requested, rest: argv.slice(2) };
}

/**
 * A stack's three generated env files, in load order: the later a file comes,
 * the more it wins, because each is loaded with `override: true`.
 */
export function envFilesFor(stackMode: StackMode): readonly string[] {
  const paths = generatedEnvPaths(stackMode);
  return [paths.backend, paths.frontend, paths.scripts];
}

/**
 * Removes from `env` each classification variable the generating mode does not
 * state, where that mode is the one the environment itself declares.
 *
 * This is what makes an omission mean "no", and it is the whole of the defence:
 * the files are loaded with `override: true`, so a variable a mode states
 * replaces whatever the machine held, but one it omits used to survive — which
 * is how a continuous-integration runner's own `CI` reached a mode that is not
 * CI and turned its whole flag profile into another mode's.
 *
 * The mode comes from the loaded environment and never from the caller's own
 * flag, because the two answer different questions and disagree on a runner:
 * the flag names which stack's files to load, while the declaration names which
 * mode wrote them. A continuous-integration job generates under the runner mode
 * and then invokes suites by the local name of the same stack, so keying the
 * clearing on the flag deletes the very values that job's generation had just
 * written.
 *
 * A file set that declares no mode is refused rather than defaulted: a fallback
 * to the flag is the same disagreement between the flag and the declaration,
 * reintroduced for the one case nobody would look at.
 *
 * The denial is a deletion rather than a stated value because this repository
 * does not own the `CI` name and its convention is presence, not value: every
 * spelling of a denial is still present, and installed tooling that decides
 * colour support and interactivity reads presence alone.
 *
 * Only the classification variables. Most of the registry is partially emitted,
 * and among the partially emitted entries are credentials that a workflow step
 * injects into the ambient environment for the job to use; clearing those would
 * take away the values the run was given.
 */
export function clearUnemittedClassification(env: NodeJS.ProcessEnv): void {
  const generatingMode = envModeFrom(env);
  if (generatingMode === undefined) {
    throw new Error(
      `with-env: the loaded environment declares no ${ENV_MODE_VARIABLE}, so which mode generated it is unknown and the classification cannot be settled. Regenerate this stack's files with \`pnpm generate:env\`.`
    );
  }
  for (const name of CLASSIFICATION_VARIABLES) {
    if (getDestinations(envConfig[name], generatingMode).length === 0) {
      // Reflect rather than `delete env[name]`: a computed key trips the
      // dynamic-delete rule, though the key is always one of
      // {@link CLASSIFICATION_VARIABLES}.
      Reflect.deleteProperty(env, name);
    }
  }
}

/**
 * Loads the generated env files of the stack a mode runs, and none at all for
 * the mode that runs none, then clears what those files did not state.
 *
 * Production is that mode: it binds nothing locally, so no stack's files are
 * written under it, and loading some other stack's would hand a production
 * command that stack's ports, database and buckets while telling it it was
 * production. Loading nothing leaves every value unset, which the registry's
 * own readers fail fast on — and leaves the machine's own environment as it
 * found it, there being no stated set of values for a silence to be measured
 * against.
 *
 * The clearing comes after the load, not before, and cannot move: the mode it
 * keys on is the one the loaded files declare, which is not in the environment
 * until they are loaded. A generated file left behind by an older registry can
 * also still carry a line for a variable that mode no longer states, and only
 * the later pass removes it.
 */
export function loadEnvironment(
  rootDir: string,
  mode: EnvMode = envModeOrDefault(process.env)
): void {
  if (!writesStackFiles(mode)) return;
  for (const file of envFilesFor(stackModeFor(mode))) {
    dotenvConfig({ path: path.join(rootDir, file), override: true, quiet: true });
  }
  clearUnemittedClassification(process.env);
}

/**
 * Retargets the Postgres URLs at `HB_TEST_DB` after the env files are loaded.
 * It has to run here, and after {@link loadEnvironment}: the env files are read
 * with `override: true`, so a caller that pre-sets `DATABASE_URL` before
 * invoking a pnpm script has it silently clobbered. The registry still defines
 * the connection; only the database on that same server changes.
 */
export function applyDatabaseOverride(env: NodeJS.ProcessEnv): void {
  const databaseName = env[TEST_DATABASE_VARIABLE];
  if (databaseName === undefined || databaseName === '') return;
  applyTestDatabaseName(env, databaseName);
}

export function appendNodeOption(existing: string | undefined, flag: string): string {
  return existing && existing.length > 0 ? `${existing} ${flag}` : flag;
}

/**
 * How the run names itself to anyone it refuses, keeps waiting, or reports as
 * holding a resource. pnpm puts the script name in the environment of
 * everything a script runs, so the name a developer typed survives however many
 * wrappers stand between them and this one.
 */
export function runCommandName(env: NodeJS.ProcessEnv, fallback: string): string {
  const script = env['npm_lifecycle_event'];
  return script === undefined || script === '' ? fallback : `pnpm ${script}`;
}

export interface RunClaimInit {
  /** What to call the run when nothing names the pnpm script behind it. */
  readonly command: string;
  readonly mode: StackMode;
  /** The checkout the run belongs to, so a reclaimer can attribute what it made. */
  readonly rootDir: string;
  /** Defaults to the machine-wide registry; a test points it elsewhere. */
  readonly registryDir?: string | undefined;
}

/**
 * Registers this invocation as a run for as long as `body` takes.
 *
 * Every invocation registers, not only the ones that use the stack. The two
 * mistakes are not symmetric: a lint run holding its slot warm costs a
 * reclaimer one skipped pass, while a run nobody registered is a stack torn
 * down underneath it and a database dropped while it is being read.
 *
 * Nesting costs nothing — an invocation launched inside a registered run adopts
 * that run instead of taking a second claim, so the chained pnpm scripts a
 * single command expands into stay one run.
 */
export async function withRunClaim<T>(init: RunClaimInit, body: () => Promise<T>): Promise<T> {
  const gitCommonDir = await resolveGitCommonDir(init.rootDir);
  if (gitCommonDir === null) {
    console.warn(
      'Running without a run claim: this directory is not a git checkout, so nothing can tell ' +
        'what this run creates from what an abandoned one left. Reclaimers will report it as ' +
        'unowned and leave it standing.'
    );
    return body();
  }

  // Published before anything the run spawns can read it, and never cleared:
  // it names the checkout rather than the run, so it is as true after the claim
  // is released as during it.
  process.env[CLONE_DIR_VARIABLE] = gitCommonDir;

  return registerRun(
    {
      command: runCommandName(process.env, init.command),
      mode: init.mode,
      slot: stackSlotFrom(process.env),
      gitCommonDir,
      ...(init.registryDir === undefined ? {} : { registryDir: init.registryDir }),
    },
    body
  );
}

/**
 * Every host port of one slot's mode band: every mode-banded service of that
 * slot and mode, in every lane it declares. Derived from the service
 * declaration, so a service appended to the port plan enters the band without
 * anyone remembering to come here.
 *
 * Mode-banding is the whole predicate, and it excludes exactly the two things a
 * run must not claim. A container publishes one port per stack rather than one
 * per mode, and freeing it means stopping the container — which is claimed as a
 * container by whoever started it. The idle daemon is the one host-bound
 * service outside the banding, being a single sentinel per slot that outlives
 * every run, so a run claiming it would have the next reclaimer kill the daemon
 * that reclaims for everyone. That mode-banded is exactly host-bound less the
 * daemon is asserted over the live declaration by the test colocated with
 * `MODE_BANDED_PORT_ENVS` in `scripts/lib/stack/dev-ports.ts`.
 *
 * A band is what a sweep reclaims across, never what a run claims. A run claims
 * the ports its own servers bind and no others, because a claim naming a port
 * this run never bound cannot tell a live server from a dead peer's orphan —
 * that orphan would resolve to a live claim and be left standing for as long as
 * the claimant ran. The entry points therefore derive their own port sets
 * (`scripts/dev.ts`, `scripts/e2e-run.ts`), and the reclaiming sweep in
 * `scripts/ensure-stack-cli.ts` is what reads this.
 */
export function hostPortsForRun(slot: number, mode: StackMode): number[] {
  return SERVICE_KEYS.filter((key) => SERVICES[key].modeBanded).flatMap((key) =>
    Array.from({ length: SERVICES[key].lanes }, (_, lane) => portFor(key, { slot, mode, lane }))
  );
}

/**
 * Spawns the wrapped command as a long-lived tree, claiming the `ports` the
 * caller knows that tree binds. A caller that knows of none passes none: the
 * claim is a statement about what was started, not a reservation.
 */
export async function runCommand(
  command: string | undefined,
  args: readonly string[],
  ports: readonly number[]
): Promise<number> {
  if (!command) {
    throw new Error(
      'with-env: missing command. Usage: tsx scripts/with-env.ts <command> [...args]'
    );
  }
  const child = await spawnLongLived(command, args, { stdio: 'inherit', ports });
  return child.exit;
}

/* v8 ignore start -- CLI entry point exercised via package.json scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(scriptDir, '..');
    const { envMode, rest } = parseEnvModeSelection(process.argv.slice(2));
    loadEnvironment(rootDir, envMode);
    applyDatabaseOverride(process.env);
    process.env['NODE_OPTIONS'] = appendNodeOption(process.env['NODE_OPTIONS'], NODE_OPTION_FLAG);

    const [command, ...args] = rest;
    const mode = stackModeFrom(process.env);
    // No port: the wrapper spawns whatever it was handed, and what that binds
    // is known only where it was chosen. The entry points that start servers
    // each derive and claim the ports their own servers bind.
    return withRunClaim({ command: command ?? 'with-env', mode, rootDir }, () =>
      runCommand(command, args, [])
    );
  });
}
/* v8 ignore stop */
