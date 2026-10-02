import { describe, expect, it } from 'vitest';
import { CRON_SCHEDULES, cronScheduleNameFor } from './cron-schedules.js';
import { cronEntriesFor } from '../scheduled.js';
import { createJobWakeCollector, grantJobWakes } from '../lib/jobs/index.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { CronScheduleName } from './cron-schedules.js';
import type { CronDependencies, ScheduledBindings } from '../scheduled.js';
import type { Telemetry } from '../lib/telemetry/index.js';

/**
 * The entry that identifies each schedule's own branch. One name per schedule
 * rather than the whole list, which `whole-app/scheduled.test.ts` already pins
 * against each expression: the claim here is that the NAME selects that
 * branch, so a pairing swapped between two real schedules fails.
 */
const IDENTIFYING_ENTRY: Record<CronScheduleName, string> = {
  'jobs-health': 'jobs-health-audit',
  'access-log': 'admin-access-log-audit',
  hourly: 'model-catalog-refresh',
  'daily-retention': 'idempotency-key-purge',
};

// Entry construction reads these seams without calling them, so the shapes are
// asserted rather than built: a real database or Redis client here would bind
// nothing this file asserts and would need live infrastructure to exist.
function fakeDeps(): CronDependencies {
  const telemetry: Telemetry = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    captureError: () => {},
  };
  return {
    env: { NODE_ENV: 'development' } as ScheduledBindings,
    db: grantJobWakes({} as Database, createJobWakeCollector()),
    redis: {} as Redis,
    telemetry,
    now: () => new Date(),
    isCI: false,
    catalogFetch: () => Promise.reject(new Error('unused')),
    gatewayBaseUrl: 'https://gateway.test/api/v1',
    refreshJitter: { maxMs: 0, random: () => 0, sleep: () => Promise.resolve() },
  };
}

const scheduleNames = Object.keys(CRON_SCHEDULES) as CronScheduleName[];

describe('cronScheduleNameFor', () => {
  it.each(scheduleNames)('resolves the expression %s is registered under back to it', (name) => {
    expect(cronScheduleNameFor(CRON_SCHEDULES[name])).toBe(name);
  });

  it('resolves an expression no schedule registers to nothing', () => {
    expect(cronScheduleNameFor('7 7 7 7 7')).toBeUndefined();
  });

  it('registers a distinct expression per name', () => {
    expect(new Set(Object.values(CRON_SCHEDULES)).size).toBe(scheduleNames.length);
  });
});

describe('firing a schedule by name', () => {
  it.each(scheduleNames)('reaches the entries %s owns', (name) => {
    const entries = cronEntriesFor(CRON_SCHEDULES[name], fakeDeps());
    expect(entries?.map((entry) => entry.name)).toContain(IDENTIFYING_ENTRY[name]);
  });

  it('reaches no entries for an expression no schedule registers', () => {
    expect(cronEntriesFor('7 7 7 7 7', fakeDeps())).toBeUndefined();
  });
});
