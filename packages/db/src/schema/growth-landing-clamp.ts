import { sql } from 'drizzle-orm';
import { growthPaths } from './growth-paths';
import type { SQL } from 'drizzle-orm';

/** The row a clamp addresses, and the visitor count its writer is about to assign. */
interface LandingClampTarget {
  readonly grain: (typeof growthPaths.$inferSelect)['grain'];
  readonly bucket: Date;
  readonly path: string;
  readonly visitors: number;
}

/**
 * Whether the addressed path row's stored landing count stands above the
 * visitor count a rollup is about to assign to it — the one condition under
 * which that count has to be lowered, because the row's own check refuses
 * anything else.
 *
 * Here rather than at the writer because it is a query fragment and a slice's
 * domain layer may compose none. It emits this comparison over these four
 * columns whatever it is handed, so a caller gains this one predicate and no
 * way to build another — the test the package root barrel's docblock states a
 * query-fragment helper is judged on, and the shape `anyOverflow` beside it
 * already takes. The WRITE stays with the table's owning slice, which is what
 * single-writer-per-table means.
 *
 * It addresses the row by its whole unique tuple, so the `UPDATE` carrying it
 * takes that row's lock and nothing else; a writer holding it cannot be raced
 * by the rollup of another hour of the same day, which assigns the same day
 * row.
 */
export function landingsAboveVisitors(target: LandingClampTarget): SQL<boolean> {
  return sql<boolean>`${growthPaths.grain} = ${target.grain}::growth_grain
    and ${growthPaths.bucket} = ${target.bucket}::timestamptz
    and ${growthPaths.path} = ${target.path}
    and ${growthPaths.landings} > ${target.visitors}`;
}
