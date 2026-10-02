import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DUMP_LABEL } from './config.js';
import {
  READINESS_ATTEMPTS,
  RESTORE_DIRECTORY_NAME,
  RESTORE_STATE_QUERY,
  RestoreDrillError,
  clientRunArguments,
  compareRestore,
  expectCommandOutput,
  parseRestoredState,
  restoreArguments,
  runRestoreDrill,
  scratchEnvironment,
  scratchRunArguments,
} from './drill.js';
import { DUMP_MANIFEST_FILE, POSTGRES_IMAGE } from './postgres.js';
import type { CommandOutcome, CommandRunner, RestoredState } from './drill.js';
import type { DumpManifest } from './postgres.js';

function manifestOf(tables: Record<string, number>, migrationHead = 'head'): DumpManifest {
  return { snapshotId: '1:1:', tables, migrationHead, formatVersion: 1 };
}

function stateOf(
  tables: Record<string, number>,
  migrationHead: string | null = 'head'
): RestoredState {
  return { tables, migrationHead };
}

describe('restoreArguments', () => {
  it('restores the dump path of the newest snapshot carrying the dump label', () => {
    const args = restoreArguments({ configPath: '/cfg/rustic.toml', destination: '/work/restore' });

    expect(args).toEqual([
      '--use-profile',
      '/cfg/rustic.toml',
      'restore',
      `latest:/${DUMP_LABEL}`,
      '/work/restore',
      '--filter-label',
      DUMP_LABEL,
      '--filter-host',
      'hushbox-backup',
    ]);
  });
});

describe('scratchRunArguments', () => {
  it('names the password variable without its value', () => {
    const args = scratchRunArguments({ name: 'hushbox-drill-abc', image: POSTGRES_IMAGE });

    expect(args).toEqual([
      'run',
      '--detach',
      '--name',
      'hushbox-drill-abc',
      '-e',
      'POSTGRES_PASSWORD',
      POSTGRES_IMAGE,
    ]);
  });
});

describe('clientRunArguments', () => {
  it('shares the scratch container network and names every variable without a value', () => {
    const args = clientRunArguments({
      image: POSTGRES_IMAGE,
      container: 'hushbox-drill-abc',
      env: scratchEnvironment('shhh'),
      command: ['psql'],
    });

    expect(args.slice(0, 4)).toEqual(['run', '--rm', '--network', 'container:hushbox-drill-abc']);
    expect(args).toContain('PGPASSWORD');
    expect(args).not.toContain('shhh');
    expect(args.at(-1)).toBe('psql');
  });

  it('mounts the restored dump read-only as the invoking user when one is given', () => {
    const args = clientRunArguments({
      image: POSTGRES_IMAGE,
      container: 'hushbox-drill-abc',
      env: scratchEnvironment('shhh'),
      command: ['pg_restore'],
      mountPath: '/work/restore',
      user: '1000:1000',
    });

    expect(args).toContain('--user');
    expect(args).toContain('1000:1000');
    expect(args).toContain('/work/restore:/dump:ro');
  });
});

describe('scratchEnvironment', () => {
  it('carries the password and the connection the client reads it with', () => {
    expect(scratchEnvironment('shhh')).toEqual({
      PGPASSWORD: 'shhh',
      PGHOST: '127.0.0.1',
      PGUSER: 'postgres',
      PGDATABASE: 'postgres',
    });
  });
});

describe('expectCommandOutput', () => {
  it('is what the command printed when it exited cleanly', () => {
    expect(
      expectCommandOutput('the census query', { exitCode: 0, timedOut: false, stdout: '{}' })
    ).toBe('{}');
  });

  it('names the command and its exit status and nothing the command printed', async () => {
    const detail = 'DETAIL: Key (email)=(person@example.test) already exists.';
    const child = await execa(
      process.execPath,
      ['-e', `console.error(${JSON.stringify(detail)}); process.exit(3)`],
      { reject: false }
    );
    const outcome: CommandOutcome = {
      exitCode: child.exitCode,
      timedOut: child.timedOut,
      stdout: '',
    };

    // What a raw subprocess error publishes, and the reason this seam drops it:
    // the child's own message carries every byte it wrote.
    expect(child.message).toContain('person@example.test');
    expect(() => expectCommandOutput('pg_restore', outcome)).toThrow(
      'runRestoreDrill: pg_restore exited 3'
    );
    expect(() => expectCommandOutput('pg_restore', outcome)).not.toThrow(/person@example.test/);
  });

  it('names a command the runtime ceiling killed', () => {
    expect(() =>
      expectCommandOutput('pg_restore', { exitCode: undefined, timedOut: true, stdout: '' })
    ).toThrow(/ran past its limit/);
  });

  it('names a command that never reached an exit status', () => {
    expect(() =>
      expectCommandOutput('pg_restore', { exitCode: undefined, timedOut: false, stdout: '' })
    ).toThrow(/no exit status/);
  });
});

