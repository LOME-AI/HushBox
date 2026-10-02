/**
 * What the operating system will say about a listening port and about a
 * process: which processes hold a port, what group one can be signalled
 * through, what it is, and how long it has stood — each answered on Linux,
 * macOS and Windows, and selected by platform.
 */

import { readFile, readdir, readlink } from 'node:fs/promises';
import { execa } from 'execa';
import { GROUP_FIELD, START_FIELD, parseProcStatRecord } from '../proc-stat.js';
import type { ResourceAge } from '../claims/resource-age.js';

// /proc/net/tcp is a hex-encoded TCP socket table. State 0A = TCP_LISTEN.
const TCP_LISTEN = '0A';

interface ProcTcpRow {
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
      throw new Error(`dev-clean: ${binary} not found on PATH (required on ${platform})`);
    }
    throw error;
  }
  if (result.failed && (result.exitCode === null || !acceptableExitCodes.has(result.exitCode))) {
    const detail = String(result.stderr).trim() || (result.shortMessage ?? 'unknown');
    throw new Error(`dev-clean: ${binary} failed (exit ${String(result.exitCode)}): ${detail}`);
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
      throw new Error(`dev-clean: unsupported platform "${platform}"`);
    }
  }
}

export type PgidResolver = (pid: number, deps?: KillerDeps) => Promise<number | null>;

/**
 * A process group a signal may address, or null. Group 1 is the refusal that
 * matters: negated it is POSIX's broadcast branch, so `kill(-1, sig)` reaches
 * every process this user may signal rather than one tree. Answering null here
 * keeps that number from ever reaching a caller, and the tree killer refuses it
 * again at the point of the signal.
 */
function addressableGroup(pgrp: number): number | null {
  return Number.isFinite(pgrp) && pgrp > 1 ? pgrp : null;
}

/**
 * Resolve a PID's process-group ID from /proc/<pid>/stat (Linux).
 *
 * The process listening on a port is often a supervised child — `workerd` under
 * `wrangler dev`, say. Ending only that child lets the supervisor put a fresh
 * one on the same port, an endless loop that defeats port cleanup. Playwright
 * and our own spawner launch each server detached as its own process group, so
 * the listener's group leads the whole tree and signalling the group leaves
 * nothing to respawn it.
 *
 * Returns null when the process is gone, the line is unparseable, or the group
 * is one no signal may address; a caller with no address leaves the listener
 * standing rather than guessing at a narrower one.
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
  const record = parseProcStatRecord(stat);
  if (record === undefined) return null;
  return addressableGroup(Number(record.fields[GROUP_FIELD]));
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
  return addressableGroup(pgid);
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
      throw new Error(`dev-clean: unsupported platform "${platform}"`);
    }
  }
}

interface ProcessIdentity {
  /** Absolute working directory, or null when it cannot be read. */
  cwd: string | null;
  /** Full command line, or null when it cannot be read. */
  command: string | null;
}

export type IdentityResolver = (pid: number, deps?: KillerDeps) => Promise<ProcessIdentity>;

async function readOrNull(read: () => Promise<string>): Promise<string | null> {
  try {
    const raw = await read();
    return raw.trim() || null;
  } catch {
    // A listener we cannot introspect (exited, or owned by another user) is one
    // we cannot claim, which the ownership rule below turns into "leave it".
    return null;
  }
}

/** Working directory and command line of a PID from /proc (Linux). */
export async function linuxProcessIdentity(
  pid: number,
  deps: KillerDeps = defaultDeps
): Promise<ProcessIdentity> {
  const cwd = await readOrNull(() => deps.readlink(`/proc/${String(pid)}/cwd`));
  const cmdline = await readOrNull(() => deps.readFile(`/proc/${String(pid)}/cmdline`, 'utf8'));
  // /proc/<pid>/cmdline separates argv entries with NUL and ends with one.
  return { cwd, command: cmdline === null ? null : cmdline.replaceAll('\0', ' ').trim() || null };
}

