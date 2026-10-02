import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_RETAINED_WALLS,
  MAX_ROWS_PER_RUNG,
  MAX_RUNS_PER_SHAPE,
  ledgerPath,
  readLedger,
  writeLedger,
  type LedgerEntry,
  type PoolLedger,
} from './ledger.js';
import { deriveConcurrency, scheduleOrder } from './schedule.js';
import { StagedWriteFailed } from '../staged-write.js';
import type { RunObservation } from './schedule.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'hb-pool-ledger-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function run(concurrency: number, makespanMs = 300_000): RunObservation {
  return { concurrency, taskCount: 18, sumWallMs: 1_274_000, longestWallMs: 299_000, makespanMs };
}

/** A store path, under which every run of one task writes its own file. */
function storeAt(task = 'lint'): string {
  return path.join(workDir, task);
}

/** One run's file, planted directly, so a read can be asked about raw content. */
function plantRun(store: string, ordinal: number, body: unknown): string {
  mkdirSync(store, { recursive: true });
  const name = `${String(ordinal).padStart(6, '0')}-${randomUUID()}.json`;
  writeFileSync(path.join(store, name), JSON.stringify(body));
  return name;
}

/** A row filed at a width, under a shape — the pair retention keys on. */
function rowAt(lanesAtPeak: number, shape: string, makespanMs = 300_000): RunObservation {
  return { ...run(lanesAtPeak, makespanMs), lanesAtPeak, shape };
}

/** A row filed at a width by a recorder that stamped no shape. */
function unstampedRowAt(lanesAtPeak: number, makespanMs = 300_000): RunObservation {
  return { ...run(lanesAtPeak, makespanMs), lanesAtPeak };
}

/** One run's file in the superseded package-rooted store beside the given one. */
function plantPackageRun(store: string, ordinal: number, body: unknown): void {
  plantRun(`${store}-pkg`, ordinal, body);
}

/** What the superseded whole-file layout wrote, at the store's own path. */
function plantSupersededFile(store: string, body: unknown): void {
  mkdirSync(path.dirname(store), { recursive: true });
  writeFileSync(`${store}.json`, JSON.stringify(body));
}

function runFiles(store: string): string[] {
  return readdirSync(store).filter((name) => name.endsWith('.json'));
}

/** A write taken on a tree that still holds the named units and no others. */
function inTree(...units: readonly string[]): (unit: string) => boolean {
  return (unit: string) => units.includes(unit);
}

/**
 * A write taken on a tree nothing has left. It is what the tests whose subject
 * is not retention are set in — a run round-tripping its figures, a staging
 * name, a warning — and stating a departure none of them models would decide
 * their outcome on a thing they never assert about.
 */
function nothingHasLeftTheTree(): boolean {
  return true;
}

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  return error;
}

function failWith(code: string): (from: string, to: string) => void {
  return () => {
    throw errno(code);
  };
}

describe('ledgerPath', () => {
  it('lives outside node_modules so an install cannot destroy it', () => {
    const file = ledgerPath('/repo', 'abc123', 'lint');
    expect(file.split(path.sep)).not.toContain('node_modules');
  });

  it('separates machines by fingerprint so one checkout can serve two at once', () => {
    expect(ledgerPath('/repo', 'aaa', 'lint')).not.toBe(ledgerPath('/repo', 'bbb', 'lint'));
  });

  it('separates tasks within a machine', () => {
    expect(ledgerPath('/repo', 'aaa', 'lint')).not.toBe(ledgerPath('/repo', 'aaa', 'typecheck'));
  });
});

