import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chmod } from 'node:fs/promises';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  FIXTURE_BOOT_BUDGET_MS,
  SIGNAL_REACTION_BUDGET_MS,
  untilFileWritten,
  untilObserved,
} from './lib/bounded-wait.setup.js';
import { execRuntimeShim } from './exec-runtime-shim.js';
import type { FileHandle } from 'node:fs/promises';

/**
 * What a case here may spend: one cold runtime reaching the point where it
 * names itself, and then whatever a kill takes to land. Both budgets are the
 * package's own, so a busy host does not become a verdict about the shim.
 */
const SHIM_CASE_TIMEOUT_MS = FIXTURE_BOOT_BUDGET_MS + SIGNAL_REACTION_BUDGET_MS;

/** The runtime the fixture manifest pins, which is what names the generated shim. */
const RUNTIME = 'node';

/** Where the package manager writes the shim, as the correction's report spells it. */
const SHIM_PATH = ['node_modules', '.bin', RUNTIME];

/** Writes its own id where the case can read it, then stays up until it is killed. */
const NAME_AND_WAIT =
  "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";

/** Writes the one exported variable the generated shim sets, then exits. */
const NAME_THE_EXPORTED_PATH =
  "require('node:fs').writeFileSync(process.argv[1], String(process.env.NODE_PATH));";

/** A value the fixture shim exports, recognisable in what a run of it reports back. */
const EXPORTED_PATH = 'fixture-module-directory';

/**
 * The shape the package manager generates for a pinned runtime: it exports the
 * environment the runtime needs, runs the real binary as a child, and hands
 * that child's status back as its own.
 *
 * Written from the generated form rather than copied out of `node_modules`, so
 * a case still has its subject on a machine where the runtime is not pinned,
 * and so the form the assertions are about is visible beside them.
 */
function generatedShim(runtime: string): string {
  return [
    '#!/bin/sh',
    String.raw`basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")`,
    '',
    'case `uname` in',
    '    *CYGWIN*|*MINGW*|*MSYS*)',
    '        if command -v cygpath > /dev/null 2>&1; then',
    '            basedir=`cygpath -w "$basedir"`',
    '        fi',
    '    ;;',
    'esac',
    '',
    'if [ -z "$NODE_PATH" ]; then',
    `  export NODE_PATH="${EXPORTED_PATH}"`,
    'else',
    `  export NODE_PATH="${EXPORTED_PATH}:$NODE_PATH"`,
    'fi',
    `"${runtime}"   "$@"`,
    'exit $?',
    '',
  ].join('\n');
}

let root = '';
/** Every process a case started, so one that outlives its case still goes. */
let started: ChildProcess[] = [];
/** Every runtime a case watched being born, which is what a forking shim leaves behind. */
let observed: number[] = [];

function shimFile(): string {
  return path.join(root, ...SHIM_PATH);
}

async function writeGeneratedShim(): Promise<void> {
  await fs.mkdir(path.dirname(shimFile()), { recursive: true });
  await fs.writeFile(shimFile(), generatedShim(process.execPath), { mode: 0o755 });
}

async function writeManifest(manifest: unknown): Promise<void> {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
}

/** A mode no umask would produce, so reading it back names the original as its source. */
const DISTINCT_MODE = 0o711;

/** Enough of the shim for a reader to be unmistakably part way through it. */
const HEAD_BYTES = 16;

/** What a reader has consumed so far, leaving its offset where a shell's would be. */
async function readAhead(handle: FileHandle, bytes: number): Promise<string> {
  const buffer = Buffer.alloc(bytes);
  const { bytesRead } = await handle.read(buffer, 0, bytes, null);
  return buffer.subarray(0, bytesRead).toString('utf8');
}

/** Everything left from where a reader had got to, read through the handle it already holds. */
async function readRest(handle: FileHandle): Promise<string> {
  const chunks: Buffer[] = [];
  for (;;) {
    const buffer = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) return Buffer.concat(chunks).toString('utf8');
    chunks.push(buffer.subarray(0, bytesRead));
  }
}

/**
 * Runs `attempt` with nothing able to create a file beside the shim, which is
 * what a correction landing as a sibling needs. The directory is writable again
 * whatever the attempt did, so the case's own teardown can still clear up.
 */
