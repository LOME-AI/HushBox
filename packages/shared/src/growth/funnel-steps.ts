/**
 * The funnel ladder's vocabulary, settled here because the same distinction
 * reaches an operator-facing operation description, a wire contract, a database
 * view and the dashboard's own caption, and those disagreed about which steps
 * each word covered. The description and the caption render these; the view and
 * the contract cite them by name, being prose rather than code.
 *
 * Each is stated as what a step is or takes, never as how many steps there
 * are, because a count is falsified by a step being added.
 */

/**
 * What makes a funnel step anonymous, and how the dashboard draws one.
 *
 * Anonymity is a fact about whose count it is and says nothing about how the
 * figure was computed — {@link BUCKET_MAXIMUM_NOTE} is that, and it is true of
 * a different set of steps.
 */
export const ANONYMOUS_STEP_NOTE =
  'A step is anonymous when no account identity stands behind its count; the dashboard hatches those and draws the account steps solid.';

/**
 * Why a step whose bucket holds more than one row reports a floor rather than
 * a total, and why a week cannot be counted directly instead.
 */
export const BUCKET_MAXIMUM_NOTE =
  'A step whose bucket holds more than one row keeps the largest of them and sums those buckets, so its figure is a lower bound: uniques are set cardinalities under a daily-rotating hash, and a week has no set to take one over.';