describe('readLedger', () => {
  it('is empty for a store that does not exist', () => {
    expect(readLedger(storeAt('absent'))).toEqual({ tasks: {}, runs: [] });
  });

  it('is empty for unparseable content rather than throwing', () => {
    const store = storeAt();
    mkdirSync(store, { recursive: true });
    writeFileSync(path.join(store, `000001-${randomUUID()}.json`), '{not json');
    expect(readLedger(store)).toEqual({ tasks: {}, runs: [] });
  });

  it('is empty for a run written in the superseded per-task-RSS shape', () => {
    // The old format recorded walls at an unrecorded concurrency, which is
    // exactly the data that cannot be interpreted; it is dropped, not migrated.
    const store = storeAt();
    plantRun(store, 1, { '@hushbox/api': { wallMs: 307_000, peakRssKb: 3_800_000 } });
    expect(readLedger(store)).toEqual({ tasks: {}, runs: [] });
  });

  it('drops runs recorded before the peak accounting was stamped, keeping the walls', () => {
    // Those peaks are per-process resident sums, inflated by however much the
    // workers shared. The walls beside them are unaffected, so they survive.
    const store = storeAt();
    plantRun(store, 1, { tasks: { '@hushbox/api': { wallsMs: [299_000] } }, runs: [run(5)] });
    expect(readLedger(store)).toEqual({
      tasks: { '@hushbox/api': { wallsMs: [299_000] } },
      runs: [],
    });
  });

  it('drops runs stamped with an accounting this build does not measure', () => {
    const store = storeAt();
    plantRun(store, 1, { peakAccounting: 'rss-sum', tasks: {}, runs: [run(5)] });
    expect(readLedger(store).runs).toEqual([]);
  });

  it('round-trips tasks and runs', () => {
    const store = storeAt();
    const ledger: PoolLedger = {
      tasks: { '@hushbox/api': { wallsMs: [299_000] } },
      runs: [run(5)],
    };
    writeLedger(store, ledger, inTree('@hushbox/api'));
    // The width comes back on the row: a run that recorded none is read at the
    // lanes it could have filled, which is what the ladder files it by.
    expect(readLedger(store)).toEqual({ ...ledger, runs: [{ ...run(5), lanesAtPeak: 5 }] });
  });

  it('drops a task entry whose walls are missing or nonsense', () => {
    const store = storeAt();
    plantRun(store, 1, {
      tasks: {
        good: { wallsMs: [10, 12] },
        negative: { wallsMs: [10, -1] },
        text: { wallsMs: 'x' },
        empty: { wallsMs: [] },
        nul: null,
      },
      runs: [],
    });
    expect(Object.keys(readLedger(store).tasks)).toEqual(['good']);
  });

  it('names no task in a run whose entries carry one wall rather than a history', () => {
    // The shape change is taken without a migration: a run recorded before it
    // names nothing, and the next run measures its own walls from cold.
    const store = storeAt();
    plantRun(store, 1, {
      peakAccounting: 'pss',
      tasks: { '@hushbox/api': { wallMs: 299_000, peakRssKb: 3_800_000 } },
      runs: [],
    });
    expect(readLedger(store).tasks).toEqual({});
  });

  it('drops a run observation that is not fully numeric', () => {
    const store = storeAt();
    plantRun(store, 1, {
      peakAccounting: 'pss',
      tasks: {},
      runs: [
        { concurrency: 5, taskCount: 3, sumWallMs: 1, longestWallMs: 1, makespanMs: 1 },
        { concurrency: 0, taskCount: 3, sumWallMs: 1, longestWallMs: 1, makespanMs: 1 },
        { concurrency: 5, sumWallMs: 1, longestWallMs: 1, makespanMs: 1 },
      ],
    });
    expect(readLedger(store).runs).toHaveLength(1);
  });

  it('drops a run observation whose walls are not durations', () => {
    const store = storeAt();
    plantRun(store, 1, {
      peakAccounting: 'pss',
      tasks: {},
      runs: [
        { concurrency: 5, taskCount: 3, sumWallMs: 'x', longestWallMs: 1, makespanMs: 1 },
        { concurrency: 5, taskCount: 3, sumWallMs: 1, longestWallMs: -1, makespanMs: 1 },
        { concurrency: 5, taskCount: 3, sumWallMs: 1, longestWallMs: 1, makespanMs: Number.NaN },
      ],
    });
    expect(readLedger(store).runs).toEqual([]);
  });

  it("folds each run's walls onto the runs before it, oldest first", () => {
    const store = storeAt();
    plantRun(store, 1, { peakAccounting: 'pss', tasks: { a: { wallsMs: [10] } }, runs: [] });
    plantRun(store, 2, { peakAccounting: 'pss', tasks: { a: { wallsMs: [20] } }, runs: [] });
    expect(readLedger(store).tasks['a']?.wallsMs).toEqual([10, 20]);
  });

  it('orders runs by the ordinal in their names, not by the order they are listed', () => {
    const store = storeAt();
    plantRun(store, 2, { peakAccounting: 'pss', tasks: {}, runs: [run(5, 222_000)] });
    plantRun(store, 1, { peakAccounting: 'pss', tasks: {}, runs: [run(5, 111_000)] });
    expect(readLedger(store).runs.map((row) => row.makespanMs)).toEqual([111_000, 222_000]);
  });

  it('orders two runs that chose the same ordinal by name, so a fold is repeatable', () => {
    // What two runs that both read the store before either landed produce: the
    // ordinal cannot separate them, and the random half of the name can.
    const store = storeAt();
    mkdirSync(store, { recursive: true });
    writeFileSync(
      path.join(store, '000001-aaaaaaaa-0000-4000-8000-000000000000.json'),
      JSON.stringify({ peakAccounting: 'pss', tasks: { a: { wallsMs: [10] } }, runs: [] })
    );
    writeFileSync(
      path.join(store, '000001-bbbbbbbb-0000-4000-8000-000000000000.json'),
      JSON.stringify({ peakAccounting: 'pss', tasks: { a: { wallsMs: [20] } }, runs: [] })
    );
    expect(readLedger(store).tasks['a']?.wallsMs).toEqual([10, 20]);
  });

  it('folds the file the superseded whole-file layout left as the oldest run', () => {
    const store = storeAt();
    plantSupersededFile(store, {
      peakAccounting: 'pss',
      tasks: { a: { wallsMs: [10] } },
      runs: [run(5, 111_000)],
    });
    plantRun(store, 1, {
      peakAccounting: 'pss',
      tasks: { a: { wallsMs: [20] } },
      runs: [run(5, 222_000)],
    });
    const ledger = readLedger(store);
    expect(ledger.tasks['a']?.wallsMs).toEqual([10, 20]);
    expect(ledger.runs.map((row) => row.makespanMs)).toEqual([111_000, 222_000]);
  });

  it('reads a store the superseded layout alone wrote', () => {
    const store = storeAt();
    plantSupersededFile(store, {
      peakAccounting: 'pss',
      tasks: { a: { wallsMs: [10] } },
      runs: [run(5)],
    });
    expect(readLedger(store)).toEqual({
      tasks: { a: { wallsMs: [10] } },
      runs: [{ ...run(5), lanesAtPeak: 5 }],
    });
  });

  it('caps what it folds, so a store nothing trimmed is still read', () => {
    // What a writer killed between landing its run and trimming leaves behind.
    const store = storeAt();
    const landed = MAX_RETAINED_WALLS + 5;
    for (let ordinal = 1; ordinal <= landed; ordinal += 1) {
      plantRun(store, ordinal, {
        peakAccounting: 'pss',
        tasks: { a: { wallsMs: [ordinal] } },
        runs: [run(5, 100_000 + ordinal)],
      });
    }
    const ledger = readLedger(store);
    expect(ledger.runs).toHaveLength(MAX_ROWS_PER_RUNG);
    expect(ledger.runs.at(-1)?.makespanMs).toBe(100_000 + landed);
    expect(ledger.tasks['a']?.wallsMs).toHaveLength(MAX_RETAINED_WALLS);
  });

  it('folds no staging file a killed writer left beside the runs', () => {
    const store = storeAt();
    plantRun(store, 1, { peakAccounting: 'pss', tasks: { a: { wallsMs: [10] } }, runs: [] });
    writeFileSync(
      path.join(store, `000002-${randomUUID()}.json.${String(process.pid)}-${randomUUID()}.tmp`),
      JSON.stringify({ peakAccounting: 'pss', tasks: { b: { wallsMs: [20] } }, runs: [] })
    );
    expect(Object.keys(readLedger(store).tasks)).toEqual(['a']);
  });
});

