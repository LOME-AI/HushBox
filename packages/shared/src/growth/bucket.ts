/**
 * How a growth bucket is spelled, at both grains.
 *
 * A bucket string is a serialization format rather than a display format: it
 * is the middle of every growth Redis key, it is the value the rollup writes
 * into the `hour` and `day` columns, and it is what a specification matches a
 * seeded row by. Two spellings of it would be a set nobody reads or a row
 * nobody finds, and the failure is silent on both sides — which is why this
 * lives in one module and is imported rather than restated.
 *
 * It sits in the shared package because its callers cross the package
 * boundary: the counting path in the product Worker publishes it through the
 * Redis key registry's barrel, and the development seed reads it from the
 * scripts tree.
 */

/** Two digits, so a bucket string sorts and compares as its own timestamp. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The UTC day a moment falls in, as the day-grain bucket. */
export function growthDayBucket(at: Date): string {
  return `${String(at.getUTCFullYear())}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** The UTC hour a moment falls in, as the hour-grain bucket. */
export function growthHourBucket(at: Date): string {
  return `${growthDayBucket(at)}T${pad(at.getUTCHours())}`;
}
