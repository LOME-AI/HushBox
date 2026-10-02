import { sql } from 'drizzle-orm';
import { jobs } from '@hushbox/db';
import type { SQL, SQLWrapper } from 'drizzle-orm';

type RecordedError = (typeof jobs.$inferSelect)['errors'][number];

/**
 * The JSON keys of one entry in a job's error history, stated once for the
 * writers that build an entry and the probes that read one. The `satisfies`
 * checks them against the column's own declared shape, so a rename there is a
 * compile error here rather than silent drift.
 */
export const RECORDED_ERROR_KEYS = {
  at: 'at',
  claim: 'claim',
  error: 'error',
} as const satisfies { [K in keyof RecordedError]: K };

/**
 * Appends one recorded failure to a row's error history. The ::int/::text
 * casts are load-bearing: jsonb_build_object takes "any" arguments, so
 * Postgres cannot infer bind-parameter types without them.
 */
export function appendRecordedError(claim: number | SQLWrapper, error: string): SQL {
  return sql`${jobs.errors} || jsonb_build_array(jsonb_build_object(${RECORDED_ERROR_KEYS.at}::text, now()::text, ${RECORDED_ERROR_KEYS.claim}::text, ${claim}::int, ${RECORDED_ERROR_KEYS.error}::text, ${error}::text))`;
}