describe('two runs recording at once', () => {
  it('keeps the rows of both, whichever lands second', () => {
    const store = storeAt();
    const first = readLedger(store);
    const second = readLedger(store);
    writeLedger(
      store,
      { tasks: {}, runs: [...first.runs, run(4, 111_000)] },
      nothingHasLeftTheTree
    );
    writeLedger(
      store,
      { tasks: {}, runs: [...second.runs, run(6, 222_000)] },
      nothingHasLeftTheTree
    );
    expect(readLedger(store).runs.map((row) => row.makespanMs)).toEqual([111_000, 222_000]);
  });

  it('keeps the walls both measured for the same unit', () => {
    const store = storeAt();
    writeLedger(store, { tasks: { a: { wallsMs: [10] } }, runs: [run(5, 100_000)] }, inTree('a'));
    // Both read the one run on record, then both record their own.
    readLedger(store);
    readLedger(store);
    writeLedger(store, { tasks: { a: { wallsMs: [20] } }, runs: [run(5, 200_000)] }, inTree('a'));
    writeLedger(store, { tasks: { a: { wallsMs: [30] } }, runs: [run(5, 300_000)] }, inTree('a'));
    expect(readLedger(store).tasks['a']?.wallsMs).toEqual([10, 20, 30]);
  });
});

describe('retention', () => {
  it('removes the run files whose rows have aged out of their shape’s window', () => {
    const store = storeAt();
    for (let index = 0; index < MAX_RUNS_PER_SHAPE + 4; index += 1) {
      writeLedger(store, { tasks: { a: { wallsMs: [index] } }, runs: [run(5)] }, inTree('a'));
    }
    expect(runFiles(store)).toHaveLength(MAX_RUNS_PER_SHAPE);
  });

  it("keeps only the most recent of a unit's walls, oldest dropped first", () => {
    const store = storeAt();
    const landed = MAX_RETAINED_WALLS + 4;
    for (let index = 0; index < landed; index += 1) {
      writeLedger(store, { tasks: { a: { wallsMs: [1000 + index] } }, runs: [] }, inTree('a'));
    }
    const kept = readLedger(store).tasks['a']?.wallsMs;
    expect(kept).toHaveLength(MAX_RETAINED_WALLS);
    expect(kept?.at(-1)).toBe(1000 + landed - 1);
    expect(kept?.[0]).toBe(1000 + 4);
  });

  it('keeps the newest run carrying a unit no newer run carries', () => {
    // The hazard this answers: the pool records only the packages a run
    // executed, so a package that rarely misses the build cache would age out
    // of a newest-N window and read as never measured — which charges it the
    // dearest peak on record and opens fewer lanes than the machine can hold.
    const store = storeAt();
    writeLedger(
      store,
      {
        tasks: { rare: { wallsMs: [7000] } },
        runs: [run(5)],
      },
      inTree('rare', 'busy')
    );
    for (let index = 0; index < MAX_RETAINED_WALLS + 4; index += 1) {
      writeLedger(
        store,
        { tasks: { busy: { wallsMs: [index] } }, runs: [run(5)] },
        inTree('rare', 'busy')
      );
    }
    expect(readLedger(store).tasks['rare']).toEqual({ wallsMs: [7000] });
  });

  it('keeps at most three carriers per unit rather than every run that named it', () => {
    const store = storeAt();
    for (let index = 0; index < 5; index += 1) {
      writeLedger(
        store,
        { tasks: { rare: { wallsMs: [7000 + index] } }, runs: [] },
        inTree('rare', 'busy')
      );
    }
    for (let index = 0; index < MAX_RETAINED_WALLS + 4; index += 1) {
      writeLedger(
        store,
        { tasks: { busy: { wallsMs: [index] } }, runs: [] },
        inTree('rare', 'busy')
      );
    }
    expect(runFiles(store)).toHaveLength(MAX_RETAINED_WALLS + 3);
    expect(readLedger(store).tasks['rare']?.wallsMs).toEqual([7002, 7003, 7004]);
  });

  it('carries enough of a unit older than the window for its median to have three readings', () => {
    // A unit whose every execution predates the newest-runs window would
    // otherwise stand on one wall, and a median over a single reading is the
    // one pathological run — a killed child, a swap storm, a machine busy with
    // something else — that the median exists to keep from deciding alone.
    const store = storeAt();
    const tree = inTree('rare', 'busy');
    for (const wall of [7000, 9000, 60_000]) {
      writeLedger(store, { tasks: { rare: { wallsMs: [wall] } }, runs: [] }, tree);
    }
    for (let index = 0; index < MAX_RETAINED_WALLS + 4; index += 1) {
      writeLedger(store, { tasks: { busy: { wallsMs: [index] } }, runs: [] }, tree);
    }
    const wallsMs = readLedger(store).tasks['rare']?.wallsMs;
    expect(wallsMs).toEqual([7000, 9000, 60_000]);
    // Those three median to 9000, which is under the reference task's wall; the
    // newest reading alone would put `rare` at 60000 and order it first.
    expect(
      scheduleOrder([
        { name: 'rare', wallsMs },
        { name: 'reference', wallsMs: [20_000] },
      ])
    ).toEqual(['reference', 'rare']);
  });

  it('drops the carrier of a unit the tree no longer holds', () => {
    const store = storeAt();
    writeLedger(store, { tasks: { removed: { wallsMs: [7000] } }, runs: [] }, inTree('busy'));
    for (let index = 0; index < MAX_RETAINED_WALLS + 4; index += 1) {
      writeLedger(store, { tasks: { busy: { wallsMs: [index] } }, runs: [] }, inTree('busy'));
    }
    expect(readLedger(store).tasks['removed']).toBeUndefined();
    expect(runFiles(store)).toHaveLength(MAX_RETAINED_WALLS);
  });

  it('keeps the carrier of a unit the tree still holds', () => {
    const store = storeAt();
    const tree = inTree('rare', 'busy');
    writeLedger(store, { tasks: { rare: { wallsMs: [7000] } }, runs: [] }, tree);
    for (let index = 0; index < MAX_RETAINED_WALLS + 4; index += 1) {
      writeLedger(store, { tasks: { busy: { wallsMs: [index] } }, runs: [] }, tree);
    }
    expect(readLedger(store).tasks['rare']).toEqual({ wallsMs: [7000] });
    expect(runFiles(store)).toHaveLength(MAX_RETAINED_WALLS + 1);
  });

  it('leaves a staging file a killed writer left behind', () => {
    const store = storeAt();
    writeLedger(store, { tasks: { a: { wallsMs: [1] } }, runs: [] }, inTree('a'));
    const staging = path.join(
      store,
      `000001-${randomUUID()}.json.${String(process.pid)}-${randomUUID()}.tmp`
    );
    writeFileSync(staging, '{}');
    for (let index = 0; index < MAX_RETAINED_WALLS + 4; index += 1) {
      writeLedger(store, { tasks: { a: { wallsMs: [index] } }, runs: [] }, inTree('a'));
    }
    expect(readdirSync(store)).toContain(path.basename(staging));
  });
});

