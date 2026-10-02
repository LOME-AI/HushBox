import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule, {
  CAPTURE_CHECK_IN,
  CHECK_IN,
  CLOSE,
  IDENTIFYING_NAMES,
  OPEN,
  SCHEDULE_RESOLVER,
  TELEMETRY_FACTORY,
} from './cron-schedule-checks-in.rule.js';

const SCHEDULE_MAP_MODULE = 'apps/api/src/composition/cron-schedules.ts';
const SENTRY_MODULE = 'apps/api/src/lib/telemetry/adapters/sentry-adapter.ts';
const CRON_MODULE = 'apps/api/src/scheduled.ts';
const CONSOLE_MODULE = 'apps/api/src/lib/telemetry/console-adapter.ts';
const FAN_OUT_MODULE = 'apps/api/src/lib/telemetry/fan-out.ts';
const SENTRY_TEST_MODULE = 'apps/api/src/lib/telemetry/adapters/sentry-adapter.test.ts';
const SENTRY_SPEC_MODULE = 'apps/api/src/lib/telemetry/adapters/sentry-adapter.spec.ts';
const TELEMETRY_SETUP_MODULE = 'apps/api/src/lib/telemetry/telemetry.setup.ts';

/** The schedule map as the composition root declares it: the names, and the expressions wrangler mirrors. */
const SCHEDULE_MAP_SOURCE = `
export const CRON_SCHEDULES = {
  'access-log': '0 */6 * * *',
  'jobs-health': '*/15 * * * *',
  hourly: '0 * * * *',
  'daily-retention': '0 3 * * *',
} as const;
export type CronScheduleName = keyof typeof CRON_SCHEDULES;
export function cronScheduleNameFor(cron: string): CronScheduleName | undefined {
  return (Object.keys(CRON_SCHEDULES) as CronScheduleName[]).find(
    (name) => CRON_SCHEDULES[name] === cron
  );
}
`;

/** The Sentry sink as it upserts the monitor: the slug, the margin pair, and the threaded-in crontab. */
const SENTRY_SOURCE = `
const MONITOR_SLUG = 'jobs-health';
const CHECK_IN_MARGIN_MINUTES = 5;
const MAX_RUNTIME_MINUTES = 10;
export function createSentrySink(client: Client, options: { monitorCrontab?: string }) {
  let openCheckInId: string | undefined;
  return {
    checkIn(status: 'in_progress' | 'ok'): void {
      if (status === 'in_progress') {
        openCheckInId = client.captureCheckIn(
          { monitorSlug: MONITOR_SLUG, status },
          options.monitorCrontab === undefined
            ? undefined
            : {
                schedule: { type: 'crontab', value: options.monitorCrontab },
                checkinMargin: CHECK_IN_MARGIN_MINUTES,
                maxRuntime: MAX_RUNTIME_MINUTES,
                timezone: 'UTC',
              }
        );
        return;
      }
      client.captureCheckIn({ monitorSlug: MONITOR_SLUG, status, checkInId: openCheckInId });
    },
  };
}
`;

/** The scheduled handler as it brackets the monitored schedule's pass. */
const CRON_SOURCE = `
import { cronScheduleNameFor } from './composition/cron-schedules.js';
import { runCronEntries } from './lib/jobs/index.js';
export function createScheduledHandler(runtime: ScheduledRuntime) {
  return async (controller, env, ctx): Promise<void> => {
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    if (entries === undefined) return;
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('ok');
    }
  };
}
`;

/** Every anchor the rule resolves, so a fixture exercises a clause rather than aborting the run. */
const ANCHORS: Readonly<Record<string, string>> = {
  [SCHEDULE_MAP_MODULE]: SCHEDULE_MAP_SOURCE,
  [SENTRY_MODULE]: SENTRY_SOURCE,
  [CRON_MODULE]: CRON_SOURCE,
};

