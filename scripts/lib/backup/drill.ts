import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delayFor } from 'node:timers/promises';

import { execa } from 'execa';
import { z } from 'zod';

import { recordOwnedResourceIfClaimed } from '../claims/ownership.js';
import { BACKUP_HOST, DUMP_LABEL } from './config.js';
import {
  DUMP_MANIFEST_FILE,
  DumpManifestSchema,
  containerUser,
  migrationHeadQuery,
  prepareOutDir,
} from './postgres.js';
import type { DumpManifest } from './postgres.js';

/**
 * The claim that these backups are restore-verified, executed: the newest dump
 * in the repository is restored into a throwaway Postgres and proved to hold
 * the database the dump was taken from, table by table.
 *
 * The proof is a comparison of two independently obtained censuses. The dump's
 * own manifest carries the counts read under the snapshot `pg_dump` ran on
 * ({@link DumpManifestSchema}); the restored database is enumerated here from
 * its own catalogue, never from the manifest. Both directions are compared, so
 * a table the restore silently dropped and a table it grew are each a failure,
 * and a comparison that had nothing to compare fails rather than passing
 * vacuously.
 *
 * The scratch database holds every user's account data in plaintext for as long
 * as the drill runs, which is why its container is removed with its volumes
 * however the drill ends, why a removal that fails is itself a failure, and why
 * the restored dump is deleted on the way out.
 */

/** The directory under the work directory the dump is restored into. */
export const RESTORE_DIRECTORY_NAME = 'restore';

/**
 * The prefix every scratch container this module starts carries. Exported
 * because a second spelling of it is a listing that silently stops finding
 * them, and the reclaim that removes one is somewhere else entirely.
 */
export const SCRATCH_CONTAINER_PREFIX = 'hushbox-drill-';

/** Where the restored dump is mounted inside the client container. */
const CONTAINER_DUMP_DIR = '/dump';

/**
 * The scratch server's own connection. The client containers share the scratch
 * container's network namespace, so the loopback address is the server itself
 * and no port is ever published to the machine running the drill.
 */
const SCRATCH_HOST = '127.0.0.1';
const SCRATCH_USER = 'postgres';
const SCRATCH_DATABASE = 'postgres';

/** How many times a starting scratch database may refuse a connection. */
export const READINESS_ATTEMPTS = 60;

/** How long the drill waits between two readiness attempts. */
const READINESS_DELAY_MS = 1000;

/**
 * Ceiling on any one subprocess. Far above a restore of this database; it is
 * here to turn a hung `docker` or `rustic` into a failure rather than a drill
 * that never ends and never releases its scratch container.
 */
const COMMAND_RUNTIME_LIMIT_MS = 30 * 60_000;

/** Bytes of randomness behind the scratch password and the container's name. */
const PASSWORD_BYTES = 24;
const NAME_BYTES = 6;

/**
 * The one question the restored database is asked. The census is built from the
 * restored catalogue and the counts are taken by the server through
 * `format('%I')`, so no identifier is ever spliced into SQL here and a table
 * this module has never heard of is still counted.
 */
export const RESTORE_STATE_QUERY = `select json_build_object(
  'tables', (
    select coalesce(json_object_agg(tablename, row_count), '{}'::json)
    from (
      select tablename,
             (xpath('/row/c/text()',
                    query_to_xml(format('select count(*) as c from public.%I', tablename),
                                 false, true, '')))[1]::text::bigint as row_count
      from pg_tables
      where schemaname = 'public'
    ) census
  ),
  'migrationHead', (${migrationHeadQuery()})
)`;

/** What the scratch database answered when it was asked to prove itself. */
const RestoredStateSchema = z.object({
  tables: z.record(z.string(), z.int().nonnegative()),
  migrationHead: z.string().min(1).nullable(),
});

export type RestoredState = z.infer<typeof RestoredStateSchema>;

/** One table the two censuses disagree about. */
export interface DrillMismatch {
  readonly table: string;
  /** The manifest's count, or nothing when the manifest never knew the table. */
  readonly expected: number | undefined;
  /** The restored count, or nothing when the restore does not hold the table. */
  readonly actual: number | undefined;
}

export interface DrillResult {
  /** Every table either census names; zero is a failure, not a clean sheet. */
  readonly tablesChecked: number;
  readonly passed: boolean;
  readonly mismatches: readonly DrillMismatch[];
  /** Present only when the restored schema is not the dumped one. */
  readonly migrationHeadMismatch?: {
    readonly expected: string;
    readonly actual: string | null;
  };
}

