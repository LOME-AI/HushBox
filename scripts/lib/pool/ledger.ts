import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import type { StagedWriteFailed } from '../staged-write.js';
import type { RunObservation } from './schedule.js';

// Explicit-URL runtime import: wherever this module is loaded by Node's own
// loader rather than through a transform that rewrites specifiers, a `.js`
// specifier resolves literally and finds no such file next to
// `../staged-write.ts` — the constraint `packages/config/vitest.config.ts`
// states in full.
const { stagedWriteSync } = (await import(
  new URL('../staged-write.ts', import.meta.url).href
)) as typeof import('../staged-write.js');

/**
 * The turbo pool's machine-local record: per-task walls for release ordering,
 * and whole-run observations for choosing concurrency.
 *
 * It sits outside `node_modules` because that tree is deleted by both
 * `pnpm install` and `pnpm clean`, which took the pool's learned state with it
 * and left every run starting blind. It is keyed by machine fingerprint, so one
 * checkout driven by two differently-shaped machines gives each its own store —
 * they never write the same path, so neither can lose the other's measurements.
 * Machines of the same shape share a store by design, since the fingerprint
 * excludes the numbers an allocation decides.
 *
 * It stays a hint: a missing, truncated or unreadable file costs one
 * suboptimally-ordered run and nothing else, so every reader tolerates garbage
 * by returning empty rather than throwing, and a writer that cannot land its
 * file reports the loss rather than failing a run whose own work passed.
 *
 * **A store is a directory, and one run writes one file into it.** A run
 * therefore records what it measured and never rewrites what another measured,
 * which is what makes two runs recording at once safe: the whole-file
 * read-modify-write this replaced discarded whatever landed between a writer's
 * read and its write, and for the pool that window is the whole run, so two
 * overlapping runs of one task lost the earlier finisher's rows every time
 * rather than occasionally. Appending into one shared file was rejected on
 * platform evidence: an append is reported non-atomic above 256 bytes on macOS
 * while a record here runs to 1.2–1.9 KB, the Windows guarantee is not
 * established, and compaction by rename races an in-flight appender holding the
 * orphaned inode — which recreates the very loss this removes.
 *
 * The read folds every file in the store, oldest first, so a unit's walls come
 * out in the order they were measured; {@link writeLedger} then trims. Two
 * superseded sources fold in ahead of the store's own files, because nothing
 * writes to either any more: a *file* at the store's own path, which is what
 * the whole-file layout wrote, and the store one suffix along, where a run
 * rooted at a single package's configuration used to record before the
 * histories were folded into one. Both are culled once nothing in them is still
 * retained, so neither is folded forever.
 *
 * Retention is the ladder's, not a window over the store as a whole. A row is
 * kept while it is among the newest at its own (shape, lane count), and while
 * its shape has run fewer than {@link MAX_RUNS_PER_SHAPE} times since — so a
 * width survives a run of narrower ones, which is what lets one store hold
 * every shape of invocation, and a width nobody revisits still falls off rather
 * than pricing counts forever. {@link UNSTAMPED_SHAPE} is the exception, and
 * ages against every run in the store rather than its own. A unit's walls are
 * kept on their own terms, because they are read as a sequence and not by
 * width.
 */

export interface LedgerEntry {
  /**
   * The task's retained walls, oldest first. A sequence rather than the latest
   * reading, so that a derivation can take a statistic over it and no single
   * pathological run — a killed child, a swap storm, a machine busy with
   * something else — decides on its own what the next run opens.
   */
  readonly wallsMs: readonly number[];
}

export interface PoolLedger {
  readonly tasks: Record<string, LedgerEntry>;
  readonly runs: readonly RunObservation[];
}

/**
 * How many of a unit's walls a store keeps. Every one the derivation consults,
 * so this is also how far back a single pathological reading can go on weighing
 * against the ones measured since.
 */
export const MAX_RETAINED_WALLS = 10;

/**
 * How many rows one rung keeps — a rung being one (shape, lane count) pair, the
 * key the projection reads a width's worst peak off. Three, so that a rung
 * stands on more than the last run that visited it and a single swap storm
 * cannot own a width on its own, and no more, because the projection takes the
 * worst of them and a longer memory only makes the worst older.
 */
