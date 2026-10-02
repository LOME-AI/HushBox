/**
 * The deployed schedules: the name a developer, a script or a spec types, and
 * the exact expression Cloudflare fires it under.
 *
 * Both halves of the pairing live here once. `cronEntriesFor` in
 * `apps/api/src/scheduled.ts` resolves an incoming expression through
 * {@link cronScheduleNameFor} and dispatches on the NAME, so a schedule that
 * runs entries is one this map names and a schedule this map names owes a
 * branch there — completeness in both directions is the compiler's, not a
 * gate's.
 *
 * It imports nothing, deliberately. It is published as
 * `@hushbox/api/cron-schedules` and read by the dev-server cron ticker and by
 * the E2E cron helper; a door onto the Worker's cron composition root would
 * charge each of those processes the whole graph's module load to read four
 * strings.
 *
 * The expressions are mirrored, in this order, by wrangler's `[triggers]`
 * crons. Cloudflare reads that file and no import can collapse the pair, so
 * `whole-app/scheduled.test.ts` holds the two equal.
 */
export const CRON_SCHEDULES = {
  'jobs-health': '*/15 * * * *',
  // ~6-hourly is load-bearing: free-tier Access retains its logs 24 h, so a
  // once-daily pull that fails once loses that window permanently.
  'access-log': '0 */6 * * *',
  hourly: '0 * * * *',
  'daily-retention': '0 3 * * *',
} as const;

/** The name half of {@link CRON_SCHEDULES}. */
export type CronScheduleName = keyof typeof CRON_SCHEDULES;

/** The schedule an expression belongs to, or nothing for one no schedule registers. */
export function cronScheduleNameFor(cron: string): CronScheduleName | undefined {
  return (Object.keys(CRON_SCHEDULES) as CronScheduleName[]).find(
    (name) => CRON_SCHEDULES[name] === cron
  );
}
