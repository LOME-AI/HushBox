import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { rootScripts, turboRunTargets } from './lib/root-manifest.js';
import { CONFIG_FILE, tasksIn, type TurboTask } from './turbo-configs.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** How turbo names a task that runs in the repository root package. */
const ROOT_TASK_PREFIX = '//#';

/**
 * The root tasks that exist today. Every case below derives its subject from
 * `turbo.json`, so a discovery bug that finds nothing would pass each of them
 * over an empty set; this list is the floor that fails instead. A count cannot
 * serve — three tasks could be swapped for three others without moving it.
 */
const KNOWN_ROOT_TASKS: readonly string[] = [
  '//#privacy:check',
  '//#arch:scan',
  '//#duplication:scan',
];

/** The wrappers that exist today, for the same non-vacuity reason. */
const KNOWN_WRAPPERS: readonly string[] = ['privacy', 'arch:check', 'lint:duplication'];

const JscpdShape = z.object({ output: z.string() });

function rootTasks(): Record<string, TurboTask> {
  return Object.fromEntries(
    Object.entries(tasksIn(CONFIG_FILE)).filter(([name]) => name.startsWith(ROOT_TASK_PREFIX))
  );
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
}

/**
 * The directory jscpd writes its report into, repo-relative. Read as strict
 * JSON, never JSONC: jscpd parses its config as strict JSON, and a comment
 * makes a config named by `--config` fail to load, so a guard tolerant of one
 * would pass a config jscpd cannot load.
 */
function jscpdOutputDirectory(): string {
  const { output } = JscpdShape.parse(readJson('.jscpd.json'));
  return path.posix.normalize(output).replace(/^\.\//, '').replace(/\/$/, '');
}

/** The root task a wrapper script targets, or `undefined` where it targets none. */
function wrappedTask(body: string): string | undefined {
  return turboRunTargets(body).find((target) => target.startsWith(ROOT_TASK_PREFIX));
}

function wrappers(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rootScripts()).filter(([, body]) => wrappedTask(body) !== undefined)
  );
}

/** Whether an output glob restores everything under `dir`. */
function coversDirectory(entry: string, dir: string): boolean {
  const base = entry.replace(/\/\*\*$/, '');
  return dir === base || dir.startsWith(`${base}/`);
}

const taskNames = Object.keys(rootTasks());
const wrapperNames = Object.keys(wrappers());

describe('turbo root tasks', () => {
  it('declares every repo-wide gate this repository caches', () => {
    expect(taskNames).toEqual(expect.arrayContaining([...KNOWN_ROOT_TASKS]));
  });

  describe.each(taskNames)('%s', (name) => {
    const task = rootTasks()[name];
    const inputs = task?.inputs ?? [];

    it('runs a root script of its own name', () => {
      expect(rootScripts()).toHaveProperty(name.slice(ROOT_TASK_PREFIX.length));
    });

    it('hashes the repository through $TURBO_DEFAULT$', () => {
      expect(inputs).toContain('$TURBO_DEFAULT$');
    });

    it('names no filesystem-walking glob', () => {
      // `**` is not gitignore-aware: it hashes `node_modules`, `.git`, `.turbo`
      // and whatever the task itself just wrote, so a task carrying one can
      // never hit cache and looks merely slow rather than broken.
      expect(inputs.filter((entry) => entry.includes('**'))).toEqual([]);
    });

    it('names the lockfile', () => {
      expect(inputs).toContain('pnpm-lock.yaml');
    });
  });
});

describe('turbo root task wrappers', () => {
  it('wraps every gate whose name a caller types', () => {
    expect(wrapperNames).toEqual(expect.arrayContaining([...KNOWN_WRAPPERS]));
  });

  describe.each(wrapperNames)('%s', (name) => {
    const target = wrappedTask(wrappers()[name] ?? '');

    it('targets a declared task', () => {
      expect(taskNames).toContain(target);
    });

    it('targets a script that does not itself invoke the task runner', () => {
      // A root task runs the root script of its own name, so a target whose
      // body ran the task runner again would re-enter this wrapper and recurse.
      const targeted = rootScripts()[(target ?? '').slice(ROOT_TASK_PREFIX.length)];
      expect(turboRunTargets(targeted ?? '')).toEqual([]);
    });
  });
});

describe('the duplication gate report', () => {
  it('declares the jscpd report directory as an output', () => {
    // A reader of this gate's verdict opens the report to see which clone pairs
    // it counted. Undeclared, a cache hit restores no report at all and leaves
    // a stale or absent file behind a green verdict.
    const outputs = rootTasks()['//#duplication:scan']?.outputs ?? [];
    const reportDirectory = jscpdOutputDirectory();
    expect(
      outputs.some((entry) => entry.endsWith('/**') && coversDirectory(entry, reportDirectory))
    ).toBe(true);
  });
});