export const MAX_ROWS_PER_RUNG = 3;

/**
 * How many of a shape's own runs a rung survives without being revisited.
 *
 * Counted per shape rather than per store — {@link UNSTAMPED_SHAPE} excepted,
 * which counts every run — and that is the whole reason one store can hold
 * every vitest invocation: a day of package-rooted one-file runs would
 * otherwise age out every batch rung, which is why that history needed a store
 * of its own. Thirty is long enough that a width a developer visits weekly is
 * still on the ladder, and short enough that a width nobody visits stops
 * pricing counts nobody opens — a rung that never expired would be state the
 * system cannot repair. Once one falls off, the ladder's answer for its width
 * falls back to the next-widest rung still retained and continues flat from
 * there.
 */
export const MAX_RUNS_PER_SHAPE = 30;

/**
 * The shape rows carry that were recorded before the stamp existed, and the one
 * every row of a tool that records no shape shares. A key rather than an absent
 * value, so that retention has one window to count them in.
 *
 * Its window counts **every** run in the store, where a stamped shape's counts
 * only its own. This is not a preference about how long such a row deserves:
 * wherever a recorder stamps, nothing can file under this key again, so a
 * window counted over its own runs cannot advance and the rung never expires —
 * the one state the ladder has no run that repairs. Counting every run gives it
 * back the mortality the per-shape window took away, and costs nothing in a
 * store nothing stamps, where the two counts are the same count.
 */
const UNSTAMPED_SHAPE = '';

/**
 * The shape the superseded package-rooted store's rows are filed under. That
 * store is where a run rooted at one package's own configuration recorded
 * before the histories were folded into one; nothing writes there now, and its
 * rows are read at the shape the store itself settles rather than at whatever
 * they happen to say.
 */
const PACKAGE_SHAPE = 'package';

/** What the package-rooted store's path is, beside the store it folds into. */
const PACKAGE_STORE_SUFFIX = '-pkg';

/**
 * How the recorded peaks were measured. Runs stamped with anything else are
 * dropped rather than read: a proportional set size and a per-process resident
 * sum differ by however much the workers shared, so a store holding both would
 * project from neither. Changing what the sampler measures means changing this,
 * which relearns the memory history over the next several runs.
 *
 * This stamp, not the `peakRssKb` key's spelling, is what separates the two
 * accountings. Renaming the key separates nothing and silently costs the peaks
 * already on disk: rows in a store stamped with the current accounting go on
 * validating with the renamed figure absent, and a projection that charges a
 * recorded peak then has nothing to charge at all — the run is unguarded, as on
 * a machine that has measured nothing, until new runs re-accumulate.
 */
const PEAK_ACCOUNTING = 'pss';

const EMPTY: PoolLedger = { tasks: {}, runs: [] };

export function ledgerPath(repoRoot: string, fingerprint: string, task: string): string {
  return path.join(repoRoot, '.cache', 'hushbox-turbo-pool', fingerprint, task);
}

/**
 * A run file's name: an ordinal, so the fold can put the runs back in the order
 * they were measured, and a random half, so two runs that pick the same ordinal
 * still write different names and neither can overwrite the other. Version 4,
 * so no clock reaches the name.
 *
 * The `.json` tail is also what keeps a staged write out of the fold and out of
 * the trim: `stagedWriteSync` names its staging file after the target with a
 * `.tmp` tail, so it matches nothing here while it is in flight.
 */
const RUN_FILE = /^(\d+)-[0-9a-f-]+\.json$/;

function runFileNames(store: string): string[] {
  try {
    return readdirSync(store).filter((name) => RUN_FILE.test(name));
  } catch {
    // No store yet, or one nothing can enumerate: both mean no runs on record.
    return [];
  }
}

function ordinalOf(name: string): number {
  /* v8 ignore next -- every name reaching this matched RUN_FILE */
  return Number(RUN_FILE.exec(name)?.[1] ?? 0);
}

