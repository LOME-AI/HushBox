import {
  derivationBasis,
  describeDerivationBound,
  deriveConcurrency,
  laneUtilization,
  memoryLadder,
  projectedPeakKb,
  unknownTaskSet,
  type ConcurrencyBound,
  type LadderRung,
  type PoolTaskEstimate,
  type RunObservation,
} from './schedule.js';

import { describeVitestDerivation, type VitestWorkerDerivation } from '../vitest/workers.js';

import type { LedgerEntry } from './ledger.js';

/**
 * The half of `pnpm concurrency` that works out what each check would open if
 * it ran now, and whether the pool is still working that number out, then
 * renders it. Pure, so the numbers can be asserted without a repo to read them
 * from — which is the whole reason the derivation sits here rather than in the
 * command, where nothing could measure it.
 */

export interface TaskStatus {
  readonly task: string;
  readonly concurrency: number;
  /**
   * How the number was arrived at: the pool's derivation state, or what a count
   * the pool does not tune is taken from.
   */
  readonly state: string;
  readonly tuned: boolean;
  readonly runs: readonly RunObservation[];
  /** Why it sits where it does, in one clause. */
  readonly note: string;
  /**
   * What the memory record had to say about this count, for a row the pool
   * derives one for. Absent on a row whose count no projection ever examines,
   * which is the only thing its absence may mean.
   */
  readonly memory?: MemoryAccount | undefined;
}

export interface MachineSummary {
  readonly fingerprint: string;
  readonly cpuModel: string;
  readonly threads: number;
  readonly cores: number;
  readonly totalMemBytes: number;
}

