import { describe, it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAY_MS, HOUR_MS, MINUTE_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  JOURNAL_PATH,
  normalizeJournalFile,
  normalizeMigrationJournal,
} from './normalize-migration-journal.js';
import { withScratchDirectory } from './lib/scratch-directory.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface FixtureEntry {
  readonly idx: number;
  readonly when: number;
  readonly tag?: string;
}

/** Mirrors drizzle-kit's own writer: the same key order, two-space indent, no final newline. */
function journalSource(entries: readonly FixtureEntry[]): string {
  return JSON.stringify(
    {
      version: '7',
      dialect: 'postgresql',
      entries: entries.map((entry) => ({
        idx: entry.idx,
        version: '7',
        when: entry.when,
        tag: entry.tag ?? `${String(entry.idx).padStart(4, '0')}_fixture`,
        breakpoints: true,
      })),
    },
    null,
    2
  );
}

function whenValues(source: string): number[] {
  const journal = JSON.parse(source) as { entries: { when: number }[] };
  return journal.entries.map((entry) => entry.when);
}

async function committedJournal(): Promise<string> {
  return readFile(path.join(REPO_ROOT, JOURNAL_PATH), 'utf8');
}

describe('normalizeMigrationJournal', () => {
  it('rewrites an appended entry to its own UTC day start plus its index', () => {
    const source = journalSource([{ idx: 3, when: TEST_DAY_START + 13 * HOUR_MS + 7 * MINUTE_MS }]);

    expect(whenValues(normalizeMigrationJournal(source))).toEqual([TEST_DAY_START + 3]);
  });

  it('keys each entry to its own day rather than to any other day in the journal', () => {
    const source = journalSource([
      { idx: 0, when: TEST_DAY_START + 9 * HOUR_MS },
      { idx: 1, when: TEST_DAY_START + 2 * DAY_MS + 4 * HOUR_MS },
    ]);

    expect(whenValues(normalizeMigrationJournal(source))).toEqual([
      TEST_DAY_START,
      TEST_DAY_START + 2 * DAY_MS + 1,
    ]);
  });

  it('keeps two migrations sharing one UTC day at distinct, increasing values', () => {
    const source = journalSource([
      { idx: 0, when: TEST_DAY_START + 3 * HOUR_MS },
      { idx: 1, when: TEST_DAY_START + 20 * HOUR_MS },
    ]);

    const [first, second] = whenValues(normalizeMigrationJournal(source));

    expect(first).toBe(TEST_DAY_START);
    expect(second).toBe(TEST_DAY_START + 1);
  });

  it('leaves an already-normalized journal byte-identical', () => {
    const once = normalizeMigrationJournal(
      journalSource([
        { idx: 0, when: TEST_DAY_START + 3 * HOUR_MS },
        { idx: 1, when: TEST_DAY_START + 20 * HOUR_MS },
      ])
    );

    expect(normalizeMigrationJournal(once)).toBe(once);
  });

  it('carries every field it does not rewrite through untouched, in its original order', () => {
    const source = journalSource([{ idx: 0, when: TEST_DAY_START + 5 * HOUR_MS, tag: '0000_a' }]);

    const normalized = JSON.parse(normalizeMigrationJournal(source)) as {
      entries: Record<string, unknown>[];
    };

    expect(Object.keys(normalized.entries[0] ?? {})).toEqual([
      'idx',
      'version',
      'when',
      'tag',
      'breakpoints',
    ]);
    expect(normalized.entries[0]).toMatchObject({
      idx: 0,
      version: '7',
      tag: '0000_a',
      breakpoints: true,
    });
  });

  it('preserves a field the scheme knows nothing about', () => {
    const source = JSON.stringify(
      {
        version: '7',
        dialect: 'postgresql',
        somethingLater: 'kept',
        entries: [{ idx: 0, when: TEST_DAY_START + HOUR_MS, tag: '0000_a', unknownField: 'kept' }],
      },
      null,
      2
    );

    const normalized = JSON.parse(normalizeMigrationJournal(source)) as Record<string, unknown>;

    expect(normalized).toMatchObject({
      somethingLater: 'kept',
      entries: [{ unknownField: 'kept', when: TEST_DAY_START }],
    });
  });

  it('refuses a journal whose entries would stop strictly increasing', () => {
    const source = journalSource([
      { idx: 0, when: TEST_DAY_START + DAY_MS },
      { idx: 1, when: TEST_DAY_START },
    ]);

    expect(() => normalizeMigrationJournal(source)).toThrow(/strictly increasing/);
  });

  it('refuses an index that has outgrown the day-boundary carve-out', () => {
    const source = journalSource([{ idx: 1000, when: TEST_DAY_START + HOUR_MS }]);

    expect(() => normalizeMigrationJournal(source)).toThrow(/day boundary/);
  });

  it('admits the widest index the carve-out still covers', () => {
    const source = journalSource([{ idx: 999, when: TEST_DAY_START + HOUR_MS }]);

    expect(whenValues(normalizeMigrationJournal(source))).toEqual([TEST_DAY_START + 999]);
  });

  it('refuses a source that is not JSON', () => {
    expect(() => normalizeMigrationJournal('{')).toThrow(/not valid JSON/);
  });

  it('refuses a journal whose entries are missing', () => {
    expect(() => normalizeMigrationJournal(JSON.stringify({ version: '7' }))).toThrow(/malformed/);
  });

  it('refuses an entry whose when is not a whole number of milliseconds', () => {
    const source = JSON.stringify({ entries: [{ idx: 0, when: 'yesterday' }] });

    expect(() => normalizeMigrationJournal(source)).toThrow(/malformed/);
  });
});

describe('the committed journal', () => {
  it('is a fixed point of the normalizer, byte for byte', async () => {
    const source = await committedJournal();

    expect(normalizeMigrationJournal(source)).toBe(source);
  });

  it('carries the serialization drizzle-kit writes: two-space indent, no closing newline', async () => {
    const source = await committedJournal();

    expect(source).toBe(JSON.stringify(JSON.parse(source), null, 2));
    expect(source.endsWith('\n')).toBe(false);
  });
});

describe('normalizeJournalFile', () => {
  it('rewrites a journal that carries clock resolution and reports the change', () =>
    withScratchDirectory('hb-journal-', async (directory) => {
      const file = path.join(directory, '_journal.json');
      await writeFile(file, journalSource([{ idx: 0, when: TEST_DAY_START + 6 * HOUR_MS }]));

      expect(normalizeJournalFile(file)).toBe(true);
      expect(whenValues(await readFile(file, 'utf8'))).toEqual([TEST_DAY_START]);
    }));

  it('leaves an already-normalized journal untouched and reports no change', () =>
    withScratchDirectory('hb-journal-', async (directory) => {
      const file = path.join(directory, '_journal.json');
      const normalized = normalizeMigrationJournal(
        journalSource([{ idx: 0, when: TEST_DAY_START + 6 * HOUR_MS }])
      );
      await writeFile(file, normalized);

      expect(normalizeJournalFile(file)).toBe(false);
      expect(await readFile(file, 'utf8')).toBe(normalized);
    }));
});
