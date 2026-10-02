import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DAY_MS } from '@hushbox/shared/test-time';

/**
 * The journal's `when` is the migrator's only already-applied watermark: it takes
 * the highest `created_at` in `drizzle.__drizzle_migrations` and applies a
 * migration only while `watermark < when`. Every entry therefore has to outrank
 * the one before it, and it is pinned here because no other gate can see it —
 * the CI migration-drift check re-runs `db:generate`, which appends and never
 * rewrites, so a hand-edited `when` produces no drift at all.
 */
const journal = JSON.parse(
  readFileSync(fileURLToPath(new URL('../drizzle/meta/_journal.json', import.meta.url)), 'utf8')
) as { entries: { idx: number; when: number; tag: string }[] };

const NORMALIZER = 'normalize-migration-journal.ts';

const generateScript =
  (
    JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    ) as { scripts: Record<string, string> }
  ).scripts['db:generate'] ?? '';

/** Derived from the calendar fields rather than by dividing, so it is an independent reading. */
function utcDayStart(millis: number): number {
  const instant = new Date(millis);
  return Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
}

describe('the migration journal', () => {
  it('has entries', () => {
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it('indexes its entries contiguously from zero', () => {
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_entry, position) => position)
    );
  });

  it('pins every entry to its own UTC day start plus its index', () => {
    const offBySomethingElse = journal.entries.filter(
      (entry) => entry.when !== utcDayStart(entry.when) + entry.idx
    );

    expect(offBySomethingElse.map((entry) => entry.tag)).toEqual([]);
  });

  it('increases strictly across every entry, including the days carrying several', () => {
    const notAscending = journal.entries.filter(
      (entry, position) => position > 0 && entry.when <= (journal.entries[position - 1]?.when ?? 0)
    );

    expect(notAscending.map((entry) => entry.tag)).toEqual([]);
  });

  it('covers days that carry more than one migration, so the scheme is load-bearing here', () => {
    const perDay = new Map<number, number>();
    for (const entry of journal.entries) {
      perDay.set(utcDayStart(entry.when), (perDay.get(utcDayStart(entry.when)) ?? 0) + 1);
    }

    expect([...perDay.values()].filter((count) => count > 1).length).toBeGreaterThan(0);
  });

  it('lifts a migration appended on any later day above every value the last entry could have carried before the retro-fit', () => {
    const last = journal.entries.at(-1);
    const lastDayStart = utcDayStart(last?.when ?? 0);
    // Before the retro-fit the last entry held drizzle-kit's `+new Date()` taken
    // on that day, so a database migrated through it carries a watermark
    // somewhere in [dayStart, dayStart + one day). The next entry lands on a
    // later day, and the day term alone already clears that whole interval.
    const highestWatermarkItCouldHold = lastDayStart + DAY_MS - 1;
    const nextEntry = lastDayStart + DAY_MS + ((last?.idx ?? 0) + 1);

    expect(nextEntry).toBeGreaterThan(highestWatermarkItCouldHold);
  });
});

/**
 * The normalizer is chained to this script because it is the innermost point
 * every path that generates a migration reaches — the root alias, the pre-commit
 * hook and a run from inside this package all land here — so no invocation can
 * leave the millisecond stamp the generator writes.
 *
 * Losing it off the end of the script is otherwise silent: the generator still
 * succeeds, the migration still ships, and the stamp is only caught later by a
 * gate. The `&&` is load-bearing too — a failed generation must not have the
 * normalizer run over whatever it left behind. These two tests are the whole of
 * what stops the chain being simplified away.
 */
describe('the db:generate script', () => {
  const stages = generateScript.split('&&').map((stage) => stage.trim());

  it('runs the journal normalizer after the migration generator', () => {
    expect(stages).toEqual([
      expect.stringContaining('drizzle-kit'),
      expect.stringContaining(NORMALIZER),
    ]);
  });

  it('names a normalizer that exists where the script points', () => {
    const named = generateScript.split(/\s+/).find((token) => token.endsWith(NORMALIZER)) ?? '';
    const resolved = named === '' ? '' : fileURLToPath(new URL(`../${named}`, import.meta.url));

    expect(existsSync(resolved) && statSync(resolved).isFile()).toBe(true);
  });
});
