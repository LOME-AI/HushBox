/**
 * The sweep half of the bound enumeration: every mutant the extractor derives is
 * applied on its own, the oracle is asked, and a mutant the oracle accepts is a
 * survivor — a boundary the suite does not actually pin.
 *
 * Three disciplines are structural rather than advisory. Each mutant is applied
 * to the pristine source read before the sweep began, never to whatever the last
 * mutant left behind, so no two movements are ever measured together. Every
 * mutant is written to a mirror outside the repository, never to the tracked
 * file: the subject is opened for reading and for nothing else, and the write
 * destination is proven to be a file the mirror itself holds by resolving it
 * rather than by reading its spelling. That is what makes a hard kill harmless —
 * there is no restore to skip, because nothing in the tree was ever changed. A
 * mutation left live in a tracked gate source does not merely make a suite lie;
 * it changes what the gate does to real commits. And the oracle is asked about
 * the unmutated mirror before the first mutant, so a sweep that could only ever
 * report kills stops instead of reporting them.
 *
 * The port carries no path for its write. A destination cannot be passed in, so
 * a tracked file cannot be named as one.
 *
 * One limit the operator owns rather than the harness: the oracle is asked once
 * per mutant and there is no repetition, so a flaky oracle yields noise shaped
 * like a map — verdicts that vary run to run over the same mutants, each run
 * carrying a genuinely green baseline. A green baseline establishes that one run
 * was green, never that the oracle is stable. Establish the oracle's determinism
 * before reading a survivor list as one.
 */
import { promises as fs, existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { enumerateBoundMutants, applyBoundMutant, type BoundMutant } from './bound-mutants.js';

/**
 * What the enumeration was last derived over, and what it produced. Without a
 * recorded subject a re-run is a fresh measurement rather than a check: it has
 * nothing to disagree with, and a total that moved for a reason nobody meant
 * reads exactly like a total that did not move at all.
 *
 * The instrument is deliberately outside its own subject. This runner and the
 * extractor are pinned by their unit tests rather than by a sweep, and putting
 * them in the set would make the recorded total a function of the record.
 */
export const SWEPT_SOURCES = ['scripts/privacy-gate.ts', 'scripts/pre-push.ts'] as const;

/** A mutant's movement with its position dropped, which is what the record holds. */
export const boundMovement = (mutant: BoundMutant): string =>
  `${mutant.kind} ${mutant.original} -> ${mutant.replacement}`;

/**
 * Every movement the extractor yields for each swept source, and how many times
 * it yields it. Recorded per source rather than as one sum, so that a source
 * whose population moves is named by the disagreement and two sources moving in
 * opposite directions cannot cancel into an unchanged total. Recorded as
 * movements rather than as a count, because a count is blind to a swap: a
 * threshold retuned or a comparison loosened changes every mutant the sweep
 * would run at that construct while leaving the count exactly where it was.
 * Position is deliberately absent — an offset or a line would make the record
 * rot on any edit above it, at the price of a bound relocated without changing
 * its movement passing unseen. The key type is the swept set, so a source added
 * there without a recorded population does not compile.
 */
export const SWEPT_MUTANT_MOVEMENTS: Readonly<
  Record<(typeof SWEPT_SOURCES)[number], Readonly<Record<string, number>>>
> = {
  'scripts/privacy-gate.ts': {
    'array-index 0 -> -1': 1,
    'array-index 0 -> 1': 1,
    'comparison-strictness > -> >=': 10,
    'numeric-literal 0 -> -1': 27,
    'numeric-literal 0 -> 1': 27,
    'numeric-literal 1 -> 0': 9,
    'numeric-literal 1 -> 2': 9,
    'numeric-literal 12 -> 11': 2,
    'numeric-literal 12 -> 13': 2,
    'numeric-literal 2 -> 1': 1,
    'numeric-literal 2 -> 3': 1,
    'position-predicate .endsWith( -> .includes(': 1,
    'position-predicate .endsWith( -> .startsWith(': 1,
    'position-predicate .startsWith( -> .endsWith(': 1,
    'position-predicate .startsWith( -> .includes(': 1,
  },
  'scripts/pre-push.ts': {
    'numeric-literal 0 -> -1': 1,
    'numeric-literal 0 -> 1': 1,
    'numeric-literal 1 -> 0': 1,
    'numeric-literal 1 -> 2': 1,
    'numeric-literal 2 -> 1': 1,
    'numeric-literal 2 -> 3': 1,
    'numeric-literal 60_000 -> 59999': 1,
    'numeric-literal 60_000 -> 60001': 1,
  },
};

export type MutantVerdict = 'killed' | 'survived';

export interface SweepResult {
  readonly path: string;
  readonly mutant: BoundMutant;
  readonly verdict: MutantVerdict;
}

export interface SweepPort {
  /** The subject as the repository holds it, read once before the first mutant. */
  readonly pristine: string;
  /** Writes one mutant. Takes no path: the destination is fixed when the port is built. */
  readonly writeMutant: (contents: string) => Promise<void>;
  /** True when the oracle rejected the mirror, which is what kills a mutant. */
  readonly rejects: () => Promise<boolean>;
}

/**
 * `subject` is a label for the report, repository-relative and forward-slashed.
 * It reaches no filesystem call from here — the port already knows where it
 * writes.
 */
export async function sweepFile(subject: string, port: SweepPort): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  for (const mutant of enumerateBoundMutants(port.pristine)) {
    await port.writeMutant(applyBoundMutant(port.pristine, mutant));
    results.push({
      path: subject,
      mutant,
      verdict: (await port.rejects()) ? 'killed' : 'survived',
    });
  }
  return results;
}