describe('writeLedger', () => {
  it('takes the liveness predicate in a position of its own, ahead of the dependencies', () => {
    // `Function.length` counts the parameters ahead of the first defaulted one,
    // so three is the predicate standing in its own required position with the
    // optional dependency bag behind it. A predicate carried as a key inside
    // that bag would leave this at two and point a caller who forgot it at a
    // container rather than at the thing it forgot.
    expect(writeLedger).toHaveLength(3);
  });

  it('refuses a write that states no liveness question', () => {
    // The assertion here is the compiler's, not the runner's: `tsc` rejects an
    // unused `@ts-expect-error`, so a two-argument call becoming legal reddens
    // the typecheck rather than passing silently — which is the only way a
    // store that keeps every carrier can be refused before it exists, since no
    // run of this file could notice a caller nobody has written yet.
    // @ts-expect-error the predicate has no default, so two arguments are not a call
    const withoutPredicate: Parameters<typeof writeLedger> = [storeAt(), { tasks: {}, runs: [] }];
    expect(withoutPredicate).toHaveLength(2);
  });

  it('creates the directory tree it needs', () => {
    const store = path.join(workDir, 'nested', 'deeper', 'lint');
    writeLedger(store, { tasks: {}, runs: [] }, nothingHasLeftTheTree);
    expect(readLedger(store)).toEqual({ tasks: {}, runs: [] });
  });

  it('sorts task keys so a rewrite produces a stable diff', () => {
    const store = storeAt();
    writeLedger(
      store,
      { tasks: { b: { wallsMs: [1] }, a: { wallsMs: [2] } }, runs: [] },
      inTree('a', 'b')
    );
    const [landed] = runFiles(store);
    /* v8 ignore next -- a write that reported no loss always lands a file */
    const raw = readFileSync(path.join(store, landed ?? ''), 'utf8');
    expect(raw.indexOf('"a"')).toBeLessThan(raw.indexOf('"b"'));
  });

  it('writes one file per run rather than replacing what is there', () => {
    const store = storeAt();
    mkdirSync(store, { recursive: true });
    writeLedger(store, { tasks: { a: { wallsMs: [1] } }, runs: [] }, inTree('a', 'b'));
    writeLedger(store, { tasks: { b: { wallsMs: [2] } }, runs: [] }, inTree('a', 'b'));
    expect(Object.keys(readLedger(store).tasks)).toEqual(['a', 'b']);
  });

  it('stages every write at a name no other writer can also choose', () => {
    const store = storeAt();
    const staged: string[] = [];
    const capture = (from: string): void => {
      staged.push(from);
    };
    writeLedger(store, { tasks: {}, runs: [] }, nothingHasLeftTheTree, { rename: capture });
    writeLedger(store, { tasks: {}, runs: [] }, nothingHasLeftTheTree, { rename: capture });
    expect(staged[0]).not.toBe(staged[1]);
  });

  it('does not throw when the write-back cannot complete', () => {
    const store = storeAt();
    expect(() => {
      writeLedger(store, { tasks: {}, runs: [] }, nothingHasLeftTheTree, {
        rename: failWith('ENOENT'),
        warn: () => undefined,
      });
    }).not.toThrow();
  });

  it('names the writer that lost and the reason when a write-back fails', () => {
    const store = storeAt();
    const warnings: string[] = [];
    let staged = '';
    writeLedger(store, { tasks: {}, runs: [] }, nothingHasLeftTheTree, {
      rename: (from) => {
        staged = from;
        throw errno('ENOENT');
      },
      warn: (message) => {
        warnings.push(message);
      },
    });
    expect(warnings[0]).toContain(writerIdOf(staged));
    expect(warnings[0]).toContain('ENOENT');
  });

  it('reports rather than throws when the store directory cannot be created', () => {
    const blocker = path.join(workDir, 'blocker');
    writeFileSync(blocker, 'a file where the store directory would go');
    const warnings: string[] = [];
    writeLedger(path.join(blocker, 'lint'), { tasks: {}, runs: [] }, nothingHasLeftTheTree, {
      warn: (message) => {
        warnings.push(message);
      },
    });
    expect(warnings).toHaveLength(1);
  });

  it('says the reason is unknown when the failure carries no error code', () => {
    const store = storeAt();
    const warnings: string[] = [];
    writeLedger(store, { tasks: {}, runs: [] }, nothingHasLeftTheTree, {
      rename: () => {
        throw new Error('a failure with no errno behind it');
      },
      warn: (message) => {
        warnings.push(message);
      },
    });
    expect(warnings[0]).toContain('unknown');
  });

  it('reports the loss in the words the shared staged write uses for it', () => {
    // Two writers that lose describe the loss identically, because one
    // mechanism names them both; a second rendering here would be a second
    // identity space wearing the same words.
    const store = storeAt();
    const warnings: string[] = [];
    let staged = '';
    writeLedger(store, { tasks: {}, runs: [] }, nothingHasLeftTheTree, {
      rename: (from) => {
        staged = from;
        throw errno('ENOENT');
      },
      warn: (message) => {
        warnings.push(message);
      },
    });
    const target = staged.replace(`.${writerIdOf(staged)}.tmp`, '');
    const shared = new StagedWriteFailed(target, writerIdOf(staged), 'ENOENT', {
      cause: errno('ENOENT'),
    });
    expect(warnings[0]).toContain(shared.message);
  });

  it('removes its staging file when the write-back fails', () => {
    const store = storeAt();
    writeLedger(store, { tasks: {}, runs: [] }, nothingHasLeftTheTree, {
      rename: failWith('EACCES'),
      warn: () => undefined,
    });
    expect(readdirSync(store)).toEqual([]);
  });
});

