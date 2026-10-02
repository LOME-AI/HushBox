import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '@hushbox/shared/test-time';
import {
  parseProcNetTcp,
  parseNetstatListeners,
  linuxListenerPids,
  darwinListenerPids,
  windowsListenerPids,
  selectListenerLookup,
  linuxPgid,
  darwinPgid,
  windowsPgid,
  selectPgidResolver,
  linuxProcessIdentity,
  darwinProcessIdentity,
  windowsProcessIdentity,
  selectIdentityResolver,
  linuxProcessAge,
  darwinProcessAge,
  windowsProcessAge,
  selectAgeResolver,
  listenerAge,
  type KillerDeps,
  type ListenerLookup,
  type PgidResolver,
  type IdentityResolver,
  type AgeResolver,
} from './process-probes.js';

type SupportedPlatform = 'linux' | 'darwin' | 'win32';

const LISTENER_LOOKUP_BY_PLATFORM = {
  linux: linuxListenerPids,
  darwin: darwinListenerPids,
  win32: windowsListenerPids,
} satisfies Record<SupportedPlatform, ListenerLookup>;

const PGID_RESOLVER_BY_PLATFORM = {
  linux: linuxPgid,
  darwin: darwinPgid,
  win32: windowsPgid,
} satisfies Record<SupportedPlatform, PgidResolver>;

const IDENTITY_RESOLVER_BY_PLATFORM = {
  linux: linuxProcessIdentity,
  darwin: darwinProcessIdentity,
  win32: windowsProcessIdentity,
} satisfies Record<SupportedPlatform, IdentityResolver>;

const AGE_RESOLVER_BY_PLATFORM = {
  linux: linuxProcessAge,
  darwin: darwinProcessAge,
  win32: windowsProcessAge,
} satisfies Record<SupportedPlatform, AgeResolver>;

/** The host platform, narrowed to the three the killer supports. */
function hostPlatform(): SupportedPlatform {
  const platform = process.platform;
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`dev-clean tests: unsupported host platform "${platform}"`);
  }
  return platform;
}

function makeDeps(overrides: Partial<KillerDeps> = {}): KillerDeps {
  return {
    readFile: vi.fn(),
    readdir: vi.fn(),
    readlink: vi.fn(),
    execa: vi.fn(),
    ...overrides,
  } as KillerDeps;
}

// Promise sugar so mocks satisfy the typed async signatures without being
// `async` themselves (eslint @typescript-eslint/require-await flags async
// functions that don't use await).
const ok = <T>(value: T): Promise<T> => Promise.resolve(value);
// eslint-disable-next-line promise/no-promise-in-callback -- intentional rejection helper for typed mocks
const fail = (error: Error): Promise<never> => Promise.reject(error);

