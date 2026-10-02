/**
 * The run directory's two files as the CLI touches them: `status.md` read into
 * the model and written back atomically under a lock, and {@link LEDGER}
 * appended. Nothing here interprets a card; that is `operations.ts`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stagedWrite } from '../lib/staged-write.js';
import { parseStatus, serializeStatus, type StatusFile } from './format.js';

const STATUS = 'status.md';
const LEDGER = 'ledger.md';
const LOCK = `${STATUS}.lock`;

interface LockOptions {
  readonly attempts?: number;
  readonly waitMs?: number;
}

const LOCK_DEFAULTS: Required<LockOptions> = { attempts: 50, waitMs: 20 };

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function readRunFile(runDir: string, name: string): Promise<string> {
  const filePath = path.join(runDir, name);
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isCode(error, 'ENOENT')) throw new Error(`no ${name} in ${runDir}`, { cause: error });
    throw error;
  }
}

/** The run's `status.md` as a model. */
export async function loadStatus(runDir: string): Promise<StatusFile> {
  return parseStatus(await readRunFile(runDir, STATUS));
}

/**
 * The file's first write, refusing a run that already has one. Exclusive
 * creation is the refusal: {@link saveStatus}'s rename lands on whatever is
 * there, and a run's cards have no second home to restore them from.
 */
export async function createStatus(runDir: string, file: StatusFile): Promise<void> {
  const filePath = path.join(runDir, STATUS);
  try {
    await fs.writeFile(filePath, serializeStatus(file), { flag: 'wx' });
  } catch (error: unknown) {
    if (isCode(error, 'EEXIST'))
      throw new Error(`${filePath} already exists; its cards are not overwritten`, {
        cause: error,
      });
    throw error;
  }
}

/** Write the model back, beside the target and moved into place. */
export async function saveStatus(runDir: string, file: StatusFile): Promise<void> {
  await stagedWrite(path.join(runDir, STATUS), serializeStatus(file));
}

/** One line onto the run's ledger; the ledger must already exist. */
export async function appendLedger(runDir: string, line: string): Promise<void> {
  const current = await readRunFile(runDir, LEDGER);
  const separator = current.endsWith('\n') || current === '' ? '' : '\n';
  await fs.writeFile(path.join(runDir, LEDGER), `${current}${separator}${line}\n`);
}

async function acquire(lockPath: string, options: Required<LockOptions>): Promise<void> {
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.close();
      return;
    } catch (error: unknown) {
      if (!isCode(error, 'EEXIST')) throw error;
      await delay(options.waitMs);
    }
  }
  throw new Error(
    `${lockPath} is held by another writer; remove it if no cards command is running`
  );
}

/** Run one read-modify-write of the status file under its lock. */
export async function withStatusLock<T>(
  runDir: string,
  action: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const lockPath = path.join(runDir, LOCK);
  await acquire(lockPath, { ...LOCK_DEFAULTS, ...options });
  try {
    return await action();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}