/** The unrepeatable half of a staging name, between the target and the tail. */
function writerIdOf(staged: string): string {
  const name = path.basename(staged);
  return name.slice(name.indexOf('.json.') + '.json.'.length, -'.tmp'.length);
}

describe('the figures the attributed derivations measure', () => {
  it("keeps a run row's fixed cost across a write and a read back", () => {
    const store = storeAt();
    writeLedger(
      store,
      { tasks: {}, runs: [{ ...run(5), fixedRssKb: 1_200_000 }] },
      nothingHasLeftTheTree
    );
    expect(readLedger(store).runs[0]?.fixedRssKb).toBe(1_200_000);
  });

  it("keeps a run row's file count across a write and a read back", () => {
    const store = storeAt();
    writeLedger(store, { tasks: {}, runs: [{ ...run(5), fileCount: 900 }] }, nothingHasLeftTheTree);
    expect(readLedger(store).runs[0]?.fileCount).toBe(900);
  });

  it("keeps a run row's per-file weight across a write and a read back", () => {
    const store = storeAt();
    writeLedger(
      store,
      { tasks: {}, runs: [{ ...run(5), perFileWallMs: 4200 }] },
      nothingHasLeftTheTree
    );
    expect(readLedger(store).runs[0]?.perFileWallMs).toBe(4200);
  });

  it("keeps a run row's summed file wall across a write and a read back", () => {
    const store = storeAt();
    writeLedger(
      store,
      { tasks: {}, runs: [{ ...run(5), sumFileWallMs: 3_780_000 }] },
      nothingHasLeftTheTree
    );
    expect(readLedger(store).runs[0]?.sumFileWallMs).toBe(3_780_000);
  });

  it('leaves a run row that carries none of the figures without them rather than at zero', () => {
    const store = storeAt();
    writeLedger(store, { tasks: {}, runs: [run(5)] }, nothingHasLeftTheTree);
    const row = readLedger(store).runs[0];
    expect(row).not.toHaveProperty('fixedRssKb');
    expect(row).not.toHaveProperty('fileCount');
    expect(row).not.toHaveProperty('perFileWallMs');
    expect(row).not.toHaveProperty('sumFileWallMs');
  });

  it('drops a non-positive fixed cost and keeps the row', () => {
    const store = storeAt();
    plantRun(store, 1, {
      peakAccounting: 'pss',
      tasks: {},
      runs: [{ ...run(5), fixedRssKb: -1 }],
    });
    expect(readLedger(store).runs[0]).toEqual({ ...run(5), lanesAtPeak: 5 });
  });

  it('drops a non-positive file count and keeps the row', () => {
    const store = storeAt();
    plantRun(store, 1, { peakAccounting: 'pss', tasks: {}, runs: [{ ...run(5), fileCount: 0 }] });
    expect(readLedger(store).runs[0]).toEqual({ ...run(5), lanesAtPeak: 5 });
  });

  it('drops a non-positive per-file weight and keeps the row', () => {
    const store = storeAt();
    plantRun(store, 1, {
      peakAccounting: 'pss',
      tasks: {},
      runs: [{ ...run(5), perFileWallMs: 0 }],
    });
    expect(readLedger(store).runs[0]).toEqual({ ...run(5), lanesAtPeak: 5 });
  });

  it('drops a non-positive summed file wall and keeps the row', () => {
    const store = storeAt();
    plantRun(store, 1, {
      peakAccounting: 'pss',
      tasks: {},
      runs: [{ ...run(5), sumFileWallMs: 0 }],
    });
    expect(readLedger(store).runs[0]).toEqual({ ...run(5), lanesAtPeak: 5 });
  });

  it('reads a run carrying none of the figures as the ledger it reads today', () => {
    const store = storeAt();
    plantRun(store, 1, {
      peakAccounting: 'pss',
      tasks: { '@hushbox/api': { wallsMs: [299_000] } },
      runs: [{ ...run(5), peakRssKb: 7_330_000 }],
    });
    expect(readLedger(store)).toStrictEqual({
      tasks: { '@hushbox/api': { wallsMs: [299_000] } },
      runs: [{ ...run(5), peakRssKb: 7_330_000, lanesAtPeak: 5 }],
    });
  });

  it("keeps an earlier row's figures when a later run records a row carrying none", () => {
    const store = storeAt();
    const measured = {
      ...run(5),
      fixedRssKb: 1_200_000,
      fileCount: 900,
      perFileWallMs: 4200,
      sumFileWallMs: 3_780_000,
    };
    writeLedger(store, { tasks: {}, runs: [measured] }, nothingHasLeftTheTree);
    writeLedger(store, { tasks: {}, runs: [run(6)] }, nothingHasLeftTheTree);
    expect(readLedger(store).runs[0]).toEqual({ ...measured, lanesAtPeak: 5 });
  });
});

