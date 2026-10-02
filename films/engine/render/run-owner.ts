import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { START_FIELD, STATE_FIELD, parseProcStatRecord } from '@hushbox/scripts/lib/proc-stat';

/** What a tool printed and the status it exited with. */
export interface RunResult {
  exitCode: number;
  stdout: string;
}

/** The operating-system reads an owner check makes, injectable so each platform's is testable anywhere. */
export interface OwnerReads {
  platform: NodeJS.Platform;
  readFile: (file: string) => Promise<string>;
  /**
   * Runs a tool with `environment` laid over this process's own, resolving with
   * its exit status whatever it is; rejects only when it cannot start.
   */
  run: (
    command: string,
    args: readonly string[],
    environment?: Readonly<Record<string, string>>
  ) => Promise<RunResult>;
}

/** A process's start could not be read, so whether a run's owner lives cannot be decided. */
export class RunOwnerError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(`run owner: ${detail}`, options);
    this.name = 'RunOwnerError';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runTool(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {}
): Promise<RunResult> {
  const env = { ...process.env, ...environment };
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: 'utf8', windowsHide: true, env }, (error, stdout) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout });
      } else if (typeof error.code === 'number') {
        resolve({ exitCode: error.code, stdout });
      } else {
        reject(new Error(error.message, { cause: error }));
      }
    });
  });
}

/** This machine's own reads. */
export const systemReads: OwnerReads = {
  platform: process.platform,
  readFile: async (file) => readFile(file, 'utf8'),
  run: runTool,
};

/** The one `/proc/<pid>/stat` state of a process that has exited but is not yet collected. */
const EXITED_STATE = 'Z';

async function linuxToken(pid: number, reads: OwnerReads): Promise<string | null> {
  let stat: string;
  try {
    stat = await reads.readFile(`/proc/${String(pid)}/stat`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new RunOwnerError(`the record of process ${String(pid)}: ${messageOf(error)}`, {
      cause: error,
    });
  }
  const record = parseProcStatRecord(stat);
  const ticks = record?.fields[START_FIELD];
  if (record === undefined || ticks === undefined) {
    throw new RunOwnerError(`the record of process ${String(pid)} names no command`);
  }
  if (record.fields[STATE_FIELD] === EXITED_STATE) {
    return null;
  }
  // Start ticks count from boot, so a token also names the boot it was read in.
  const boot = await reads.readFile('/proc/sys/kernel/random/boot_id');
  return `linux:${boot.trim()}:${ticks}`;
}

/** Runs `command`, failing as a `RunOwnerError` when it cannot start. */
async function ran(
  reads: OwnerReads,
  command: string,
  args: readonly string[],
  environment?: Readonly<Record<string, string>>
): Promise<RunResult> {
  try {
    return await reads.run(command, args, environment);
  } catch (error) {
    throw new RunOwnerError(`${command} did not run: ${messageOf(error)}`, { cause: error });
  }
}

async function darwinToken(pid: number, reads: OwnerReads): Promise<string | null> {
  // ps prints `lstart` in the caller's time zone and locale, so every caller
  // asks in the same ones and reads the same start for the same process.
  const { exitCode, stdout } = await ran(reads, 'ps', ['-o', 'lstart=', '-p', String(pid)], {
    TZ: 'UTC',
    LC_ALL: 'C',
  });
  const printed = stdout.trim();
  if (exitCode === 0 && printed !== '') {
    return `darwin:${printed}`;
  }
  if (exitCode === 1 && printed === '') {
    return null;
  }
  throw new RunOwnerError(`ps exited ${String(exitCode)} for process ${String(pid)}`);
}

const FILE_TIME = /^\d+$/;

async function windowsToken(pid: number, reads: OwnerReads): Promise<string | null> {
  // A UTC file time is an integer, so no locale or timezone reaches the token.
  const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}'; if ($p) { $p.CreationDate.ToFileTimeUtc() }`;
  const { exitCode, stdout } = await ran(reads, 'powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ]);
  const printed = stdout.trim();
  if (exitCode !== 0 || (printed !== '' && !FILE_TIME.test(printed))) {
    throw new RunOwnerError(`PowerShell exited ${String(exitCode)} for process ${String(pid)}`);
  }
  return printed === '' ? null : `win32:${printed}`;
}

/**
 * A token naming the process `pid` and when it started, equal for that process
 * every time it is read and different for any later process given the same pid;
 * null when no process runs under `pid`.
 */
export async function startToken(pid: number, reads: OwnerReads): Promise<string | null> {
  switch (reads.platform) {
    case 'linux': {
      return linuxToken(pid, reads);
    }
    case 'darwin': {
      return darwinToken(pid, reads);
    }
    case 'win32': {
      return windowsToken(pid, reads);
    }
    default: {
      throw new RunOwnerError(`no read of a process's start on ${reads.platform}`);
    }
  }
}

/** The owner a run directory's name records: its process id and a digest of its start token. */
export interface RunOwner {
  pid: number;
  digest: string;
}

const DIGEST_LENGTH = 16;

function digestOf(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, DIGEST_LENGTH);
}

/**
 * The prefix of a run directory's name, recording its owner. The name carries
 * the record, so a directory exists only with its owner already written.
 */
export function runDirectoryPrefix(pid: number, token: string): string {
  return `run-${String(pid)}-${digestOf(token)}-`;
}

const RUN_DIRECTORY = /^run-(\d+)-([\da-f]{16})-[\dA-Za-z]{6}$/;

/** The owner a directory's name records, or null for a name that records none. */
export function parseRunOwner(name: string): RunOwner | null {
  const found = RUN_DIRECTORY.exec(name);
  const [, pid, digest] = found ?? [];
  return pid === undefined || digest === undefined ? null : { pid: Number(pid), digest };
}

/** Whether the process that made a run directory still runs: its pid, with the start it recorded. */
export async function ownerAlive(owner: RunOwner, reads: OwnerReads): Promise<boolean> {
  const token = await startToken(owner.pid, reads);
  return token !== null && digestOf(token) === owner.digest;
}
