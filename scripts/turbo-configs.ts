/**
 * The task runner's configuration as the suites that read it need it: where the
 * configs are, and what a task declares. One implementation because the suites
 * reading it had drifted into disagreeing about both — each passing against its
 * own copy, which is what made the drift silent.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { getWorkspacePaths } from './lib/cli/workspaces.js';
import { readJsonc } from './lib/jsonc.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** What the task runner's config is called, at the repository root and in every package override. */
export const CONFIG_FILE = 'turbo.json';

/**
 * One task as a config declares it. Loose because a task carries keys past the
 * ones read here and a reader of one key must not reject a config for the rest;
 * every key optional because a config declares only what it overrides.
 */
export const TurboTaskShape = z.looseObject({
  env: z.array(z.string()).optional(),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
});

export type TurboTask = z.infer<typeof TurboTaskShape>;

const TurboConfigShape = z.object({
  tasks: z.record(z.string(), TurboTaskShape),
});

/**
 * The package-level configs that exist today. A suite deriving its subjects
 * from discovery passes over an empty set when discovery finds nothing, and
 * this list is the floor that fails instead; a count cannot serve, because one
 * config could be swapped for another without moving it. One list rather than
 * one per suite because the two it replaces had already drifted by an entry,
 * and the cost was precisely this: discovery still found the omitted config, so
 * no case lost a subject — a regression dropping that config would have failed
 * the suite whose floor named it and passed the suite whose floor did not.
 */
export const KNOWN_PACKAGE_CONFIGS: readonly string[] = [
  `apps/admin/${CONFIG_FILE}`,
  `apps/api/${CONFIG_FILE}`,
  `apps/sandbox/${CONFIG_FILE}`,
  `packages/config/${CONFIG_FILE}`,
  `scripts/${CONFIG_FILE}`,
];

/** Every package-level config: one per workspace that overrides the root task runner config. */
export function packageConfigFiles(): string[] {
  return getWorkspacePaths(REPO_ROOT)
    .map((workspace) => `${workspace}/${CONFIG_FILE}`)
    .filter((file) => existsSync(path.join(REPO_ROOT, file)));
}

/** The tasks one config declares, keyed by task name, read from its repo-relative path. */
export function tasksIn(file: string): Record<string, TurboTask> {
  return TurboConfigShape.parse(readJsonc(file)).tasks;
}