/**
 * The counts lint and typecheck open are settled by {@link deriveConcurrency}
 * over what the store holds, and this change moved only where the store holds
 * it. The superseded whole-file layout is still readable at the store's own
 * path, so the same measurements can be put through both layouts and the two
 * derivations compared directly rather than against a remembered number.
 */
describe('the derived count of a pool task', () => {
  const POOL_TASKS = ['lint', 'typecheck'] as const;

  const MEASURED = [
    { unit: '@hushbox/api', wallMs: 299_000 },
    { unit: '@hushbox/web', wallMs: 121_000 },
    { unit: '@hushbox/ui', wallMs: 41_000 },
    { unit: '@hushbox/shared', wallMs: 22_000 },
  ] as const;

  const OBSERVED: RunObservation = { ...run(5), fixedRssKb: 1_200_000 };

  const stillMeasured = inTree(...MEASURED.map((row) => row.unit));

  function derivedCount(store: string): number {
    const { tasks, runs } = readLedger(store);
    return deriveConcurrency({
      tasks: Object.entries(tasks).map(([name, entry]) => ({ name, wallsMs: entry.wallsMs })),
      observations: runs,
      maxConcurrency: 8,
      memoryBudgetKb: 12_000_000,
    }).concurrency;
  }

  for (const task of POOL_TASKS) {
    it(`is what the superseded whole-file layout derived, for ${task}`, () => {
      const perRun = storeAt(`${task}-per-run`);
      for (const { unit, wallMs } of MEASURED) {
        writeLedger(perRun, { tasks: { [unit]: { wallsMs: [wallMs] } }, runs: [] }, stillMeasured);
      }
      writeLedger(perRun, { tasks: {}, runs: [OBSERVED] }, stillMeasured);

      const wholeFile = storeAt(`${task}-whole-file`);
      plantSupersededFile(wholeFile, {
        peakAccounting: 'pss',
        tasks: Object.fromEntries(
          MEASURED.map(({ unit, wallMs }) => [unit, { wallsMs: [wallMs] }])
        ),
        runs: [OBSERVED],
      });

      expect(readLedger(perRun)).toEqual(readLedger(wholeFile));
      expect(derivedCount(perRun)).toBe(derivedCount(wholeFile));
    });
  }
});

describe('the lane count a row is filed at', () => {
  it('reads back the lane count the run recorded', () => {
    const store = storeAt();
    plantRun(store, 1, {
      peakAccounting: 'pss',
      tasks: {},
      runs: [{ ...run(8), taskCount: 2, lanesAtPeak: 5 }],
    });
    expect(readLedger(store).runs[0]?.lanesAtPeak).toBe(5);
  });

  it('approximates a missing lane count at the units the run had to fill its lanes', () => {
    const store = storeAt();
    plantRun(store, 1, { peakAccounting: 'pss', tasks: {}, runs: [{ ...run(8), taskCount: 3 }] });
    expect(readLedger(store).runs[0]?.lanesAtPeak).toBe(3);
  });

  it('approximates a missing lane count at the lanes the run opened where units exceed them', () => {
    const store = storeAt();
    plantRun(store, 1, { peakAccounting: 'pss', tasks: {}, runs: [{ ...run(4), taskCount: 18 }] });
    expect(readLedger(store).runs[0]?.lanesAtPeak).toBe(4);
  });

  it('counts a run that collected files by those files rather than by its packages', () => {
    // A vitest row's lanes are filled by test files; the packages it covered
    // sit in the comparability slot and would file a nine-hundred-file batch
    // at one lane, which is the direction that pins a low rung high.
    const store = storeAt();
    plantRun(store, 1, {
      peakAccounting: 'pss',
      tasks: {},
      runs: [{ ...run(18), taskCount: 1, fileCount: 900 }],
    });
    expect(readLedger(store).runs[0]?.lanesAtPeak).toBe(18);
  });
});