/** Output of an introspection tool, or null when it fails or cannot be spawned. */
async function probeOutput(
  binary: 'lsof' | 'ps' | 'powershell.exe',
  args: readonly string[],
  deps: KillerDeps
): Promise<string | null> {
  try {
    const result = (await deps.execa(binary, [...args], { reject: false })) as ExecaResultLike;
    if (result.exitCode !== 0) return null;
    return String(result.stdout).trim() || null;
  } catch {
    return null;
  }
}

/** Working directory (via lsof) and command line (via ps) of a PID (macOS). */
export async function darwinProcessIdentity(
  pid: number,
  deps: KillerDeps = defaultDeps
): Promise<ProcessIdentity> {
  const cwdOutput = await probeOutput('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], deps);
  // lsof -F prints one field per line, each tagged by its first character; the
  // cwd path is the "n" field.
  const cwdLine = cwdOutput
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('n'));
  const command = await probeOutput('ps', ['-o', 'command=', '-p', String(pid)], deps);
  return { cwd: cwdLine === undefined ? null : cwdLine.slice(1) || null, command };
}

/**
 * Command line of a PID via PowerShell (Windows). Win32_Process exposes no
 * working directory, so Windows ownership rests on the command line alone.
 */
export async function windowsProcessIdentity(
  pid: number,
  deps: KillerDeps = defaultDeps
): Promise<ProcessIdentity> {
  const command = await probeOutput(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}').CommandLine`,
    ],
    deps
  );
  return { cwd: null, command };
}

export function selectIdentityResolver(
  platform: NodeJS.Platform = process.platform
): IdentityResolver {
  switch (platform) {
    case 'linux': {
      return linuxProcessIdentity;
    }
    case 'darwin': {
      return darwinProcessIdentity;
    }
    case 'win32': {
      return windowsProcessIdentity;
    }
    default: {
      throw new Error(`dev-clean: unsupported platform "${platform}"`);
    }
  }
}

/** One second, in the milliseconds every age here is answered in. */
const SECOND_MS = 1000;

/** How long a process has been running, or why that could not be established. */
export type AgeResolver = (pid: number, deps?: KillerDeps) => Promise<ResourceAge>;

function ageUnread(reason: string): ResourceAge {
  return { kind: 'unreadable', reason };
}

/**
 * Clock ticks per second in the figures the process filesystem publishes. It is
 * the interface's own unit rather than the kernel's internal tick rate, which
 * is why it is a constant here and not something read off the machine.
 */
const PROC_TICKS_PER_SECOND = 100;

/**
 * How long the process `pid` has been running, from the process filesystem (Linux).
 *
 * Both halves are read off one clock — the record says how long after boot the
 * process started, the uptime says how long ago boot was — so the answer is an
 * elapsed time rather than the difference between two clocks. Nothing here
 * reads a wall clock, so a machine whose time has been stepped answers the
 * same, and no reading is comparable with a timestamp anything else wrote.
 */
export async function linuxProcessAge(
  pid: number,
  deps: KillerDeps = defaultDeps
): Promise<ResourceAge> {
  let stat: string;
  try {
    stat = await deps.readFile(`/proc/${String(pid)}/stat`, 'utf8');
  } catch {
    return ageUnread('the process filesystem has no record of it');
  }
  const record = parseProcStatRecord(stat);
  const startedTicks = record === undefined ? Number.NaN : Number(record.fields[START_FIELD]);
  let uptime: string;
  try {
    uptime = await deps.readFile('/proc/uptime', 'utf8');
  } catch {
    return ageUnread('the machine would not say how long it has been up');
  }
  const upSeconds = Number(uptime.trim().split(/\s+/)[0]);
  const elapsedMs = (upSeconds - startedTicks / PROC_TICKS_PER_SECOND) * SECOND_MS;
  // A start later than the machine has been up is a reading of two things that
  // do not belong together, which answers nothing about how long it has stood.
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return ageUnread('the process filesystem gave no figure this could be read from');
  }
  return { kind: 'known', elapsedMs };
}

/** The `[[dd-]hh:]mm:ss` an elapsed time is printed in, wherever `ps` prints one. */
const ELAPSED_TIME = /^(?:(?<days>\d+)-)?(?:(?<hours>\d+):)?(?<minutes>\d+):(?<seconds>\d+)$/;

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SECONDS_PER_MINUTE = 60;

