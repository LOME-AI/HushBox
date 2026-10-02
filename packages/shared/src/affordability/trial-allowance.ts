/**
 * The trial tier's daily message allowance.
 *
 * The figure is declared once, on the tier authority beside every other tier
 * constant, and published here so a surface asking how much of the day's
 * preview is left compares against the declared allowance rather than a literal
 * of its own. A count is the whole answer: the trial is metered in messages, not
 * money — the server admits its turns on quota rather than balance
 * (`docs/BILLING.md` §Affordability 8).
 *
 * Like the free tier's allowance beside it, it answers what one day's allowance
 * IS, never how much of it is left; the remaining count is a served figure.
 */

import { TRIAL_MESSAGE_LIMIT } from './money/tiers.ts';

export function trialDailyMessageAllowance(): number {
  return TRIAL_MESSAGE_LIMIT;
}