function gib(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(0)}s`;
}

/** `N=10 x1, N=5 x2`, newest counts last, or a dash when nothing was recorded. */
export function summariseRuns(runs: readonly RunObservation[]): string {
  if (runs.length === 0) return '—';
  const counts = new Map<number, number>();
  for (const run of runs) counts.set(run.concurrency, (counts.get(run.concurrency) ?? 0) + 1);
  return [...counts.entries()]
    .toSorted((a, b) => b[0] - a[0])
    .map(([concurrency, count]) => `N=${String(concurrency)} x${String(count)}`)
    .join(', ');
}

/**
 * What a row's note says about its own observations, derived from the rows the
 * row carries rather than written as a sentence beside them.
 *
 * The note and the observations column are the same claim seen twice, so a
 * note that spells its emptiness out in prose goes on spelling it out once rows
 * start arriving — which is how the package-rooted row came to say that nothing
 * records anything while its history was filling, with a test pinning the
 * sentence rather than catching it.
 *
 * It counts runs and says nothing about their shape: every vitest invocation
 * records into one store, so the rows a row is handed are every shape's.
 */
export function rowObservationNote(runs: readonly RunObservation[]): string {
  if (runs.length === 0) return 'no run is on record, so this row carries no observation';
  return `${String(runs.length)} run(s) on record, summarised in the columns`;
}

/** One width of the ladder, with how far back the newest row filed there sits. */
export interface DatedRung {
  readonly rung: LadderRung;
  /** The shape of the newest row filed at this width — the population its age counts in. */
  readonly shape: string;
  /**
   * Retained rows of that shape standing after the newest row filed here.
   *
   * A floor on the runs behind the rung rather than the runs themselves: the
   * store hands back only the rows it kept, and it keeps a few per width per
   * shape, so the runs it discarded are not here to count. It is counted per
   * shape because the store's own age window is — a rung falls off once its own
   * shape has run far enough past it — so an age over every shape at once would
   * answer a question nothing asks.
   */
  readonly rowsAfter: number;
}

/** The newest baseline recorded under one kind of invocation. */
export interface ShapeFixedCost {
  readonly shape: string;
  readonly fixedRssKb: number;
}

/**
 * What the memory record had to say about one count: every width that has held
 * anything, the baselines recorded beside them, the budget the count had to fit
 * into, and which of the three limits the count came out of.
 *
 * Held rather than rendered at the row, so that what the report claims can be
 * asserted as figures rather than as a sentence to grep.
 */
export interface MemoryAccount {
  /** The share the count had to fit into; undefined where none could be read. */
  readonly budgetKb: number | undefined;
  /** Every width on record, narrowest first. */
  readonly rungs: readonly DatedRung[];
  /** The newest baseline per shape, in the order the shapes first appear. */
  readonly fixedCosts: readonly ShapeFixedCost[];
  readonly concurrency: number;
  readonly bound: ConcurrencyBound;
  /** False is the count no projection examined — no budget, or no width on record. */
  readonly memoryGuarded: boolean;
}

export interface MemoryAccountInput {
  readonly runs: readonly RunObservation[];
  readonly concurrency: number;
  readonly bound: ConcurrencyBound;
  readonly memoryGuarded: boolean;
  readonly budgetKb: number | undefined;
}

/** What a row the store stamped with no shape is filed under. */
const UNSTAMPED_SHAPE = 'unstamped';

/** A row's shape as a word a reader can act on, for a row carrying none. */
function shapeLabel(shape: string | undefined): string {
  return shape === undefined || shape === '' ? UNSTAMPED_SHAPE : shape;
}

/**
 * Whether the ladder files this row at a width, and so carries the lane count
 * the rest of this module reads off it.
 *
 * Asked of {@link memoryLadder} itself rather than spelled here: which rows
 * price a width is the projection's rule, and a second spelling of it in the
 * report would date a rung by a row the projection rejected. The narrowing is
 * that rule read back — a row the ladder filed was filed at a lane count.
 */
function pricesAWidth(run: RunObservation): run is RunObservation & { lanesAtPeak: number } {
  return memoryLadder([run]).length === 1;
}

/**
 * The ladder's widths, each dated by the newest row filed at it and by how many
 * retained rows of that row's own shape stand after it.
 *
 * One pass from the newest row backwards, so a shape's running count is what a
 * row meets when it is reached and the first row seen at a width is the newest
 * one there.
 */
function datedRungs(runs: readonly RunObservation[]): DatedRung[] {
  const undated = new Map(memoryLadder(runs).map((rung) => [rung.lanes, rung]));
  const seenPerShape = new Map<string, number>();
  const dated: DatedRung[] = [];
  for (const run of runs.toReversed()) {
    const shape = shapeLabel(run.shape);
    const rowsAfter = seenPerShape.get(shape) ?? 0;
    seenPerShape.set(shape, rowsAfter + 1);
    if (!pricesAWidth(run)) continue;
    const rung = undated.get(run.lanesAtPeak);
    if (rung === undefined) continue;
    undated.delete(run.lanesAtPeak);
    dated.push({ rung, shape, rowsAfter });
  }
  return dated.toSorted((a, b) => a.rung.lanes - b.rung.lanes);
}

/**
 * The newest baseline each shape recorded.
 *
 * Kept per shape because a baseline is the one figure that is not portable
 * between them — a consolidated run pays for a task runner and sibling suites
 * that a package-rooted one never starts — so one figure over all of them would
 * answer for neither.
 */
function newestFixedCosts(runs: readonly RunObservation[]): ShapeFixedCost[] {
  const newest = new Map<string, number>();
  for (const run of runs) {
    if (run.fixedRssKb === undefined) continue;
    newest.set(shapeLabel(run.shape), run.fixedRssKb);
  }
  return [...newest.entries()].map(([shape, fixedRssKb]) => ({ shape, fixedRssKb }));
}

/** What the recorded rows say about a count, as figures rather than prose. */
export function memoryAccount(input: MemoryAccountInput): MemoryAccount {
  const { runs, concurrency, bound, memoryGuarded, budgetKb } = input;
  return {
    budgetKb,
    rungs: datedRungs(runs),
    fixedCosts: newestFixedCosts(runs),
    concurrency,
    bound,
    memoryGuarded,
  };
}

export function describeLastRun(runs: readonly RunObservation[]): string {
  const last = runs.at(-1);
  if (!last) return '—';
  const peak = last.peakRssKb === undefined ? 'peak unmeasured' : gib(last.peakRssKb * 1024);
  return `${seconds(last.makespanMs)} / ${peak}`;
}

/** Column padding that never lets a value that overruns its width touch the next one. */
function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(1, width - value.length));
}

/** One place in this repository that decides how many lanes something opens. */
export interface LaneMechanism {
  /** The deciding file, repo-relative. */
  readonly site: string;
  /** What it decides, in one clause. */
  readonly decides: string;
  /** The rows of this report that carry it; empty where none does. */
  readonly rows: readonly string[];
}

/**
 * The file names the completeness gate sweeps, as globs over a path's last
 * segment. It is the sole declaration of the gate's reach: both the predicate
 * and the words the report prints for it are built from this list, so the two
 * are one statement rather than two held in agreement.
 */
const LANE_SITE_GLOBS = ['*.config.ts', '*.config.mts', '*.config.mjs'] as const;

function globMatches(glob: string, name: string): boolean {
  const source = glob.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replaceAll('*', '[^/]*');
  return new RegExp(`^${source}$`).test(name);
}

/**
 * Directories the gate does not enter: build output, caches, dependencies and
 * version control, none of which holds a declaration of record.
 *
 * Declared here beside the globs rather than at the sweep, for the reason the
 * globs are: the reach the report states and the reach the sweep has are one
 * statement, and two spellings of it agree only until one is edited.
 */
const LANE_SITE_UNSWEPT = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.turbo',
  '.astro',
  '.wrangler',
  '.cache',
] as const;

/** The files the completeness gate sweeps: what it accepts, and how it reads. */
export const LANE_SITE_SCOPE = {
  describes:
    `files named ${new Intl.ListFormat('en', { type: 'disjunction' }).format(LANE_SITE_GLOBS)}, ` +
    `in every directory but ${new Intl.ListFormat('en', { type: 'conjunction' }).format(
      LANE_SITE_UNSWEPT
    )}`,
  /** Directory names the sweep does not descend into. */
  unswept: LANE_SITE_UNSWEPT,
  matches(relativePath: string): boolean {
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
    return LANE_SITE_GLOBS.some((glob) => globMatches(glob, name));
  },
} as const;

/** How a file spells a lane count, as the completeness gate recognises one. */
export const LANE_DECLARATION_PATTERN =
  /maxWorkers|minWorkers|\bworkers\s*:|\bconcurrency['"]?\s*[:=]|--concurrency|maxConcurrency|fileParallelism|--jobs\b/;

/**
 * The mechanisms this report knows open lanes, and which of its rows carry each.
 *
 * Written down rather than derived, because nothing in the repository
 * enumerates them: every site declares its count in its own vocabulary and none
 * reads a shared registry, so there is no set to read. What stands in is the
 * gate beside this list — a sweep of {@link LANE_SITE_SCOPE} that fails on a
 * declaration no entry names and on an entry naming a file that has stopped
 * declaring one. That bounds the omission instead of closing it, and
 * {@link coverageSection} is where the reader is told so.
 */
export const LANE_MECHANISMS: readonly LaneMechanism[] = [
  {
    site: 'scripts/turbo-pool.ts',
    decides: 'how many packages the lint and typecheck pools run at once',
    rows: ['lint', 'typecheck'],
  },
  {
    site: 'scripts/lib/vitest/workers.ts',
    decides: 'the vitest worker count, which both vitest configurations read',
    rows: ['vitest-batch', 'vitest-pkg'],
  },
  {
    site: 'scripts/test-batch.ts',
    decides: 'the worker ceiling the consolidated run is launched with',
    rows: ['vitest-batch'],
  },
  {
    site: 'scripts/test-batch.ts',
    decides:
      'how many package tasks turbo runs at once inside the consolidated run, each of them a process that waits on the batch',
    rows: [],
  },
  {
    site: 'vitest.projects.config.ts',
    decides:
      "the consolidated run's ceiling, by dropping each lifted package's own and carrying the shared one",
    rows: ['vitest-batch'],
  },
  {
    site: 'packages/config/vitest.config.ts',
    decides:
      'the ceiling a vitest invocation that reaches this configuration without a launcher opens — pnpm test:watch:ui and a bare runner call — taken from the shared derivation as the configuration loads, over every test file on record and the runs the store holds, against a memory budget and the machine’s parallelism',
    rows: [],
  },
  {
    site: 'playwright.config.ts',
    decides: 'the end-to-end worker count, and the per-project caps beneath it',
    rows: ['playwright'],
  },
  {
    site: 'apps/api/vitest.workers.config.ts',
    decides:
      'no count of its own, so the API package’s workerd project opens the runner’s default, over its own test files, against no budget',
    rows: [],
  },
  {
    site: 'packages/db/vitest.workers.config.ts',
    decides:
      'file parallelism off, so the database package’s workerd project runs one file at a time',
    rows: [],
  },
  {
    site: 'packages/realtime/vitest.workers.config.ts',
    decides:
      'file parallelism off, so the realtime package’s workerd project runs one file at a time',
    rows: [],
  },
  {
    site: 'scripts/lib/vitest/coverage-provider-host.ts',
    decides:
      'the merge thread pool a coverage run opens, sized from how many dump batches that run produces — a figure no command can know before the run',
    rows: [],
  },
  {
    site: 'stryker.config.json',
    decides: 'how many mutant runs pnpm mutation executes at once, each of them a child process',
    rows: [],
  },
  {
    site: 'scripts/lib/backup/postgres.ts',
    decides: 'the parallel worker processes pg_dump opens when pnpm backup takes a database dump',
    rows: [],
  },
  {
    site: 'scripts/lib/backup/drill.ts',
    decides: 'the parallel worker processes pg_restore opens inside the restore drill',
    rows: [],
  },
];

/**
 * What the table is, and what it is not.
 *
 * The rows are a set someone wrote down, and a reader who cannot tell that from
 * a derived set will read an omission as an absence. So the section says which
 * it is, says what would make it the other, names the reach of the gate that
 * stands in, and then lists the mechanisms no row carries — the part a reader
 * would otherwise never learn exists.
 */
export function coverageSection(mechanisms: readonly LaneMechanism[]): string {
  const lines = [
    'coverage',
    '  The rows above are the mechanisms this report was told about, not a set it',
    '  derived: each one declares its count in its own vocabulary and none reads a',
    '  shared registry, so there is nothing here to enumerate them from. Deriving',
    '  the set would mean every site taking its count through one such module.',
    '  Standing in for that: a test sweeps for a lane-count declaration across',
    `  ${LANE_SITE_SCOPE.describes},`,
    '  and fails on one that neither a row above nor a line below accounts for,',
    '  so a new one there is hard to omit. A lane count outside that reach — any',
    '  other file name, or one of those directories — is not caught, and reaches',
    '  this report only because somebody put it here.',
  ];
  const uncarried = mechanisms.filter((mechanism) => mechanism.rows.length === 0);
  if (uncarried.length > 0) {
    lines.push('  Known, and carried by no row above:');
    for (const mechanism of uncarried) lines.push(`    ${mechanism.site} — ${mechanism.decides}`);
  }
  return lines.join('\n');
}

/** A kilobyte figure as the report prints memory everywhere else. */
function gibFromKb(kb: number): string {
  return gib(kb * 1024);
}

/** How far back a width was last visited, counted in rows rather than in time. */
function describeAge(dated: DatedRung): string {
  const { shape, rowsAfter } = dated;
  if (rowsAfter === 0) return `the newest is the latest retained ${shape} row`;
  return `the newest with ${String(rowsAfter)} retained ${shape} row(s) after it`;
}

/** What one width has held, and the evidence standing behind it. */
function rungLine(dated: DatedRung): string {
  const { rung } = dated;
  return (
    `${String(rung.lanes)} lane(s) have held ${gibFromKb(rung.peakRssKb)} — ` +
    `${String(rung.rows)} row(s) filed here, ${describeAge(dated)}`
  );
}

/**
 * The dearest of the rungs given, narrowest first among equals — the one whose
 * figure the projection reads at their widest width.
 *
 * Taken narrowest-first rather than as the widest rung: a narrow run that held
 * more goes on pricing every wider count, and naming the wrong width would make
 * the figure look wrong to anyone who checked it.
 */
function dearestRung(rungs: readonly LadderRung[], seed: LadderRung): LadderRung {
  let dearest = seed;
  for (const rung of rungs) {
    if (rung.peakRssKb > dearest.peakRssKb) dearest = rung;
  }
  return dearest;
}

/**
 * The line a count no rung's figure landed on was priced along, named by the
 * figures at its two ends.
 *
 * It runs between the widths bracketing the count, starting at the widest
 * width below it — not at the dearest width below, which is what set the
 * figure standing there. Below the narrowest rung it runs down to no lanes at
 * all, where the projection anchors at the lower of that rung's own figure and
 * the baseline its run held outside its lanes.
 *
 * Named by the figures rather than by the widths, because neither end is the
 * figure printed beside its width above: the projection stands every width at
 * the worst figure it or any narrower width recorded, and it anchors the
 * descent no higher than the rung it descends from. A clause naming the widths
 * alone hands a reader two printed figures that rebuild a different number
 * from the one beside them. Both ends are read back off the projection at the
 * widths they sit at, so neither is assembled here and neither can drift from
 * the arithmetic the clause describes.
 *
 * Undefined where no width is left above the count, which the clause naming
 * the whole ladder's worst figure has already answered.
 */
function lineUnderCount(
  ladder: readonly LadderRung[],
  widestBelow: LadderRung | undefined,
  concurrency: number
): string | undefined {
  const upper = ladder.find((rung) => rung.lanes > concurrency);
  if (upper === undefined) return undefined;
  const lowerKb = projectedPeakKb(ladder, widestBelow?.lanes ?? 0);
  const upperKb = projectedPeakKb(ladder, upper.lanes);
  /* v8 ignore next -- the ladder carries a rung, so the projection prices every width */
  if (lowerKb === undefined || upperKb === undefined) return undefined;
  if (widestBelow === undefined) {
    return (
      `the line from ${gibFromKb(upperKb)} at ${String(upper.lanes)} lane(s) to ` +
      `${gibFromKb(lowerKb)} at no lanes, the baseline that run held outside its ` +
      `lanes taken no higher than that rung's own figure`
    );
  }
  return (
    `the line from ${gibFromKb(lowerKb)} at ${String(widestBelow.lanes)} lane(s) to ` +
    `${gibFromKb(upperKb)} at ${String(upper.lanes)} lane(s), each width standing at ` +
    `the worst figure it or any narrower width recorded`
  );
}