/** Oldest first: by ordinal, then by name so two runs sharing one never tie. */
function inMeasuredOrder(names: readonly string[]): string[] {
  return [...names].toSorted((a, b) => ordinalOf(a) - ordinalOf(b) || a.localeCompare(b));
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function duration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * A task's walls, or nothing. An entry recorded before the history existed
 * carries a single `wallMs` and no array, so it reads as nothing here and the
 * task is dropped: the shape is taken without a migration, at the price of one
 * cold start per file.
 */
function validWalls(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const walls: number[] = [];
  for (const wall of value as readonly unknown[]) {
    if (!duration(wall)) return undefined;
    walls.push(wall);
  }
  return walls;
}

function validEntry(value: unknown): LedgerEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const walls = validWalls((value as { wallsMs?: unknown }).wallsMs);
  return walls === undefined ? undefined : { wallsMs: walls };
}

/**
 * The row's optional keys — the figures a run may or may not have measured. The
 * required ones are named in {@link validRun}, where leaving one out fails to
 * compile; these are named in {@link RUN_FIGURE_KEYS}, which is why the list is
 * checked for completeness against this rather than trusted to match it.
 */
type OptionalRunKey = {
  [K in keyof RunObservation]-?: undefined extends RunObservation[K] ? K : never;
}[keyof RunObservation];

/** The optional keys that are figures, which is every one but the shape. */
type NumericRunKey = {
  [K in OptionalRunKey]: NonNullable<RunObservation[K]> extends number ? K : never;
}[OptionalRunKey];

const RUN_FIGURE_KEYS = [
  'peakRssKb',
  'fixedRssKb',
  'fileCount',
  'perFileWallMs',
  'sumFileWallMs',
  'lanesAtPeak',
] as const satisfies readonly NumericRunKey[];

/**
 * What a valid row carries beyond its required keys. The second half is empty
 * whenever the list above is complete, and holds any optional key the list does
 * not name — which {@link validFigures} then cannot produce, so an unlisted key
 * fails to compile there. Nothing about the failure it stands in for is visible
 * at runtime: an unnamed key is simply dropped on read.
 */
type RunFigures = Pick<RunObservation, (typeof RUN_FIGURE_KEYS)[number]> &
  Record<Exclude<NumericRunKey, (typeof RUN_FIGURE_KEYS)[number]>, never>;

/**
 * The figures a run may or may not have measured, each carried across on its own
 * terms: a row that recorded none of them is still a row, and one that recorded
 * some keeps exactly those.
 */
function validFigures(value: Record<string, unknown>): RunFigures {
  const figures: { -readonly [K in keyof RunFigures]?: number } = {};
  for (const key of RUN_FIGURE_KEYS) {
    const figure = value[key];
    if (positive(figure)) figures[key] = figure;
  }
  return figures;
}

/**
 * The width a row is filed at, where the row recorded none.
 *
 * `min(lanes, units)` is the best the row itself can say: a run that declared
 * more lanes than it had units to fill them held the units, not the lanes, and
 * filing it at the declared count would pin a rung high at a width the run
 * never reached. Units are the run's own — the files it collected where it
 * collected any, because those are what fill a test runner's workers, and the
 * packages it covered otherwise. Reading the packages of a run that collected
 * files would file a nine-hundred-file batch at one lane, which is the
 * direction that costs lanes at every wider count.
 */
function lanesFilled(row: RunObservation): number {
  return Math.min(row.concurrency, row.fileCount ?? row.taskCount);
}

/** The shape a row states for itself, or nothing where it states none. */
function validShape(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The counts a row is nothing without, or nothing where one is missing. */
function validCounts(
  record: Record<string, unknown>
):
  | Pick<RunObservation, 'concurrency' | 'taskCount' | 'sumWallMs' | 'longestWallMs' | 'makespanMs'>
  | undefined {
  const { concurrency, taskCount, sumWallMs, longestWallMs, makespanMs } = record;
  if (!positive(concurrency) || !positive(taskCount)) return undefined;
  if (!duration(sumWallMs) || !duration(longestWallMs) || !duration(makespanMs)) return undefined;
  return { concurrency, taskCount, sumWallMs, longestWallMs, makespanMs };
}

function validRun(value: unknown, shape: string | undefined): RunObservation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const counts = validCounts(record);
  if (counts === undefined) return undefined;
  const filed = shape ?? validShape(record['shape']);
  const row: RunObservation = {
    ...counts,
    ...validFigures(record),
    ...(filed === undefined ? {} : { shape: filed }),
  };
  return row.lanesAtPeak === undefined ? { ...row, lanesAtPeak: lanesFilled(row) } : row;
}

function parseFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    // Absent, truncated or not JSON: all mean the same here, which is nothing.
    return undefined;
  }
}

function readTasks(tasks: object): Record<string, LedgerEntry> {
  const valid: Record<string, LedgerEntry> = {};
  for (const [name, value] of Object.entries(tasks)) {
    const entry = validEntry(value);
    if (entry) valid[name] = entry;
  }
  return valid;
}

function readRuns(
  peakAccounting: unknown,
  runs: readonly unknown[],
  shape: string | undefined
): RunObservation[] {
  if (peakAccounting !== PEAK_ACCOUNTING) return [];
  const valid: RunObservation[] = [];
  for (const value of runs) {
    const observation = validRun(value, shape);
    if (observation) valid.push(observation);
  }
  return valid;
}

/**
 * One file the fold reads, and what its own position settles about it.
 *
 * `shape` is set where the source decides the shape of everything in it rather
 * than the rows deciding for themselves, which is how the package-rooted
 * store's rows are read: they predate the stamp, and the store they sit in is
 * the only thing that knows what recorded them.
 *
 * `wholeFile` separates the superseded layout — one file that was the whole
 * store — from a run file. The two are culled by different rules, because only
 * a run file was ever part of the carrier machinery that keeps a unit's walls.
 */
interface LedgerSource {
  readonly file: string;
  readonly shape?: string | undefined;
  readonly wholeFile: boolean;
}

/** What one source states, or nothing where it states nothing readable. */
function readSource(source: LedgerSource): PoolLedger {
  const parsed = parseFile(source.file);
  if (typeof parsed !== 'object' || parsed === null) return EMPTY;
  const { peakAccounting, tasks, runs } = parsed as {
    peakAccounting?: unknown;
    tasks?: unknown;
    runs?: unknown;
  };
  // A file without both keys is the superseded shape, whose walls carry no
  // record of the concurrency they were measured at. Unreadable, so dropped.
  if (typeof tasks !== 'object' || tasks === null || !Array.isArray(runs)) return EMPTY;
  return { tasks: readTasks(tasks), runs: readRuns(peakAccounting, runs, source.shape) };
}

/**
 * Every file the store folds, oldest first.
 *
 * The superseded sources come first because nothing writes to any of them any
 * more, so everything the live store holds was measured after them. Within
 * them the order is this list's, which is what makes the fold repeatable:
 * every store numbers its own run files from one, so an ordinal cannot order
 * two stores against each other and no comparison of the files themselves
 * could — the one available answer is that the superseded ones are older.
 */
function storedSources(store: string): LedgerSource[] {
  const packageStore = `${store}${PACKAGE_STORE_SUFFIX}`;
  const inStore = (directory: string, shape?: string): LedgerSource[] =>
    inMeasuredOrder(runFileNames(directory)).map((name) => ({
      file: path.join(directory, name),
      ...(shape === undefined ? {} : { shape }),
      wholeFile: false,
    }));
  return [
    { file: `${store}.json`, wholeFile: true },
    { file: `${packageStore}.json`, shape: PACKAGE_SHAPE, wholeFile: true },
    ...inStore(packageStore, PACKAGE_SHAPE),
    ...inStore(store),
  ];
}

/** What one source holds, paired with the source, so a culler can act on it. */
interface FoldedSource {
  readonly source: LedgerSource;
  readonly held: PoolLedger;
}

function foldStore(store: string): FoldedSource[] {
  return storedSources(store).map((source) => ({ source, held: readSource(source) }));
}

/**
 * What retention says about one row.
 *
 * Two answers rather than one, because a row the ladder no longer reads may
 * still have to stay on disk. The window is a count of a shape's own runs, and
 * a count cannot be taken over runs that have been deleted — so a store that
 * dropped every row the rung cap excluded could never fill a window, and no
 * rung would ever expire. Keeping the window's runs is what makes the age a
 * fact about the shape's history rather than about what retention felt like
 * keeping.
 */