/**
 * What a subprocess did. Deliberately without the child's own output on the
 * failure side: a Postgres client reports a data error with the column value in
 * its DETAIL and CONTEXT lines, so a `pg_restore` that fails on a row would
 * publish that row through any channel that carried its stderr — and no
 * redaction can help, because a row value looks like nothing in particular.
 * What a failure carries is the exit status and which command produced it.
 */
export interface CommandOutcome {
  /** Absent for a child that never reached an exit status. */
  readonly exitCode: number | undefined;
  readonly timedOut: boolean;
  readonly stdout: string;
}

/**
 * How a subprocess is run. The one seam in this module, so that
 * {@link runRestoreDrill}'s sequencing and every argument list it builds are
 * proved without Docker.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>
) => Promise<CommandOutcome>;

/* v8 ignore start -- the subprocess seam, exercised by the drill's own integration test */
const execaRunner: CommandRunner = async (command, args, env) => {
  const { exitCode, timedOut, stdout } = await execa(command, args, {
    env,
    timeout: COMMAND_RUNTIME_LIMIT_MS,
    reject: false,
  });
  return { exitCode, timedOut, stdout };
};
/* v8 ignore stop */

/** What the command printed, or a failure naming the command and its status. */
export function expectCommandOutput(label: string, outcome: CommandOutcome): string {
  if (outcome.exitCode === 0) return outcome.stdout;
  if (outcome.timedOut) {
    throw new Error(
      `runRestoreDrill: ${label} ran past its limit of ${String(COMMAND_RUNTIME_LIMIT_MS)} ms and was killed`
    );
  }
  throw new Error(
    outcome.exitCode === undefined
      ? `runRestoreDrill: ${label} reached no exit status`
      : `runRestoreDrill: ${label} exited ${String(outcome.exitCode)}`
  );
}

export interface RestoreArgumentsInput {
  readonly configPath: string;
  readonly destination: string;
}

/**
 * The newest dump in the repository. The label is filtered on both sides of the
 * question — the snapshot chosen and the path taken out of it — because
 * `latest` alone is the newest snapshot of any source, and the object sources
 * are snapshotted in the same run.
 */
export function restoreArguments(input: RestoreArgumentsInput): string[] {
  return [
    '--use-profile',
    input.configPath,
    'restore',
    `latest:/${DUMP_LABEL}`,
    input.destination,
    '--filter-label',
    DUMP_LABEL,
    '--filter-host',
    BACKUP_HOST,
  ];
}

/** The libpq variables a client container reads the scratch server through. */
export function scratchEnvironment(password: string): Record<string, string> {
  return {
    PGPASSWORD: password,
    PGHOST: SCRATCH_HOST,
    PGUSER: SCRATCH_USER,
    PGDATABASE: SCRATCH_DATABASE,
  };
}

export interface ScratchRunInput {
  readonly name: string;
  readonly image: string;
}

/**
 * The scratch server. Every `-e` names a variable and never its value, so the
 * password reaches the server through the environment and appears in no
 * argument vector. Nothing is published: the only way in is a container that
 * joins this one's network namespace.
 */
export function scratchRunArguments(input: ScratchRunInput): string[] {
  return ['run', '--detach', '--name', input.name, '-e', 'POSTGRES_PASSWORD', input.image];
}

export interface ClientRunInput {
  readonly image: string;
  /** The scratch container whose network namespace the client joins. */
  readonly container: string;
  readonly env: Readonly<Record<string, string>>;
  readonly command: readonly string[];
  /** The restored dump, mounted read-only when the client has to read it. */
  readonly mountPath?: string | undefined;
  /** From {@link containerUser}, so mounted files are read as their owner. */
  readonly user?: string | undefined;
}

export function clientRunArguments(input: ClientRunInput): string[] {
  return [
    'run',
    '--rm',
    '--network',
    `container:${input.container}`,
    ...Object.keys(input.env).flatMap((variable) => ['-e', variable]),
    ...(input.user === undefined ? [] : ['--user', input.user]),
    ...(input.mountPath === undefined ? [] : ['-v', `${input.mountPath}:${CONTAINER_DUMP_DIR}:ro`]),
    input.image,
    ...input.command,
  ];
}

/** `docker rm` that takes the anonymous volume the server's data lives on too. */
function removeScratchArguments(name: string): string[] {
  return ['rm', '--force', '--volumes', name];
}

/** A psql that reads its connection from the environment and stops at the first error. */
function psqlCommand(statement: string): string[] {
  return ['psql', '-v', 'ON_ERROR_STOP=1', '-X', '-A', '-t', '-c', statement];
}