/**
 * Where the count sits against the ladder, in the one clause a reader acts on.
 *
 * Three shapes, because the projection reaches its figure three ways. Where a
 * rung at or below the count holds the figure, the clause names that width.
 * Where none does, the figure came off a line {@link lineUnderCount} names —
 * and then the clause says that no width held the figure, because none did,
 * and a reader acting on it as a measurement would be acting on arithmetic.
 */
function landingClause(account: MemoryAccount): string {
  const { rungs, concurrency } = account;
  if (!account.memoryGuarded) return 'and nothing examined it against what has been held';
  const ladder = rungs.map(({ rung }) => rung);
  const heldKb = projectedPeakKb(ladder, concurrency);
  const narrowest = ladder[0];
  // One condition written twice: the projection answers nothing exactly where
  // the ladder carries no rung, and a row can carry a guarded count with no row
  // on it that prices a width.
  if (heldKb === undefined || narrowest === undefined) {
    return 'and no width has a rung, so nothing bounded it';
  }
  const held = `held against ${gibFromKb(heldKb)}`;
  const widest = Math.max(...ladder.map((rung) => rung.lanes));
  if (concurrency > widest) {
    // Past the widest width every rung is at or below the count, so the figure
    // is the worst of the whole ladder and no width is left to raise it.
    return (
      `${held} — the most any width on record has held, set at ` +
      `${String(dearestRung(ladder, narrowest).lanes)} lane(s); above the widest width ` +
      `on record (${String(widest)} lanes) the projection holds that figure flat`
    );
  }
  const below = ladder.filter((rung) => rung.lanes <= concurrency);
  const first = below[0];
  const dearestBelow = first === undefined ? undefined : dearestRung(below, first);
  if (dearestBelow?.peakRssKb === heldKb) {
    return (
      `${held} — the most any width at or below ` +
      `${String(concurrency)} lanes has held, set at ${String(dearestBelow.lanes)} lane(s)`
    );
  }
  const line = lineUnderCount(ladder, below.at(-1), concurrency);
  /* v8 ignore next -- at the widest width the figure is a rung's own, so the clause above answered */
  if (line === undefined) return held;
  return `${held} — read on ${line}, so no width on record has held it`;
}

