import { readFile, readdir, readlink } from 'node:fs/promises';
import { execa } from 'execa';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

export function resolvePorts(envNames: readonly string[]): number[] {
  const ports: number[] = [];
  for (const name of envNames) {
    const raw = process.env[name];
    if (!raw) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    ports.push(parsed);
  }
  return ports;
}

// /proc/net/tcp is a hex-encoded TCP socket table. State 0A = TCP_LISTEN.
const TCP_LISTEN = '0A';

export interface ProcTcpRow {
  port: number;
  state: string;
  inode: string;
}

export function parseProcNetTcp(content: string): ProcTcpRow[] {
  const rows: ProcTcpRow[] = [];
  const lines = content.split('\n');
  for (let index = 1; index < lines.length; index++) {
    const trimmed = lines[index]?.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    const local = cols[1];
    const state = cols[3];
    const inode = cols[9];
    if (!local || !state || !inode) continue;
    const portHex = local.split(':')[1];
    if (!portHex) continue;
    const port = Number.parseInt(portHex, 16);
    if (!Number.isFinite(port)) continue;
    rows.push({ port, state, inode });
  }
  return rows;
}

function isMatchingListenerRow(cols: readonly string[], portSuffix: string): boolean {
  return (
    cols.length >= 5 &&
    cols[0] === 'TCP' &&
    cols[3] === 'LISTENING' &&
    cols[1]?.endsWith(portSuffix) === true
  );
}