interface RowStanding {
  /** On the ladder: the projection reads this row. */
  readonly onLadder: boolean;
  /** Inside its shape's age window, so the store keeps the run it came from. */
  readonly inWindow: boolean;
}

/**
 * Where each row stands, taken newest first so that a row's own recency decides
 * it.
 *
 * Both conditions are keyed on the row's shape. A row is in its shape's window
 * while that shape has run fewer than {@link MAX_RUNS_PER_SHAPE} times since,
 * which is what expires a width nobody revisits — so the ladder repairs itself
 * rather than holding a rung forever, and the answer for a width whose rung
 * falls off is the next-widest rung still retained, continued flat from there.
 * Inside the window it reaches the ladder while it is among the newest
 * {@link MAX_ROWS_PER_RUNG} rows at its own lane count, which is what stops a
 * width somebody visits constantly from owning the ladder on its own.
 *
 * Counting the window per shape is the whole reason one store can hold every
 * shape of invocation: a day of one-file runs ages out nothing a batch
 * recorded, which is what the two stores used to buy. A row under
 * {@link UNSTAMPED_SHAPE} is counted against every run instead, for the reason
 * given there: its own shape cannot run, so its own window cannot advance.
 */
function rowStandings(rows: readonly RunObservation[]): RowStanding[] {
  const standings = rows.map(() => ({ onLadder: false, inWindow: false }));
  const runsSeen = new Map<string, number>();
  const rowsKept = new Map<string, number>();
  let runsSeenAtAll = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    /* v8 ignore next -- the index came from this array's own length */
    if (row === undefined) continue;
    runsSeenAtAll += 1;
    const shape = row.shape ?? UNSTAMPED_SHAPE;
    let seen: number;
    if (shape === UNSTAMPED_SHAPE) {
      seen = runsSeenAtAll;
    } else {
      seen = (runsSeen.get(shape) ?? 0) + 1;
      runsSeen.set(shape, seen);
    }
    if (seen > MAX_RUNS_PER_SHAPE) continue;
    const rung = `${shape}\u0000${String(row.lanesAtPeak)}`;
    const kept = rowsKept.get(rung) ?? 0;
    const onLadder = kept < MAX_ROWS_PER_RUNG;
    if (onLadder) rowsKept.set(rung, kept + 1);
    standings[index] = { onLadder, inWindow: true };
  }
  return standings;
}

/** Where each source stands, from the rows it holds. */
interface SourceStanding {
  /** Holds at least one row still inside its shape's window. */
  readonly inWindow: boolean;
  /** Holds at least one row at all, readable or not by the ladder's terms. */
  readonly hasRows: boolean;
}

function sourceStandings(folded: readonly FoldedSource[]): SourceStanding[] {
  const standings = rowStandings(folded.flatMap(({ held }) => held.runs));
  let cursor = 0;
  return folded.map(({ held }) => {
    let inWindow = false;
    for (let index = 0; index < held.runs.length; index += 1, cursor += 1) {
      if (standings[cursor]?.inWindow === true) inWindow = true;
    }
    return { inWindow, hasRows: held.runs.length > 0 };
  });
}

/**
 * Every run in the store, folded into the one record the derivations read, with
 * retention applied: a unit's newest walls, and the rows still standing on the
 * ladder.
 *
 * The cost is one parse per file retention leaves in the store — each shape's
 * newest {@link MAX_RUNS_PER_SHAPE} runs, the newest
 * {@link MAX_RETAINED_WALLS} run files, and up to
 * {@link MAX_CARRIERS_PER_UNIT} carrier files for each unit that still exists —
 * so it follows the retention bound rather than the number of runs a machine
 * has ever recorded. That is a bounded count of files against a
 * run whose own work takes minutes, so the fold is not worth avoiding.
 */