/**
 * The one guard both write paths pass through. Both operands are resolved through
 * their links first, because a comparison of two spellings is a claim about the
 * filesystem where resolving them is an answer from it: a mirror root linked to the
 * repository root, and a scratch parent linked into the tree, are each spelled
 * outside and each land inside. It names no path in its refusal: an absolute path
 * discloses the host layout, and the caller already knows which destination it
 * asked for.
 */
export function assertOutsideRepository(repoRoot: string, destination: string): void {
  if (isWithin(resolveThroughLinks(repoRoot), resolveThroughLinks(destination))) {
    throw new Error('Refusing to write a mutant inside the repository.');
  }
}

/**
 * The path with every link on it resolved, as deep as the filesystem can answer. A
 * destination that does not exist yet has no real path, so resolution stops at the
 * deepest existing ancestor and the remainder is kept as spelled — the segments
 * that do exist are still answered by the filesystem rather than by their spelling.
 */
function resolveThroughLinks(target: string): string {
  const absolute = path.resolve(target);
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  try {
    return realpathSync(absolute);
  } catch {
    return path.join(resolveThroughLinks(parent), path.basename(absolute));
  }
}

const isWithin = (root: string, target: string): boolean =>
  target === root || target.startsWith(root + path.sep);

/**
 * The destination the port is about to bind, established against the filesystem
 * rather than against its own spelling. Two shapes make the lexical answer wrong
 * and both have been observed writing into a tracked file: a subject that is
 * itself a symlink is mirrored as a symlink, because the copy does not
 * dereference, so the mutant write follows it home; and a subject whose top-level
 * segment does not string-match the entry the mirror copied — a case or
 * normalisation difference the host still resolves — is reached through the
 * linked directory instead. So the mirror must hold the subject as a regular file
 * it copied, and that file must still be under the mirror once every link on the
 * way has been resolved. Neither refusal names a path: the path is the host
 * layout, and the caller already knows which subject it asked for.
 */