/** One row's whole memory account, as the lines printed beneath its name. */
function accountLines(account: MemoryAccount): string[] {
  const { budgetKb, rungs, fixedCosts, concurrency, bound } = account;
  const fixed =
    fixedCosts.length === 0
      ? 'none on record'
      : fixedCosts.map((cost) => `${cost.shape} ${gibFromKb(cost.fixedRssKb)}`).join('; ');
  return [
    budgetKb === undefined
      ? 'budget: none could be read, so nothing was checked against one'
      : `budget: ${gibFromKb(budgetKb)} — a share of the memory free when this count was derived`,
    ...(rungs.length === 0
      ? [
          'no run on record carries all three of a peak, a baseline and the lanes that were ' +
            'live when the peak was set, so no width has a rung',
        ]
      : rungs.map((dated) => rungLine(dated))),
    `fixed cost, newest per shape: ${fixed}`,
    `count ${String(concurrency)} (${derivationBasis({ bound })}), ${landingClause(account)}`,
  ];
}

/**
 * The two rows {@link vitestTaskStatus} and {@link packageVitestTaskStatus}
 * build, in the order this section prints them.
 *
 * One derivation over one reading of one store builds both, so the second row's
 * count, state, unit count and ladder are the first row's printed again rather
 * than a second measurement that agrees with it. Said beneath the second block,
 * because that is where a reader meets the repetition.
 */