describe('parseRestoredState', () => {
  it('reads the census and the migration head the restored database answers with', () => {
    const parsed = parseRestoredState('{"tables":{"users":3},"migrationHead":"abc"}\n');

    expect(parsed).toEqual({ tables: { users: 3 }, migrationHead: 'abc' });
  });

  it('reads a database that holds no applied migration as holding none', () => {
    expect(parseRestoredState('{"tables":{},"migrationHead":null}').migrationHead).toBeNull();
  });

  it('refuses an answer that is not the census shape', () => {
    expect(() => parseRestoredState('{"tables":{"users":"three"}}')).toThrow();
  });

  it('refuses an answer that is not JSON', () => {
    expect(() => parseRestoredState('ERROR: relation does not exist')).toThrow(
      /answered no census/
    );
  });

  it('names every table in one query rather than one query per table', () => {
    expect(RESTORE_STATE_QUERY).toContain('pg_tables');
  });
});

describe('compareRestore', () => {
  it('passes when every count and the migration head match', () => {
    const result = compareRestore(
      manifestOf({ users: 3, wallets: 1 }),
      stateOf({ users: 3, wallets: 1 })
    );

    expect(result).toEqual({ tablesChecked: 2, passed: true, mismatches: [] });
  });

  it('names a table the restore holds a different number of rows for', () => {
    const result = compareRestore(manifestOf({ users: 3 }), stateOf({ users: 2 }));

    expect(result.passed).toBe(false);
    expect(result.mismatches).toEqual([{ table: 'users', expected: 3, actual: 2 }]);
  });

  it('names a table the manifest holds and the restore dropped', () => {
    const result = compareRestore(manifestOf({ users: 3, wallets: 1 }), stateOf({ users: 3 }));

    expect(result.passed).toBe(false);
    expect(result.mismatches).toEqual([{ table: 'wallets', expected: 1, actual: undefined }]);
    expect(result.tablesChecked).toBe(2);
  });

  it('names a table the restore holds and the manifest never recorded', () => {
    const result = compareRestore(manifestOf({ users: 3 }), stateOf({ users: 3, stowaway: 7 }));

    expect(result.passed).toBe(false);
    expect(result.mismatches).toEqual([{ table: 'stowaway', expected: undefined, actual: 7 }]);
    expect(result.tablesChecked).toBe(2);
  });

  it('fails a comparison that had no table to compare', () => {
    const result = compareRestore(manifestOf({}), stateOf({}));

    expect(result.passed).toBe(false);
    expect(result.tablesChecked).toBe(0);
  });

  it('fails a restore whose schema is not the schema the dump was taken at', () => {
    const result = compareRestore(manifestOf({ users: 3 }, 'abc'), stateOf({ users: 3 }, 'def'));

    expect(result.passed).toBe(false);
    expect(result.migrationHeadMismatch).toEqual({ expected: 'abc', actual: 'def' });
  });

  it('fails a restore that holds no applied migration', () => {
    const result = compareRestore(manifestOf({ users: 3 }, 'abc'), stateOf({ users: 3 }, null));

    expect(result.passed).toBe(false);
    expect(result.migrationHeadMismatch).toEqual({ expected: 'abc', actual: null });
  });
});

