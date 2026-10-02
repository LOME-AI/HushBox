import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  DumpManifestSchema,
  POSTGRES_IMAGE,
  assertDumpSucceeded,
  containerConnection,
  containerUser,
  dumpCommandArguments,
  dumpCommandOptions,
  dumpDatabase,
  prepareOutDir,
  readSnapshotFacts,
} from './postgres.js';
import type { SnapshotQuery } from './postgres.js';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('POSTGRES_IMAGE', () => {
  it('names the image the local stack already runs', () => {
    const compose = parse(readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8')) as {
      services: { postgres: { image: string } };
    };

    expect(POSTGRES_IMAGE).toBe(compose.services.postgres.image);
  });
});

describe('containerConnection', () => {
  it('maps every connection field onto its libpq variable', () => {
    const connection = containerConnection('postgresql://dumper:letmein@db.example.net:6543/main');

    expect(connection.env).toEqual({
      PGHOST: 'db.example.net',
      PGPORT: '6543',
      PGUSER: 'dumper',
      PGPASSWORD: 'letmein',
      PGDATABASE: 'main',
    });
  });

  it('percent-decodes the user and the password', () => {
    const connection = containerConnection('postgresql://a%40b:p%2Fw@db.example.net/main');

    expect(connection.env['PGUSER']).toBe('a@b');
    expect(connection.env['PGPASSWORD']).toBe('p/w');
  });

  it('supplies the default port when the URL names none', () => {
    const connection = containerConnection('postgresql://u:p@db.example.net/main');

    expect(connection.env['PGPORT']).toBe('5432');
  });

  it('omits PGPASSWORD when the URL carries no password', () => {
    const connection = containerConnection('postgresql://u@db.example.net/main');

    expect(connection.env['PGPASSWORD']).toBeUndefined();
  });

  it('translates recognised connection parameters', () => {
    const connection = containerConnection(
      'postgresql://u:p@db.example.net/main?sslmode=require&channel_binding=require'
    );

    expect(connection.env['PGSSLMODE']).toBe('require');
    expect(connection.env['PGCHANNELBINDING']).toBe('require');
  });

  it('rejects a connection parameter it cannot translate', () => {
    expect(() =>
      containerConnection('postgresql://u:p@db.example.net/main?target_session_attrs=rw')
    ).toThrow(/target_session_attrs/);
  });

  it('rejects a string that is not a URL at all', () => {
    expect(() => containerConnection('db.example.net/main')).toThrow(/not a URL/);
  });

  it('rejects a URL that is not a Postgres URL', () => {
    expect(() => containerConnection('mysql://u:p@db.example.net/main')).toThrow(/postgres/);
  });

  it('rejects a URL that names no user', () => {
    expect(() => containerConnection('postgresql://db.example.net/main')).toThrow(/user/);
  });

  it('rejects a URL that names no database', () => {
    expect(() => containerConnection('postgresql://u:p@db.example.net')).toThrow(/database/);
  });

  it('rewrites a loopback host to the alias a container resolves to the host machine', () => {
    const connection = containerConnection('postgresql://u:p@localhost:10600/main');

    expect(connection.env['PGHOST']).toBe('host.docker.internal');
  });

  it('asks for the host-gateway alias only when it rewrote a loopback host', () => {
    expect(containerConnection('postgresql://u:p@localhost:10600/main').needsHostGateway).toBe(
      true
    );
    expect(containerConnection('postgresql://u:p@db.example.net/main').needsHostGateway).toBe(
      false
    );
  });
});

describe('containerUser', () => {
  it('renders the invoking uid and gid', () => {
    expect(containerUser({ getuid: () => 1000, getgid: () => 20 })).toBe('1000:20');
  });

  it('names no user on a platform that has none', () => {
    expect(containerUser({})).toBeUndefined();
  });
});

describe('dumpCommandArguments', () => {
  const connection = containerConnection('postgresql://u:p@db.example.net/main');

  it('runs pg_dump in the given image over a bind-mounted output directory', () => {
    expect(
      dumpCommandArguments({
        image: 'postgres:18-alpine',
        outDir: '/work/dump',
        snapshotId: '00000003-00000002-1',
        connection,
        user: '1000:20',
      })
    ).toEqual([
      'run',
      '--rm',
      '--user',
      '1000:20',
      '-e',
      'PGHOST',
      '-e',
      'PGPORT',
      '-e',
      'PGUSER',
      '-e',
      'PGPASSWORD',
      '-e',
      'PGDATABASE',
      '-v',
      '/work/dump:/dump',
      'postgres:18-alpine',
      'pg_dump',
      '-Fd',
      '-Z0',
      '--jobs',
      '4',
      '--no-owner',
      '--no-privileges',
      '--lock-wait-timeout=60000',
      '--snapshot=00000003-00000002-1',
      '-f',
      '/dump',
    ]);
  });

  it('carries no credential in any argument', () => {
    const args = dumpCommandArguments({
      image: 'postgres:18-alpine',
      outDir: '/work/dump',
      snapshotId: '00000003-00000002-1',
      connection: containerConnection('postgresql://dumper:letmein@db.example.net/main'),
      user: undefined,
    });

    expect(args.join(' ')).not.toContain('letmein');
    expect(args.join(' ')).not.toContain('dumper');
  });

  it('omits the user flag when the platform names no user', () => {
    const args = dumpCommandArguments({
      image: 'postgres:18-alpine',
      outDir: '/work/dump',
      snapshotId: '00000003-00000002-1',
      connection,
      user: undefined,
    });

    expect(args).not.toContain('--user');
  });

  it('publishes the host gateway only for a loopback connection', () => {
    const local = dumpCommandArguments({
      image: 'postgres:18-alpine',
      outDir: '/work/dump',
      snapshotId: '00000003-00000002-1',
      connection: containerConnection('postgresql://u:p@localhost:10600/main'),
      user: undefined,
    });

    expect(local).toContain('--add-host=host.docker.internal:host-gateway');
    expect(
      dumpCommandArguments({
        image: 'postgres:18-alpine',
        outDir: '/work/dump',
        snapshotId: '00000003-00000002-1',
        connection,
        user: undefined,
      })
    ).not.toContain('--add-host=host.docker.internal:host-gateway');
  });
});

