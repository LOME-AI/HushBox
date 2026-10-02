/**
 * What a growth cell says where it has no figure to put there, from one
 * definition every panel reads. Three spellings of one absence read as three
 * different absences, so no panel writes its own.
 */

/**
 * What a cell says where there is no count to state.
 *
 * Words rather than a mark, because every mark short enough for a cell carries
 * a second reading in a right-aligned column of figures: a hyphen is a minus
 * sign, a period a truncated decimal, parentheses a negative, a comma a
 * thousands separator. Not "No count", which reads as a count that came to
 * none: a nought is a figure these columns can state, and it is the other
 * claim, that something was counted and nothing was there.
 */
export const NO_COUNT = 'No data';

/**
 * What a cell says where there is no rate to state.
 *
 * A separate wording from {@link NO_COUNT} because it is a separate absence: a
 * share has nothing to be taken against, where a count is simply not held, and
 * a cell saying the count is missing would be a false account of why the share
 * is. It stays clear of `0.0%`, which is a rate these columns can state and
 * does not mean the same thing.
 */
export const NO_RATE = 'No rate';
