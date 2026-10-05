/**
 * How long one isolate stays quiet about a report key it has already reported.
 * A window rather than a flag: an unbounded report floods the one channel a
 * human reads with a single repeated fact during an outage, and a flag would
 * report the first outage an isolate meets and none after it, while an isolate
 * can live for hours. A minute refreshes at the pace someone reading an
 * incident looks. It bounds telemetry volume and nothing else.
 */
export const REPORT_WINDOW_MS = 60_000;

/**
 * When this isolate last reported each key. Module scope is where an isolate's
 * own reporting state lives: it gates REPORTING and never the answer, and
 * losing it with the isolate costs nothing. One map serves every caller, so a
 * caller's keys name what it reports (a dependency and its failure arm, an
 * inference code and its status) and an outage of one thing cannot silence
 * another's.
 */
const lastReportAt = new Map<string, number>();

/**
 * Whether a report under `key` may go out at `nowMs`: true at most once per
 * {@link REPORT_WINDOW_MS} for each key, and a true answer starts the key's
 * next window.
 */
export function admitReport(key: string, nowMs: number): boolean {
  const lastAt = lastReportAt.get(key);
  if (lastAt !== undefined && nowMs - lastAt < REPORT_WINDOW_MS) return false;
  lastReportAt.set(key, nowMs);
  return true;
}