const REPEATED_VITEST_BLOCK = { printedFirst: 'vitest-batch', printedAgain: 'vitest-pkg' } as const;

/**
 * Why the second vitest block repeats the first, where it does.
 *
 * Guarded on the two blocks actually matching rather than declared from the row
 * names: a caller that hands the two rows different observations has derived
 * them apart, and the sentence would then be describing a report it is not in.
 */
function repeatedBlockLine(
  task: string,
  block: readonly string[],
  printed: ReadonlyMap<string, readonly string[]>
): string | undefined {
  if (task !== REPEATED_VITEST_BLOCK.printedAgain) return undefined;
  const first = printed.get(REPEATED_VITEST_BLOCK.printedFirst);
  if (first?.join('\n') !== block.join('\n')) return undefined;
  return (
    `identical to the ${REPEATED_VITEST_BLOCK.printedFirst} block above, line for line: ` +
    'one derivation over one reading of one store builds both rows, so their counts, ' +
    'states, unit counts and ladders are one computation printed twice'
  );
}

/**
 * What the machine's own record says about memory, per tool.
 *
 * It states what widths have held and nothing about what a width will hold, so
 * a sentence in the future tense here would be claiming something no row
 * supports. Every rung it prints is a reading. The one figure that need not be
 * is the one a count landed on, since the projection reads a count off the line
 * between two rungs where no rung stands at it — which is why the clause naming
 * that figure says which line it came from rather than which width held it.
 */