export function readLedger(store: string): PoolLedger {
  const walls: Record<string, number[]> = {};
  const rows: RunObservation[] = [];
  for (const { held } of foldStore(store)) {
    for (const [name, entry] of Object.entries(held.tasks)) {
      const measured = walls[name] ?? [];
      measured.push(...entry.wallsMs);
      walls[name] = measured;
    }
    rows.push(...held.runs);
  }
  const standings = rowStandings(rows);
  return {
    tasks: Object.fromEntries(
      Object.entries(walls).map(([name, held]) => [
        name,
        { wallsMs: held.slice(-MAX_RETAINED_WALLS) },
      ])
    ),
    runs: rows.filter((_, index) => standings[index]?.onLadder === true),
  };
}

interface WriteLedgerDeps {
  readonly rename?: (from: string, to: string) => void;
  readonly warn?: (message: string) => void;
}

/**
 * How many runs retention will keep a unit alive across once the newest ones
 * stop naming it. Three, because the wall a unit stands on is the median of its
 * retained walls, and the median in `scripts/lib/pool/schedule.ts` states where
 * that guard begins: one reading is the pathological run itself, two median to
 * their mean so half an outlier still reaches the answer, and three is the
 * first count at which a real measurement sits between the extremes. A rule
 * that let a unit fall to a single carrier would hand the median one reading
 * and defeat the guard it feeds.
 */
const MAX_CARRIERS_PER_UNIT = 3;

/** Every run file whose rows keep it, and every one the newest window keeps. */
function filesRowsKeep(
  folded: readonly FoldedSource[],
  standings: readonly SourceStanding[]
): Set<string> {
  const keep = new Set<string>();
  for (const [index, { source }] of folded.entries()) {
    if (!source.wholeFile && standings[index]?.inWindow === true) keep.add(source.file);
  }
  for (const { source } of runFilesOf(folded).slice(-MAX_RETAINED_WALLS)) keep.add(source.file);
  return keep;
}

function runFilesOf(folded: readonly FoldedSource[]): FoldedSource[] {
  return folded.filter(({ source }) => !source.wholeFile);
}

/**
 * The run files retention keeps: every one holding a row still inside its
 * shape's age window, the newest {@link MAX_RETAINED_WALLS} of them, and
 * additionally the newest runs carrying each existing unit that the kept ones
 * do not already carry {@link MAX_CARRIERS_PER_UNIT} times over.
 *
 * The three parts answer three different questions. A row inside its shape's
 * window is what the ladder is built and aged from, and it is filed by width,
 * so the file it sits in outlives the newest-N window — that is what lets one
 * width's history survive a run of narrow ones, and what makes the age of a
 * rung countable at all. The newest-N window is what keeps a unit's walls,
 * which are read as a sequence and not by width. And the carriers are for the
 * unit the window misses: the pool records only the packages a run
 * actually executed, so a package that rarely misses the build cache would age
 * out of a newest-N window and read as never measured, and the better the
 * cache, the worse the derivation would get.
 *
 * A unit that has ceased to exist carries nothing worth keeping a run for,
 * which is what bounds the carriers: a carrier kept for a removed package or a
 * deleted test file is a file no later run has any reason to remove, and they
 * accumulate for as long as the store lives. Existence is the caller's
 * question, derived at each use, so nothing here remembers a verdict or
 * schedules a sweep. Every extra file kept fills at least one unit's unfilled
 * carrier slot, so the store is bounded by the window's runs — up to
 * {@link MAX_RUNS_PER_SHAPE} per shape, which is a far larger set than the
 * rows the ladder reads — plus the newest {@link MAX_RETAINED_WALLS} runs plus
 * {@link MAX_CARRIERS_PER_UNIT} per live unit.
 */
function retainedFiles(
  folded: readonly FoldedSource[],
  standings: readonly SourceStanding[],
  unitExists: (unit: string) => boolean
): Set<string> {
  const runFiles = runFilesOf(folded);
  const keep = filesRowsKeep(folded, standings);
  const carriers = new Map<string, number>();
  const unitsOf = ({ held }: FoldedSource): string[] =>
    Object.keys(held.tasks).filter((unit) => unitExists(unit));
  const carry = (units: readonly string[]): void => {
    for (const unit of units) carriers.set(unit, (carriers.get(unit) ?? 0) + 1);
  };
  const wanted = (units: readonly string[]): boolean =>
    units.some((unit) => (carriers.get(unit) ?? 0) < MAX_CARRIERS_PER_UNIT);
  for (const entry of runFiles) {
    if (keep.has(entry.source.file)) carry(unitsOf(entry));
  }
  for (const entry of runFiles.toReversed()) {
    if (keep.has(entry.source.file)) continue;
    const units = unitsOf(entry);
    if (!wanted(units)) continue;
    keep.add(entry.source.file);
    carry(units);
  }
  return keep;
}

