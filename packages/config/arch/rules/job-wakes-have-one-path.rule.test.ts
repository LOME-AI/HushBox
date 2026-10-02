import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './job-wakes-have-one-path.rule.js';

const CAPABILITY_MODULE = 'apps/api/src/lib/jobs/wake-capability.ts';
const NUDGE_MODULE = 'apps/api/src/lib/jobs/wake.ts';
const NUDGE_FACTORY_MODULE = 'apps/api/src/lib/jobs/health-entry.ts';
const CRON_MODULE = 'apps/api/src/scheduled.ts';
const BOUNDARY = 'apps/api/src/middleware/pipeline-bindings.ts';
const OP = 'apps/api/src/slices/admin/domain/operations/job.ts';

/**
 * The capability module as it declares itself: the mint, the merge protocol
 * that mints WITHOUT discharging, the discharge, and the branded type. The
 * merge protocol is the one exempt mint, so a fixture missing it would leave
 * that exemption unexercised.
 */
const CAPABILITY_SOURCE = `
export interface JobWakeCollector {
  readonly collect: (shard: string) => void;
  readonly shards: () => readonly string[];
}
export type JobWakeCapable<T> = T & { readonly [JOB_WAKES]: JobWakeCollector };
export function createJobWakeCollector(): JobWakeCollector {
  return { collect: () => {}, shards: () => [] };
}
export function grantJobWakes<T extends object>(handle: T, collector: JobWakeCollector) {
  return Object.assign(handle, { [JOB_WAKES]: collector });
}
export async function runWithJobWakes<T>(handle: object, body: (c: JobWakeCollector) => Promise<T>) {
  const collected = createJobWakeCollector();
  const result = await body(collected);
  return result;
}
export async function dischargeJobWakes(env: unknown, collector: JobWakeCollector) {
  const wake = createDispatcherWake(env);
  for (const shard of collector.shards()) await wake(shard);
}
`;

/** `wake.ts` — where the nudge itself is declared. */
const NUDGE_SOURCE = `
export async function wakeJobDispatcher(namespace: unknown, shard: string): Promise<void> {
  await namespace.get(namespace.idFromName(shard)).fetch('https://job-dispatcher/wake');
}
`;

/** `health-entry.ts` — the factory, and the one legal caller of the nudge. */
const NUDGE_FACTORY_SOURCE = `
import { wakeJobDispatcher } from './wake.js';
export function createDispatcherWake(env: { JOB_DISPATCHER?: unknown }) {
  return async (shard: string): Promise<void> => {
    const namespace = env.JOB_DISPATCHER;
    if (namespace === undefined) return;
    await wakeJobDispatcher(namespace, shard);
  };
}
`;

/** `scheduled.ts` — the jobs-health auditor's wiring, the factory's other legal caller. */
const CRON_SOURCE = `
import { createDispatcherWake, createJobWakeCollector, dischargeJobWakes, grantJobWakes } from './lib/jobs/index.js';
export function cronEntriesFor(cron: string, deps: Deps) {
  return match(schedule)
    .with('jobs-health', () => [createJobsHealthEntry({ wake: createDispatcherWake(deps.env) })])
    .exhaustive();
}
export function createScheduledHandler(runtime: Runtime) {
  return async (controller, env, ctx): Promise<void> => {
    const jobWakes = createJobWakeCollector();
    const db = grantJobWakes(runtime.createDb(env), jobWakes);
    try {
      await run(db);
    } finally {
      await dischargeJobWakes(env, jobWakes);
      await db.$client.end();
    }
  };
}
`;

/** Every anchor the rule resolves, so a fixture exercises clauses rather than throws. */
const ANCHORS: Readonly<Record<string, string>> = {
  [CAPABILITY_MODULE]: CAPABILITY_SOURCE,
  [NUDGE_MODULE]: NUDGE_SOURCE,
  [NUDGE_FACTORY_MODULE]: NUDGE_FACTORY_SOURCE,
  [CRON_MODULE]: CRON_SOURCE,
};

function projectOf(files: Readonly<Record<string, string>> = {}): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries({ ...ANCHORS, ...files })) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

