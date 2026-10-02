import { sql } from 'drizzle-orm';
import type { SQL, SQLWrapper } from 'drizzle-orm';

/**
 * Whether any row being aggregated had its count cut off by a set ceiling, so
 * the aggregate built from them is a floor rather than a total.
 *
 * One rule wherever a ceiling flag is reduced, in a view or in a read: a second
 * spelling of how a floor combines is how the same figure comes to be marked on
 * one surface and printed as a total on another.
 *
 * A contributing row's flag counts even where the aggregate did not keep that
 * row's value. A bucket that keeps its largest row is still a floor if a row it
 * beat was cut off, because the cut-off row's true value is unknown and may be
 * the larger of the two.
 *
 * In the schema tree beside the tables whose column it reduces, but out of
 * `./index` deliberately: the architecture rules derive the table and view sets
 * from that barrel's named exports, where a name is taken for a table unless
 * its suffix marks it an enum, a relations object or a view. The package root
 * barrel publishes this one instead.
 */
export function anyOverflow(flag: SQLWrapper): SQL<boolean> {
  return sql<boolean>`bool_or(${flag})`;
}