export function memorySection(statuses: readonly TaskStatus[]): string {
  const lines = [
    'memory — what widths have held here, and what each count was checked against',
    '  Ages count rows the store kept, not runs: it keeps only a few rows per width',
    '  per shape, so a row with none after it may still have runs behind it.',
    '  A budget is a reading rather than a property of this machine: every count',
    '  reads the memory free at the moment it is derived, so two rows of one report',
    '  naming different budgets are two readings, not a disagreement.',
  ];
  const printed = new Map<string, readonly string[]>();
  for (const status of statuses) {
    if (status.memory === undefined) continue;
    const block = accountLines(status.memory);
    printed.set(status.task, block);
    lines.push(`  ${status.task}`, ...block.map((line) => `    ${line}`));
    const repeat = repeatedBlockLine(status.task, block, printed);
    if (repeat !== undefined) lines.push(`    ${repeat}`);
  }
  return lines.join('\n');
}

export function formatReport(machine: MachineSummary, statuses: readonly TaskStatus[]): string {
  const header =
    `machine  ${machine.fingerprint}  (${machine.cpuModel}, ` +
    `${String(machine.threads)} threads / ${String(machine.cores)} cores, ` +
    `${gib(machine.totalMemBytes)})`;
  // `launched at`, never `observations`: these are the widths runs were started
  // with, and the memory section beneath reports the widths peaks were *held*
  // at. The two differ whenever a run had fewer units than lanes, so one header
  // over both would invite a reader to join rows that are not the same rows.
  const columns = `${pad('task', 14)}${pad('N', 4)}${pad('state', 14)}${pad('launched at', 24)}last run`;
  const rows = statuses.map(
    (status) =>
      pad(status.task, 14) +
      pad(String(status.concurrency), 4) +
      pad(status.state, 14) +
      pad(summariseRuns(status.runs), 24) +
      describeLastRun(status.runs)
  );
  const notes = statuses.map((status) => `${status.task}: ${status.note}`);
  return [
    header,
    '',
    columns,
    ...rows,
    '',
    ...notes,
    '',
    memorySection(statuses),
    '',
    coverageSection(LANE_MECHANISMS),
  ].join('\n');
}

/**
 * A ledger's task entries as the bounds' inputs: their walls, and nothing else.
 *
 * Nothing else is available and nothing else would be read. The memory bound is
 * a ladder over whole-run rows indexed by the lanes that were live when each
 * peak was set, so no per-unit figure reaches a projection at all — which is
 * why a unit here carries a wall and stops.
 */
export function poolTaskEstimates(tasks: Record<string, LedgerEntry>): PoolTaskEstimate[] {
  return Object.entries(tasks).map(([name, entry]) => ({ name, wallsMs: entry.wallsMs }));
}

interface PoolTaskInputs {
  readonly task: string;
  /** Walls on record for the packages a run would execute; empty where the ledger names none. */
  readonly tasks: readonly PoolTaskEstimate[];
  readonly runs: readonly RunObservation[];
  /** The machine ceiling — real cores where detectable. */
  readonly ceiling: number;
  readonly memoryBudgetKb?: number | undefined;
}

/**
 * What one pool task would open right now, from its own ledger.
 *
 * A ledger naming no package means the task set is unknown here, not that it
 * is empty: a real run takes its list from turbo. Standing one in is what lets
 * every reported number come out of the projection — deriving over an empty
 * set answers a different question and returns a single lane, which would read
 * as "this will run serially", while answering with the ceiling outright
 * reports a number no projection produced and a real run would not open.
 */