async function assertMirrorHoldsSubject(mirrorRoot: string, destination: string): Promise<void> {
  const entry = await fs.lstat(destination).catch(() => undefined);
  if (!entry?.isFile()) {
    throw new Error('Refusing a subject the mirror does not hold as a file it copied.');
  }
  if (!isWithin(await fs.realpath(mirrorRoot), await fs.realpath(destination))) {
    throw new Error('Refusing a destination that resolves outside the mirror.');
  }
}

const isPlainSegment = (segment: string): boolean =>
  segment !== '' && segment !== '.' && segment !== '..' && !segment.includes(path.win32.sep);

/**
 * A subject names one file under one top-level directory, forward-slashed. This
 * refusal is early and cheap enough to run before the mirror exists, which is why
 * `mirrorRepository` can use it before its first `mkdtemp` — but it is not what
 * makes containment hold, and no rule over the string could be. The mirror's
 * other top-level entries are links back into the repository, so whether a
 * destination stays inside the mirror is a question about the filesystem;
 * `assertMirrorHoldsSubject` asks it once there is a mirror to ask about.
 */
function assertPlainSubject(subject: string): void {
  if (
    path.win32.isAbsolute(subject) ||
    !subject.split('/').every((segment) => isPlainSegment(segment))
  ) {
    throw new Error('Refusing a subject that is not a plain repository-relative path.');
  }
}

const withoutModules = (source: string): boolean => path.basename(source) !== 'node_modules';

/**
 * A directory holding a subject is copied as real files, because module
 * resolution follows a symlink to its target: a linked source file would import
 * the tracked original and the mutant would never be under test. Only the
 * directory's own installed modules are linked back — a nested package's are
 * not, so a subject deeper than a top-level package fails loudly at resolution
 * rather than quietly measuring the wrong tree.
 */
async function copySubjectDirectory(source: string, destination: string): Promise<void> {
  await fs.cp(source, destination, { recursive: true, filter: withoutModules });
  const modules = path.join(source, 'node_modules');
  if (existsSync(modules)) {
    await fs.symlink(modules, path.join(destination, 'node_modules'), 'junction');
  }
}

/**
 * Builds the tree the oracle runs in. Everything the subject does not live in is
 * linked rather than copied, because a full copy of this repository is gigabytes;
 * top-level files are copied rather than linked, since a file symlink needs a
 * privilege Windows does not grant by default. No git directory is copied, so
 * the mirror root is not a repository — but a linked top-level directory still
 * is, because a query run inside one resolves through the link, and that is
 * where a monorepo task runner puts an upstream package's work.
 *
 * Building the mirror is all this does; removing it belongs to whoever asked for
 * one, because only that caller knows when the oracle has stopped reading it.
 * {@link runSweep} is that caller for a sweep.
 */