describe('job-wakes-have-one-path', () => {
  describe('a scope that mints the capability discharges it', () => {
    it('accepts the real boundary shape: mint and discharge in one scope', () => {
      expect(rule.check(projectOf())).toEqual([]);
    });

    it('accepts a discharge nested deeper inside the minting scope', () => {
      const project = projectOf({
        [BOUNDARY]: `
import { createJobWakeCollector, dischargeJobWakes, grantJobWakes } from '../lib/jobs/index.js';
export function pipelineBindings() {
  return async (c, next) => {
    const jobWakes = createJobWakeCollector();
    const db = grantJobWakes(createRequestDb(c), jobWakes);
    try {
      await next();
    } finally {
      const teardown = async (): Promise<void> => {
        await dischargeJobWakes(c.env, jobWakes);
        await db.$client.end();
      };
      c.executionCtx.waitUntil(teardown());
    }
  };
}
`,
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('flags a boundary that mints and never discharges', () => {
      const project = projectOf({
        [BOUNDARY]: `
import { createJobWakeCollector, grantJobWakes } from '../lib/jobs/index.js';
export function pipelineBindings() {
  return async (c, next) => {
    const jobWakes = createJobWakeCollector();
    c.set('db', grantJobWakes(createRequestDb(c), jobWakes));
    await next();
  };
}
`,
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: BOUNDARY });
      expect(violations[0]?.message).toMatch(/discharge/i);
    });

    it('flags a mint under an import alias that never discharges', () => {
      const project = projectOf({
        [BOUNDARY]: `
import { createJobWakeCollector as mintWakes } from '../lib/jobs/index.js';
export async function openScope(env: unknown): Promise<void> {
  const jobWakes = mintWakes();
  await use(jobWakes);
}
`,
      });

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags a mint at module scope, which no invocation can discharge', () => {
      const project = projectOf({
        [BOUNDARY]: `
import { createJobWakeCollector } from '../lib/jobs/index.js';
export const sharedWakes = createJobWakeCollector();
`,
      });

      expect(rule.check(project)).toHaveLength(1);
    });

    it('accepts the merge protocol, whose mint is merged upward rather than discharged', () => {
      // Exercised by the real capability module in ANCHORS; asserted here so the
      // exemption is a case rather than a side effect of another fixture.
      expect(rule.check(projectOf())).toEqual([]);
    });

    it('flags a second mint in the capability module outside the merge protocol', () => {
      const project = projectOf({
        [CAPABILITY_MODULE]:
          CAPABILITY_SOURCE +
          `
export async function runWithSharedWakes<T>(body: () => Promise<T>): Promise<T> {
  const collected = createJobWakeCollector();
  return await body();
}
`,
      });

      expect(rule.check(project)).toHaveLength(1);
    });

    it('ignores a test file that mints without discharging', () => {
      const project = projectOf({
        'apps/api/src/lib/jobs/lifecycle.test.ts': `
import { createJobWakeCollector, grantJobWakes } from './wake-capability.js';
it('redrives', async () => {
  await redriveJob(grantJobWakes(writer, createJobWakeCollector()), 'job-1');
});
`,
      });

      expect(rule.check(project)).toEqual([]);
    });
  });

  describe('the capability is minted, never asserted', () => {
    it('flags a handle cast to the capability outside its owning module', () => {
      const project = projectOf({
        [OP]: `
import type { JobWakeCapable } from '../../../../lib/jobs/index.js';
export async function redrive(db: Database): Promise<void> {
  await redriveJob(db as JobWakeCapable<Database>, 'job-1');
}
`,
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: OP });
      expect(violations[0]?.message).toMatch(/grantJobWakes/);
    });

    it('flags a double assertion that launders through unknown', () => {
      const project = projectOf({
        [OP]: `
import type { JobWakeCapable } from '../../../../lib/jobs/index.js';
const capable = db as unknown as JobWakeCapable<Database>;
`,
      });

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags an angle-bracket assertion to the capability', () => {
      const project = projectOf({
        [OP]: `
import type { JobWakeCapable } from '../../../../lib/jobs/index.js';
const capable = <JobWakeCapable<Database>>db;
`,
      });

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags an assertion written through a type-import alias', () => {
      const project = projectOf({
        [OP]: `
import type { JobWakeCapable as Capable } from '../../../../lib/jobs/index.js';
const capable = db as Capable<Database>;
`,
      });

      expect(rule.check(project)).toHaveLength(1);
    });

    it('accepts the capability as a declared type, which asserts nothing', () => {
      const project = projectOf({
        [OP]: `
import type { JobWakeCapable } from '../../../../lib/jobs/index.js';
export interface Deps {
  readonly db: JobWakeCapable<Database>;
}
export async function redrive(tx: JobWakeCapable<DbWriter>): Promise<void> {
  await redriveJob(tx, 'job-1');
}
`,
      });

      expect(rule.check(project)).toEqual([]);
    });
  });

  describe('the dispatcher nudge has one path', () => {
    it('accepts the nudge inside the factory that binds it', () => {
      expect(rule.check(projectOf())).toEqual([]);
    });

    it('flags a hand-rolled nudge in an admin operation', () => {
      const project = projectOf({
        [OP]: `
import { wakeJobDispatcher } from '../../../../lib/jobs/index.js';
export async function redrive(c: Context): Promise<void> {
  await redriveJob(c.var.db, 'job-1');
  await wakeJobDispatcher(c.env.JOB_DISPATCHER, 'default');
}
`,
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: OP });
      expect(violations[0]?.message).toMatch(/wakeJobDispatcher/);
    });

    it('flags a hand-rolled nudge that reaches the factory instead', () => {
      const project = projectOf({
        [OP]: `
import { createDispatcherWake } from '../../../../lib/jobs/index.js';
export async function redrive(c: Context): Promise<void> {
  await createDispatcherWake(c.env)('default');
}
`,
      });

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/createDispatcherWake/);
    });

    it('flags a nudge in the factory module but outside the factory', () => {
      const project = projectOf({
        [NUDGE_FACTORY_MODULE]:
          NUDGE_FACTORY_SOURCE +
          `
export async function nudgeBothShards(env: { JOB_DISPATCHER?: unknown }): Promise<void> {
  await wakeJobDispatcher(env.JOB_DISPATCHER, 'default');
}
`,
      });

      expect(rule.check(project)).toHaveLength(1);
    });

    it('ignores a test file that nudges the dispatcher directly', () => {
      const project = projectOf({
        'apps/api/src/lib/jobs/wake.test.ts': `
import { wakeJobDispatcher } from './wake.js';
it('swallows a failing nudge', async () => {
  await wakeJobDispatcher(namespace, 'default');
});
`,
      });

      expect(rule.check(project)).toEqual([]);
    });
  });

  describe('the rule fails loudly when its subject moves', () => {
    it('throws when the capability module is no longer in the scanned tree', () => {
      const project = new Project({ useInMemoryFileSystem: true });
      project.createSourceFile(NUDGE_MODULE, NUDGE_SOURCE);

      expect(() => rule.check(project)).toThrow(/wake-capability\.ts/);
    });

    it('throws when the mint is renamed', () => {
      const project = projectOf({
        [CAPABILITY_MODULE]: CAPABILITY_SOURCE.replace(
          'export function createJobWakeCollector(',
          'export function createWakeCollector('
        ),
      });

      expect(() => rule.check(project)).toThrow(/createJobWakeCollector/);
    });

    it('throws when the discharge is renamed', () => {
      const project = projectOf({
        [CAPABILITY_MODULE]: CAPABILITY_SOURCE.replace(
          'export async function dischargeJobWakes(',
          'export async function flushJobWakes('
        ),
      });

      expect(() => rule.check(project)).toThrow(/dischargeJobWakes/);
    });

    it('throws when the merge protocol is renamed', () => {
      const project = projectOf({
        [CAPABILITY_MODULE]: CAPABILITY_SOURCE.replace(
          'export async function runWithJobWakes<T>(',
          'export async function withJobWakes<T>('
        ),
      });

      expect(() => rule.check(project)).toThrow(/runWithJobWakes/);
    });

    it('throws when the branded type is renamed', () => {
      const project = projectOf({
        [CAPABILITY_MODULE]: CAPABILITY_SOURCE.replace(
          'export type JobWakeCapable<T>',
          'export type WakeCapable<T>'
        ),
      });

      expect(() => rule.check(project)).toThrow(/JobWakeCapable/);
    });

    it('throws when the nudge is renamed', () => {
      const project = projectOf({
        [NUDGE_MODULE]: NUDGE_SOURCE.replace(
          'export async function wakeJobDispatcher(',
          'export async function nudgeJobDispatcher('
        ),
      });

      expect(() => rule.check(project)).toThrow(/wakeJobDispatcher/);
    });

    it('throws when the nudge factory is renamed', () => {
      const project = projectOf({
        [NUDGE_FACTORY_MODULE]: NUDGE_FACTORY_SOURCE.replace(
          'export function createDispatcherWake(',
          'export function createWake('
        ),
      });

      expect(() => rule.check(project)).toThrow(/createDispatcherWake/);
    });

    it('throws when the cron dispatch that wires the auditor is renamed', () => {
      const project = projectOf({
        [CRON_MODULE]: CRON_SOURCE.replace(
          'export function cronEntriesFor(',
          'export function entriesForCron('
        ),
      });

      expect(() => rule.check(project)).toThrow(/cronEntriesFor/);
    });
  });
});