function remove(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // A file that cannot be removed is one the fold drops from the record
    // anyway, and the next run's trim reaches it again. Failing here would
    // sink a run whose own work passed over a file that costs nothing to keep.
  }
}

/**
 * Remove what the store has superseded: run files retention no longer keeps,
 * and a whole-file layout every row of which has aged off the ladder.
 *
 * The superseded whole-file is culled on its rows alone, and not on the
 * carriers, because it was never part of the carrier machinery — one file that
 * was the whole store cannot be one of a unit's three most recent carriers.
 * Folding it forever is what this removes; the walls it is the last carrier of
 * cost one cold-start ordering, the same price the module already pays for a
 * shape it takes without a migration.
 *
 * A whole-file holding no readable row at all is kept rather than removed: its
 * rows have not aged out, they were never readable, and an empty premise is no
 * evidence that the walls beside them have been superseded. It costs one parse.
 */
function trim(store: string, unitExists: (unit: string) => boolean): void {
  const folded = foldStore(store);
  const standings = sourceStandings(folded);
  const keep = retainedFiles(folded, standings, unitExists);
  for (const [index, { source }] of folded.entries()) {
    const standing = standings[index];
    const superseded = standing !== undefined && standing.hasRows && !standing.inWindow;
    if (source.wholeFile ? !superseded : keep.has(source.file)) continue;
    remove(source.file);
  }
}

/**
 * Land what this run measured as a run of its own, then trim.
 *
 * `measured` is this run's own rows, never the accumulated record: the fold at
 * {@link readLedger} is what assembles the history, and a caller handing back
 * what it read would have that history counted once per run that read it.
 *
 * `unitExists` answers, from the tree at the moment it is asked, whether a unit
 * the store names still exists — a package the workspace still declares, a test
 * file still on disk. Each store asks its own question, and it stands in a
 * required position of its own rather than as a key in `deps` so that a caller
 * with nothing to say must say so: a predicate that could be left out would
 * default to keeping every carrier forever, and a store that silently keeps
 * everything is what {@link retainedFiles} exists to bound.
 */
export function writeLedger(
  store: string,
  measured: PoolLedger,
  unitExists: (unit: string) => boolean,
  deps: WriteLedgerDeps = {}
): void {
  const warn = deps.warn ?? console.warn;
  const sortedTasks = Object.fromEntries(
    Object.entries(measured.tasks)
      .toSorted(([a], [b]) => a.localeCompare(b))
      // Rebuilt rather than spread, so that a unit row lands carrying walls
      // and nothing else whatever the caller handed over.
      .map(([name, entry]) => [name, { wallsMs: entry.wallsMs.slice(-MAX_RETAINED_WALLS) }])
  );
  const body = {
    peakAccounting: PEAK_ACCOUNTING,
    tasks: sortedTasks,
    runs: measured.runs,
  };
  let highest = 0;
  for (const name of runFileNames(store)) highest = Math.max(highest, ordinalOf(name));
  const ordinal = String(highest + 1).padStart(6, '0');
  const runFile = path.join(store, `${ordinal}-${randomUUID()}.json`);
  try {
    stagedWriteSync(runFile, `${JSON.stringify(body, undefined, 2)}\n`, {
      ...(deps.rename ? { rename: deps.rename } : {}),
    });
  } catch (error) {
    // The read side already treats a missing or unreadable store as no
    // measurements; the write side is the same trade seen from the other end.
    // Failing the caller here would sink a run whose own work passed over a
    // scheduling hint, so the loss is reported and swallowed — reported,
    // because a hint that silently stops accumulating is indistinguishable
    // from a machine that never gets faster.
    const { message } = error as StagedWriteFailed;
    warn(`[pool-ledger] ${message}; this run's timings go unrecorded and the run continues.`);
    return;
  }
  trim(store, unitExists);
}