describe('the shape a row is filed under', () => {
  it('reads back the shape the run recorded', () => {
    const store = storeAt();
    plantRun(store, 1, { peakAccounting: 'pss', tasks: {}, runs: [{ ...run(4), shape: 'batch' }] });
    expect(readLedger(store).runs[0]?.shape).toBe('batch');
  });

  it('leaves a row recorded before the stamp existed without one', () => {
    const store = storeAt();
    plantRun(store, 1, { peakAccounting: 'pss', tasks: {}, runs: [run(4)] });
    expect(readLedger(store).runs[0]).not.toHaveProperty('shape');
  });

  it('drops a shape that is not a name', () => {
    const store = storeAt();
    plantRun(store, 1, { peakAccounting: 'pss', tasks: {}, runs: [{ ...run(4), shape: 7 }] });
    expect(readLedger(store).runs[0]).not.toHaveProperty('shape');
  });
});

describe('the superseded package-rooted store', () => {
  it('folds its rows into the store beside it', () => {
    const store = storeAt('vitest');
    plantPackageRun(store, 1, {
      peakAccounting: 'pss',
      tasks: {},
      runs: [run(2, 111_000)],
    });
    expect(readLedger(store).runs.map((row) => row.makespanMs)).toEqual([111_000]);
  });

  it('stamps every row it holds as the package shape, whatever the row says', () => {
    const store = storeAt('vitest');
    plantPackageRun(store, 1, {
      peakAccounting: 'pss',
      tasks: {},
      runs: [{ ...run(2), shape: 'batch' }],
    });
    expect(readLedger(store).runs[0]?.shape).toBe('package');
  });

  it('folds its whole-file layout in as well', () => {
    const store = storeAt('vitest');
    plantSupersededFile(`${store}-pkg`, {
      peakAccounting: 'pss',
      tasks: { a: { wallsMs: [10] } },
      runs: [run(2, 222_000)],
    });
    const ledger = readLedger(store);
    expect(ledger.runs.map((row) => row.shape)).toEqual(['package']);
    expect(ledger.tasks['a']?.wallsMs).toEqual([10]);
  });

  it('folds beneath the rows the live store holds, so the order is settled by source', () => {
    // Both directories number their runs from one, so an ordinal cannot order
    // them against each other. Nothing writes to the package-rooted store any
    // more, which is what makes "superseded first" a fact rather than a guess.
    const store = storeAt('vitest');
    plantPackageRun(store, 9, { peakAccounting: 'pss', tasks: { a: { wallsMs: [10] } }, runs: [] });
    plantRun(store, 1, { peakAccounting: 'pss', tasks: { a: { wallsMs: [20] } }, runs: [] });
    expect(readLedger(store).tasks['a']?.wallsMs).toEqual([10, 20]);
  });
});