describe('which processes hold a port, and what each of them is', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseProcNetTcp', () => {
    const sampleTcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:10E7 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123924786 1 ffffffff 100 0 0 10 0',
      '   1: 0100007F:22D3 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123925043 1 ffffffff 100 0 0 10 0',
      '   2: 0100007F:0050 0100007F:E7B2 01 00000000:00000000 00:00000000 00000000  1000        0 123925100 1 ffffffff 100 0 0 10 0',
      '',
    ].join('\n');

    it('parses listening sockets with port (hex) and inode', () => {
      const rows = parseProcNetTcp(sampleTcp);
      expect(rows).toContainEqual({ port: 0x10_e7, state: '0A', inode: '123924786' });
      expect(rows).toContainEqual({ port: 0x22_d3, state: '0A', inode: '123925043' });
    });

    it('also includes non-listening rows with their state', () => {
      const rows = parseProcNetTcp(sampleTcp);
      const established = rows.find((r) => r.state === '01');
      expect(established).toEqual({ port: 0x50, state: '01', inode: '123925100' });
    });

    it('skips header line', () => {
      const rows = parseProcNetTcp(sampleTcp);
      expect(rows).toHaveLength(3);
    });

    it('skips blank lines', () => {
      const withBlanks = sampleTcp + '\n\n   \n';
      expect(parseProcNetTcp(withBlanks)).toHaveLength(3);
    });

    it('skips malformed rows missing required columns', () => {
      const broken = ['  sl  local_address ...', '   0: bad-row', ''].join('\n');
      expect(parseProcNetTcp(broken)).toEqual([]);
    });

    it('skips rows whose local address has no port after the colon', () => {
      const noPort = [
        '  sl  local_address rem_address   st ...',
        '   0: 0100007F: 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 42 1 ffffffff 100 0 0 10 0',
        '',
      ].join('\n');
      expect(parseProcNetTcp(noPort)).toEqual([]);
    });

    it('skips rows whose port hex is non-numeric', () => {
      const badPort = [
        '  sl  local_address rem_address   st ...',
        '   0: 0100007F:ZZZZ 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 42 1 ffffffff 100 0 0 10 0',
        '',
      ].join('\n');
      expect(parseProcNetTcp(badPort)).toEqual([]);
    });

    it('parses tcp6 entries (32-char hex addresses)', () => {
      const tcp6 = [
        '  sl  local_address                         remote_address                        st ...',
        '   0: 00000000000000000000000000000000:10E7 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 999 1 ffffffff 100 0 0 10 0',
        '',
      ].join('\n');
      const rows = parseProcNetTcp(tcp6);
      expect(rows).toEqual([{ port: 0x10_e7, state: '0A', inode: '999' }]);
    });

    it('returns empty array for empty content', () => {
      expect(parseProcNetTcp('')).toEqual([]);
    });
  });

  describe('parseNetstatListeners', () => {
    const sampleNetstat = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:4301           0.0.0.0:0              LISTENING       5518',
      '  TCP    0.0.0.0:8915           0.0.0.0:0              LISTENING       5895',
      '  TCP    127.0.0.1:54321        127.0.0.1:4301         ESTABLISHED     9999',
      '  TCP    [::]:4301              [::]:0                 LISTENING       5518',
      '  UDP    0.0.0.0:4301           *:*                                    1234',
      '',
    ].join('\n');

    it('returns LISTENING PIDs for matching TCP port', () => {
      expect(parseNetstatListeners(sampleNetstat, 4301)).toEqual([5518]);
    });

    it('returns empty for ports with no LISTENING entry', () => {
      expect(parseNetstatListeners(sampleNetstat, 9999)).toEqual([]);
    });

    it('ignores rows whose PID is zero', () => {
      const stdout = '  TCP    0.0.0.0:4301           0.0.0.0:0              LISTENING       0';

      expect(parseNetstatListeners(stdout, 4301)).toEqual([]);
    });

    it('ignores UDP and ESTABLISHED rows', () => {
      expect(parseNetstatListeners(sampleNetstat, 54_321)).toEqual([]);
    });

    it('deduplicates PIDs that appear on both IPv4 and IPv6 LISTEN rows', () => {
      const pids = parseNetstatListeners(sampleNetstat, 4301);
      expect(pids).toEqual([5518]);
    });

    it('returns empty for empty input', () => {
      expect(parseNetstatListeners('', 4301)).toEqual([]);
    });
  });

  describe('linuxListenerPids', () => {
    function tcpFixture(port: number, inode: string): string {
      const portHex = port.toString(16).toUpperCase().padStart(4, '0');
      return [
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
        `   0: 0100007F:${portHex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 ffffffff 100 0 0 10 0`,
        '',
      ].join('\n');
    }

    it('returns PIDs whose /proc fds reference the listening inode', async () => {
      const readFile = vi.fn((path: string): Promise<string> => {
        if (path === '/proc/net/tcp') return ok(tcpFixture(4301, '123924786'));
        if (path === '/proc/net/tcp6') return ok('');
        return fail(new Error(`unexpected readFile ${path}`));
      });
      const readdir = vi.fn((path: string): Promise<string[]> => {
        if (path === '/proc') return ok(['1', '5518', 'self', 'cpuinfo']);
        if (path === '/proc/1/fd') return ok(['0', '1', '2']);
        if (path === '/proc/5518/fd') return ok(['0', '1', '2', '14']);
        return fail(new Error(`unexpected readdir ${path}`));
      });
      const readlink = vi.fn((path: string): Promise<string> => {
        if (path === '/proc/5518/fd/14') return ok('socket:[123924786]');
        if (path.startsWith('/proc/1/fd/')) return ok('/dev/null');
        if (path.startsWith('/proc/5518/fd/')) return ok('pipe:[111]');
        return fail(new Error(`unexpected readlink ${path}`));
      });
      const deps = makeDeps({ readFile, readdir, readlink });
      await expect(linuxListenerPids(4301, deps)).resolves.toEqual([5518]);
    });

    it('returns empty array when no listener matches the port', async () => {
      const readFile = vi.fn(() => ok(tcpFixture(9999, '5')));
      const readdir = vi.fn(() => ok([] as string[]));
      const readlink = vi.fn();
      const deps = makeDeps({ readFile, readdir, readlink });
      await expect(linuxListenerPids(4301, deps)).resolves.toEqual([]);
      expect(readdir).not.toHaveBeenCalled();
    });

    it('tolerates /proc/net/tcp6 being absent', async () => {
      const readFile = vi.fn((path: string): Promise<string> => {
        if (path === '/proc/net/tcp') return ok(tcpFixture(4301, '42'));
        return fail(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });
      const readdir = vi.fn(
        (path: string): Promise<string[]> => ok(path === '/proc' ? ['1'] : ['0'])
      );
      const readlink = vi.fn(() => ok('/dev/null'));
      const deps = makeDeps({ readFile, readdir, readlink });
      await expect(linuxListenerPids(4301, deps)).resolves.toEqual([]);
    });

    it('propagates failure to read /proc/net/tcp', async () => {
      const readFile = vi.fn(() => fail(new Error('EACCES')));
      const deps = makeDeps({ readFile });
      await expect(linuxListenerPids(4301, deps)).rejects.toThrow('EACCES');
    });

    it('skips non-numeric /proc entries (self, cpuinfo) and broken readlinks', async () => {
      const readFile = vi.fn(
        (path: string): Promise<string> =>
          ok(path === '/proc/net/tcp' ? tcpFixture(4301, '42') : '')
      );
      const readdir = vi.fn((path: string): Promise<string[]> => {
        if (path === '/proc') return ok(['self', 'cpuinfo', '99']);
        if (path === '/proc/99/fd') return ok(['7']);
        return fail(new Error(`unexpected ${path}`));
      });
      const readlink = vi.fn(() => fail(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      const deps = makeDeps({ readFile, readdir, readlink });
      await expect(linuxListenerPids(4301, deps)).resolves.toEqual([]);
    });

    it('skips PIDs whose fd directory cannot be read (process exited mid-scan)', async () => {
      const readFile = vi.fn(
        (path: string): Promise<string> =>
          ok(path === '/proc/net/tcp' ? tcpFixture(4301, '42') : '')
      );
      const readdir = vi.fn((path: string): Promise<string[]> => {
        if (path === '/proc') return ok(['1234']);
        return fail(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });
      const readlink = vi.fn();
      const deps = makeDeps({ readFile, readdir, readlink });
      await expect(linuxListenerPids(4301, deps)).resolves.toEqual([]);
    });
  });

  describe('darwinListenerPids', () => {
    it('shells lsof -t and parses one PID per line', async () => {
      const execa = vi.fn(() =>
        ok({ stdout: '5518\n5519\n', stderr: '', exitCode: 0, failed: false })
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinListenerPids(4301, deps)).resolves.toEqual([5518, 5519]);
      expect(execa).toHaveBeenCalledWith('lsof', ['-nP', '-iTCP:4301', '-sTCP:LISTEN', '-t'], {
        reject: false,
      });
    });

    it('returns empty when lsof exits 1 (no matches)', async () => {
      const execa = vi.fn(() => ok({ stdout: '', stderr: '', exitCode: 1, failed: true }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinListenerPids(4301, deps)).resolves.toEqual([]);
    });

    it('throws when lsof exits with another non-zero code', async () => {
      const execa = vi.fn(() =>
        ok({
          stdout: '',
          stderr: 'permission denied',
          exitCode: 2,
          failed: true,
          shortMessage: 'lsof failed',
        })
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinListenerPids(4301, deps)).rejects.toThrow(
        /lsof failed.*permission denied/
      );
    });

    it('throws a clear error when lsof is missing (ENOENT)', async () => {
      const execa = vi.fn(() =>
        fail(Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }))
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinListenerPids(4301, deps)).rejects.toThrow(/lsof not found/);
    });

    it('re-throws non-ENOENT spawn errors verbatim', async () => {
      const execa = vi.fn(() =>
        fail(Object.assign(new Error('spawn lsof EACCES'), { code: 'EACCES' }))
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinListenerPids(4301, deps)).rejects.toThrow('spawn lsof EACCES');
    });

    it('reports "unknown" when the binary failed without stderr or shortMessage', async () => {
      const execa = vi.fn(() => ok({ stdout: '', stderr: '', exitCode: null, failed: true }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinListenerPids(4301, deps)).rejects.toThrow(
        /lsof failed \(exit null\): unknown/
      );
    });
  });

  describe('windowsListenerPids', () => {
    it('shells netstat -ano and returns LISTENING PIDs for the port', async () => {
      const stdout = [
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    0.0.0.0:4301           0.0.0.0:0              LISTENING       5518',
        '',
      ].join('\n');
      const execa = vi.fn(() => ok({ stdout, stderr: '', exitCode: 0, failed: false }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(windowsListenerPids(4301, deps)).resolves.toEqual([5518]);
      expect(execa).toHaveBeenCalledWith('netstat', ['-ano'], { reject: false });
    });

    it('throws when netstat exits non-zero', async () => {
      const execa = vi.fn(() =>
        ok({
          stdout: '',
          stderr: 'oops',
          exitCode: 1,
          failed: true,
          shortMessage: 'netstat failed',
        })
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(windowsListenerPids(4301, deps)).rejects.toThrow(/netstat failed.*oops/);
    });

    it('throws a clear error when netstat is missing (ENOENT)', async () => {
      const execa = vi.fn(() =>
        fail(Object.assign(new Error('spawn netstat ENOENT'), { code: 'ENOENT' }))
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(windowsListenerPids(4301, deps)).rejects.toThrow(/netstat not found/);
    });
  });

  describe('selectListenerLookup', () => {
    it('returns the Linux killer on linux', () => {
      expect(selectListenerLookup('linux')).toBe(linuxListenerPids);
    });

    it('returns the macOS killer on darwin', () => {
      expect(selectListenerLookup('darwin')).toBe(darwinListenerPids);
    });

    it('returns the Windows killer on win32', () => {
      expect(selectListenerLookup('win32')).toBe(windowsListenerPids);
    });

    it('throws on unsupported platforms', () => {
      expect(() => selectListenerLookup('aix' as NodeJS.Platform)).toThrow(
        /unsupported platform "aix"/
      );
    });

    it('defaults to process.platform when no argument is passed', () => {
      expect(selectListenerLookup()).toBe(LISTENER_LOOKUP_BY_PLATFORM[hostPlatform()]);
    });
  });

  describe('linuxPgid', () => {
    it('returns the process group from /proc/<pid>/stat', async () => {
      const readFile = vi.fn(() => ok('649954 (workerd) S 649860 649773 649773 0 -1 4194560'));
      const deps = makeDeps({ readFile });
      await expect(linuxPgid(649_954, deps)).resolves.toBe(649_773);
      expect(readFile).toHaveBeenCalledWith('/proc/649954/stat', 'utf8');
    });

    it('parses pgrp when the comm field itself contains parentheses', async () => {
      // comm (field 2) is "(weird ) (name)"; pgrp is the 3rd field after the LAST ')'
      const readFile = vi.fn(() => ok('42 (weird ) (name) S 7 1234 1234 0 -1 0'));
      const deps = makeDeps({ readFile });
      await expect(linuxPgid(42, deps)).resolves.toBe(1234);
    });

    it('returns null when /proc/<pid>/stat cannot be read (process exited)', async () => {
      const readFile = vi.fn(() => fail(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      const deps = makeDeps({ readFile });
      await expect(linuxPgid(999, deps)).resolves.toBeNull();
    });

    it('returns null when the stat line has no closing paren', async () => {
      const readFile = vi.fn(() => ok('garbage-without-paren'));
      const deps = makeDeps({ readFile });
      await expect(linuxPgid(1, deps)).resolves.toBeNull();
    });

    it('returns null when the pgrp field is non-numeric', async () => {
      const readFile = vi.fn(() => ok('42 (comm) S 7 notanumber 0 0'));
      const deps = makeDeps({ readFile });
      await expect(linuxPgid(42, deps)).resolves.toBeNull();
    });

    it('returns null when pgrp is not positive', async () => {
      const readFile = vi.fn(() => ok('42 (comm) S 7 0 0 0'));
      const deps = makeDeps({ readFile });
      await expect(linuxPgid(42, deps)).resolves.toBeNull();
    });

    // Group 1 negated is POSIX's broadcast branch: `kill(-1, ...)` signals
    // every process this user may signal. No caller may ever be handed it.
    it('returns null for group 1, which negated would address every process', async () => {
      const readFile = vi.fn(() => ok('42 (comm) S 7 1 0 0'));
      const deps = makeDeps({ readFile });
      await expect(linuxPgid(42, deps)).resolves.toBeNull();
    });
  });

  describe('darwinPgid', () => {
    it('shells `ps -o pgid=` and parses the group id', async () => {
      const execa = vi.fn(() =>
        ok({ stdout: ' 649773\n', stderr: '', exitCode: 0, failed: false })
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinPgid(649_954, deps)).resolves.toBe(649_773);
      expect(execa).toHaveBeenCalledWith('ps', ['-o', 'pgid=', '-p', '649954'], { reject: false });
    });

    it('returns null when ps prints nothing (no such pid)', async () => {
      const execa = vi.fn(() => ok({ stdout: '', stderr: '', exitCode: 1, failed: true }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinPgid(999, deps)).resolves.toBeNull();
    });

    it('returns null when ps cannot be spawned', async () => {
      const execa = vi.fn(() =>
        fail(Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }))
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinPgid(999, deps)).resolves.toBeNull();
    });

    it('returns null for group 1, which negated would address every process', async () => {
      const execa = vi.fn(() => ok({ stdout: ' 1\n', stderr: '', exitCode: 0, failed: false }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });
      await expect(darwinPgid(999, deps)).resolves.toBeNull();
    });
  });

  describe('windowsPgid', () => {
    it('always returns null (POSIX process groups are not used on Windows)', async () => {
      await expect(windowsPgid()).resolves.toBeNull();
    });
  });

  describe('selectPgidResolver', () => {
    it('returns the Linux resolver on linux', () => {
      expect(selectPgidResolver('linux')).toBe(linuxPgid);
    });

    it('returns the macOS resolver on darwin', () => {
      expect(selectPgidResolver('darwin')).toBe(darwinPgid);
    });

    it('returns the Windows resolver on win32', () => {
      expect(selectPgidResolver('win32')).toBe(windowsPgid);
    });

    it('throws on unsupported platforms', () => {
      expect(() => selectPgidResolver('aix' as NodeJS.Platform)).toThrow(
        /unsupported platform "aix"/
      );
    });

    it('defaults to process.platform when no argument is passed', () => {
      expect(selectPgidResolver()).toBe(PGID_RESOLVER_BY_PLATFORM[hostPlatform()]);
    });
  });

  describe('linuxProcessIdentity', () => {
    it('reads the working directory and command line from /proc', async () => {
      const readlink = vi.fn(() => ok('/repo/worktree/apps/web'));
      // /proc/<pid>/cmdline is NUL-separated with a trailing NUL.
      const readFile = vi.fn(() =>
        ok(['node', '/repo/worktree/node_modules/.bin/vite', '--port 5173', ''].join('\u0000'))
      );
      const deps = makeDeps({ readlink, readFile });

      await expect(linuxProcessIdentity(5518, deps)).resolves.toEqual({
        cwd: '/repo/worktree/apps/web',
        command: 'node /repo/worktree/node_modules/.bin/vite --port 5173',
      });
      expect(readlink).toHaveBeenCalledWith('/proc/5518/cwd');
      expect(readFile).toHaveBeenCalledWith('/proc/5518/cmdline', 'utf8');
    });

    it('reports a null command line for an empty cmdline (kernel thread)', async () => {
      const deps = makeDeps({
        readlink: vi.fn(() => ok('')),
        readFile: vi.fn(() => ok(['', ''].join('\u0000'))),
      });

      await expect(linuxProcessIdentity(2, deps)).resolves.toEqual({ cwd: null, command: null });
    });

    it('reports nulls when /proc entries cannot be read', async () => {
      const deps = makeDeps({
        readlink: vi.fn(() => fail(Object.assign(new Error('EACCES'), { code: 'EACCES' }))),
        readFile: vi.fn(() => fail(Object.assign(new Error('ESRCH'), { code: 'ESRCH' }))),
      });

      await expect(linuxProcessIdentity(5518, deps)).resolves.toEqual({
        cwd: null,
        command: null,
      });
    });
  });

  describe('darwinProcessIdentity', () => {
    it('reads the working directory via lsof and the command via ps', async () => {
      const execa = vi.fn((binary: string) =>
        binary === 'lsof'
          ? ok({ stdout: 'p5518\nfcwd\nn/repo/worktree/apps/web\n', exitCode: 0, failed: false })
          : ok({ stdout: 'node vite --port 5173\n', exitCode: 0, failed: false })
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });

      await expect(darwinProcessIdentity(5518, deps)).resolves.toEqual({
        cwd: '/repo/worktree/apps/web',
        command: 'node vite --port 5173',
      });
      expect(execa).toHaveBeenCalledWith('lsof', ['-a', '-d', 'cwd', '-p', '5518', '-Fn'], {
        reject: false,
      });
      expect(execa).toHaveBeenCalledWith('ps', ['-o', 'command=', '-p', '5518'], { reject: false });
    });

    it('reports nulls when neither tool answers', async () => {
      const execa = vi.fn(() => ok({ stdout: '', exitCode: 1, failed: true }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });

      await expect(darwinProcessIdentity(5518, deps)).resolves.toEqual({
        cwd: null,
        command: null,
      });
    });

    it('reports nulls when the tools cannot be spawned', async () => {
      const execa = vi.fn(() => fail(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });

      await expect(darwinProcessIdentity(5518, deps)).resolves.toEqual({
        cwd: null,
        command: null,
      });
    });
  });

  describe('windowsProcessIdentity', () => {
    it('reads the command line via PowerShell and reports no working directory', async () => {
      const execa = vi.fn(() =>
        ok({ stdout: 'node vite --port 5173\n', exitCode: 0, failed: false })
      );
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });

      await expect(windowsProcessIdentity(5518, deps)).resolves.toEqual({
        cwd: null,
        command: 'node vite --port 5173',
      });
    });

    it('reports nulls when PowerShell fails', async () => {
      const execa = vi.fn(() => ok({ stdout: '', exitCode: 1, failed: true }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });

      await expect(windowsProcessIdentity(5518, deps)).resolves.toEqual({
        cwd: null,
        command: null,
      });
    });
  });

  describe('selectIdentityResolver', () => {
    it('returns the Linux resolver on linux', () => {
      expect(selectIdentityResolver('linux')).toBe(linuxProcessIdentity);
    });

    it('returns the macOS resolver on darwin', () => {
      expect(selectIdentityResolver('darwin')).toBe(darwinProcessIdentity);
    });

    it('returns the Windows resolver on win32', () => {
      expect(selectIdentityResolver('win32')).toBe(windowsProcessIdentity);
    });

    it('throws on unsupported platforms', () => {
      expect(() => selectIdentityResolver('aix' as NodeJS.Platform)).toThrow(
        /unsupported platform "aix"/
      );
    });

    it('defaults to process.platform when no argument is passed', () => {
      expect(selectIdentityResolver()).toBe(IDENTITY_RESOLVER_BY_PLATFORM[hostPlatform()]);
    });
  });
});

/**
 * How long the process holding a port has been running, which is what decides
 * the fate of a listener no claim accounts for.
 */
describe('the age of a listener', () => {
  /**
   * A `/proc/<pid>/stat` record whose start field carries `ticks`. The fields
   * before it are filler: only the position matters, and the record is built
   * rather than pasted so a reader can see which field is under test.
   */
  function statRecord(ticks: number): string {
    const before = [
      'S',
      '7',
      '1234',
      '1234',
      '0',
      '-1',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '20',
      '0',
      '1',
      '0',
    ];
    return `42 (node) ${[...before, String(ticks)].join(' ')}`;
  }

  /** The machine's uptime file: seconds since boot, then seconds spent idle. */
  function uptime(seconds: number): string {
    return `${String(seconds)} 6908265.57\n`;
  }

  describe('linuxProcessAge', () => {
    it('answers the time between the process starting and now, on the boot clock alone', async () => {
      const bootSeconds = 400_000;
      const startedAfterBoot = bootSeconds - (3 * DAY_MS) / SECOND_MS;
      const readFile = vi.fn((file: string) =>
        ok(file === '/proc/uptime' ? uptime(bootSeconds) : statRecord(startedAfterBoot * 100))
      );

      await expect(linuxProcessAge(42, makeDeps({ readFile }))).resolves.toEqual({
        kind: 'known',
        elapsedMs: 3 * DAY_MS,
      });
      expect(readFile).toHaveBeenCalledWith('/proc/42/stat', 'utf8');
      expect(readFile).toHaveBeenCalledWith('/proc/uptime', 'utf8');
    });

    it('answers unreadable when the process filesystem has no record of the process', async () => {
      const readFile = vi.fn(() => fail(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));

      await expect(linuxProcessAge(999, makeDeps({ readFile }))).resolves.toMatchObject({
        kind: 'unreadable',
      });
    });

    it('answers unreadable when the record brackets no command', async () => {
      const readFile = vi.fn(() => ok('garbage-without-paren'));

      await expect(linuxProcessAge(42, makeDeps({ readFile }))).resolves.toMatchObject({
        kind: 'unreadable',
      });
    });

    it('answers unreadable when the start field is not a number', async () => {
      const readFile = vi.fn((file: string) =>
        ok(file === '/proc/uptime' ? uptime(400_000) : statRecord(Number.NaN))
      );

      await expect(linuxProcessAge(42, makeDeps({ readFile }))).resolves.toMatchObject({
        kind: 'unreadable',
      });
    });

    it('answers unreadable when the machine will not say how long it has been up', async () => {
      const readFile = vi.fn((file: string) =>
        file === '/proc/uptime' ? fail(new Error('EACCES')) : ok(statRecord(100))
      );

      await expect(linuxProcessAge(42, makeDeps({ readFile }))).resolves.toMatchObject({
        kind: 'unreadable',
      });
    });

    it('answers unreadable when the process reads as having started before the machine booted', async () => {
      const readFile = vi.fn((file: string) =>
        ok(file === '/proc/uptime' ? uptime(10) : statRecord(400_000 * 100))
      );

      await expect(linuxProcessAge(42, makeDeps({ readFile }))).resolves.toMatchObject({
        kind: 'unreadable',
      });
    });
  });

  describe('darwinProcessAge', () => {
    it('shells `ps -o etime=` and reads days, hours, minutes and seconds', async () => {
      const execa = vi.fn(() => ok({ stdout: ' 3-04:05:06\n', exitCode: 0, failed: false }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });

      await expect(darwinProcessAge(5518, deps)).resolves.toEqual({
        kind: 'known',
        elapsedMs: 3 * DAY_MS + 4 * HOUR_MS + 5 * MINUTE_MS + 6 * SECOND_MS,
      });
      expect(execa).toHaveBeenCalledWith('ps', ['-o', 'etime=', '-p', '5518'], { reject: false });
    });

    it('reads an elapsed time carrying only minutes and seconds', async () => {
      // Built from the duration it stands for rather than written out: the
      // shorter form ps prints is two numbers separated by a colon, which is
      // also the shape of a clock reading, and the privacy gate reads it as one.
      const printed = `${String(7).padStart(2, '0')}:${String(9).padStart(2, '0')}`;
      const execa = vi.fn(() => ok({ stdout: `${printed}\n`, exitCode: 0, failed: false }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });

      await expect(darwinProcessAge(5518, deps)).resolves.toEqual({
        kind: 'known',
        elapsedMs: 7 * MINUTE_MS + 9 * SECOND_MS,
      });
    });

    it('answers unreadable when ps does not answer', async () => {
      const execa = vi.fn(() => ok({ stdout: '', exitCode: 1, failed: true }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });

      await expect(darwinProcessAge(5518, deps)).resolves.toMatchObject({ kind: 'unreadable' });
    });

    it('answers unreadable when what ps printed is not an elapsed time', async () => {
      const execa = vi.fn(() => ok({ stdout: 'not-a-time\n', exitCode: 0, failed: false }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });

      await expect(darwinProcessAge(5518, deps)).resolves.toMatchObject({ kind: 'unreadable' });
    });
  });

  describe('windowsProcessAge', () => {
    it('asks PowerShell for the seconds since the process was created', async () => {
      const execa = vi.fn(() => ok({ stdout: '259200\n', exitCode: 0, failed: false }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });

      await expect(windowsProcessAge(5518, deps)).resolves.toEqual({
        kind: 'known',
        elapsedMs: 3 * DAY_MS,
      });
    });

    it('answers unreadable when what PowerShell printed is not a count of seconds', async () => {
      const execa = vi.fn(() => ok({ stdout: 'yesterday\n', exitCode: 0, failed: false }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });

      await expect(windowsProcessAge(5518, deps)).resolves.toMatchObject({ kind: 'unreadable' });
    });

    it('answers unreadable when PowerShell fails', async () => {
      const execa = vi.fn(() => ok({ stdout: '', exitCode: 1, failed: true }));
      const deps = makeDeps({ execa: execa as unknown as KillerDeps['execa'] });

      await expect(windowsProcessAge(5518, deps)).resolves.toMatchObject({ kind: 'unreadable' });
    });
  });

  describe('selectAgeResolver', () => {
    it('returns the Linux resolver on linux', () => {
      expect(selectAgeResolver('linux')).toBe(linuxProcessAge);
    });

    it('returns the macOS resolver on darwin', () => {
      expect(selectAgeResolver('darwin')).toBe(darwinProcessAge);
    });

    it('returns the Windows resolver on win32', () => {
      expect(selectAgeResolver('win32')).toBe(windowsProcessAge);
    });

    it('throws on unsupported platforms', () => {
      expect(() => selectAgeResolver('aix' as NodeJS.Platform)).toThrow(
        /unsupported platform "aix"/
      );
    });

    it('defaults to process.platform when no argument is passed', () => {
      expect(selectAgeResolver()).toBe(AGE_RESOLVER_BY_PLATFORM[hostPlatform()]);
    });
  });

  describe('listenerAge', () => {
    it('answers with the youngest of the processes holding the port', async () => {
      const age = await listenerAge(5173, {
        lookup: () => ok([11, 12]),
        age: (pid) => ok({ kind: 'known', elapsedMs: pid === 11 ? 3 * DAY_MS : HOUR_MS }),
      });

      expect(age).toEqual({ kind: 'known', elapsedMs: HOUR_MS });
    });

    it('answers unreadable when one of the holders will not say how long it has stood', async () => {
      const age = await listenerAge(5173, {
        lookup: () => ok([11, 12]),
        age: (pid) =>
          ok(
            pid === 11
              ? { kind: 'known', elapsedMs: 3 * DAY_MS }
              : { kind: 'unreadable', reason: 'the process filesystem has no record of it' }
          ),
      });

      expect(age).toMatchObject({ kind: 'unreadable' });
    });

    it('answers unreadable when nothing is holding the port any more', async () => {
      const age = await listenerAge(5173, {
        lookup: () => ok([]),
        age: () => ok({ kind: 'known', elapsedMs: 0 }),
      });

      expect(age).toMatchObject({ kind: 'unreadable' });
    });
  });
});
