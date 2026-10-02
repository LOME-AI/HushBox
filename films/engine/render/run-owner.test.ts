import { describe, expect, it } from 'vitest';

import {
  RunOwnerError,
  ownerAlive,
  parseRunOwner,
  runDirectoryPrefix,
  startToken,
  systemReads,
} from './run-owner.js';

import type { OwnerReads, RunResult } from './run-owner.js';

const BOOT_ID = '6f1c2a5e-9b0d-4d8e-a1f2-3c4d5e6f7a8b';

/** A `/proc/<pid>/stat` record whose command holds a space and a bracket, in state `state`, started at `ticks`. */
function statRecord(pid: number, state: string, ticks: number): string {
  const before = [state, '1', String(pid), String(pid), '0', '-1', '4194560'];
  const middle = Array.from({ length: 12 }, () => '0');
  return `${String(pid)} (node (worker) a) ${[...before, ...middle, String(ticks), '0'].join(' ')}\n`;
}

function missing(file: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), {
    code: 'ENOENT',
  });
}

/** Reads of a Linux machine whose process filesystem holds the given records. */
function linux(records: Readonly<Record<string, string>>): OwnerReads {
  return {
    platform: 'linux',
    readFile: (file) => {
      if (file === '/proc/sys/kernel/random/boot_id') return Promise.resolve(`${BOOT_ID}\n`);
      const record = records[file];
      return record === undefined ? Promise.reject(missing(file)) : Promise.resolve(record);
    },
    run: () => Promise.reject(new Error('Linux reads no tool')),
  };
}

