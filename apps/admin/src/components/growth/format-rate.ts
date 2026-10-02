import { NO_RATE } from './absent-figure.js';

/**
 * A rate as a percentage to one decimal, or the words where there is none to
 * state. Every rate the growth screen prints goes through here, so one screen
 * cannot come to state one kind of figure at two precisions.
 */
export function formatRate(rate: number | null): string {
  return rate === null ? NO_RATE : `${(rate * 100).toFixed(1)}%`;
}