export function poolTaskStatus(inputs: PoolTaskInputs): TaskStatus {
  const { task, tasks, runs, ceiling, memoryBudgetKb } = inputs;
  const derived = deriveConcurrency({
    tasks: tasks.length === 0 ? unknownTaskSet(ceiling) : tasks,
    observations: runs,
    maxConcurrency: ceiling,
    memoryBudgetKb,
  });
  return {
    task,
    concurrency: derived.concurrency,
    state: derivationBasis(derived),
    tuned: true,
    runs,
    note: poolNote(derived, runs),
    memory: memoryAccount({
      runs,
      concurrency: derived.concurrency,
      bound: derived.bound,
      memoryGuarded: derived.memoryGuarded,
      budgetKb: memoryBudgetKb,
    }),
  };
}

/**
 * What the rows behind a vitest row are, stated on every row that shows them.
 *
 * One store holds every vitest invocation, so a row's columns and its recorded
 * work describe every shape of run rather than its own. Unsaid, the narrowest
 * launched width on the consolidated row reads as a consolidated run that
 * opened one worker, when it is a developer running one file. Shared between
 * the two vitest rows, which make the same claim about the same rows.
 */
const ONE_VITEST_STORE =
  'every vitest invocation records into one store, stamped with the shape that measured it, ' +
  'so the rows behind this one are every shape of run rather than this row’s alone';

interface VitestStatusInputs {
  /** What the derivation answered for this machine, and how it got there. */
  readonly derivation: VitestWorkerDerivation;
  readonly runs: readonly RunObservation[];
  /** The share the count had to fit into; undefined where none could be read. */
  readonly memoryBudgetKb: number | undefined;
}

/**
 * Where the consolidated vitest run stands: the count its derivation produced,
 * and what the recorded history had to say about the workload behind it.
 */
export function vitestTaskStatus(inputs: VitestStatusInputs): TaskStatus {
  const { derivation, runs, memoryBudgetKb } = inputs;
  return {
    task: 'vitest-batch',
    concurrency: derivation.workers,
    state: derivationBasis(derivation),
    tuned: true,
    runs,
    note:
      `one test file is one unit, bounded by the same derivation the turbo pool uses: ` +
      `${describeVitestDerivation(derivation)}; ${ONE_VITEST_STORE}; ` +
      describeRecordedWork(runs),
    memory: vitestMemoryAccount(derivation, runs, memoryBudgetKb),
  };
}

/** One vitest row's memory account, over the rows its own store handed it. */
function vitestMemoryAccount(
  derivation: VitestWorkerDerivation,
  runs: readonly RunObservation[],
  budgetKb: number | undefined
): MemoryAccount {
  return memoryAccount({
    runs,
    concurrency: derivation.workers,
    bound: derivation.bound,
    memoryGuarded: derivation.memoryGuarded,
    budgetKb,
  });
}

/**
 * What the recorded rows say about the work behind the vitest runs on record.
 *
 * Every recorded row is read, whatever roster it covered and whichever shape of
 * invocation measured it: one store holds them all. The rows were once filtered
 * to those covering the same number of packages, on the argument that a row over
 * another roster describes other work; the ladder settles that question the
 * other way — it files a peak by the lanes that were live when it was set and
 * compares across set sizes deliberately — so a filter here would be the report
 * holding a rule the derivation has dropped. The span says whose runs it spans,
 * because a single-file run's figure sits in it beside a whole suite's.
 *
 * Work comes from the run's recorded total and from nothing else. The mean file
 * wall beside it averages only the files a run could weigh, while the file
 * count counts every entry the reporter wrote — an entry that failed to collect
 * or was wholly skipped sits in the second and outside the first — so their
 * product reads high, one-sidedly, and by the most on a run that already broke.
 */
function describeRecordedWork(runs: readonly RunObservation[]): string {
  const perWorkerMs = runs
    .filter(
      (run): run is RunObservation & { sumFileWallMs: number } =>
        run.sumFileWallMs !== undefined && run.concurrency > 0
    )
    .map((run) => run.sumFileWallMs / run.concurrency);
  const last = perWorkerMs.at(-1);
  if (last === undefined) {
    return 'no recorded run carries any test work, so nothing on record describes this workload';
  }
  // The span, not the newest alone: a reader shown one figure cannot see how
  // far the rows disagree about the workload that figure stands for.
  if (perWorkerMs.length === 1) {
    return `the one recorded run that weighed its files carried ${seconds(last)} of test work per worker`;
  }
  return (
    `the recorded runs that weighed their files carried ${seconds(Math.min(...perWorkerMs))} to ` +
    `${seconds(Math.max(...perWorkerMs))} of test work per worker, the newest of them ${seconds(last)}`
  );
}