export async function mirrorRepository(
  repoRoot: string,
  subjects: readonly string[],
  scratchParent: string
): Promise<string> {
  assertOutsideRepository(repoRoot, scratchParent);
  for (const subject of subjects) assertPlainSubject(subject);
  const mirrorRoot = await fs.mkdtemp(path.join(scratchParent, 'hushbox-bound-sweep-'));
  // Exact string equality here is no longer load-bearing on containment: a case or
  // normalisation mismatch links the directory instead, and a destination reached
  // through a link is refused by resolution — with no hint that spelling was the cause.
  const carriesSubject = new Set(subjects.map((subject) => subject.split('/')[0]));
  for (const entry of await fs.readdir(repoRoot, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const source = path.join(repoRoot, entry.name);
    const destination = path.join(mirrorRoot, entry.name);
    if (!entry.isDirectory()) await fs.copyFile(source, destination);
    else if (carriesSubject.has(entry.name)) await copySubjectDirectory(source, destination);
    else await fs.symlink(source, destination, 'junction');
  }
  return mirrorRoot;
}

/** Reads the subject from the repository and binds every write to the mirror. */
export async function mirroredPort(
  repoRoot: string,
  mirrorRoot: string,
  subject: string,
  rejects: () => Promise<boolean>
): Promise<SweepPort> {
  assertPlainSubject(subject);
  const segments = subject.split('/');
  const destination = path.join(mirrorRoot, ...segments);
  assertOutsideRepository(repoRoot, destination);
  await assertMirrorHoldsSubject(mirrorRoot, destination);
  const pristine = await fs.readFile(path.join(repoRoot, ...segments), 'utf8');
  return {
    pristine,
    writeMutant: (contents) => fs.writeFile(destination, contents, 'utf8'),
    rejects,
  };
}

interface OracleOutcome {
  /** The oracle rejected the tree it was pointed at, which is what kills a mutant. */
  readonly rejected: boolean;
  /** Everything the oracle said, so a refusal can show why it was already red. */
  readonly output: string;
}

/** Asks the oracle about one tree. The mirror root is the working directory. */
type Oracle = (cwd: string) => Promise<OracleOutcome>;

/** Runs a shell command in the given tree and reads its exit status as the verdict. */
export function commandOracle(command: string): Oracle {
  return async (cwd: string): Promise<OracleOutcome> => {
    const run = await execa(command, { shell: true, reject: false, all: true, cwd });
    return { rejected: run.exitCode !== 0, output: run.all };
  };
}

/**
 * Builds the mirror, establishes that the oracle is green on it unmutated, and
 * sweeps every subject. Without the baseline an oracle that cannot run *in the
 * mirror* rejects every mutant and the sweep reports a clean kill of everything
 * while measuring nothing — a false kill hides a real gap, which is the one
 * direction a survivor map must never err in. The refusal carries the baseline
 * run's own output, because a sweep that stops without saying why is no more
 * diagnosable than the false map it replaced.
 */
export async function runSweep(
  repoRoot: string,
  subjects: readonly string[],
  scratchParent: string,
  oracle: Oracle
): Promise<SweepResult[]> {
  const mirrorRoot = await mirrorRepository(repoRoot, subjects, scratchParent);
  try {
    const baseline = await oracle(mirrorRoot);
    if (baseline.rejected) {
      throw new Error(
        `The oracle is red on the unmutated mirror, so a sweep would measure nothing rather than ` +
          `report it. What the baseline run said:\n${baseline.output}`
      );
    }
    const rejects = async (): Promise<boolean> => {
      const outcome = await oracle(mirrorRoot);
      return outcome.rejected;
    };
    const results: SweepResult[] = [];
    for (const subject of subjects) {
      const port = await mirroredPort(repoRoot, mirrorRoot, subject, rejects);
      results.push(...(await sweepFile(subject, port)));
    }
    return results;
  } finally {
    // Recursive removal unlinks a symlink instead of descending it, which is
    // what keeps this off the repository the mirror's other top-level entries
    // link back to; `scripts/lib/scratch-directory.test.ts` pins that semantic.
    await fs.rm(mirrorRoot, { recursive: true, force: true });
  }
}

const locate = (result: SweepResult): string =>
  `${result.path}:${String(result.mutant.line)} ${boundMovement(result.mutant)}`;

export function formatSweepReport(results: readonly SweepResult[]): string {
  if (results.length === 0) return 'No bound-bearing construct: nothing to sweep.';
  const survivors = results.filter((result) => result.verdict === 'survived');
  const tally = `${String(results.length - survivors.length)} of ${String(results.length)} mutants killed`;
  if (survivors.length === 0) return `${tally}; no survivor.`;
  return [`${tally}; survivors:`, ...survivors.map((result) => `  ${locate(result)}`)].join('\n');
}

/* v8 ignore start -- CLI entry point, exercised by running the sweep */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const [oracle = '', ...subjects] = process.argv.slice(2);
    if (oracle === '' || subjects.length === 0) {
      throw new Error('Usage: bound-sweep.ts <oracle command> <repository-relative file>...');
    }
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const results = await runSweep(repoRoot, subjects, os.tmpdir(), commandOracle(oracle));
    console.log(formatSweepReport(results));
    return 0;
  });
}
/* v8 ignore stop */