/** The load. `-d` is what makes `pg_restore` restore rather than print SQL. */
function pgRestoreCommand(): string[] {
  return [
    'pg_restore',
    '--no-owner',
    '--no-privileges',
    '--jobs',
    '4',
    '-d',
    SCRATCH_DATABASE,
    CONTAINER_DUMP_DIR,
  ];
}

export function parseRestoredState(stdout: string): RestoredState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error('runRestoreDrill: the scratch database answered no census');
  }
  return RestoredStateSchema.parse(parsed);
}

/**
 * The drill's verdict, from the manifest and a census of the restored database
 * taken independently of it.
 *
 * The table set is the union of the two censuses rather than the manifest's own
 * keys: iterating the manifest would compare the manifest to itself wherever
 * the restore is missing a table, and would never see one the restore invented.
 * An empty union is a failure for the same reason — it is the shape in which a
 * comparison proves nothing while reporting no mismatch.
 */
export function compareRestore(manifest: DumpManifest, restored: RestoredState): DrillResult {
  const tables = new Set([...Object.keys(manifest.tables), ...Object.keys(restored.tables)]);
  const mismatches: DrillMismatch[] = [];
  for (const table of [...tables].toSorted((a, b) => a.localeCompare(b))) {
    const expected = manifest.tables[table];
    const actual = restored.tables[table];
    if (expected !== actual) mismatches.push({ table, expected, actual });
  }
  const headMatches = restored.migrationHead === manifest.migrationHead;
  return {
    tablesChecked: tables.size,
    passed: mismatches.length === 0 && headMatches && tables.size > 0,
    mismatches,
    ...(headMatches
      ? {}
      : {
          migrationHeadMismatch: {
            expected: manifest.migrationHead,
            actual: restored.migrationHead,
          },
        }),
  };
}

/**
 * A restore that is not the database it was taken from. The message names
 * tables and counts and the two migration heads — the shape of the data, never
 * a row of it.
 */
export class RestoreDrillError extends Error {
  constructor(readonly result: DrillResult) {
    super(`runRestoreDrill: ${describeFailure(result)}`);
    this.name = 'RestoreDrillError';
  }
}

function describeCount(count: number | undefined): string {
  return count === undefined ? 'no such table' : `${String(count)} rows`;
}

function describeFailure(result: DrillResult): string {
  const reasons: string[] = [];
  if (result.tablesChecked === 0) {
    reasons.push('the manifest and the restored database name no table between them');
  }
  for (const mismatch of result.mismatches) {
    reasons.push(
      `'${mismatch.table}': the manifest records ${describeCount(mismatch.expected)} and ` +
        `the restore holds ${describeCount(mismatch.actual)}`
    );
  }
  const head = result.migrationHeadMismatch;
  if (head !== undefined) {
    reasons.push(
      `the dump was taken at migration ${head.expected} and the restore holds ` +
        (head.actual ?? 'no applied migration')
    );
  }
  return reasons.join('; ');
}

export interface RestoreDrillOptions {
  readonly rusticPath: string;
  readonly configPath: string;
  readonly image: string;
  /** The restore lands in a `restore` directory here, and is deleted after. */
  readonly workDir: string;
  readonly run?: CommandRunner;
  /** The wait between readiness attempts; a test passes one that does not wait. */
  readonly delay?: (ms: number) => Promise<void>;
  /**
   * Told the scratch container's name as it is claimed, before it exists.
   *
   * The claim record is where that name durably lands, and it is not a channel
   * back to this caller: one record serves a whole run and every process in it,
   * so nothing read out of it says which container THIS invocation minted. A
   * caller that has to know — because it is checking that this drill removed
   * what this drill created — is told here, on every path, since the drill
   * fails as often as it returns.
   */
  readonly onScratchContainer?: (name: string) => void;
}

/**
 * Waits for a scratch server that answers rather than for one that has merely
 * started: the image's own initialisation runs a server on a socket before the
 * real one listens, so only a query over the network proves the database is
 * there and the password works.
 */
async function awaitScratchReady(
  run: CommandRunner,
  delay: (ms: number) => Promise<void>,
  client: (command: readonly string[]) => string[],
  env: Readonly<Record<string, string>>
): Promise<void> {
  for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
    const outcome = await run('docker', client(psqlCommand('select 1')), env);
    if (outcome.exitCode === 0) return;
    await delay(READINESS_DELAY_MS);
  }
  throw new Error(
    `runRestoreDrill: the scratch database never accepted a connection in ${String(READINESS_ATTEMPTS)} attempts`
  );
}