describe('DumpManifestSchema', () => {
  it('accepts a manifest carrying counts and a migration head', () => {
    const parsed = DumpManifestSchema.parse({
      snapshotId: '00000003-00000002-1',
      tables: { users: 2 },
      migrationHead: 'abc',
      formatVersion: 1,
    });

    expect(parsed.tables['users']).toBe(2);
  });

  it('rejects a fractional row count', () => {
    expect(() =>
      DumpManifestSchema.parse({
        snapshotId: 's',
        tables: { users: 1.5 },
        migrationHead: 'abc',
        formatVersion: 1,
      })
    ).toThrow();
  });
});

/**
 * The reads happen in a fixed order — snapshot, table list, one count per
 * table, journal head — so a queue answers them without the fake having to
 * understand SQL.
 */
function queuedQuery(responses: Record<string, unknown>[][]): SnapshotQuery {
  const queue = [...responses];
  return () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error('the fake was asked for more rows than the test queued');
    }
    return Promise.resolve(next);
  };
}

describe('readSnapshotFacts', () => {
  const seeded = (): SnapshotQuery =>
    queuedQuery([
      [{ snapshot_id: '00000003-00000002-1' }],
      [{ tablename: 'users' }, { tablename: 'wallets' }],
      [{ row_count: '2' }],
      [{ row_count: '0' }],
      [{ hash: 'a1b2' }],
    ]);

  it('reports the snapshot the readings were taken under', async () => {
    await expect(readSnapshotFacts(seeded())).resolves.toMatchObject({
      snapshotId: '00000003-00000002-1',
    });
  });

  it('reports one row count per table in the public schema', async () => {
    await expect(readSnapshotFacts(seeded())).resolves.toMatchObject({
      tables: { users: 2, wallets: 0 },
    });
  });

  it('reports the newest journal hash as the migration head', async () => {
    await expect(readSnapshotFacts(seeded())).resolves.toMatchObject({ migrationHead: 'a1b2' });
  });

  it('reports no count when the public schema holds no table', async () => {
    const facts = await readSnapshotFacts(
      queuedQuery([[{ snapshot_id: 's' }], [], [{ hash: 'a1b2' }]])
    );

    expect(facts.tables).toEqual({});
  });

  it('refuses a database whose migration journal is empty', async () => {
    await expect(readSnapshotFacts(queuedQuery([[{ snapshot_id: 's' }], [], []]))).rejects.toThrow(
      /no applied migration/
    );
  });

  it('refuses a count that comes back without a row', async () => {
    await expect(
      readSnapshotFacts(queuedQuery([[{ snapshot_id: 's' }], [{ tablename: 'users' }], []]))
    ).rejects.toThrow(/returned no row/);
  });

  it('refuses a row count that is not a whole number', async () => {
    await expect(
      readSnapshotFacts(
        queuedQuery([
          [{ snapshot_id: 's' }],
          [{ tablename: 'users' }],
          [{ row_count: 'not a number' }],
        ])
      )
    ).rejects.toThrow(/not a whole number/);
  });
});

describe('dumpCommandOptions', () => {
  const connection = containerConnection('postgresql://u:p@db.example.net/main');

  it('hands the client its credentials through the subprocess environment', () => {
    expect(dumpCommandOptions(connection).env).toEqual(connection.env);
  });

  it('bounds how long the client may run', () => {
    const { timeout } = dumpCommandOptions(connection);

    expect(Number.isFinite(timeout)).toBe(true);
    expect(timeout).toBeGreaterThan(0);
  });
});

describe('assertDumpSucceeded', () => {
  it('accepts a client that exited zero', () => {
    expect(() => {
      assertDumpSucceeded({ exitCode: 0, timedOut: false, stderr: '' });
    }).not.toThrow();
  });

  it('reports the exit code and what the client wrote', () => {
    expect(() => {
      assertDumpSucceeded({ exitCode: 1, timedOut: false, stderr: 'connection refused' });
    }).toThrow(/exited 1[\s\S]*connection refused/);
  });

  it('reports a client killed at its limit rather than the exit code it never had', () => {
    expect(() => {
      assertDumpSucceeded({ exitCode: undefined, timedOut: true, stderr: '' });
    }).toThrow(/ran past its limit/);
  });
});

describe('prepareOutDir', () => {
  it.skipIf(process.platform === 'win32')(
    'leaves the directory reachable only by the user the dump belongs to',
    async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'hb-dump-mode-'));
      const outDir = path.join(parent, 'dump');
      await mkdir(outDir);
      await chmod(outDir, 0o777);

      try {
        await prepareOutDir(outDir);
        const stats = await stat(outDir);

        expect(stats.mode & 0o777).toBe(0o700);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    }
  );
});

describe('dumpDatabase', () => {
  it('refuses an output directory that already holds files', async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), 'hb-dump-guard-'));
    await writeFile(path.join(outDir, 'keep.txt'), 'x');
    try {
      await expect(
        dumpDatabase({
          databaseUrl: 'postgresql://u:p@db.example.net/main',
          outDir,
          image: POSTGRES_IMAGE,
        })
      ).rejects.toThrow(/not empty/);
      await expect(rm(path.join(outDir, 'keep.txt'))).resolves.toBeUndefined();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