/** Reads of a machine whose one tool answers `result`, recording each call and its environment. */
function tool(
  platform: NodeJS.Platform,
  result: RunResult | Error,
  calls: string[][] = [],
  environments: (Readonly<Record<string, string>> | undefined)[] = []
): OwnerReads {
  return {
    platform,
    readFile: (file) => Promise.reject(missing(file)),
    run: (command, args, environment) => {
      calls.push([command, ...args]);
      environments.push(environment);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

/** What `promise` rejects with, or the string 'resolved'. */
async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error;
  }
}

describe('startToken on Linux', () => {
  it("reads the process's start ticks and the boot it started in", async () => {
    const reads = linux({ '/proc/42/stat': statRecord(42, 'S', 9_876_543) });

    await expect(startToken(42, reads)).resolves.toBe(`linux:${BOOT_ID}:9876543`);
  });

  it('answers null for a process the process filesystem has no record of', async () => {
    await expect(startToken(42, linux({}))).resolves.toBeNull();
  });

  it('answers null for a process that has exited and not yet been collected', async () => {
    const reads = linux({ '/proc/42/stat': statRecord(42, 'Z', 9_876_543) });

    await expect(startToken(42, reads)).resolves.toBeNull();
  });

  it('refuses a record that names no command', async () => {
    const reads = linux({ '/proc/42/stat': '42 S 1 42\n' });

    expect(await outcomeOf(startToken(42, reads))).toBeInstanceOf(RunOwnerError);
  });

  it('passes on a read failure other than a missing record', async () => {
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const reads: OwnerReads = { ...linux({}), readFile: () => Promise.reject(denied) };

    expect(await outcomeOf(startToken(42, reads))).toBeInstanceOf(RunOwnerError);
  });
});

describe('startToken on macOS', () => {
  it('reads the start time ps prints for the process', async () => {
    const calls: string[][] = [];
    // Any line ps prints is the token; this one stands in for its printed start.
    const reads = tool('darwin', { exitCode: 0, stdout: 'printed start of 42\n' }, calls);

    const token = await startToken(42, reads);

    expect([token, calls]).toEqual([
      'darwin:printed start of 42',
      [['ps', '-o', 'lstart=', '-p', '42']],
    ]);
  });

  it('runs ps in one time zone and locale, so every caller prints the same start', async () => {
    const environments: (Readonly<Record<string, string>> | undefined)[] = [];
    const reads = tool(
      'darwin',
      { exitCode: 0, stdout: 'printed start of 42\n' },
      [],
      environments
    );

    await startToken(42, reads);

    expect(environments).toEqual([{ TZ: 'UTC', LC_ALL: 'C' }]);
  });

  it('answers null when ps finds no such process', async () => {
    await expect(startToken(42, tool('darwin', { exitCode: 1, stdout: '' }))).resolves.toBeNull();
  });

  it('refuses any other answer from ps', async () => {
    const reads = tool('darwin', { exitCode: 2, stdout: 'ps: illegal option' });

    expect(await outcomeOf(startToken(42, reads))).toBeInstanceOf(RunOwnerError);
  });

  it('refuses when ps cannot be run', async () => {
    const reads = tool('darwin', new Error('spawn ps ENOENT'));

    expect(await outcomeOf(startToken(42, reads))).toBeInstanceOf(RunOwnerError);
  });
});

describe('startToken on Windows', () => {
  it("reads the process's creation time as a UTC file time", async () => {
    const calls: string[][] = [];
    const reads = tool('win32', { exitCode: 0, stdout: '134041234567890123\r\n' }, calls);

    const token = await startToken(42, reads);

    expect([token, calls[0]?.[0], calls[0]?.at(-1)?.includes("'ProcessId=42'")]).toEqual([
      'win32:134041234567890123',
      'powershell.exe',
      true,
    ]);
  });

  it('answers null when no such process exists', async () => {
    await expect(
      startToken(42, tool('win32', { exitCode: 0, stdout: '\r\n' }))
    ).resolves.toBeNull();
  });

  it('refuses an answer that is not a file time', async () => {
    const reads = tool('win32', { exitCode: 0, stdout: 'Get-CimInstance : Access denied' });

    expect(await outcomeOf(startToken(42, reads))).toBeInstanceOf(RunOwnerError);
  });

  it('refuses when PowerShell fails', async () => {
    const reads = tool('win32', { exitCode: 1, stdout: '' });

    expect(await outcomeOf(startToken(42, reads))).toBeInstanceOf(RunOwnerError);
  });
});

describe('startToken elsewhere', () => {
  it('refuses a platform it has no read for', async () => {
    const reads = tool('aix', { exitCode: 0, stdout: '' });

    expect(await outcomeOf(startToken(42, reads))).toBeInstanceOf(RunOwnerError);
  });
});

describe('startToken on this machine', () => {
  it('reads the same token for this process twice', async () => {
    const first = await startToken(process.pid, systemReads);
    const second = await startToken(process.pid, systemReads);

    expect([first === null, first === second]).toEqual([false, true]);
  });
});

describe('runDirectoryPrefix and parseRunOwner', () => {
  it('reads back the pid and start-token digest a prefix records', () => {
    const name = `${runDirectoryPrefix(42, 'linux:boot:7')}Ab3dE9`;

    expect(parseRunOwner(name)).toEqual({
      pid: 42,
      digest: runDirectoryPrefix(42, 'linux:boot:7').split('-')[2],
    });
  });

  it('records different start tokens under different digests', () => {
    expect(runDirectoryPrefix(42, 'linux:boot:7')).not.toBe(runDirectoryPrefix(42, 'linux:boot:8'));
  });

  it('reads no owner from a name that records none', () => {
    expect([
      parseRunOwner('run-Ab3dE9'),
      parseRunOwner('stills'),
      parseRunOwner('run-42-x-Ab3dE9'),
    ]).toEqual([null, null, null]);
  });
});

describe('ownerAlive', () => {
  const reads = linux({ '/proc/42/stat': statRecord(42, 'S', 7) });
  const token = `linux:${BOOT_ID}:7`;

  it('holds the owner alive while its pid runs with the start time it recorded', async () => {
    const owner = parseRunOwner(`${runDirectoryPrefix(42, token)}Ab3dE9`);

    await expect(ownerAlive(owner ?? { pid: 0, digest: '' }, reads)).resolves.toBe(true);
  });

  it('holds the owner dead when its pid now runs a process that started at another time', async () => {
    const earlier = `linux:${BOOT_ID}:6`;
    const owner = parseRunOwner(`${runDirectoryPrefix(42, earlier)}Ab3dE9`);

    await expect(ownerAlive(owner ?? { pid: 0, digest: '' }, reads)).resolves.toBe(false);
  });

  it('holds the owner dead when its pid runs nothing', async () => {
    const owner = parseRunOwner(`${runDirectoryPrefix(43, token)}Ab3dE9`);

    await expect(ownerAlive(owner ?? { pid: 0, digest: '' }, reads)).resolves.toBe(false);
  });
});

describe('systemReads.run', () => {
  it('resolves with what a tool printed when it exits 0', async () => {
    await expect(
      systemReads.run(process.execPath, ['-e', "process.stdout.write('printed')"])
    ).resolves.toEqual({ exitCode: 0, stdout: 'printed' });
  });

  it('resolves with the status of a tool that exits non-zero', async () => {
    await expect(systemReads.run(process.execPath, ['-e', 'process.exit(3)'])).resolves.toEqual({
      exitCode: 3,
      stdout: '',
    });
  });

  it('hands the tool its environment overrides beside the inherited environment', async () => {
    const script =
      'process.stdout.write([process.env.FILMS_RUN_OWNER_PROBE, typeof process.env.PATH].join(" "))';

    await expect(
      systemReads.run(process.execPath, ['-e', script], { FILMS_RUN_OWNER_PROBE: 'handed' })
    ).resolves.toEqual({ exitCode: 0, stdout: 'handed string' });
  });

  it('rejects when the tool cannot start', async () => {
    expect(await outcomeOf(systemReads.run('films-no-such-tool', []))).toBeInstanceOf(Error);
  });
});
