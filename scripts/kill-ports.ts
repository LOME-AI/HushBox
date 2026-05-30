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

export type PgidResolver = (pid: number, deps?: KillerDeps) => Promise<number | null>;

/**
 * Resolve a PID's process-group ID from /proc/<pid>/stat (Linux).
 *
 * The process listening on a port is often a supervised child — e.g. `workerd`
 * under `wrangler dev`. Killing only that child lets the supervisor respawn it
 * onto the same port (an endless loop that defeats port cleanup). Playwright and
 * our dev scripts launch each server detached as its own process group, so the
 * listener's PGID leads the whole tree; signalling the group (see
 * {@link killPort}) tears everything down with nothing left to respawn.
 *
 * Returns null when the process is gone or the line is unparseable; the caller
 * then falls back to killing the listener PID directly.
 */
export async function linuxPgid(
  pid: number,
  deps: KillerDeps = defaultDeps
): Promise<number | null> {
  let stat: string;
  try {
    stat = await deps.readFile(`/proc/${String(pid)}/stat`, 'utf8');
  } catch {
    return null;
  }
  // Format: "pid (comm) state ppid pgrp ...". comm is parenthesized and may
  // itself contain spaces and ')', so parse the fields after the LAST ')'.
  const rparen = stat.lastIndexOf(')');
  if (rparen === -1) return null;
  // Fields after comm: [state, ppid, pgrp, ...] — pgrp is index 2.
  const fields = stat
    .slice(rparen + 1)
    .trim()
    .split(/\s+/);
  const pgrp = Number(fields[2]);
  return Number.isFinite(pgrp) && pgrp > 0 ? pgrp : null;
}

/** Resolve a PID's process-group ID via `ps -o pgid=` (macOS). See {@link linuxPgid}. */
export async function darwinPgid(
  pid: number,
  deps: KillerDeps = defaultDeps
): Promise<number | null> {
  let res: ExecaResultLike;
  try {
    res = (await deps.execa('ps', ['-o', 'pgid=', '-p', String(pid)], {
      reject: false,
    })) as ExecaResultLike;
  } catch {
    // ps failed to spawn — degrade to null (pid-fallback), matching linuxPgid.
    return null;
  }
  const pgid = Number(String(res.stdout).trim());
  return Number.isFinite(pgid) && pgid > 0 ? pgid : null;
}

/** Windows lacks POSIX process groups; signal the listener PID directly. */
export function windowsPgid(): Promise<number | null> {
  return Promise.resolve(null);
}

export function selectPgidResolver(platform: NodeJS.Platform = process.platform): PgidResolver {
  switch (platform) {
    case 'linux': {
      return linuxPgid;
    }
    case 'darwin': {
      return darwinPgid;
    }
    case 'win32': {
      return windowsPgid;
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
  pgid?: PgidResolver;
  /**
   * Our own process group, used by the self-guard. Defaults to resolving the
   * current process's PGID via the platform resolver. Pass `null` to disable the
   * guard (e.g. in tests), or an explicit value to assert guard behavior.
   */
  selfPgid?: number | null;
  deps?: KillerDeps;
  killer?: ProcessKiller;
}

/**
 * Map listener PIDs to SIGKILL targets. On POSIX each target is a negative PGID
 * (kills the whole process group, so a supervisor like `wrangler dev` dies too
 * instead of respawning the listener). Groups are de-duplicated so a group with
 * several listeners is signalled once. A listener whose PGID can't be resolved
 * falls back to its own PID. Our own group (`ownPgid`) is never targeted — that
 * would kill the cleanup process and, in a `kill-ports && start-server` chain,
 * the server about to launch.
 */
async function resolveKillTargets(
  pids: readonly number[],
  pgidResolver: PgidResolver,
  ownPgid: number | null,
  deps?: KillerDeps
): Promise<number[]> {
  const groups = new Set<number>();
  const pidFallbacks: number[] = [];
  for (const pid of pids) {
    const pgid = await pgidResolver(pid, deps);
    if (pgid === null) {
      pidFallbacks.push(pid);
      continue;
    }
    if (pgid === ownPgid) continue; // self-guard: never signal our own group
    groups.add(pgid);
  }
  return [...[...groups].map((pgid) => -pgid), ...pidFallbacks];
}

function describeTarget(target: number): string {
  return target < 0 ? `process group ${String(-target)}` : `pid ${String(target)}`;
}

/** SIGKILL one target (negative => process group). ESRCH is a benign race. */
function killTarget(killer: ProcessKiller, target: number, port: number): void {
  try {
    killer.kill(target, 'SIGKILL');
  } catch (error) {
    // ESRCH = process/group exited between discovery and kill; we won the race.
    if (hasErrnoCode(error) && error.code === 'ESRCH') return;
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `kill-ports: failed to SIGKILL ${describeTarget(target)} (port ${String(port)}): ${msg}`
    );
  }
}

export async function killPort(port: number, options: KillPortOptions = {}): Promise<number[]> {
  const lookup = options.lookup ?? selectListenerLookup();
  const pgidResolver = options.pgid ?? selectPgidResolver();
  const killer = options.killer ?? realProcessKiller;
  const pids = await lookup(port, options.deps);
  // Resolve PGIDs and kill only when something is listening — skips a needless
  // /proc read or `ps` spawn on the common "already free" path before a server
  // starts. (Selecting the resolver above is free; calling it is the cost.)
  if (pids.length > 0) {
    const ownPgid =
      options.selfPgid === undefined
        ? await pgidResolver(process.pid, options.deps)
        : options.selfPgid;
    const targets = await resolveKillTargets(pids, pgidResolver, ownPgid, options.deps);
    for (const target of targets) killTarget(killer, target, port);
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
