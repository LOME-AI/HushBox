/**
 * How a check-in reports its pass: `in_progress` opens it, and `ok` or `error`
 * closes it, `error` when any of its entries failed.
 */
export type CheckInStatus = 'in_progress' | 'ok' | 'error';

/**
 * The jobs-health monitor's check-in: the cron pass brackets its run with
 * `in_progress` and a closing status, and a pair that never arrives is what
 * tells the monitor that the schedule's isolate did not run.
 *
 * A sibling of the Telemetry port (`apps/api/src/lib/telemetry/port.ts`) rather
 * than a method on it, because only the cron path checks in: a required method
 * would land on every `Telemetry`-typed literal in the tree.
 */
export interface ScheduleCheckIn {
  checkIn(status: CheckInStatus): void;
}