/**
 * One clause explaining where a pool task stands, from its own last run.
 *
 * The bound it opens with comes from the same vocabulary the state column
 * prints, rather than from prose of its own: the note and the column are one
 * claim about one count, and two spellings of it drift the moment either is
 * edited.
 */
export function poolNote(
  basis: { readonly bound: ConcurrencyBound },
  runs: readonly RunObservation[]
): string {
  const last = runs.at(-1);
  if (!last) {
    return `${describeDerivationBound(basis)} — no run on record, so nothing here has held any width`;
  }
  const filled =
    `last run held ${laneUtilization(last).toFixed(2)} of its lanes ` +
    `across ${String(last.taskCount)} task(s) at N=${String(last.concurrency)}`;
  return `${describeDerivationBound(basis)} — ${filled}`;
}

interface PlaywrightStatusInputs {
  /** The count the per-CPU resolver produced for this machine. */
  readonly workers: number;
  /** The per-worker persona pool the same module derives, which has to cover that count. */
  readonly personaPoolSize: number;
}

/**
 * Where the end-to-end run stands: what its worker count is answered from, and
 * the two things beside it a reader needs before treating the figure as the
 * whole story — the pool sized to cover it, and the per-project cap this
 * command cannot see.
 *
 * The cap is named rather than reported because it is declared inside the
 * Playwright configuration, which this command will not load: that file reads
 * the worktree's computed ports at module scope and fails without them, and
 * loading it to read one number would trade this command's one useful property
 * — that it starts nothing — for a figure the reader can go and read.
 */
export function playwrightTaskStatus(inputs: PlaywrightStatusInputs): TaskStatus {
  const { workers, personaPoolSize } = inputs;
  return {
    task: 'playwright',
    concurrency: workers,
    state: 'per-cpu',
    tuned: false,
    runs: [],
    note:
      "the count is what the per-CPU worker registry answers for this machine's processor, " +
      'a fixed share of its logical cores where no entry names it, clamped to that core count; ' +
      'a project may declare a lower cap of its own, which this command does not read; ' +
      `the per-worker persona pool is derived at ${String(personaPoolSize)} so it covers the count; ` +
      'no run of it is recorded here, so this row carries no observation',
  };
}

interface PackageVitestStatusInputs {
  /** What the derivation answered for this machine, and how it got there. */
  readonly derivation: VitestWorkerDerivation;
  /**
   * The rows the one vitest store holds; empty where it holds none. Required
   * rather than optional so that a caller cannot leave the row carrying nothing
   * while the store fills, which is what it did.
   */
  readonly runs: readonly RunObservation[];
  /** The share the count had to fit into; undefined where none could be read. */
  readonly memoryBudgetKb: number | undefined;
}

/**
 * Where a vitest run rooted at a package’s own configuration stands — the shape
 * the watch, single-file and package-test commands take.
 *
 * The row exists because without it the report answers "where did this number
 * come from" for one of the two configurations a run can resolve against, and a
 * reader cannot tell the other opens anything at all.
 *
 * What it can answer is narrower than what such a run decides, in one respect
 * and no more: a watch or single-file invocation derives over the test files it
 * names, and no command knows those before one is typed. Everything else the
 * count rests on is knowable without running anything and is read here exactly
 * as a run reads it. So the row answers over every file on record, and says
 * that is what it answered over, rather than presenting the figure as the count
 * the next invocation opens. A package's own test run narrows nothing and
 * derives over that same repository-wide set, so for that one the row is not
 * standing in for anything.
 */
export function packageVitestTaskStatus(inputs: PackageVitestStatusInputs): TaskStatus {
  const { derivation, runs, memoryBudgetKb } = inputs;
  return {
    task: 'vitest-pkg',
    concurrency: derivation.workers,
    state: derivationBasis(derivation),
    tuned: true,
    runs,
    note:
      "a watch or single-file run rooted at a package's own configuration derives its count " +
      'over the test files the invocation names, which no command can know before one is ' +
      'typed, so this row derives over every file on record instead, bounded the way such a ' +
      `run bounds the files it names: ${describeVitestDerivation(derivation)}; ` +
      'such an invocation names a narrower set and answers for itself, down to one worker ' +
      "for one file, while a package's own test run derives over every file on record just " +
      'as this row does, so that scoping it to one package cannot slow it; ' +
      `${ONE_VITEST_STORE}, and this row and the consolidated row differ only in ` +
      'the units they derive over; ' +
      rowObservationNote(runs),
    memory: vitestMemoryAccount(derivation, runs, memoryBudgetKb),
  };
}