/** An elapsed time as `ps` prints it, in milliseconds, or nothing where it is not one. */
function parseElapsedTime(printed: string): number | undefined {
  const found = ELAPSED_TIME.exec(printed.trim())?.groups;
  if (found === undefined) return undefined;
  const minutes =
    Number(found['days'] ?? 0) * HOURS_PER_DAY * MINUTES_PER_HOUR +
    Number(found['hours'] ?? 0) * MINUTES_PER_HOUR +
    Number(found['minutes'] ?? 0);
  return (minutes * SECONDS_PER_MINUTE + Number(found['seconds'] ?? 0)) * SECOND_MS;
}

/**
 * How long the process `pid` has been running, via `ps` (macOS).
 *
 * The elapsed time rather than the start time, for the reason
 * {@link linuxProcessAge} gives: what is wanted is how long the process has
 * stood, and asking for that directly keeps every clock out of the answer.
 */
export async function darwinProcessAge(
  pid: number,
  deps: KillerDeps = defaultDeps
): Promise<ResourceAge> {
  const printed = await probeOutput('ps', ['-o', 'etime=', '-p', String(pid)], deps);
  if (printed === null) return ageUnread('ps would not say how long it has been running');
  const elapsedMs = parseElapsedTime(printed);
  if (elapsedMs === undefined) return ageUnread('what ps printed is not an elapsed time');
  return { kind: 'known', elapsedMs };
}

/**
 * How long the process `pid` has been running, via PowerShell (Windows).
 *
 * The subtraction is done in the shell and only the count of seconds crosses
 * back, because a printed creation time is a date in the host's own locale and
 * timezone and an elapsed count of seconds is neither.
 */
export async function windowsProcessAge(
  pid: number,
  deps: KillerDeps = defaultDeps
): Promise<ResourceAge> {
  const printed = await probeOutput(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `[int64]((Get-Date) - (Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}').CreationDate).TotalSeconds`,
    ],
    deps
  );
  if (printed === null) return ageUnread('PowerShell would not say when it was created');
  const seconds = Number(printed.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    return ageUnread('what PowerShell printed is not a count of seconds');
  }
  return { kind: 'known', elapsedMs: seconds * SECOND_MS };
}

export function selectAgeResolver(platform: NodeJS.Platform = process.platform): AgeResolver {
  switch (platform) {
    case 'linux': {
      return linuxProcessAge;
    }
    case 'darwin': {
      return darwinProcessAge;
    }
    case 'win32': {
      return windowsProcessAge;
    }
    default: {
      throw new Error(`dev-clean: unsupported platform "${platform}"`);
    }
  }
}

export interface ListenerAgeOptions {
  readonly lookup?: ListenerLookup;
  readonly age?: AgeResolver;
  readonly deps?: KillerDeps;
}

/**
 * How long the port `port` has been held, as the age of the youngest process
 * holding it.
 *
 * The youngest rather than the oldest, and one unreadable holder answering for
 * the whole port, because this decides whether a listener nothing accounts for
 * may be ended: a fresh process on the port is fresh work whatever has been
 * sitting beside it, and a holder that will not say how long it has stood is a
 * holder nothing here knows to be past anything.
 */
export async function listenerAge(
  port: number,
  options: ListenerAgeOptions = {}
): Promise<ResourceAge> {
  const lookup = options.lookup ?? selectListenerLookup();
  const holders = await lookup(port, options.deps);
  return youngestAge(holders, options.age ?? selectAgeResolver(), options.deps);
}

/** How long the youngest of `holders` has been running. See {@link listenerAge}. */
export async function youngestAge(
  holders: readonly number[],
  resolve: AgeResolver,
  deps: KillerDeps | undefined
): Promise<ResourceAge> {
  if (holders.length === 0) return ageUnread('nothing is holding it any more');
  let youngest = Number.POSITIVE_INFINITY;
  for (const pid of holders) {
    const age = await resolve(pid, deps);
    if (age.kind === 'unreadable') return age;
    youngest = Math.min(youngest, age.elapsedMs);
  }
  return { kind: 'known', elapsedMs: youngest };
}
