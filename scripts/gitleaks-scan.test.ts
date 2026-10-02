import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
// Auto-spy keeps the real filesystem under every case here — the trees these
// assertions read are trees the filesystem holds — while letting the cases
// about a reclaim that cannot finish force a call to reject.
vi.mock('node:fs/promises', { spy: true });
// Only the installer is faked: `runGitleaks` — the shared ensure-then-run
// helper this wrapper delegates to — stays real, so these assertions run
// through it rather than around it. The scratch-directory helper stays real
// too, so the extraction directory these tests read is one the filesystem
// actually holds and actually loses.
vi.mock('./lib/privacy/gitleaks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/privacy/gitleaks.js')>()),
  ensureGitleaks: vi.fn(),
}));

import { execa } from 'execa';
import { DAY_MS, MINUTE_MS } from '@hushbox/shared/test-time';
import { ensureGitleaks } from './lib/privacy/gitleaks.js';
import {
  ABANDONED_AFTER_MS,
  abortOnTermination,
  GITLEAKS_SCAN_ARGS,
  runGitleaksScan,
} from './gitleaks-scan.js';
import type { PathLike, RmOptions } from 'node:fs';

const execaMock = vi.mocked(execa);
const ensureMock = vi.mocked(ensureGitleaks);
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const BINARY = 'gitleaks-binary';
const REPO = 'repo-root';
const GIT_DIAGNOSIS = 'fatal: not a valid object name: no-such-revision';

/** As much of a finished process as these assertions and the code under test read. */
interface ProcessResult {
  readonly exitCode?: number;
  readonly stderr?: string;
}

/** The `execa` options these assertions read. */
interface RecordedOptions {
  readonly cwd?: string;
  readonly buffer?: unknown;
  readonly cancelSignal?: unknown;
  readonly cleanup?: unknown;
}

/** What the faked processes were asked to do, recorded as they were asked. */
interface Invocations {
  archive: readonly string[];
  archiveOptions: RecordedOptions | undefined;
  extract: readonly string[];
  extractOptions: RecordedOptions | undefined;
  scan: readonly string[];
  scanOptions: RecordedOptions | undefined;
}

/** How each of the three processes a run spawns is to finish. */
interface Spawns {
  readonly scan: () => Promise<ProcessResult>;
  readonly archived?: ProcessResult;
  readonly extracted?: ProcessResult;
  /** Runs the moment the archive is spawned, for whatever befalls a run in flight. */
  readonly whileArchiving?: () => void;
}

let invocations: Invocations;

const SUCCEEDED: ProcessResult = { exitCode: 0, stderr: '' };

/**
 * Fakes both processes the scan spawns. `execa`'s published type is a set of
 * overloads no hand-written function inhabits, so the implementation is written
 * against the two call shapes this module uses and asserted into the library's
 * type at the single line that installs it; restating the real signature would
 * add nothing the assertions below read.
 */
function stubExeca({
  scan,
  archived = SUCCEEDED,
  extracted = SUCCEEDED,
  whileArchiving,
}: Spawns): void {
  const implementation = (
    file: string,
    args: readonly string[],
    options?: RecordedOptions
  ): unknown => {
    if (file === 'git') {
      invocations.archive = args;
      invocations.archiveOptions = options;
      whileArchiving?.();
      // The archive is awaited for its own result *and* piped, so the fake is
      // both, exactly as the library's subprocess is.
      return Object.assign(Promise.resolve(archived), {
        pipe: (
          tarFile: string,
          tarArgs: readonly string[],
          tarOptions?: RecordedOptions
        ): Promise<ProcessResult> => {
          invocations.extract = [tarFile, ...tarArgs];
          invocations.extractOptions = tarOptions;
          return Promise.resolve(extracted);
        },
      });
    }
    invocations.scan = args;
    invocations.scanOptions = options;
    return scan();
  };
  execaMock.mockImplementation(
    implementation as unknown as Parameters<typeof execaMock.mockImplementation>[0]
  );
}

/** Where the extraction was told to write, read back off the `tar` line. */
function extractionDirectory(): string {
  const at = invocations.extract.indexOf('-C');
  return invocations.extract[at + 1] ?? '';
}

function resolveWith(exitCode?: number): void {
  stubExeca({ scan: () => Promise.resolve(exitCode === undefined ? {} : { exitCode }) });
}