describe('RestoreDrillError', () => {
  it('names the tables that did not match', () => {
    const error = new RestoreDrillError(
      compareRestore(manifestOf({ users: 3 }), stateOf({ users: 2 }))
    );

    expect(error.message).toContain('users');
    expect(error.name).toBe('RestoreDrillError');
  });

  it('says that nothing was compared when nothing was', () => {
    const error = new RestoreDrillError(compareRestore(manifestOf({}), stateOf({})));

    expect(error.message).toContain('no table');
  });

  it('names both migration heads', () => {
    const error = new RestoreDrillError(
      compareRestore(manifestOf({ users: 1 }, 'abc'), stateOf({ users: 1 }, 'def'))
    );

    expect(error.message).toContain('abc');
    expect(error.message).toContain('def');
  });

  it('says that a table the manifest recorded is not in the restore at all', () => {
    const error = new RestoreDrillError(
      compareRestore(manifestOf({ users: 3, wallets: 1 }), stateOf({ users: 3 }))
    );

    expect(error.message).toContain('wallets');
    expect(error.message).toContain('no such table');
  });

  it('says that the restore holds no applied migration when it holds none', () => {
    const error = new RestoreDrillError(
      compareRestore(manifestOf({ users: 1 }, 'abc'), stateOf({ users: 1 }, null))
    );

    expect(error.message).toContain('no applied migration');
  });
});

/** One recorded subprocess: what was run, with which arguments and environment. */
interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

interface FakeOptions {
  /** The census the scratch database answers with. */
  readonly census?: string;
  /** How many readiness attempts refuse before one is accepted. */
  readonly refusals?: number;
  /** Commands that exit non-zero when reached, keyed by a word in their arguments. */
  readonly failing?: readonly string[];
  /** What the restore leaves as the manifest; `null` leaves none at all. */
  readonly manifest?: string | null;
}

interface Fake {
  readonly run: CommandRunner;
  readonly calls: Call[];
}

const exited = (code: number, stdout = ''): CommandOutcome => ({
  exitCode: code,
  timedOut: false,
  stdout,
});

function fakeRunner(options: FakeOptions = {}): Fake {
  const calls: Call[] = [];
  let refusals = options.refusals ?? 0;
  const failing = options.failing ?? [];
  const census = options.census ?? '{"tables":{"users":3},"migrationHead":"head"}';
  const manifest =
    options.manifest === undefined ? JSON.stringify(manifestOf({ users: 3 })) : options.manifest;

  const run: CommandRunner = async (command, args, env) => {
    calls.push({ command, args, env });
    if (failing.some((candidate) => args.includes(candidate))) return exited(1);
    if (command !== 'docker') {
      const destination = args[4];
      if (destination === undefined) throw new Error('fake: the restore names no destination');
      if (manifest !== null) {
        await writeFile(path.join(destination, DUMP_MANIFEST_FILE), manifest);
      }
      return exited(0);
    }
    if (args.includes('select 1')) {
      if (refusals > 0) {
        refusals -= 1;
        return exited(1);
      }
      return exited(0, '1');
    }
    if (args.includes(RESTORE_STATE_QUERY)) return exited(0, census);
    return exited(0);
  };
  return { run, calls };
}