describe('the ladder retention keeps', () => {
  it('keeps the newest three rows of a width and drops the fourth', () => {
    const store = storeAt();
    for (let index = 0; index < 4; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(4, 'batch', 100_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    expect(readLedger(store).runs.map((row) => row.makespanMs)).toEqual([
      100_001, 100_002, 100_003,
    ]);
  });

  it('counts the three per width rather than across the whole store', () => {
    const store = storeAt();
    for (let index = 0; index < 4; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(4, 'batch', 100_000 + index)] },
        nothingHasLeftTheTree
      );
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(9, 'batch', 200_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    const widths = readLedger(store).runs.map((row) => row.lanesAtPeak);
    expect(widths.filter((width) => width === 4)).toHaveLength(3);
    expect(widths.filter((width) => width === 9)).toHaveLength(3);
  });

  it('counts the three per shape as well as per width', () => {
    const store = storeAt();
    for (let index = 0; index < 4; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(4, 'batch', 100_000 + index)] },
        nothingHasLeftTheTree
      );
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(4, 'watch', 200_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    const shapes = readLedger(store).runs.map((row) => row.shape);
    expect(shapes.filter((shape) => shape === 'batch')).toHaveLength(3);
    expect(shapes.filter((shape) => shape === 'watch')).toHaveLength(3);
  });

  it('keeps a wide-width row after forty narrow-width runs of another shape land', () => {
    // The whole reason one store can serve both: a day of one-file runs used to
    // evict every wide row, which is why vitest kept two stores.
    const store = storeAt();
    writeLedger(store, { tasks: {}, runs: [rowAt(18, 'batch', 900_000)] }, nothingHasLeftTheTree);
    for (let index = 0; index < 40; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(1, 'package', 100_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    const kept = readLedger(store).runs;
    expect(kept.map((row) => row.makespanMs)).toContain(900_000);
    expect(kept.filter((row) => row.shape === 'package')).toHaveLength(3);
  });

  it('keeps the run file a retained row sits in, however old the file is', () => {
    const store = storeAt();
    writeLedger(store, { tasks: {}, runs: [rowAt(18, 'batch', 900_000)] }, nothingHasLeftTheTree);
    for (let index = 0; index < 40; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(1, 'package', 100_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    expect(readLedger(store).runs.map((row) => row.makespanMs)).toContain(900_000);
    expect(runFiles(store).length).toBeLessThan(41);
  });
});

describe('the age a rung expires at', () => {
  it('drops a width nobody has visited in the newest thirty runs of its shape', () => {
    const store = storeAt();
    writeLedger(store, { tasks: {}, runs: [rowAt(18, 'batch', 900_000)] }, nothingHasLeftTheTree);
    for (let index = 0; index < 30; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(1, 'batch', 100_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    expect(readLedger(store).runs.map((row) => row.makespanMs)).not.toContain(900_000);
  });

  it('keeps a width still inside the newest thirty runs of its shape', () => {
    const store = storeAt();
    writeLedger(store, { tasks: {}, runs: [rowAt(18, 'batch', 900_000)] }, nothingHasLeftTheTree);
    for (let index = 0; index < 29; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(1, 'batch', 100_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    expect(readLedger(store).runs.map((row) => row.makespanMs)).toContain(900_000);
  });

  it('counts the window in runs of the row’s own shape, so another shape cannot expire it', () => {
    const store = storeAt();
    writeLedger(store, { tasks: {}, runs: [rowAt(18, 'batch', 900_000)] }, nothingHasLeftTheTree);
    for (let index = 0; index < 60; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(1, 'package', 100_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    expect(readLedger(store).runs.map((row) => row.makespanMs)).toContain(900_000);
  });

  it('counts every run against a row no recorder stamped, whatever shape those runs carry', () => {
    const store = storeAt();
    writeLedger(store, { tasks: {}, runs: [unstampedRowAt(18, 900_000)] }, nothingHasLeftTheTree);
    for (let index = 0; index < MAX_RUNS_PER_SHAPE; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(1, 'batch', 100_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    expect(readLedger(store).runs.map((row) => row.makespanMs)).not.toContain(900_000);
  });

  it('keeps such a row while a store holding nothing else has run fewer than thirty times since', () => {
    const store = storeAt();
    writeLedger(store, { tasks: {}, runs: [unstampedRowAt(18, 900_000)] }, nothingHasLeftTheTree);
    for (let index = 0; index < MAX_RUNS_PER_SHAPE - 1; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [unstampedRowAt(1, 100_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    expect(readLedger(store).runs.map((row) => row.makespanMs)).toContain(900_000);
  });

  it('counts no unstamped run against a row that carries a shape', () => {
    const store = storeAt();
    writeLedger(store, { tasks: {}, runs: [rowAt(18, 'batch', 900_000)] }, nothingHasLeftTheTree);
    for (let index = 0; index < MAX_RUNS_PER_SHAPE * 2; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [unstampedRowAt(1, 100_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    expect(readLedger(store).runs.map((row) => row.makespanMs)).toContain(900_000);
  });
});

describe('the superseded whole-file layout', () => {
  it('is kept while one row in it is still retained', () => {
    const store = storeAt();
    plantSupersededFile(store, {
      peakAccounting: 'pss',
      tasks: {},
      runs: [rowAt(18, 'batch', 900_000)],
    });
    for (let index = 0; index < 29; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(1, 'batch', 100_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    expect(existsSync(`${store}.json`)).toBe(true);
    expect(readLedger(store).runs.map((row) => row.makespanMs)).toContain(900_000);
  });

  it('is kept where nothing in it can be read as a row at all', () => {
    // Its rows have not aged out — they were never readable — and an empty
    // premise is no evidence that the walls beside them have been superseded.
    const store = storeAt();
    plantSupersededFile(store, { tasks: { a: { wallsMs: [10] } }, runs: [run(5)] });
    for (let index = 0; index < 30; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(1, 'batch', 100_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    expect(existsSync(`${store}.json`)).toBe(true);
    expect(readLedger(store).tasks['a']?.wallsMs).toEqual([10]);
  });

  it('is removed once every row in it has aged out of retention', () => {
    const store = storeAt();
    plantSupersededFile(store, {
      peakAccounting: 'pss',
      tasks: {},
      runs: [rowAt(18, 'batch', 900_000)],
    });
    for (let index = 0; index < 30; index += 1) {
      writeLedger(
        store,
        { tasks: {}, runs: [rowAt(1, 'batch', 100_000 + index)] },
        nothingHasLeftTheTree
      );
    }
    expect(existsSync(`${store}.json`)).toBe(false);
  });
});

describe('the per-unit peak the composition consumed', () => {
  it('is dropped from a row a superseded file carries, keeping the walls beside it', () => {
    const store = storeAt();
    plantRun(store, 1, {
      peakAccounting: 'pss',
      tasks: { a: { wallsMs: [10], peakRssKb: 500_000 } },
      runs: [],
    });
    expect(readLedger(store).tasks['a']).toEqual({ wallsMs: [10] });
  });

  it('is a figure a unit row can no longer be handed', () => {
    // The compiler's assertion, not the runner's: `tsc` rejects an unused
    // `@ts-expect-error`, so the key becoming writable again reddens the
    // typecheck rather than passing silently here.
    const entry: LedgerEntry = {
      wallsMs: [10],
      // @ts-expect-error a unit row carries its walls and nothing else
      peakRssKb: 500_000,
    };
    expect(entry.wallsMs).toEqual([10]);
  });
});
