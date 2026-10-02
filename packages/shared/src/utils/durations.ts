/**
 * The one declaration of each duration unit for every caller that needs one,
 * on both sides of the test boundary.
 *
 * This module deliberately imports nothing: the test-time module next to it
 * pulls in the test runner, which is why product code and dev scripts could
 * not reach the units declared there and started keeping copies. A test pins
 * the import graph so that coupling cannot come back.
 */

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const MINUTE_SECONDS = 60;
export const HOUR_SECONDS = 60 * MINUTE_SECONDS;
export const DAY_SECONDS = 24 * HOUR_SECONDS;

export const HOUR_MINUTES = 60;
export const DAY_MINUTES = 24 * HOUR_MINUTES;
