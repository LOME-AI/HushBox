import { DAY_MS, HOUR_MS, MINUTE_MS } from '@hushbox/shared/durations';

/**
 * A due instant read against a supplied now: the phrase to show, and whether it
 * is late. Local: it is this module's own return annotation, and a caller that
 * needs to name it reaches it through `ReturnType<typeof relativeTime>`.
 */
interface RelativeTime {
  readonly label: string;
  readonly overdue: boolean;
}

/**
 * Coarsest whole unit that fits, so a dense column never wraps. Sub-minute
 * collapses to `<1m` rather than rounding to `0m`, which would read as "no
 * wait at all" on a row that has one.
 */
function magnitude(ms: number): string {
  if (ms < MINUTE_MS) return '<1m';
  if (ms < HOUR_MS) return `${String(Math.floor(ms / MINUTE_MS))}m`;
  if (ms < DAY_MS) return `${String(Math.floor(ms / HOUR_MS))}h`;
  return `${String(Math.floor(ms / DAY_MS))}d`;
}

/**
 * Pure by construction: the caller supplies the instant, so a test names it
 * from the shared test-time module instead of mocking a clock this module read.
 *
 * A row due at exactly `nowMs` is claimable but not late, so the boundary reads
 * as due rather than overdue — the dispatcher claims on `<= now`, and calling a
 * zero-millisecond overrun "overdue" would flag every row the instant it ripens.
 */
export function relativeTime(iso: string, nowMs: number): RelativeTime {
  const deltaMs = Date.parse(iso) - nowMs;
  if (deltaMs > 0) return { label: `in ${magnitude(deltaMs)}`, overdue: false };
  if (deltaMs === 0) return { label: 'due now', overdue: false };
  return { label: `${magnitude(-deltaMs)} overdue`, overdue: true };
}