/** The message a rejected scan carries, as a developer reads it. */
async function failureOf(revision: string): Promise<string> {
  try {
    await runGitleaksScan(REPO, revision);
    return '';
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Where these runs materialise, and where the reclaim below sweeps: a fixture
 * directory of this case's own, so a sweep reaches what the case put there and
 * nothing another run on this machine left. `os.tmpdir()` reads `TMPDIR` on
 * POSIX and `TEMP`/`TMP` on Windows, and reads them on every call.
 */
let temporaryLocation = '';

const TEMPORARY_LOCATION_VARIABLES = ['TMPDIR', 'TEMP', 'TMP'];

/** A tree a run left in the temporary location, aged as the filesystem records age. */
function abandonedTree(name: string, ageMs: number): string {
  const tree = path.join(temporaryLocation, `hushbox-gitleaks-tree-${name}`);
  mkdirSync(tree);
  writeFileSync(path.join(tree, 'extracted'), 'what the extraction wrote');
  const seconds = (Date.now() - ageMs) / 1000;
  utimesSync(tree, seconds, seconds);
  return tree;
}

beforeEach(() => {
  vi.resetAllMocks();
  temporaryLocation = mkdtempSync(path.join(tmpdir(), 'hushbox-gitleaks-scan-case-'));
  for (const variable of TEMPORARY_LOCATION_VARIABLES) vi.stubEnv(variable, temporaryLocation);
  ensureMock.mockResolvedValue(BINARY);
  invocations = {
    archive: [],
    archiveOptions: undefined,
    extract: [],
    extractOptions: undefined,
    scan: [],
    scanOptions: undefined,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(temporaryLocation, { recursive: true, force: true });
});

describe('runGitleaksScan', () => {
  it('materialises the revision from git objects rather than reading the checkout', async () => {
    resolveWith(0);

    await runGitleaksScan(REPO, 'HEAD');

    expect(invocations.archive).toEqual(['-C', REPO, 'archive', '--format=tar', 'HEAD']);
  });

  it('extracts that archive into the directory it scans', async () => {
    resolveWith(0);

    await runGitleaksScan(REPO, 'HEAD');

    expect(invocations.extract).toEqual(['tar', '-xf', '-', '-C', extractionDirectory()]);
    expect(extractionDirectory()).not.toBe('');
  });

  // Measured, not reasoned: the process library caps what it collects from a
  // stream, and this archive is far past that cap. Left to buffer, the pipe is
  // cut mid-stream and the extraction fails on a truncated archive rather than
  // on anything about the tree. Standard error is small and is collected,
  // because it is the only place git says what it could not resolve.
  it('streams the archive through while collecting what git says about it', async () => {
    resolveWith(0);

    await runGitleaksScan(REPO, 'HEAD');

    expect(invocations.archiveOptions?.buffer).toEqual({ stdout: false });
    expect(invocations.extractOptions?.buffer).toBe(false);
  });

  it('names the revision and git’s own diagnosis when the revision cannot be resolved', async () => {
    stubExeca({
      scan: () => Promise.resolve({ exitCode: 0 }),
      archived: { exitCode: 128, stderr: `${GIT_DIAGNOSIS}\n` },
      extracted: { exitCode: 2 },
    });

    const failure = await failureOf('no-such-revision');

    expect(failure).toContain('cannot materialise revision no-such-revision');
    expect(failure).toContain(GIT_DIAGNOSIS);
    expect(failure).not.toContain('tar');
  });

  it('reports both exit statuses when the extraction fails and git said nothing', async () => {
    stubExeca({
      scan: () => Promise.resolve({ exitCode: 0 }),
      extracted: { exitCode: 2 },
    });

    const failure = await failureOf('HEAD');

    expect(failure).toContain('cannot materialise revision HEAD');
    expect(failure).toContain('2');
  });

  // git can exit 0 having printed a warning, and the failure is then the
  // extraction's. Reading the reason off whatever git said sends the developer
  // after the tool that worked and drops the status of the one that did not.
  it('reports the extraction’s status when git succeeded while printing a warning', async () => {
    stubExeca({
      scan: () => Promise.resolve({ exitCode: 0 }),
      archived: { exitCode: 0, stderr: 'warning: ignoring broken ref refs/heads/bent\n' },
      extracted: { exitCode: 2 },
    });

    const failure = await failureOf('HEAD');

    expect(failure).toContain('the extraction exited 2');
    expect(failure).toContain('git exited 0');
  });

  // The failure is built from the finished processes rather than from the
  // library's own text, which quotes the whole `tar` command line — and with it
  // an extraction path that on Windows names the account the work happened on.
  it('names no path of its own in the failure it reports', async () => {
    stubExeca({
      scan: () => Promise.resolve({ exitCode: 0 }),
      extracted: { exitCode: 2 },
    });

    const failure = await failureOf('HEAD');

    expect(failure).not.toContain(extractionDirectory());
    expect(failure.split(/\s+/).filter((word) => path.isAbsolute(word))).toEqual([]);
  });

  // A killed run is the hook's commonest failure: the parallel runner ends
  // every sibling as soon as one check fails. Blaming the revision there sends
  // the developer after a tree that was never in doubt.
  it('says the run was terminated rather than blaming the revision', async () => {
    stubExeca({
      scan: () => Promise.resolve({ exitCode: 0 }),
      archived: { stderr: '' },
      extracted: {},
      whileArchiving: () => {
        process.emit('SIGTERM');
      },
    });

    const failure = await failureOf('HEAD');

    expect(failure).toContain('terminated');
    expect(failure).not.toContain('cannot materialise');
  });

  it('materialises the revision it was given rather than always the tip', async () => {
    resolveWith(0);

    await runGitleaksScan(REPO, 'other-revision');

    expect(invocations.archive).toContain('other-revision');
  });

  it('scans the tip when no revision is named', async () => {
    resolveWith(0);

    await runGitleaksScan(REPO);

    expect(invocations.archive).toContain('HEAD');
  });

  it('runs the scanner with its working directory inside the materialised tree', async () => {
    resolveWith(0);

    await runGitleaksScan(REPO, 'HEAD');

    expect(invocations.scanOptions?.cwd).toBe(extractionDirectory());
  });

  // The whole gate rests on this spelling. gitleaks resolves its configuration
  // from the target path and reports findings relative to it, so an absolute
  // target stops every path-anchored allowlist in `.gitleaks.toml` from
  // matching and the scan reports hundreds of already-exempt lines instead of
  // the handful that are real.
  it('gives the scanner a relative target, never a path of its own', async () => {
    resolveWith(0);

    await runGitleaksScan(REPO, 'HEAD');

    expect(invocations.scan).toEqual([...GITLEAKS_SCAN_ARGS]);
    expect(invocations.scan[1]).toBe('.');
    expect(invocations.scan.filter((argument) => path.isAbsolute(argument))).toEqual([]);
  });

  // Without this every process the run spawned outlives the signal that ended
  // it, and `tar` keeps filling a directory nothing will ever remove.
  it('hands every process it spawns the run’s cancel signal', async () => {
    resolveWith(0);

    await runGitleaksScan(REPO, 'HEAD');

    expect(invocations.archiveOptions?.cancelSignal).toBeInstanceOf(AbortSignal);
    expect(invocations.extractOptions?.cancelSignal).toBeInstanceOf(AbortSignal);
    expect(invocations.scanOptions?.cancelSignal).toBeInstanceOf(AbortSignal);
  });

  // The library's own exit hook re-raises the signal it handled, which kills
  // node before the unwind that removes the materialised tree can reach the
  // removal. The cancel signal above ends the same subprocesses from inside
  // that unwind instead.
  it('leaves subprocess termination to the cancel signal rather than to the library’s exit hook', async () => {
    resolveWith(0);

    await runGitleaksScan(REPO, 'HEAD');

    expect(invocations.archiveOptions?.cleanup).toBe(false);
    expect(invocations.extractOptions?.cleanup).toBe(false);
    expect(invocations.scanOptions?.cleanup).toBe(false);
  });

  it('stops listening for termination once the scan is over', async () => {
    resolveWith(0);
    const before = process.listenerCount('SIGTERM');

    await runGitleaksScan(REPO, 'HEAD');

    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('removes the materialised tree once the scan is done', async () => {
    resolveWith(0);

    await runGitleaksScan(REPO, 'HEAD');

    expect(existsSync(extractionDirectory())).toBe(false);
  });

  it('removes the materialised tree when the scan fails outright', async () => {
    stubExeca({ scan: () => Promise.reject(new Error('scanner died')) });

    await expect(runGitleaksScan(REPO, 'HEAD')).rejects.toThrow('scanner died');

    expect(extractionDirectory()).not.toBe('');
    expect(existsSync(extractionDirectory())).toBe(false);
  });

  it('passes a clean scan through', async () => {
    resolveWith(0);

    await expect(runGitleaksScan(REPO, 'HEAD')).resolves.toBe(0);
  });

  it('fails the step when the scanner reports findings', async () => {
    resolveWith(1);

    await expect(runGitleaksScan(REPO, 'HEAD')).resolves.toBe(1);
  });

  it('fails when the scanner died without an exit code', async () => {
    resolveWith();

    await expect(runGitleaksScan(REPO, 'HEAD')).resolves.toBe(1);
  });

  it('redacts findings rather than printing the bytes it matched', () => {
    expect(GITLEAKS_SCAN_ARGS).toContain('--redact');
  });

  // A run killed while its own removal was still running leaves its
  // materialised tree where nothing else collects it. The next run collects it,
  // which is what keeps the leak bounded rather than permanent.
  describe('the trees earlier runs abandoned', () => {
    it('removes one left past the window, before materialising its own', async () => {
      const abandoned = abandonedTree('abandoned', ABANDONED_AFTER_MS + MINUTE_MS);
      let stillThereWhenMaterialising = true;
      stubExeca({
        scan: () => Promise.resolve({ exitCode: 0 }),
        whileArchiving: () => {
          stillThereWhenMaterialising = existsSync(abandoned);
        },
      });

      await runGitleaksScan(REPO, 'HEAD');

      expect(existsSync(abandoned)).toBe(false);
      expect(stillThereWhenMaterialising).toBe(false);
    });

    // A tree's modification time stops advancing the moment its extraction
    // finishes, so inside the window a run that is merely wedged looks exactly
    // like one that was abandoned — and taking a live run's tree away from it
    // would have this gate report fewer findings than the tree carries.
    it('leaves a tree inside the window where it is', async () => {
      resolveWith(0);
      const live = abandonedTree('live', ABANDONED_AFTER_MS - MINUTE_MS);

      await runGitleaksScan(REPO, 'HEAD');

      expect(existsSync(live)).toBe(true);
    });

    it('leaves a directory outside the prefix alone at any age', async () => {
      resolveWith(0);
      const neighbours = ['hushbox-gitleaks-trees', 'someone-elses-work'].map((name) => {
        const directory = path.join(temporaryLocation, name);
        mkdirSync(directory);
        const seconds = (Date.now() - 365 * DAY_MS) / 1000;
        utimesSync(directory, seconds, seconds);
        return directory;
      });

      await runGitleaksScan(REPO, 'HEAD');

      expect(neighbours.filter((directory) => existsSync(directory))).toEqual(neighbours);
    });

    // A prefixed name in a world-writable location can be a symbolic link to
    // something valuable. The age the sweep reads is the target's, because
    // `stat` follows the link; the removal unlinks instead of descending, which
    // is the whole of why the sweep never deletes outside that location.
    it('unlinks a prefixed symbolic link rather than descending into its target', async () => {
      resolveWith(0);
      const target = path.join(temporaryLocation, 'not-a-tree');
      mkdirSync(target);
      const survivor = path.join(target, 'survivor.txt');
      writeFileSync(survivor, 'contents');
      const seconds = (Date.now() - (ABANDONED_AFTER_MS + MINUTE_MS)) / 1000;
      utimesSync(target, seconds, seconds);
      const link = path.join(temporaryLocation, 'hushbox-gitleaks-tree-link');
      symlinkSync(target, link, 'junction');

      await runGitleaksScan(REPO, 'HEAD');

      expect(existsSync(link)).toBe(false);
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(survivor, 'utf8')).toBe('contents');
    });

    // A gate that refuses to run because it could not tidy up is worse than the
    // bytes it did not reclaim, so a refused removal is skipped rather than
    // raised — and the trees behind it are still reclaimed.
    it('scans on when a tree it found cannot be removed', async () => {
      resolveWith(0);
      // The refusal lands on whichever tree the listing hands over first, so
      // this tells a per-entry skip from a sweep that stops at the first
      // refusal whatever order the listing returns.
      const abandoned = [
        abandonedTree('one', ABANDONED_AFTER_MS + MINUTE_MS),
        abandonedTree('another', ABANDONED_AFTER_MS + MINUTE_MS),
      ];
      let refused = '';
      vi.mocked(rm).mockImplementation((target: PathLike, options?: RmOptions): Promise<void> => {
        if (refused !== '') return realFs.rm(target, options);
        refused = String(target);
        return Promise.reject(new Error('refused'));
      });

      await expect(runGitleaksScan(REPO, 'HEAD')).resolves.toBe(0);

      expect(abandoned.filter((tree) => existsSync(tree))).toEqual([refused]);
    });

    it('scans on when the temporary location cannot be listed', async () => {
      resolveWith(0);
      vi.mocked(readdir).mockRejectedValue(new Error('cannot be listed'));

      await expect(runGitleaksScan(REPO, 'HEAD')).resolves.toBe(0);
    });
  });
});

describe('abortOnTermination', () => {
  it('aborts when another pre-push check kills this one', () => {
    const termination = abortOnTermination();

    try {
      process.emit('SIGTERM');

      expect(termination.signal.aborted).toBe(true);
    } finally {
      termination.release();
    }
  });

  it('aborts when the developer interrupts the hook', () => {
    const termination = abortOnTermination();

    try {
      process.emit('SIGINT');

      expect(termination.signal.aborted).toBe(true);
    } finally {
      termination.release();
    }
  });

  it('leaves no listener behind once released', () => {
    const before = process.listenerCount('SIGINT');
    const termination = abortOnTermination();

    termination.release();

    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