async function withUnwritableBinDirectory<T>(attempt: () => Promise<T>): Promise<T> {
  const binDirectory = path.dirname(shimFile());
  await chmod(binDirectory, 0o555);
  try {
    return await attempt();
  } finally {
    await chmod(binDirectory, 0o755);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

interface Run {
  /** The id a caller can signal: what spawning the shim started. */
  readonly spawned: number;
  /** What the program the shim ran wrote about itself. */
  readonly reported: string;
}

/** Runs the shim on a program of the case's choosing and waits for it to report. */
async function runThroughShim(program: string): Promise<Run> {
  const reportFile = path.join(root, `report-${String(started.length)}`);
  const child = spawn(shimFile(), ['-e', program, reportFile], { stdio: 'inherit' });
  started.push(child);

  const reported = await untilFileWritten(reportFile, FIXTURE_BOOT_BUDGET_MS);
  const spawned = child.pid;
  if (spawned === undefined) throw new Error('The shim was never started.');
  return { spawned, reported };
}

/** The id the runtime reported for itself, recorded so the teardown can end it. */
function runningId(run: Run): number {
  const pid = Number(run.reported);
  observed.push(pid);
  return pid;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-runtime-shim-'));
  started = [];
  observed = [];
  await writeManifest({ devEngines: { runtime: { name: RUNTIME } } });
  await writeGeneratedShim();
});

afterEach(async () => {
  // Runs whether the case passed or failed: a runtime a forking shim left
  // behind is the same leak on either path.
  for (const pid of observed) {
    if (Number.isInteger(pid) && pid > 1 && isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
  for (const child of started) child.kill('SIGKILL');
  await fs.rm(root, { recursive: true, force: true });
});

describe('the process a generated runtime shim starts', { timeout: SHIM_CASE_TIMEOUT_MS }, () => {
  it('is not the process that runs, as the package manager generates it', async () => {
    const run = await runThroughShim(NAME_AND_WAIT);

    expect(
      runningId(run),
      'the generated shim runs the runtime as a child, which is the hazard the correction removes; a fixture whose two ids already agreed would let the case below pass over a correction that did nothing'
    ).not.toBe(run.spawned);
  });

  it('is the process that runs, once the shim replaces itself', async () => {
    await execRuntimeShim({ root });

    const run = await runThroughShim(NAME_AND_WAIT);

    expect(
      runningId(run),
      'the id a caller can signal has to be the id of the runtime itself; while the two differ, a signal reaches a shell and the runtime below it is never told'
    ).toBe(run.spawned);
  });

  it('takes the runtime with it when it is killed', async () => {
    await execRuntimeShim({ root });
    const run = await runThroughShim(NAME_AND_WAIT);
    const running = runningId(run);

    process.kill(run.spawned, 'SIGKILL');

    expect(
      await untilObserved(() => !isAlive(running), SIGNAL_REACTION_BUDGET_MS),
      'the runtime survived a hard kill of the id it was spawned as, so it keeps every socket it holds open and nothing below it ever sees end of file'
    ).toBe(true);
  });

  it('still has the environment the shim exports', async () => {
    await execRuntimeShim({ root });

    const run = await runThroughShim(NAME_THE_EXPORTED_PATH);

    expect(
      run.reported,
      'the correction replaces the shell with the runtime and leaves the lines above the invocation alone, so what the shim exports still reaches the runtime'
    ).toContain(EXPORTED_PATH);
  });
});

describe('correcting a generated runtime shim', () => {
  it('reports what it did to the shim the manifest names', async () => {
    const outcome = await execRuntimeShim({ root });

    expect(outcome.kind).toBe('corrected');
    expect(outcome.summary).toContain(SHIM_PATH.join('/'));
  });

  it('leaves a shim it has already corrected byte for byte as it is', async () => {
    await execRuntimeShim({ root });
    const once = await fs.readFile(shimFile(), 'utf8');

    const outcome = await execRuntimeShim({ root });

    expect(await fs.readFile(shimFile(), 'utf8')).toBe(once);
    expect(outcome.kind).toBe('already-corrected');
  });

  it('corrects the shim again after an install regenerates it', async () => {
    await execRuntimeShim({ root });
    const corrected = await fs.readFile(shimFile(), 'utf8');

    await writeGeneratedShim();
    const outcome = await execRuntimeShim({ root });

    expect(await fs.readFile(shimFile(), 'utf8')).toBe(corrected);
    expect(outcome.kind).toBe('corrected');
  });

  it('leaves the shim as generated where nothing can replace a running process', async () => {
    const generated = await fs.readFile(shimFile(), 'utf8');

    const outcome = await execRuntimeShim({ root, platform: 'win32' });

    expect(await fs.readFile(shimFile(), 'utf8')).toBe(generated);
    expect(outcome).toEqual({
      kind: 'untouched',
      summary: expect.stringContaining('Windows') as unknown as string,
    });
  });

  it('leaves a shim whose shape it does not recognise as it is', async () => {
    const unrecognised = '#!/bin/sh\nsomething the package manager never wrote\n';
    await fs.writeFile(shimFile(), unrecognised);

    const outcome = await execRuntimeShim({ root });

    expect(await fs.readFile(shimFile(), 'utf8')).toBe(unrecognised);
    expect(outcome.kind).toBe('untouched');
  });

  it('reports rather than fails where the package manager generated no shim', async () => {
    await fs.rm(shimFile());

    const outcome = await execRuntimeShim({ root });

    expect(outcome.kind).toBe('untouched');
    expect(outcome.summary).toContain(SHIM_PATH.join('/'));
  });

  it('leaves an empty shim as it is', async () => {
    await fs.writeFile(shimFile(), '');

    const outcome = await execRuntimeShim({ root });

    expect(await fs.readFile(shimFile(), 'utf8')).toBe('');
    expect(outcome.kind).toBe('untouched');
  });

  it('leaves a shim that is nothing but the status hand-back as it is', async () => {
    const handBackOnly = 'exit $?\n';
    await fs.writeFile(shimFile(), handBackOnly);

    const outcome = await execRuntimeShim({ root });

    expect(await fs.readFile(shimFile(), 'utf8')).toBe(handBackOnly);
    expect(outcome.kind).toBe('untouched');
  });

  it('leaves a shim whose last command forwards no arguments as it is', async () => {
    const forwardsNothing = '#!/bin/sh\n"the-runtime"\nexit $?\n';
    await fs.writeFile(shimFile(), forwardsNothing);

    const outcome = await execRuntimeShim({ root });

    expect(await fs.readFile(shimFile(), 'utf8')).toBe(forwardsNothing);
    expect(outcome.kind).toBe('untouched');
  });

  it('leaves a shim that replaces itself with something forwarding no arguments as it is', async () => {
    const replacesWithoutForwarding = '#!/bin/sh\nexec "the-runtime"\n';
    await fs.writeFile(shimFile(), replacesWithoutForwarding);

    const outcome = await execRuntimeShim({ root });

    expect(await fs.readFile(shimFile(), 'utf8')).toBe(replacesWithoutForwarding);
    expect(outcome.kind).toBe('untouched');
  });

  it("reads this checkout's own manifest when it is given no root", async () => {
    const outcome = await execRuntimeShim({ platform: 'win32' });

    expect(outcome.kind).toBe('untouched');
    expect(outcome.summary).toContain(SHIM_PATH.join('/'));
  });

  it('reports rather than fails where the manifest pins no runtime', async () => {
    await writeManifest({});

    const outcome = await execRuntimeShim({ root });

    expect(outcome.kind).toBe('untouched');
  });

  it('raises where the shim is there but cannot be read', async () => {
    await fs.rm(shimFile());
    await fs.mkdir(shimFile());

    await expect(execRuntimeShim({ root })).rejects.toThrow();
  });
});

describe('landing a correction on a shim a shell may be reading', () => {
  it('writes the correction to a new file rather than into the one being corrected', async () => {
    const before = await fs.stat(shimFile());

    await execRuntimeShim({ root });

    const after = await fs.stat(shimFile());

    expect(
      after.ino,
      'the correction landed on the same inode, so it truncated a file a shell may be part way through reading'
    ).not.toBe(before.ino);
  });

  it('leaves a reader that opened the shim first able to read the whole original', async () => {
    const generated = await fs.readFile(shimFile(), 'utf8');
    const reader = await fs.open(shimFile(), 'r');
    try {
      const opening = await readAhead(reader, HEAD_BYTES);

      await execRuntimeShim({ root });

      expect(
        opening + (await readRest(reader)),
        'a shell holds its offset against the inode, so a reader part way through the shim has to finish on the bytes it started with'
      ).toBe(generated);
    } finally {
      await reader.close();
    }
  });

  it('leaves the corrected shim executable', async () => {
    await execRuntimeShim({ root });

    const landed = await fs.stat(shimFile());

    expect(
      landed.mode & 0o111,
      'the correction lands as a new file, and one nothing may execute is worse than one that forks'
    ).toBe(0o111);
  });

  it('carries the mode the shim was generated with onto the corrected one', async () => {
    await chmod(shimFile(), DISTINCT_MODE);

    await execRuntimeShim({ root });

    const landed = await fs.stat(shimFile());

    expect(
      landed.mode & 0o777,
      'a new file lands at whatever the process umask allows unless the original mode is carried across'
    ).toBe(DISTINCT_MODE);
  });

  it('leaves the shim as it was where the correction cannot be written', async () => {
    const generated = await fs.readFile(shimFile(), 'utf8');

    await expect(withUnwritableBinDirectory(() => execRuntimeShim({ root }))).rejects.toThrow();

    expect(await fs.readFile(shimFile(), 'utf8')).toBe(generated);
  });

  it('leaves nothing beside the shim where the correction cannot be written', async () => {
    await expect(withUnwritableBinDirectory(() => execRuntimeShim({ root }))).rejects.toThrow();

    expect(
      await fs.readdir(path.dirname(shimFile())),
      'a staging file left behind is a half-written shim sitting where the next install writes'
    ).toEqual([RUNTIME]);
  });
});
