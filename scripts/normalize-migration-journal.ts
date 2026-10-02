/**
 * Pins every drizzle migration journal entry's `when` to its own UTC day start
 * plus its index. Chained to the `packages/db` `db:generate` script, so a
 * freshly appended entry is normalized before the generator that wrote it
 * returns. It resolves the repository root from its own location and reads no
 * environment, so the working directory it is called from does not matter.
 *
 * `when` is the migrator's only already-applied watermark: it reads the highest
 * `created_at` from `drizzle.__drizzle_migrations` once and applies a migration
 * only while `watermark < when`. That comparison is strict, so collapsing a day's
 * entries onto one value (plain midnight) would make every migration after the
 * first on any shared day unreachable, permanently and silently. The `+ idx`
 * term is what keeps the sequence strictly increasing: within a day the index
 * separates entries, and across days the day term dominates because an index can
 * never reach a day's worth of milliseconds.
 *
 * The rewrite is applied to the whole journal rather than to the newest entry
 * alone. It is idempotent, so a normalized entry passes through unchanged, and a
 * journal that skipped the hook heals on the next commit.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { MS_PER_DAY, isDayBoundaryMillis } from './lib/privacy/instants.js';
import { runMain } from './lib/cli/run-main.js';

/** Repo-relative, so the same string names the file for both the read and the log line. */
export const JOURNAL_PATH = path.join('packages', 'db', 'drizzle', 'meta', '_journal.json');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Only the two fields this rewrite reads are described. Unknown keys are left
 * alone rather than rejected: drizzle-kit owns this file's shape and may extend
 * it, and a field nobody here interprets cannot make the rewrite wrong.
 */
const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number().int().min(0), when: z.number().int().min(0) })),
});

interface JournalEntry {
  idx: number;
  when: number;
}

interface Journal {
  entries: JournalEntry[];
}

/**
 * Returns the object `JSON.parse` produced rather than the schema's output. The
 * parsed object still holds every key in the order drizzle-kit wrote it, and
 * re-serializing that is what keeps a schema commit from diff-thrashing the
 * whole file.
 */
function parseJournal(source: string): Journal {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    // The parser quotes the offending bytes, which on this file are timestamps.
    throw new Error(`${JOURNAL_PATH} is not valid JSON.`);
  }
  const parsed = journalSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${JOURNAL_PATH} is malformed: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`
    );
  }
  return json as Journal;
}

function utcDayStart(millis: number): number {
  return Math.floor(millis / MS_PER_DAY) * MS_PER_DAY;
}

/**
 * The two properties the scheme exists to provide, asserted on the result rather
 * than assumed from the input. Both failures are silent in production if they
 * ship — a skipped migration, or a journal the privacy gate starts reporting —
 * so neither may pass.
 */
function assertScheme(entries: readonly JournalEntry[]): void {
  let previous = -1;
  for (const entry of entries) {
    if (!isDayBoundaryMillis(entry.when)) {
      throw new Error(
        `${JOURNAL_PATH} entry ${String(entry.idx)} no longer resolves to a day boundary: ` +
          `the journal has more migrations than one day's carve-out admits.`
      );
    }
    if (entry.when <= previous) {
      throw new Error(
        `${JOURNAL_PATH} entry ${String(entry.idx)} is not strictly increasing over the one ` +
          `before it, so the migrator would skip it. Entries must be in index order.`
      );
    }
    previous = entry.when;
  }
}

export function normalizeMigrationJournal(source: string): string {
  const journal = parseJournal(source);
  for (const entry of journal.entries) {
    entry.when = utcDayStart(entry.when) + entry.idx;
  }
  assertScheme(journal.entries);
  return JSON.stringify(journal, null, 2);
}

/** Returns whether the file needed rewriting, so that a no-op prints nothing. */
export function normalizeJournalFile(journalPath: string): boolean {
  const source = readFileSync(journalPath, 'utf8');
  const normalized = normalizeMigrationJournal(source);
  if (normalized === source) return false;
  writeFileSync(journalPath, normalized);
  return true;
}

export const COMMAND_LINE = {
  command: 'tsx scripts/normalize-migration-journal.ts',
  summary: "Pins every migration journal entry's timestamp to its own day.",
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point */
if (isMainModule(import.meta.url)) {
  void runMain(() => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    if (normalizeJournalFile(path.join(REPO_ROOT, JOURNAL_PATH))) {
      console.log(`normalized ${JOURNAL_PATH} to day resolution`);
    }
    return 0;
  });
}
/* v8 ignore stop */