function projectOf(files: Readonly<Record<string, string>> = {}): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries({ ...ANCHORS, ...files })) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

/** A scheduled module built around one handler body, so a case states only what it changes. */
function cronModule(body: string): string {
  return `
import { cronScheduleNameFor } from './composition/cron-schedules.js';
import { runCronEntries } from './lib/jobs/index.js';
export function createScheduledHandler(runtime: ScheduledRuntime) {
  return async (controller, env, ctx): Promise<void> => {
${body}
  };
}
`;
}

/** The anchor set less one module, for the cases where a named path has gone. */
function projectWithout(omitted: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(ANCHORS)) {
    if (filePath !== omitted) project.createSourceFile(filePath, source);
  }
  return project;
}

/** The anchor map with the monitored schedule fired under a different expression. */
function scheduleMapFiring(crontab: string): Readonly<Record<string, string>> {
  return { [SCHEDULE_MAP_MODULE]: SCHEDULE_MAP_SOURCE.replace('*/15 * * * *', crontab) };
}

/** The monitor config as the sink writes it, for a test that stands one somewhere else. */
const MONITOR_CONFIG_SOURCE = `
export function fixtureCapture(client: Client, crontab: string): void {
  client.captureCheckIn(
    { monitorSlug: 'jobs-health', status: 'in_progress' },
    {
      schedule: { type: 'crontab', value: crontab },
      checkinMargin: 5,
      maxRuntime: 10,
      timezone: 'UTC',
    }
  );
}
`;

/** The Sentry sink with one fragment of its check-in capture rewritten. */
function sentrySink(from: string, to: string): Readonly<Record<string, string>> {
  if (!SENTRY_SOURCE.includes(from)) throw new Error(`the sink fixture holds no '${from}'`);
  return { [SENTRY_MODULE]: SENTRY_SOURCE.replace(from, to) };
}