describe('runRestoreDrill', () => {
  let workDir: string;

  const options = (
    fake: Fake,
    extra: { readonly refusals?: number } = {}
  ): Parameters<typeof runRestoreDrill>[0] => ({
    rusticPath: '/bin/rustic',
    configPath: '/cfg/rustic.toml',
    image: POSTGRES_IMAGE,
    workDir,
    run: fake.run,
    delay: async (): Promise<void> => {
      await Promise.resolve();
    },
    ...extra,
  });

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'hb-drill-unit-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('proves the restored database against the manifest the restore carried', async () => {
    const fake = fakeRunner();

    await expect(runRestoreDrill(options(fake))).resolves.toEqual({
      tablesChecked: 1,
      passed: true,
      mismatches: [],
    });
  });

  it('puts the scratch password in no argument of any command it runs', async () => {
    const fake = fakeRunner();

    await runRestoreDrill(options(fake));

    const started = fake.calls.find((call) => call.args.includes('--detach'));
    const password = started?.env['POSTGRES_PASSWORD'];
    expect(password).toBeTruthy();
    for (const call of fake.calls) {
      expect(call.args.some((argument) => argument.includes(String(password)))).toBe(false);
    }
  });

  it('removes the scratch container and its volumes however the drill ends', async () => {
    const fake = fakeRunner({ census: '{"tables":{"users":2},"migrationHead":"head"}' });

    await expect(runRestoreDrill(options(fake))).rejects.toThrow(/users/);

    const removal = fake.calls.find((call) => call.args[0] === 'rm');
    expect(removal?.args).toEqual(['rm', '--force', '--volumes', expect.any(String)]);
  });

  it('removes the scratch container when the dump cannot be loaded into it', async () => {
    const fake = fakeRunner({ failing: ['pg_restore'] });

    await expect(runRestoreDrill(options(fake))).rejects.toThrow(/pg_restore/);

    expect(fake.calls.some((call) => call.args[0] === 'rm')).toBe(true);
  });

  it('deletes the restored dump once the drill is over', async () => {
    const fake = fakeRunner();

    await runRestoreDrill(options(fake));

    await expect(stat(path.join(workDir, RESTORE_DIRECTORY_NAME))).rejects.toThrow();
  });

  it('waits for a scratch database that is not accepting connections yet', async () => {
    const fake = fakeRunner({ refusals: 3 });

    await expect(runRestoreDrill(options(fake))).resolves.toMatchObject({ passed: true });

    const attempts = fake.calls.filter((call) => call.args.includes('select 1'));
    expect(attempts).toHaveLength(4);
  });

  it('gives up on a scratch database that never accepts connections', async () => {
    const fake = fakeRunner({ refusals: READINESS_ATTEMPTS });

    await expect(runRestoreDrill(options(fake))).rejects.toThrow(/never accepted/);
    expect(fake.calls.some((call) => call.args[0] === 'rm')).toBe(true);
  });

  it('fails loudly when the scratch container holding the data cannot be removed', async () => {
    const fake = fakeRunner({ failing: ['--volumes'] });

    await expect(runRestoreDrill(options(fake))).rejects.toThrow(/could not be removed/);
  });

  it('reports both failures when a failed drill also leaves its container behind', async () => {
    const fake = fakeRunner({ failing: ['pg_restore', '--volumes'] });

    await expect(runRestoreDrill(options(fake))).rejects.toThrow(AggregateError);
  });

  it('reads the manifest out of the restored tree', async () => {
    const fake = fakeRunner();

    await runRestoreDrill(options(fake));

    const restore = fake.calls.find((call) => call.command !== 'docker');
    expect(restore?.args.at(4)).toBe(path.join(workDir, RESTORE_DIRECTORY_NAME));
  });

  it('starts no scratch server when the dump could not be restored out of the repository', async () => {
    const fake = fakeRunner({ failing: ['restore'] });

    await expect(runRestoreDrill(options(fake))).rejects.toThrow(/rustic restore exited 1/);

    expect(fake.calls.some((call) => call.command === 'docker')).toBe(false);
    await expect(stat(path.join(workDir, RESTORE_DIRECTORY_NAME))).rejects.toThrow();
  });

  it('asks for the removal of a scratch server that could not be started', async () => {
    const fake = fakeRunner({ failing: ['--detach'] });

    await expect(runRestoreDrill(options(fake))).rejects.toThrow(/the scratch server exited 1/);

    expect(fake.calls.some((call) => call.args[0] === 'rm')).toBe(true);
  });

  it('starts no scratch server when the restored tree carries no manifest', async () => {
    const fake = fakeRunner({ manifest: null });

    await expect(runRestoreDrill(options(fake))).rejects.toThrow();

    expect(fake.calls.some((call) => call.command === 'docker')).toBe(false);
  });

  it('starts no scratch server when the restored manifest is not a manifest', async () => {
    const fake = fakeRunner({ manifest: '{"tables":{"users":"three"}}' });

    await expect(runRestoreDrill(options(fake))).rejects.toThrow();

    expect(fake.calls.some((call) => call.command === 'docker')).toBe(false);
  });

  it('leaves a destination it was refused as it found it', async () => {
    const destination = path.join(workDir, RESTORE_DIRECTORY_NAME);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'keep.txt'), 'x');
    const fake = fakeRunner();

    await expect(runRestoreDrill(options(fake))).rejects.toThrow(/not empty/);

    await expect(readFile(path.join(destination, 'keep.txt'), 'utf8')).resolves.toBe('x');
  });
});
