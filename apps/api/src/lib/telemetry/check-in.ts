/**
 * The jobs-health monitor's check-in: the cron pass brackets its run with
 * `in_progress` and `ok`, and a pair that never arrives is what tells the
 * monitor that the schedule's isolate did not run.
 *
 * A sibling of the Telemetry port (`apps/api/src/lib/telemetry/port.ts`) rather
 * than a method on it, because only the cron path checks in: a required method
 * would land on every `Telemetry`-typed literal in the tree.
 */
export interface ScheduleCheckIn {
  checkIn(status: 'in_progress' | 'ok'): void;
}
