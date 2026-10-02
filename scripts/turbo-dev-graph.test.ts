import path from 'node:path';
import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Tasks the development graph reaches today. Every assertion below reads the
 * graph the task runner plans, so a planning call that answered with no tasks
 * would pass them over an empty set; this list is the floor that fails instead.
 */
const KNOWN_DEV_TASKS: readonly string[] = ['@hushbox/api#dev', '@hushbox/web#dev'];

const DryRunShape = z.object({
  tasks: z.array(
    z.looseObject({
      taskId: z.string(),
      outputs: z.array(z.string()).nullable(),
    })
  ),
});

type DryRunTask = z.infer<typeof DryRunShape>['tasks'][number];

let tasks: readonly DryRunTask[];

beforeAll(async () => {
  const { stdout } = await execa('turbo', ['run', 'dev', '--dry=json'], {
    cwd: REPO_ROOT,
    preferLocal: true,
  });
  tasks = DryRunShape.parse(JSON.parse(stdout)).tasks;
});

describe('the development task graph', () => {
  it('reaches the development servers', () => {
    expect(tasks.map((task) => task.taskId)).toEqual(expect.arrayContaining([...KNOWN_DEV_TASKS]));
  });

  it('reaches no task that writes build output', () => {
    // A task declaring outputs writes into, or restores into, a directory every
    // stack of this checkout shares, and the task runner's restore merges
    // rather than replacing: whatever the development stack leaves there is
    // carried into the next stack's bundle.
    const writers = tasks
      .filter((task) => (task.outputs ?? []).length > 0)
      .map((task) => `${task.taskId} → ${(task.outputs ?? []).join(', ')}`);
    expect(writers).toEqual([]);
  });
});