export function parseNetstatListeners(stdout: string, port: number): number[] {
  // netstat -ano columns: Proto, Local Address, Foreign Address, State, PID.
  const pids = new Set<number>();
  const suffix = `:${String(port)}`;
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (!isMatchingListenerRow(cols, suffix)) continue;
    // isMatchingListenerRow guarantees cols.length >= 5, so cols[4] exists.
    const pid = Number.parseInt(String(cols[4]), 10);
    if (Number.isFinite(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

// Narrowed to the call shapes we actually use, so tests can satisfy these
// slots with simply-typed mocks instead of fs/promises' overload soup.
export interface KillerDeps {
  readFile: (path: string, encoding: 'utf8') => Promise<string>;
  readdir: (path: string) => Promise<string[]>;
  readlink: (path: string) => Promise<string>;
  execa: typeof execa;
}

const defaultDeps: KillerDeps = { readFile, readdir, readlink, execa };

const SOCKET_INODE_RE = /^socket:\[(\d+)]$/;

async function fdMatchesAnyInode(
  fdDir: string,
  fds: readonly string[],
  inodes: ReadonlySet<string>,
  readlink: KillerDeps['readlink']
): Promise<boolean> {
  for (const fd of fds) {
    let target: string;
    try {
      target = await readlink(`${fdDir}/${fd}`);
    } catch {
      continue;
    }
    const match = SOCKET_INODE_RE.exec(target);
    if (match?.[1] !== undefined && inodes.has(match[1])) return true;
  }
  return false;
}

async function findPidsForInodes(inodes: ReadonlySet<string>, deps: KillerDeps): Promise<number[]> {
  if (inodes.size === 0) return [];
  const entries = await deps.readdir('/proc');
  const pids = new Set<number>();
  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10);
    if (!Number.isFinite(pid) || String(pid) !== entry) continue;
    const fdDir = `/proc/${entry}/fd`;
    let fds: string[];
    try {
      fds = await deps.readdir(fdDir);
    } catch {
      // Process exited between /proc scan and fd read, or kernel thread we
      // can't introspect. Either way, it can't own our port — skip it.
      continue;
    }
    if (await fdMatchesAnyInode(fdDir, fds, inodes, deps.readlink)) pids.add(pid);
  }
  return [...pids];
}

export async function linuxListenerPids(
  port: number,
  deps: KillerDeps = defaultDeps
): Promise<number[]> {
  const tcp = await deps.readFile('/proc/net/tcp', 'utf8');
  // tcp6 is absent in IPv4-only containers; absence is not an error.
  const tcp6 = await deps.readFile('/proc/net/tcp6', 'utf8').catch(() => '');
  const rows = [...parseProcNetTcp(tcp), ...parseProcNetTcp(tcp6)];
  const inodes = new Set<string>();
  for (const row of rows) {
    if (row.state === TCP_LISTEN && row.port === port) inodes.add(row.inode);
  }
  return findPidsForInodes(inodes, deps);
}

function hasErrnoCode(err: unknown): err is Error & { code: string } {
  return (
    err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string'
  );
}

interface ExecaResultLike {
  stdout: string | Buffer;
  stderr: string | Buffer;
  exitCode: number | null;
  failed: boolean;
  shortMessage?: string;
}

async function runOrThrow(
  binary: 'lsof' | 'netstat',
  args: readonly string[],
  deps: KillerDeps,
  acceptableExitCodes: ReadonlySet<number>
): Promise<ExecaResultLike> {
  let result: ExecaResultLike;
  try {
    result = (await deps.execa(binary, [...args], { reject: false })) as ExecaResultLike;
  } catch (error) {
    if (hasErrnoCode(error) && error.code === 'ENOENT') {
      const platform = binary === 'lsof' ? 'macOS' : 'win32';
      throw new Error(`kill-ports: ${binary} not found on PATH (required on ${platform})`);
    }
    throw error;
  }
  if (result.failed && (result.exitCode === null || !acceptableExitCodes.has(result.exitCode))) {
    const detail = String(result.stderr).trim() || (result.shortMessage ?? 'unknown');
    throw new Error(`kill-ports: ${binary} failed (exit ${String(result.exitCode)}): ${detail}`);
  }
  return result;
}

export async function darwinListenerPids(
  port: number,
  deps: KillerDeps = defaultDeps
): Promise<number[]> {
  // lsof -t prints PIDs only, one per line. Exit 1 = no matches, fine.
  const res = await runOrThrow(
    'lsof',
    ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'],
    deps,
    new Set([0, 1])
  );
  const pids = new Set<number>();
  for (const line of String(res.stdout).split('\n')) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isFinite(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export async function windowsListenerPids(
  port: number,
  deps: KillerDeps = defaultDeps
): Promise<number[]> {
  const res = await runOrThrow('netstat', ['-ano'], deps, new Set([0]));
  return parseNetstatListeners(String(res.stdout), port);
}

export type ListenerLookup = (port: number, deps?: KillerDeps) => Promise<number[]>;

export function selectListenerLookup(platform: NodeJS.Platform = process.platform): ListenerLookup {
  switch (platform) {
    case 'linux': {
      return linuxListenerPids;
    }
    case 'darwin': {
      return darwinListenerPids;
    }
    case 'win32': {
      return windowsListenerPids;
    }
    default: {
      throw new Error(`kill-ports: unsupported platform "${platform}"`);
    }
  }
}

export interface ProcessKiller {
  kill(pid: number, signal: NodeJS.Signals): void;
}

/* v8 ignore start -- thin adapter over the real process.kill, exercised only at runtime */
const realProcessKiller: ProcessKiller = {
  kill(pid, signal) {
    process.kill(pid, signal);
  },
};
/* v8 ignore stop */

export interface KillPortOptions {
  lookup?: ListenerLookup;
  deps?: KillerDeps;
  killer?: ProcessKiller;
}

export async function killPort(port: number, options: KillPortOptions = {}): Promise<number[]> {
  const lookup = options.lookup ?? selectListenerLookup();
  const killer = options.killer ?? realProcessKiller;
  const pids = await lookup(port, options.deps);
  for (const pid of pids) {
    try {
      killer.kill(pid, 'SIGKILL');
    } catch (error) {
      // ESRCH = process exited between discovery and kill; we won the race.
      if (hasErrnoCode(error) && error.code === 'ESRCH') continue;
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `kill-ports: failed to SIGKILL pid ${String(pid)} (port ${String(port)}): ${msg}`
      );
    }
  }
  return pids;
}

export async function killPorts(
  ports: readonly number[],
  options: KillPortOptions = {}
): Promise<void> {
  for (const port of ports) {
    await killPort(port, options);
  }
}

/* v8 ignore start -- CLI entry point exercised via package.json scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    await killPorts(resolvePorts(process.argv.slice(2)));
  });
}
/* v8 ignore stop */
