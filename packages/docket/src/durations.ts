/**
 * The one declaration of each duration unit this package uses, source and
 * tests alike. Package-local on purpose: every caller is inside this package,
 * so collapsing the copies here costs nothing in the workspace graph.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