describe('cron-schedule-checks-in', () => {
  describe('the scheduled handler brackets the monitored schedule', () => {
    it('accepts the bracket the handler writes', () => {
      expect(rule.check(projectOf())).toEqual([]);
    });

    it('accepts a guard written at the branch rather than through a bound name', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    if (cronScheduleNameFor(controller.cron) === 'jobs-health') {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (cronScheduleNameFor(controller.cron) === 'jobs-health') {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('flags a handler whose closing check-in was deleted', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);`),
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({ file: CRON_MODULE, message: expect.stringContaining("'ok'") }),
      ]);
    });

    it('flags a handler whose opening check-in was deleted', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({
          file: CRON_MODULE,
          message: expect.stringContaining("'in_progress'"),
        }),
      ]);
    });

    it('flags a bracket that closes around nothing, both check-ins after the run', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('in_progress');
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({
          file: CRON_MODULE,
          message: expect.stringContaining("'in_progress'"),
        }),
      ]);
    });

    it('flags check-ins that run on every schedule rather than the monitored one', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    telemetry.checkIn('in_progress');
    await runCronEntries(entries, telemetry);
    telemetry.checkIn('ok');`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a guard that spells the crontab instead of resolving the schedule name', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = controller.cron === '*/15 * * * *';
    if (checksIn) {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a bracket whose check-in is a look-alike declared beside the telemetry handle', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const monitor = { checkIn: (status: string): void => {} };
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      monitor.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      monitor.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a cron run the closing check-in cannot be after, because nothing awaits it', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      telemetry.checkIn('in_progress');
    }
    void runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({ file: CRON_MODULE, message: expect.stringContaining('await') }),
      ]);
    });

    it('aborts when the handler it stands over is no longer declared', () => {
      const project = projectOf({ [CRON_MODULE]: 'export const nothing = 1;\n' });

      expect(() => rule.check(project)).toThrow(/createScheduledHandler/);
    });

    it('aborts when the cron run it brackets is no longer called', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    await Promise.resolve();`),
      });

      expect(() => rule.check(project)).toThrow(/runCronEntries/);
    });
  });

  describe('a telemetry module derives the crontab rather than spelling it', () => {
    it('flags a crontab written as a string literal in a telemetry module', () => {
      const project = projectOf({
        [CONSOLE_MODULE]: `export const MONITOR_CRONTAB = '*/15 * * * *';\n`,
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({ file: CONSOLE_MODULE, line: 1 }),
      ]);
    });

    it('flags a crontab written as a template literal in a telemetry module', () => {
      const project = projectOf({
        [CONSOLE_MODULE]: 'export const MONITOR_CRONTAB = `0 */6 * * *`;\n',
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({ file: CONSOLE_MODULE, line: 1 }),
      ]);
    });

    it('accepts a crontab spelled outside the telemetry tree, where the map declares it', () => {
      expect(rule.check(projectOf())).toEqual([]);
    });
  });

  describe('the monitor reports a missed pass before the next one starts', () => {
    it('accepts a margin and a maximum runtime under the schedule period', () => {
      expect(rule.check(projectOf())).toEqual([]);
    });

    it('accepts the two minute counts written as numeric literals', () => {
      const project = projectOf({
        [SENTRY_MODULE]: SENTRY_SOURCE.replace('CHECK_IN_MARGIN_MINUTES,', '5,').replace(
          'MAX_RUNTIME_MINUTES,',
          '10,'
        ),
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('flags a check-in margin as long as the schedule period', () => {
      const project = projectOf({
        [SENTRY_MODULE]: SENTRY_SOURCE.replace(
          'const CHECK_IN_MARGIN_MINUTES = 5;',
          'const CHECK_IN_MARGIN_MINUTES = 15;'
        ),
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({
          file: SENTRY_MODULE,
          message: expect.stringContaining('checkinMargin'),
        }),
      ]);
    });

    it('flags a maximum runtime longer than the schedule period', () => {
      const project = projectOf({
        [SENTRY_MODULE]: SENTRY_SOURCE.replace(
          'const MAX_RUNTIME_MINUTES = 10;',
          'const MAX_RUNTIME_MINUTES = 20;'
        ),
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({
          file: SENTRY_MODULE,
          message: expect.stringContaining('maxRuntime'),
        }),
      ]);
    });

    it('flags a monitor whose slug names no schedule the map declares', () => {
      const project = projectOf({
        [SENTRY_MODULE]: SENTRY_SOURCE.replace(
          "const MONITOR_SLUG = 'jobs-health';",
          "const MONITOR_SLUG = 'job-health';"
        ),
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({
          file: SENTRY_MODULE,
          message: expect.stringContaining('job-health'),
        }),
      ]);
    });

    it('flags a monitor upserted with no schedule of its own', () => {
      const project = projectOf({
        [SENTRY_MODULE]: `
const MONITOR_SLUG = 'jobs-health';
export function createSentrySink(client: Client) {
  return {
    checkIn(status: 'in_progress' | 'ok'): void {
      client.captureCheckIn({ monitorSlug: MONITOR_SLUG, status });
    },
  };
}
`,
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({
          file: SENTRY_MODULE,
          message: expect.stringContaining('checkinMargin'),
        }),
      ]);
    });

    it('flags a monitor config whose slug is not a name this rule can read', () => {
      const project = projectOf({
        [SENTRY_MODULE]: SENTRY_SOURCE.replace(
          'monitorSlug: MONITOR_SLUG, status },',
          'monitorSlug: slugFor(options), status },'
        ),
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({
          file: SENTRY_MODULE,
          message: expect.stringContaining('monitorSlug'),
        }),
      ]);
    });

    it('flags a minute count that is not a literal this rule can read', () => {
      const project = projectOf({
        [SENTRY_MODULE]: SENTRY_SOURCE.replace(
          'maxRuntime: MAX_RUNTIME_MINUTES,',
          'maxRuntime: MAX_RUNTIME_MINUTES * 2,'
        ),
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({
          file: SENTRY_MODULE,
          message: expect.stringContaining('maxRuntime'),
        }),
      ]);
    });

    it('aborts when a schedule the monitor watches is not a crontab it can expand', () => {
      const project = projectOf({
        [SCHEDULE_MAP_MODULE]: SCHEDULE_MAP_SOURCE.replace(
          "'jobs-health': '*/15 * * * *'",
          "'jobs-health': '*/15 * * *'"
        ),
      });

      expect(() => rule.check(project)).toThrow(/five-field crontab/);
    });

    it('aborts when no telemetry module captures a check-in at all', () => {
      const project = projectOf({
        [SENTRY_MODULE]: 'export const createSentrySink = () => buildSink();\n',
      });

      expect(() => rule.check(project)).toThrow(/captureCheckIn/);
    });

    it('aborts when the schedule map it derives the period from has moved', () => {
      const project = projectOf({ [SCHEDULE_MAP_MODULE]: 'export const nothing = 1;\n' });

      expect(() => rule.check(project)).toThrow(/CRON_SCHEDULES/);
    });
  });

  describe('the period is derived from the expression the schedule fires under', () => {
    it('accepts a monitor watching a schedule written as a stepped range', () => {
      expect(rule.check(projectOf(scheduleMapFiring('0-45/15 * * * *')))).toEqual([]);
    });

    it('accepts a monitor watching a schedule stepping from a starting minute', () => {
      expect(rule.check(projectOf(scheduleMapFiring('5/20 * * * *')))).toEqual([]);
    });

    it('accepts a monitor watching a schedule written as a plain minute of a stepped hour', () => {
      expect(rule.check(projectOf(scheduleMapFiring('0 */6 * * *')))).toEqual([]);
    });

    it('flags both counts when a bare range fires the schedule every minute', () => {
      expect(rule.check(projectOf(scheduleMapFiring('0-9 * * * *')))).toHaveLength(2);
    });

    it.each([
      ['a range opening on something that is not a number', 'a-9 * * * *'],
      ['a range closing on something that is not a number', '0-b * * * *'],
      ['a field that is neither a wildcard, a number nor a range', 'x * * * *'],
      ['a step that is not a whole number', '*/x * * * *'],
      ['a step of zero', '*/0 * * * *'],
      ['a value outside the field it sits in', '70 * * * *'],
      ['a range that runs backwards', '30-5 * * * *'],
    ])('aborts on %s', (_description, crontab) => {
      expect(() => rule.check(projectOf(scheduleMapFiring(crontab)))).toThrow(/five-field crontab/);
    });
  });

  describe('the anchors the clauses rest on', () => {
    it('aborts when the module holding the bracket is gone from the tree', () => {
      expect(() => rule.check(projectWithout(CRON_MODULE))).toThrow(/names no file/);
    });

    it('aborts when the module declaring the schedules is gone from the tree', () => {
      expect(() => rule.check(projectWithout(SCHEDULE_MAP_MODULE))).toThrow(/names no file/);
    });

    it('aborts when the schedule map declares nothing', () => {
      const project = projectOf({
        [SCHEDULE_MAP_MODULE]: 'export const CRON_SCHEDULES = {} as const;\n',
      });

      expect(() => rule.check(project)).toThrow(/declares no schedule/);
    });

    it('aborts when the handler calls the cron run more than once', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    await runCronEntries(entries, telemetry);
    await runCronEntries(entries, telemetry);`),
      });

      expect(() => rule.check(project)).toThrow(/2 times/);
    });

    it('reads past map entries that are not a name paired with an expression', () => {
      const project = projectOf({
        [SCHEDULE_MAP_MODULE]: `
const INHERITED = { hourly: '0 * * * *' };
export const CRON_SCHEDULES = {
  ...INHERITED,
  'jobs-health': '*/15 * * * *',
  'access-log': accessLogCron(),
} as const;
`,
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('reads past a telemetry call whose callee is not a name at all', () => {
      const project = projectOf({
        [CONSOLE_MODULE]: 'export const sink = resolveSinkFactory()();\n',
      });

      expect(rule.check(project)).toEqual([]);
    });
  });

  describe('the monitor is read off the capture rather than off a name', () => {
    it('accepts a monitor config passed as the capture second argument outright', () => {
      const project = projectOf(
        sentrySink(
          `options.monitorCrontab === undefined
            ? undefined
            : {`,
          '{'
        )
      );

      expect(rule.check(project)).toEqual([]);
    });

    it('flags a slug bound outside the module the capture sits in', () => {
      const project = projectOf(
        sentrySink('monitorSlug: MONITOR_SLUG, status },', 'monitorSlug: EXTERNAL_SLUG, status },')
      );

      expect(rule.check(project)).toEqual([
        expect.objectContaining({ message: expect.stringContaining('monitorSlug') }),
      ]);
    });

    it('flags a capture whose payload declares no slug', () => {
      const project = projectOf(sentrySink('monitorSlug: MONITOR_SLUG, status },', 'status },'));

      expect(rule.check(project)).toEqual([
        expect.objectContaining({ message: expect.stringContaining('monitorSlug') }),
      ]);
    });

    it('flags a capture whose payload is not written out where the rule reads it', () => {
      const project = projectOf(sentrySink('{ monitorSlug: MONITOR_SLUG, status },', 'payload,'));

      expect(rule.check(project)).toEqual([
        expect.objectContaining({ message: expect.stringContaining('monitorSlug') }),
      ]);
    });

    it('reads a second argument carrying one of the two counts as no monitor config', () => {
      const project = projectOf(
        sentrySink(
          `schedule: { type: 'crontab', value: options.monitorCrontab },
                checkinMargin: CHECK_IN_MARGIN_MINUTES,
                maxRuntime: MAX_RUNTIME_MINUTES,`,
          `schedule: { type: 'crontab', value: options.monitorCrontab },
                checkinMargin: CHECK_IN_MARGIN_MINUTES,`
        )
      );

      expect(rule.check(project)).toEqual([
        expect.objectContaining({
          file: SENTRY_MODULE,
          message: expect.stringContaining('no monitor config'),
        }),
      ]);
    });

    it('reads a second argument carrying the maximum runtime alone as no monitor config', () => {
      const project = projectOf(
        sentrySink(
          `checkinMargin: CHECK_IN_MARGIN_MINUTES,
                maxRuntime: MAX_RUNTIME_MINUTES,`,
          'maxRuntime: MAX_RUNTIME_MINUTES,'
        )
      );

      expect(rule.check(project)).toEqual([
        expect.objectContaining({
          file: SENTRY_MODULE,
          message: expect.stringContaining('no monitor config'),
        }),
      ]);
    });

    it('flags a minute count bound outside the module the capture sits in', () => {
      const project = projectOf(
        sentrySink('checkinMargin: CHECK_IN_MARGIN_MINUTES,', 'checkinMargin: EXTERNAL_MARGIN,')
      );

      expect(rule.check(project)).toEqual([
        expect.objectContaining({ message: expect.stringContaining('checkinMargin') }),
      ]);
    });

    it('flags minute counts carried in by shorthand rather than written against their names', () => {
      const project = projectOf(
        sentrySink(
          `checkinMargin: CHECK_IN_MARGIN_MINUTES,
                maxRuntime: MAX_RUNTIME_MINUTES,`,
          'checkinMargin,\n                maxRuntime,'
        )
      );

      expect(rule.check(project)).toHaveLength(2);
    });
  });

  describe('the bracket is read off the handler rather than off a spelling', () => {
    it('flags a check-in on a handle the runtime seam did not produce', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = deps.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a check-in on a handle the runtime built from a different seam', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createDb(env);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a bracket whose handle was destructured out of the runtime seam', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const { checkIn } = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a bracket whose check-ins name statuses the port does not carry', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      telemetry.checkIn('open');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('done');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a closing check-in written before the run it should close', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      telemetry.checkIn('in_progress');
      telemetry.checkIn('ok');
    }
    await runCronEntries(entries, telemetry);`),
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({ file: CRON_MODULE, message: expect.stringContaining("'ok'") }),
      ]);
    });

    it('flags a bracket whose method name extends the check-in rather than being it', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      telemetry.checkInLater('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkInLater('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a bracket whose method name differs from the check-in only in case', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      telemetry.checkin('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkin('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a guard whose resolver name extends the map resolver rather than being it', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameForDisplay(controller.cron) === 'jobs-health';
    if (checksIn) {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a bracket that calls another method of the telemetry handle', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      telemetry.record('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.record('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a check-in that names no status', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      telemetry.checkIn();
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn();
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('accepts a guard that compares the other way round', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = 'jobs-health' === cronScheduleNameFor(controller.cron);
    if (checksIn) {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toEqual([]);
    });

    it('flags a guard that is not a comparison at all', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    if (isJobsHealth(controller.cron)) {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (isJobsHealth(controller.cron)) {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a guard that resolves the schedule name through a second reading of the map', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = scheduleNameOf(controller.cron) === 'jobs-health';
    if (checksIn) {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a guard that reads the schedule name off the controller', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = controller.scheduleName === 'jobs-health';
    if (checksIn) {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a bracket guarded the other way round on a different declared schedule', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = 'hourly' === cronScheduleNameFor(controller.cron);
    if (checksIn) {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a bracket guarded on a different schedule the map declares', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'hourly';
    if (checksIn) {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags a guard that compares loosely rather than strictly', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) == 'jobs-health';
    if (checksIn) {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });

    it('flags check-ins written in the branch the guard rejects', () => {
      const project = projectOf({
        [CRON_MODULE]: cronModule(`
    const telemetry = runtime.createTelemetry(env, ctx);
    const entries = runtime.entriesFor(controller.cron, { env, telemetry });
    const checksIn = cronScheduleNameFor(controller.cron) === 'jobs-health';
    if (checksIn) {
      noop();
    } else {
      telemetry.checkIn('in_progress');
    }
    await runCronEntries(entries, telemetry);
    if (checksIn) {
      noop();
    } else {
      telemetry.checkIn('ok');
    }`),
      });

      expect(rule.check(project)).toHaveLength(2);
    });
  });

  describe('a test module answers for no claim about production', () => {
    it('flags a production capture whose config moved into a colocated test', () => {
      const project = projectOf({
        ...sentrySink(
          `options.monitorCrontab === undefined
            ? undefined
            : {
                schedule: { type: 'crontab', value: options.monitorCrontab },
                checkinMargin: CHECK_IN_MARGIN_MINUTES,
                maxRuntime: MAX_RUNTIME_MINUTES,
                timezone: 'UTC',
              }`,
          'undefined'
        ),
        [SENTRY_TEST_MODULE]: MONITOR_CONFIG_SOURCE,
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({
          file: SENTRY_MODULE,
          message: expect.stringContaining('checkinMargin'),
        }),
      ]);
    });

    it('aborts when the only check-in left in the tree sits in a colocated test', () => {
      const project = projectOf({
        [SENTRY_MODULE]: 'export const createSentrySink = () => buildSink();\n',
        [SENTRY_TEST_MODULE]: MONITOR_CONFIG_SOURCE,
      });

      expect(() => rule.check(project)).toThrow(/captureCheckIn/);
    });

    it('flags a production capture whose config moved into a spec-spelled module', () => {
      const project = projectOf({
        ...sentrySink(
          `options.monitorCrontab === undefined
            ? undefined
            : {
                schedule: { type: 'crontab', value: options.monitorCrontab },
                checkinMargin: CHECK_IN_MARGIN_MINUTES,
                maxRuntime: MAX_RUNTIME_MINUTES,
                timezone: 'UTC',
              }`,
          'undefined'
        ),
        [SENTRY_SPEC_MODULE]: MONITOR_CONFIG_SOURCE,
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({
          file: SENTRY_MODULE,
          message: expect.stringContaining('no monitor config'),
        }),
      ]);
    });

    it('flags a production capture whose config moved into a setup-spelled module', () => {
      const project = projectOf({
        ...sentrySink(
          `options.monitorCrontab === undefined
            ? undefined
            : {
                schedule: { type: 'crontab', value: options.monitorCrontab },
                checkinMargin: CHECK_IN_MARGIN_MINUTES,
                maxRuntime: MAX_RUNTIME_MINUTES,
                timezone: 'UTC',
              }`,
          'undefined'
        ),
        [TELEMETRY_SETUP_MODULE]: MONITOR_CONFIG_SOURCE,
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({
          file: SENTRY_MODULE,
          message: expect.stringContaining('no monitor config'),
        }),
      ]);
    });

    it('flags a crontab spelled in a setup module of the telemetry tree', () => {
      const project = projectOf({
        [TELEMETRY_SETUP_MODULE]: `const CRONTAB = '*/15 * * * *';\nexport { CRONTAB };\n`,
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({ file: TELEMETRY_SETUP_MODULE, line: 1 }),
      ]);
    });

    it('flags a crontab spelled in a colocated test, which the wider clause still reads', () => {
      const project = projectOf({
        [SENTRY_TEST_MODULE]: `const CRONTAB = '*/15 * * * *';\nexport { CRONTAB };\n`,
      });

      expect(rule.check(project)).toEqual([
        expect.objectContaining({ file: SENTRY_TEST_MODULE, line: 1 }),
      ]);
    });

    it('flags a crontab in every telemetry module that spells one, not just the first', () => {
      const project = projectOf({
        [CONSOLE_MODULE]: `export const A = '*/15 * * * *';\n`,
        [FAN_OUT_MODULE]: `export const B = '0 */6 * * *';\n`,
      });

      expect(rule.check(project)).toHaveLength(2);
    });
  });

  describe('the period comes from the schedule the monitor watches', () => {
    it('takes it from the watched slug, not from the map its first or last entry names', () => {
      const project = projectOf({
        [SCHEDULE_MAP_MODULE]: `
export const CRON_SCHEDULES = {
  hourly: '0 * * * *',
  'jobs-health': '0,30 * * * *',
  'daily-retention': '0 3 * * *',
} as const;
`,
        ...sentrySink('const CHECK_IN_MARGIN_MINUTES = 5;', 'const CHECK_IN_MARGIN_MINUTES = 30;'),
      });

      expect(rule.check(project)).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('fires every 30') })
      );
    });
  });

  describe('the period the counts are held under is the one the expression derives', () => {
    it.each([
      ['a comma list of minutes', '0,30 * * * *', 30],
      ['a step from a starting minute', '5/20 * * * *', 20],
      ['a plain minute of a stepped hour', '0 */6 * * *', 360],
      ['two hours whose closest gap wraps past midnight', '0 0,23 * * *', 60],
      ['a wildcard minute', '* * * * *', 1],
    ])('names the period it derived from %s', (_description, crontab, period) => {
      const project = projectOf({
        ...scheduleMapFiring(crontab),
        ...sentrySink(
          'const CHECK_IN_MARGIN_MINUTES = 5;',
          `const CHECK_IN_MARGIN_MINUTES = ${String(period)};`
        ),
      });

      expect(rule.check(project)).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining(`fires every ${String(period)}`),
        })
      );
    });
  });
});

/**
 * Where each published name is written among the anchors, and how the rule must
 * answer once it is spelled otherwise. One entry per name rather than one case per
 * name: the widenings below multiply these into the table, so a name the rule adds
 * needs a site here and no case of its own — and without one, the coverage
 * assertion reddens rather than the name going quietly unasked about.
 */
const NEAR_MISS_SITES: Readonly<
  Record<string, { readonly module: string; readonly answers: 'reports' | 'aborts' }>
> = {
  [SCHEDULE_RESOLVER]: { module: CRON_MODULE, answers: 'reports' },
  [TELEMETRY_FACTORY]: { module: CRON_MODULE, answers: 'reports' },
  [CHECK_IN]: { module: CRON_MODULE, answers: 'reports' },
  [OPEN]: { module: CRON_MODULE, answers: 'reports' },
  [CLOSE]: { module: CRON_MODULE, answers: 'reports' },
  [CAPTURE_CHECK_IN]: { module: SENTRY_MODULE, answers: 'aborts' },
};

/**
 * The ways an equality against a name is widened by a token, each paired with the
 * spelling that slips through it. Held open rather than closed: the fourth was found
 * by trying a widening nobody had listed, so a fifth is expected rather than ruled out.
 */
const WIDENINGS: readonly {
  readonly widening: string;
  readonly spell: (name: string) => string;
}[] = [
  { widening: 'a name extending it', spell: (name) => `${name}Later` },
  { widening: 'a name it extends', spell: (name) => name.slice(0, -1) },
  {
    widening: 'the same name in another case',
    spell: (name) => (name.toLowerCase() === name ? name.toUpperCase() : name.toLowerCase()),
  },
  { widening: 'the same name under a trailing digit', spell: (name) => `${name}2` },
];

/** One derived case: a published name, spelled so that one widening would accept it. */
interface NearMiss {
  readonly name: string;
  readonly widening: string;
  readonly spelling: string;
  readonly module: string;
  readonly answers: 'reports' | 'aborts';
}

const NEAR_MISSES: readonly NearMiss[] = IDENTIFYING_NAMES.flatMap((name) => {
  const site = NEAR_MISS_SITES[name];
  return site === undefined
    ? []
    : WIDENINGS.map(({ widening, spell }) => ({
        name,
        widening,
        spelling: spell(name),
        module: site.module,
        answers: site.answers,
      }));
});

/** The anchors with one name respelled throughout the module that writes it. */
function respelled(nearMiss: NearMiss): Project {
  const source = ANCHORS[nearMiss.module];
  if (source === undefined) throw new Error(`no anchor source for '${nearMiss.module}'`);
  if (!source.includes(nearMiss.name)) {
    throw new Error(`'${nearMiss.name}' is not written in ${nearMiss.module}`);
  }
  return projectOf({ [nearMiss.module]: source.replaceAll(nearMiss.name, nearMiss.spelling) });
}

describe('cron-schedule-checks-in — the names it identifies things by', () => {
  it('declares a near-miss site for every name the rule publishes', () => {
    const byName = (left: string, right: string): number => left.localeCompare(right);

    expect(Object.keys(NEAR_MISS_SITES).toSorted(byName)).toEqual(
      [...IDENTIFYING_NAMES].toSorted(byName)
    );
  });

  it('derives a spelling that differs from the name it stands next to', () => {
    expect(NEAR_MISSES.filter(({ name, spelling }) => name === spelling)).toEqual([]);
  });

  it.each(NEAR_MISSES.filter(({ answers }) => answers === 'reports'))(
    "reports when '$name' is spelled '$spelling' — $widening",
    (nearMiss) => {
      expect(rule.check(respelled(nearMiss))).not.toEqual([]);
    }
  );

  it.each(NEAR_MISSES.filter(({ answers }) => answers === 'aborts'))(
    "aborts when '$name' is spelled '$spelling' — $widening",
    (nearMiss) => {
      expect(() => rule.check(respelled(nearMiss))).toThrow();
    }
  );
});