async function readRestoredManifest(destination: string): Promise<DumpManifest> {
  const raw = await readFile(path.join(destination, DUMP_MANIFEST_FILE), 'utf8');
  return DumpManifestSchema.parse(JSON.parse(raw));
}

/**
 * Restores the newest dump into a scratch server and proves it against the
 * manifest that travelled with it.
 *
 * Removal of the scratch container is not conditional on the drill succeeding
 * and never replaces the reason it failed: a drill that fails and also leaves
 * plaintext data behind reports both, because either one alone would be a
 * different and less serious problem.
 */
export async function runRestoreDrill(options: RestoreDrillOptions): Promise<DrillResult> {
  const { rusticPath, configPath, image, workDir } = options;
  const run = options.run ?? execaRunner;
  const delay =
    options.delay ??
    (async (ms: number): Promise<void> => {
      await delayFor(ms);
    });

  const destination = path.join(workDir, RESTORE_DIRECTORY_NAME);
  const name = `${SCRATCH_CONTAINER_PREFIX}${randomBytes(NAME_BYTES).toString('hex')}`;
  const password = randomBytes(PASSWORD_BYTES).toString('base64url');
  const env = scratchEnvironment(password);
  const user = containerUser(process);
  const client = (command: readonly string[], mountPath?: string): string[] =>
    clientRunArguments({ image, container: name, env, command, mountPath, user });
  const output = async (
    label: string,
    command: string,
    args: readonly string[],
    commandEnv: Readonly<Record<string, string>>
  ): Promise<string> => expectCommandOutput(label, await run(command, args, commandEnv));

  // Deliberately outside the deletion in this function's `finally`: a
  // destination refused because it already holds something is one this drill
  // did not create, and deleting it would destroy what the refusal protects.
  await prepareOutDir(destination);
  try {
    await output('rustic restore', rusticPath, restoreArguments({ configPath, destination }), {});
    const manifest = await readRestoredManifest(destination);

    let outcome: { readonly result: DrillResult } | { readonly failure: unknown };
    try {
      options.onScratchContainer?.(name);
      // Claim before create, so a drill killed between this line and the run
      // below leaves a container its run's record names rather than one nothing
      // on the machine can attribute — the state no reclaim may remove and no
      // check may distinguish from another run's.
      //
      // A caller holding no run claim records nothing and is not refused. The
      // scheduled backup is one, and no claim would serve it: a claim exists so
      // that a later run on the same machine can classify what an earlier one
      // left, and the runner `.github/workflows/backup.yml` takes is built for
      // its single job and destroyed with it, so nothing would ever read the
      // record. What accounts for the container there is {@link removeScratch}
      // instead — asked for on the success and the failure path alike once the
      // container may exist, and a failure in its own right when it cannot
      // remove one — so a container outliving that path fails the run rather
      // than standing unattributed.
      await recordOwnedResourceIfClaimed('container', name);
      await output('the scratch server', 'docker', scratchRunArguments({ name, image }), {
        POSTGRES_PASSWORD: password,
      });
      await awaitScratchReady(run, delay, client, env);
      await output('pg_restore', 'docker', client(pgRestoreCommand(), destination), env);
      const census = await output(
        'the census query',
        'docker',
        client(psqlCommand(RESTORE_STATE_QUERY)),
        env
      );
      const result = compareRestore(manifest, parseRestoredState(census));
      if (!result.passed) throw new RestoreDrillError(result);
      outcome = { result };
    } catch (error) {
      outcome = { failure: error };
    }

    const leftBehind = await removeScratch(run, name);
    if ('failure' in outcome) {
      if (leftBehind === undefined) throw outcome.failure;
      throw new AggregateError(
        [outcome.failure, leftBehind],
        'runRestoreDrill: the drill failed and its scratch container could not be removed'
      );
    }
    if (leftBehind !== undefined) {
      throw new Error(
        'runRestoreDrill: the scratch container holding the restored data could not be removed',
        { cause: leftBehind }
      );
    }
    return outcome.result;
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

/**
 * Removes the scratch container, reporting rather than throwing a failure.
 *
 * It is asked for even when the server never started, because a `docker run`
 * that failed may still have left a created container behind; `docker rm
 * --force` exits 0 on a name that does not exist, so asking costs nothing.
 */
async function removeScratch(run: CommandRunner, name: string): Promise<unknown> {
  try {
    expectCommandOutput('docker rm', await run('docker', removeScratchArguments(name), {}));
    return undefined;
  } catch (error) {
    return error;
  }
}
