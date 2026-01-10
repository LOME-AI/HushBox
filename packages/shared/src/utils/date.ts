/**
 * Date utilities for consistent time handling across the application.
 * Single source of truth for UTC midnight calculations and reset logic.
 */

/**
 * Get the start of the current UTC day (midnight).
 * Used for daily reset logic (free allowance, guest usage, etc.)
 *
 * @returns Date object representing 00:00:00.000 UTC of the current day
 */
export function getUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Check if a timestamp is before the current UTC midnight.
 * Used for lazy reset patterns - returns true if reset is needed.
 *
 * @param resetAt - The last reset timestamp, or null if never reset
 * @returns true if resetAt is null or before today's UTC midnight
 */
export function needsResetBeforeMidnight(resetAt: Date | null): boolean {
  if (resetAt === null) {
    return true;
  }
  const midnight = getUtcMidnight();
  return resetAt < midnight;
}
