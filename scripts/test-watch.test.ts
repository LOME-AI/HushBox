import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { LIFELINE_ENV, closeProcessLifeline } from './lib/spawn/long-lived.js';
import { RUN_CLAIM_ENV } from './lib/claims/registry.js';
import {
  deriveWatchWorkers,
  emptyRunNotice,
  findOwningPackageDir,
  planInvocation,
  runVitest,
  splitCoverageRequest,
  type CoverageRun,
  type Invocation,
  type WatchFs,
  type WatchRunDeps,
} from './test-watch.js';
import { measureVitestRun } from './run-package-tests.js';
import { coverageIncludeFor, modulesUnderTest } from './lib/test-run/file-coverage.js';
import { partialCoverageReason } from './lib/vitest/coverage-scope.js';
import { VITEST_LEDGER_TASK, recordVitestRun } from './lib/vitest/workers.js';
import { MAX_RUNS_PER_SHAPE, ledgerPath, readLedger } from './lib/pool/ledger.js';
import { batchRunRecord } from './test-batch.js';
import type { VitestJsonReport } from './lib/test-run/test-report.js';
import type { LedgerEntry, PoolLedger } from './lib/pool/ledger.js';
import type { RunObservation } from './lib/pool/schedule.js';
import type { VitestWorkerDerivation } from './lib/vitest/workers.js';

const mockExeca = vi.mocked(execa);

/**
 * The socket this worker answers its children on goes when the file that made
 * it is done, rather than staying until the runner signals the worker — which
 * reaches no handler and would leave the file behind.
 */
afterAll(async () => {
  await closeProcessLifeline();
});

const ROOT = path.resolve('/repo');

/**
 * A count no default produces, so a launch line carrying it can only have taken
 * it from the derivation handed to the run.
 */
const DERIVED: VitestWorkerDerivation = {
  workers: 7,
  state: 'derived',
  bound: 'memory',
  memoryCapped: true,
  memoryGuarded: true,
  units: 12,
};

/**
 * Fake fs: `files` are existing files, `packageDirs` contain a package.json,
 * `extraDirs` exist as directories without one. Package dirs also exist as
 * directories (as on a real disk).
 */
function fakeFs(
  files: readonly string[],
  packageDirectories: readonly string[],
  extraDirectories: readonly string[] = []
): WatchFs {
  const fileSet = new Set(files.map((f) => path.resolve(f)));
  const packageSet = new Set(packageDirectories.map((d) => path.resolve(d)));
  const dirSet = new Set([...packageSet, ...extraDirectories.map((d) => path.resolve(d))]);
  return {
    isFile: (p) => fileSet.has(path.resolve(p)),
    isDirectory: (p) => dirSet.has(path.resolve(p)),
    listDirectory: () => [],
    hasPackageJson: (dir) => packageSet.has(path.resolve(dir)),
  };
}

/**
 * What `spawnLongLived` reads off a subprocess: a pid, and — under the runtime
 * process the library wraps, which is the only place the library carries it —
 * the status it already holds and the exit it announces. A child that has not
 * ended carries neither a code nor a signal, and the exit is an event rather
 * than the resolution of the subprocess itself, because that resolution is an
 * answer about the streams as much as about the process.
 */
function fakeChild(exitCode?: number): ReturnType<typeof execa> {
  return Object.assign(Promise.resolve({ exitCode }), {
    pid: 4321,
    stdio: [null, null, null],
    nodeChildProcess: {
      exitCode: null,
      signalCode: null,
      on: (event: string, handler: (code: number | null) => void): void => {
        if (event !== 'exit') return;
        setImmediate(() => {
          handler(exitCode ?? null);
        });
      },
    },
  }) as unknown as ReturnType<typeof execa>;
}

describe('findOwningPackageDir', () => {
  it('returns the nearest ancestor directory containing a package.json', () => {
    const fs = fakeFs([], [ROOT, path.join(ROOT, 'apps/web')]);
    const dir = findOwningPackageDir(path.join(ROOT, 'apps/web/src/foo.test.tsx'), ROOT, fs);
    expect(dir).toBe(path.join(ROOT, 'apps/web'));
  });

  it('returns the root when no intermediate package.json exists', () => {
    const fs = fakeFs([], [ROOT]);
    const dir = findOwningPackageDir(path.join(ROOT, 'e2e/foo.test.ts'), ROOT, fs);
    expect(dir).toBe(ROOT);
  });

  it('throws a clear error when no package.json exists up to the root', () => {
    const fs = fakeFs([], []);
    expect(() => findOwningPackageDir(path.join(ROOT, 'a/b.ts'), ROOT, fs)).toThrow(
      'test:watch: no package.json found'
    );
  });
});

describe('planInvocation', () => {
  it('keeps the invocation directory and empty args for watch-all usage', () => {
    const plan = planInvocation([], ROOT, fakeFs([], [ROOT]));
    expect(plan).toEqual({ cwd: ROOT, args: [], paths: [] });
  });

  it('passes a flag through unchanged rather than classifying it as a path', () => {
    const plan = planInvocation(['--ui'], ROOT, fakeFs([], [ROOT]));
    expect(plan).toEqual({ cwd: ROOT, args: ['--ui'], paths: [] });
  });

  it('runs from the owning package directory for a single package file', () => {
    const file = path.join(ROOT, 'apps/web/src/foo.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    const plan = planInvocation(['apps/web/src/foo.test.tsx'], ROOT, fs);
    expect(plan).toEqual({ cwd: path.join(ROOT, 'apps/web'), args: [file], paths: [file] });
  });

  it('accepts multiple files from the same package', () => {
    const a = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const b = path.join(ROOT, 'apps/web/src/b.test.ts');
    const fs = fakeFs([a, b], [ROOT, path.join(ROOT, 'apps/web')]);
    const plan = planInvocation(
      ['apps/web/src/a.test.tsx', 'apps/web/src/b.test.ts', '--run'],
      ROOT,
      fs
    );
    expect(plan).toEqual({
      cwd: path.join(ROOT, 'apps/web'),
      args: [a, b, '--run'],
      paths: [a, b],
    });
  });

  it('detects the owning package for an existing directory argument', () => {
    const dir = path.join(ROOT, 'apps/api/src/slices/chat');
    const fs = fakeFs([], [ROOT, path.join(ROOT, 'apps/api')], [dir]);
    const plan = planInvocation(['apps/api/src/slices/chat'], ROOT, fs);
    expect(plan).toEqual({ cwd: path.join(ROOT, 'apps/api'), args: [dir], paths: [dir] });
  });

  it('errors clearly when files span multiple packages', () => {
    const web = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const api = path.join(ROOT, 'apps/api/src/b.test.ts');
    const fs = fakeFs([web, api], [ROOT, path.join(ROOT, 'apps/web'), path.join(ROOT, 'apps/api')]);
    expect(() =>
      planInvocation(['apps/web/src/a.test.tsx', 'apps/api/src/b.test.ts'], ROOT, fs)
    ).toThrow('test:watch: files span multiple packages');
  });

  it('stays in the invocation directory for a file owned by the root package', () => {
    const file = path.join(ROOT, 'e2e/foo.test.ts');
    const fs = fakeFs([file], [ROOT]);
    const plan = planInvocation(['e2e/foo.test.ts'], ROOT, fs);
    expect(plan).toEqual({ cwd: ROOT, args: [file], paths: [file] });
  });

  it('runs from the owning package directory when a root-owned path is named beside a package file', () => {
    const rootOwned = path.join(ROOT, 'e2e/foo.test.ts');
    const packageOwned = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const fs = fakeFs([rootOwned, packageOwned], [ROOT, path.join(ROOT, 'apps/web')]);
    const plan = planInvocation(['e2e/foo.test.ts', 'apps/web/src/a.test.tsx'], ROOT, fs);
    expect(plan).toEqual({
      cwd: path.join(ROOT, 'apps/web'),
      args: [rootOwned, packageOwned],
      paths: [rootOwned, packageOwned],
    });
  });

  it('rejects a positional that resolves to nothing', () => {
    const fs = fakeFs([], [ROOT, path.join(ROOT, 'apps/web')]);
    expect(() => planInvocation(['apps/web/src/typo.test.tsx'], ROOT, fs)).toThrow(
      'test:watch: no such file or directory'
    );
  });

  it('names the resolved location and the filter flag when a positional resolves to nothing', () => {
    const fs = fakeFs([], [ROOT]);
    expect(() => planInvocation(['src/typo.test.ts'], ROOT, fs)).toThrow(
      new RegExp(String.raw`${path.join(ROOT, 'src/typo.test.ts')}[\s\S]*--path-filter`)
    );
  });

  it('rejects a non-existent positional standing beside an existing one', () => {
    const file = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    expect(() =>
      planInvocation(['apps/web/src/a.test.tsx', 'apps/web/src/typo.test.tsx'], ROOT, fs)
    ).toThrow('test:watch: no such file or directory');
  });

  it('passes a --path-filter value to vitest as a bare positional filter', () => {
    const fs = fakeFs([], [ROOT, path.join(ROOT, 'apps/web')]);
    const plan = planInvocation(['--path-filter', 'thinking-disclosure'], ROOT, fs);
    expect(plan).toEqual({ cwd: ROOT, args: ['thinking-disclosure'], paths: [] });
  });

  it('accepts the --path-filter=value spelling', () => {
    const fs = fakeFs([], [ROOT]);
    const plan = planInvocation(['--path-filter=thinking-disclosure'], ROOT, fs);
    expect(plan).toEqual({ cwd: ROOT, args: ['thinking-disclosure'], paths: [] });
  });

  it('runs a --path-filter from the package directory of an existing path beside it', () => {
    const file = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    const plan = planInvocation(['apps/web/src/a.test.tsx', '--path-filter', 'renders'], ROOT, fs);
    expect(plan).toEqual({
      cwd: path.join(ROOT, 'apps/web'),
      args: [file, 'renders'],
      paths: [file],
    });
  });

  it('rejects a --path-filter with no value after it', () => {
    const fs = fakeFs([], [ROOT]);
    expect(() => planInvocation(['--path-filter'], ROOT, fs)).toThrow(
      'test:watch: --path-filter needs a substring'
    );
  });

  it('rejects a --path-filter given an empty substring', () => {
    const fs = fakeFs([], [ROOT]);
    expect(() => planInvocation(['--path-filter='], ROOT, fs)).toThrow(
      'test:watch: --path-filter needs a substring'
    );
  });

  it('keeps a leading vitest subcommand out of path checking', () => {
    const file = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    const plan = planInvocation(['run', 'apps/web/src/a.test.tsx'], ROOT, fs);
    expect(plan).toEqual({ cwd: path.join(ROOT, 'apps/web'), args: ['run', file], paths: [file] });
  });

  it('keeps a subcommand that follows a flag out of path checking', () => {
    const fs = fakeFs([], [ROOT]);
    const plan = planInvocation(['--ui', 'run'], ROOT, fs);
    expect(plan).toEqual({ cwd: ROOT, args: ['--ui', 'run'], paths: [] });
  });

  it('keeps a value taken by a preceding flag out of path checking', () => {
    const file = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    const plan = planInvocation(['apps/web/src/a.test.tsx', '-t', 'some case'], ROOT, fs);
    expect(plan).toEqual({
      cwd: path.join(ROOT, 'apps/web'),
      args: [file, '-t', 'some case'],
      paths: [file],
    });
  });

  it('keeps a flag value out of path checking when a positional before it is spelled the same', () => {
    const file = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    const plan = planInvocation(
      ['apps/web/src/a.test.tsx', '-t', 'apps/web/src/a.test.tsx'],
      ROOT,
      fs
    );
    expect(plan).toEqual({
      cwd: path.join(ROOT, 'apps/web'),
      args: [file, '-t', 'apps/web/src/a.test.tsx'],
      paths: [file],
    });
  });

  it('keeps a flag value out of path checking when a positional after it is spelled the same', () => {
    const file = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    const plan = planInvocation(
      ['-t', 'apps/web/src/a.test.tsx', 'apps/web/src/a.test.tsx'],
      ROOT,
      fs
    );
    expect(plan).toEqual({
      cwd: path.join(ROOT, 'apps/web'),
      args: ['-t', 'apps/web/src/a.test.tsx', file],
      paths: [file],
    });
  });

  it('keeps a leading subcommand out of path checking when a positional is spelled the same', () => {
    const dir = path.join(ROOT, 'run');
    const fs = fakeFs([], [ROOT], [dir]);
    const plan = planInvocation(['run', 'run'], ROOT, fs);
    expect(plan).toEqual({ cwd: ROOT, args: ['run', dir], paths: [dir] });
  });

  it("keeps a repeated flag's value out of path checking", () => {
    const file = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    // vitest's own refusal of the repeated option is what surfaces, naming the
    // flag; the flag's values never reach path checking, which would instead
    // reject `true` as a missing file.
    expect(() =>
      planInvocation(
        ['--coverage.enabled', 'true', '--coverage.enabled', 'true', 'apps/web/src/a.test.tsx'],
        ROOT,
        fs
      )
    ).toThrow('Expected a single value for option "--coverage.enabled"');
  });

  it('refuses a path a preceding flag swallowed rather than running the whole repository', () => {
    const file = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    expect(() => planInvocation(['-u', 'apps/web/src/a.test.tsx'], ROOT, fs)).toThrow(
      'test:watch: `-u` took `apps/web/src/a.test.tsx` as its value'
    );
  });

  it('refuses a swallowed directory as readily as a swallowed file', () => {
    const dir = path.join(ROOT, 'apps/api/src/slices/chat');
    const fs = fakeFs([], [ROOT, path.join(ROOT, 'apps/api')], [dir]);
    expect(() => planInvocation(['--update', 'apps/api/src/slices/chat'], ROOT, fs)).toThrow(
      'test:watch: `--update` took `apps/api/src/slices/chat` as its value'
    );
  });

  it('names both orders in the refusal so the caller can repair the invocation', () => {
    const file = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    expect(() => planInvocation(['-u', 'apps/web/src/a.test.tsx'], ROOT, fs)).toThrow(
      /`apps\/web\/src\/a\.test\.tsx -u`[\s\S]*whole repository/
    );
  });

  it('refuses a positional standing after a `--` rather than running everything', () => {
    const file = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    expect(() => planInvocation(['--', 'run', 'apps/web/src/a.test.tsx'], ROOT, fs)).toThrow(
      "test:watch: `--` ends vitest's options"
    );
  });

  it('names every slot the terminator dropped so the operator sees what was lost', () => {
    const file = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    expect(() =>
      planInvocation(['--', 'run', 'apps/web/src/a.test.tsx', '--coverage.enabled'], ROOT, fs)
    ).toThrow(/`run`, `apps\/web\/src\/a\.test\.tsx`, `--coverage\.enabled`/);
  });

  it('leaves a trailing terminator alone, having nothing after it to drop', () => {
    const file = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    const plan = planInvocation(['apps/web/src/a.test.tsx', '--'], ROOT, fs);
    expect(plan).toEqual({ cwd: path.join(ROOT, 'apps/web'), args: [file, '--'], paths: [file] });
  });

  it('leaves a flag value that names nothing on disk to vitest', () => {
    const fs = fakeFs([], [ROOT]);
    const plan = planInvocation(['-t', 'some case'], ROOT, fs);
    expect(plan).toEqual({ cwd: ROOT, args: ['-t', 'some case'], paths: [] });
  });

  it('resolves relative file args against the invocation directory', () => {
    const base = path.join(ROOT, 'apps/web');
    const file = path.join(base, 'src/foo.test.tsx');
    const fs = fakeFs([file], [ROOT, base]);
    const plan = planInvocation(['src/foo.test.tsx'], base, fs);
    expect(plan).toEqual({ cwd: base, args: [file], paths: [file] });
  });
});

describe('runVitest', () => {
  const REPORT_FILE = path.join(ROOT, 'report.json');

  /** A report of one collected, passing test file — the healthy shape. */
  const PASSED_REPORT: VitestJsonReport = {
    testResults: [{ name: 'a.test.ts', status: 'passed' }],
  };

  /**
   * The run's report-reading and warning seams, with the report a case wants,
   * beside the list of report files the run went on to drop.
   */
  function deps(
    report?: VitestJsonReport,
    warn: (line: string) => void = () => undefined
  ): {
    readonly deps: WatchRunDeps;
    readonly dropped: string[];
    readonly measured: { runnerPid: number; derivation: VitestWorkerDerivation }[];
    readonly recorded: (VitestJsonReport | undefined)[];
  } {
    const dropped: string[] = [];
    const measured: { runnerPid: number; derivation: VitestWorkerDerivation }[] = [];
    const recorded: (VitestJsonReport | undefined)[] = [];
    return {
      dropped,
      measured,
      recorded,
      deps: {
        claimReportFile: () => Promise.resolve(REPORT_FILE),
        readReport: () => report,
        dropReport: (file) => dropped.push(file),
        warn,
        measure: (runnerPid, derivation) => {
          measured.push({ runnerPid, derivation });
          return {
            record: (collected) => recorded.push(collected),
          };
        },
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // A test process inherits its pnpm invocation's run claim, and this file
    // spawns through the real spawner over a mocked execa: without this the
    // fixture's stand-in pid is recorded against the machine-wide claim of the
    // run executing these tests, where a reclaimer would later signal it.
    vi.stubEnv(RUN_CLAIM_ENV, '');
  });

  afterEach(() => {
    // The runner restores stubs before each test and never after the last one,
    // so the claim this file blanks in setup outlives the file without this.
    vi.unstubAllEnvs();
  });

  it('spawns vitest in the planned directory, preferring its local binary', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const cwd = path.join(ROOT, 'apps/web');

    const exitCode = await runVitest({ cwd, args: ['--run', 'foo.test.ts'] }, DERIVED, deps().deps);

    expect(mockExeca).toHaveBeenCalledWith(
      'vitest',
      [
        `--maxWorkers=${String(DERIVED.workers)}`,
        '--run',
        'foo.test.ts',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${REPORT_FILE}`,
      ],
      {
        stdio: ['inherit', 'inherit', 'inherit'],
        reject: false,
        preferLocal: true,
        localDir: cwd,
        cwd,
        detached: true,
        // Any string here, because what the address must be is not this file's
        // subject: that it names a socket this process answers on is proven where
        // the spawner is, by a child that connects to it and says what answered.
        env: { [LIFELINE_ENV]: expect.any(String) as unknown as string },
      }
    );
    expect(exitCode).toBe(0);
  });

  it('spawns the watcher in its own process group, so a later run can reap its tree', async () => {
    mockExeca.mockReturnValue(fakeChild(0));

    await runVitest({ cwd: ROOT, args: [] }, DERIVED, deps().deps);

    expect(mockExeca).toHaveBeenCalledWith(
      'vitest',
      expect.arrayContaining(['--reporter=json']),
      expect.objectContaining({ detached: true })
    );
  });

  /**
   * The watch path: no coverage plan, so no `run` subcommand, and the count is
   * declared once at launch for the whole session rather than worked out again
   * for each re-run the watcher fires.
   */
  it('declares the derived worker count when it launches the watcher', async () => {
    mockExeca.mockReturnValue(fakeChild(0));

    await runVitest({ cwd: ROOT, args: [] }, DERIVED, deps().deps);

    expect(mockExeca).toHaveBeenCalledWith(
      'vitest',
      expect.arrayContaining([`--maxWorkers=${String(DERIVED.workers)}`]),
      expect.anything()
    );
  });

  it('propagates a non-zero exit code from vitest', async () => {
    mockExeca.mockReturnValue(fakeChild(3));
    await expect(runVitest({ cwd: ROOT, args: [] }, DERIVED, deps().deps)).resolves.toBe(3);
  });

  it('returns 1 when vitest exits with no numeric exit code', async () => {
    mockExeca.mockReturnValue(fakeChild());
    await expect(runVitest({ cwd: ROOT, args: [] }, DERIVED, deps().deps)).resolves.toBe(1);
  });

  it('asks vitest for the json report the empty-run verdict reads', async () => {
    mockExeca.mockReturnValue(fakeChild(0));

    await runVitest({ cwd: ROOT, args: ['foo.test.ts'] }, DERIVED, deps().deps);

    expect(mockExeca).toHaveBeenCalledWith(
      'vitest',
      [
        `--maxWorkers=${String(DERIVED.workers)}`,
        'foo.test.ts',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${REPORT_FILE}`,
      ],
      expect.objectContaining({ cwd: ROOT })
    );
  });

  it('drops the json report the empty-run verdict has finished reading', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const { deps: watchDeps, dropped } = deps();

    await runVitest({ cwd: ROOT, args: [] }, DERIVED, watchDeps);

    expect(dropped).toEqual([REPORT_FILE]);
  });

  it('drops the json report of a run whose tests failed', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const { deps: watchDeps, dropped } = deps({ testResults: [] });

    await runVitest({ cwd: ROOT, args: [] }, DERIVED, watchDeps);

    expect(dropped).toEqual([REPORT_FILE]);
  });

  it('drops the json report only once the empty-run verdict has read it', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const order: string[] = [];
    const watchDeps: WatchRunDeps = {
      claimReportFile: () => Promise.resolve(REPORT_FILE),
      readReport: () => {
        order.push('read');
        return { testResults: [] };
      },
      dropReport: () => order.push('drop'),
      warn: () => undefined,
      measure: () => ({ record: () => order.push('record') }),
    };

    await runVitest({ cwd: ROOT, args: [] }, DERIVED, watchDeps);

    expect(order).toEqual(['read', 'record', 'drop']);
  });

  it('tells a run that collected no test file apart from one whose tests failed', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const warn = vi.fn();

    await runVitest(
      { cwd: ROOT, args: ['foo.test.ts'] },
      DERIVED,
      deps({ testResults: [] }, warn).deps
    );

    expect(warn).toHaveBeenCalledWith(emptyRunNotice(['foo.test.ts']));
  });

  it('says nothing about an empty run when the run collected test files', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const warn = vi.fn();

    await runVitest(
      { cwd: ROOT, args: ['foo.test.ts'] },
      DERIVED,
      deps({ testResults: [{ name: 'foo.test.ts' }] }, warn).deps
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it('says nothing about an empty run when the run exited zero', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const warn = vi.fn();

    await runVitest(
      { cwd: ROOT, args: ['foo.test.ts'] },
      DERIVED,
      deps({ testResults: [] }, warn).deps
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it('says nothing about an empty run when no report was written', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const warn = vi.fn();

    await runVitest({ cwd: ROOT, args: ['foo.test.ts'] }, DERIVED, deps(undefined, warn).deps);

    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * The watch path's own measurement. A watcher names reporters on its command
   * line, which is what replaces the configured recorder wholesale, so the row
   * a run of this shape leaves is the launcher's or there is none at all.
   */
  it('measures a run no coverage plan was asked of, at the derivation it launched it at', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const harness = deps(PASSED_REPORT);

    await runVitest({ cwd: ROOT, args: ['a.test.ts'] }, DERIVED, harness.deps);

    expect(harness.measured).toEqual([{ runnerPid: 4321, derivation: DERIVED }]);
  });

  it('records what such a run collected, once', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const harness = deps(PASSED_REPORT);

    await runVitest({ cwd: ROOT, args: ['a.test.ts'] }, DERIVED, harness.deps);

    expect(harness.recorded).toEqual([PASSED_REPORT]);
  });
});

describe('emptyRunNotice', () => {
  it('names every argument that scoped the run', () => {
    const notice = emptyRunNotice(['a.test.ts', 'b.test.ts']);

    expect(notice).toContain('a.test.ts');
    expect(notice).toContain('b.test.ts');
  });
});

describe('splitCoverageRequest', () => {
  it('leaves an ordinary invocation untouched', () => {
    const split = splitCoverageRequest(['foo.test.ts', '--run']);
    expect(split).toEqual({ rest: ['foo.test.ts', '--run'], coverage: false, sources: [] });
  });

  it('takes the coverage flag out of the arguments vitest is shown', () => {
    const split = splitCoverageRequest(['--coverage', 'foo.test.ts']);
    expect(split.coverage).toBe(true);
    expect(split.rest).toEqual(['foo.test.ts']);
  });

  it('collects a source override written in either CLI form', () => {
    const split = splitCoverageRequest([
      '--coverage',
      '--source',
      'a.ts',
      '--source=b.ts',
      'foo.test.ts',
    ]);
    expect(split.sources).toEqual(['a.ts', 'b.ts']);
    expect(split.rest).toEqual(['foo.test.ts']);
  });

  it('refuses a source override with nothing after it', () => {
    expect(() => splitCoverageRequest(['--coverage', '--source'])).toThrow(/--source/);
  });
});

describe('runVitest under coverage', () => {
  const REPORT_FILE = path.join(ROOT, 'report.json');
  const PACKAGE_DIR = path.join(ROOT, 'apps/web');
  const COVERAGE_DIR = path.join(PACKAGE_DIR, 'coverage', 'run-a-b');

  const MEASURED = {
    [path.join(PACKAGE_DIR, 'src/api-client.ts')]: {
      statementMap: { '0': { start: { line: 1 } } },
      s: { '0': 1 },
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    },
  };

  /** A scope naming a module in another package, which this run could never measure. */
  const OUTSIDE_INCLUDE = ['../../packages/shared/src/estimate.ts'];

  interface CoverageProbe {
    readonly run: CoverageRun;
    readonly order: string[];
    readonly printed: string[];
  }

  function coverage(
    overrides: Partial<CoverageRun> = {},
    order: string[] = [],
    printed: string[] = []
  ): CoverageProbe {
    return {
      order,
      printed,
      run: {
        reportsDirectory: COVERAGE_DIR,
        include: ['src/api-client.ts'],
        packageName: '@hushbox/web',
        rootDir: ROOT,
        claim: (dir) => {
          order.push(`claim ${dir}`);
          return Promise.resolve();
        },
        readMap: () => MEASURED,
        drop: (dir) => {
          order.push(`drop ${dir}`);
        },
        report: (line) => printed.push(line),
        ...overrides,
      },
    };
  }

  function watchDeps(
    report?: VitestJsonReport,
    measure: WatchRunDeps['measure'] = () => ({ record: () => undefined })
  ): WatchRunDeps {
    return {
      claimReportFile: () => Promise.resolve(REPORT_FILE),
      readReport: () => report,
      dropReport: () => undefined,
      warn: () => undefined,
      measure,
    };
  }

  const PASSED: VitestJsonReport = { testResults: [{ name: 'a.test.ts', status: 'passed' }] };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv(RUN_CLAIM_ENV, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('measures only the modules the named test files cover', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const probe = coverage();

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      probe.run
    );

    const args = mockExeca.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--coverage');
    expect(args).toContain(`--coverage.reportsDirectory=${COVERAGE_DIR}`);
    expect(args).toContain('--coverage.include=src/api-client.ts');
  });

  it('declares the derived worker count when it launches a coverage run', async () => {
    mockExeca.mockReturnValue(fakeChild(0));

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      coverage().run
    );

    expect(mockExeca).toHaveBeenCalledWith(
      'vitest',
      expect.arrayContaining([`--maxWorkers=${String(DERIVED.workers)}`]),
      expect.anything()
    );
  });

  /**
   * One derivation, two uses: the count on the launch line and the count the
   * row records as the one this run declared. A second derivation taken for the
   * measurement could disagree with the pool that actually ran.
   */
  it('measures the run against the derivation it launched it at', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const seen: VitestWorkerDerivation[] = [];

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED, (_runnerPid, derivation) => {
        seen.push(derivation);
        return { record: () => undefined };
      }),
      coverage().run
    );

    expect(seen).toEqual([DERIVED]);
  });

  it('measures the runner it started and records what the finished run collected', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const seen: { runnerPid?: number; report?: VitestJsonReport | undefined } = {};

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED, (runnerPid) => {
        seen.runnerPid = runnerPid;
        return {
          record: (report) => {
            seen.report = report;
          },
        };
      }),
      coverage().run
    );

    expect(seen).toEqual({ runnerPid: 4321, report: PASSED });
  });

  /**
   * One row for one run, whichever plan the run carried: two recorders on one
   * run price a width off a peak counted twice, which is worse than not
   * pricing it at all.
   */
  it('records a coverage run exactly once', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const recorded: (VitestJsonReport | undefined)[] = [];

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED, () => ({ record: (report) => recorded.push(report) })),
      coverage().run
    );

    expect(recorded).toEqual([PASSED]);
  });

  it('runs once rather than watching', async () => {
    mockExeca.mockReturnValue(fakeChild(0));

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      coverage().run
    );

    expect((mockExeca.mock.calls[0]?.[1] as string[])[0]).toBe('run');
  });

  it('claims the directory before vitest can create it, and drops it afterwards', async () => {
    mockExeca.mockImplementation(() => {
      order.push('vitest');
      return fakeChild(0);
    });
    const order: string[] = [];
    const probe = coverage({}, order);

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      probe.run
    );

    expect(probe.order).toEqual([`claim ${COVERAGE_DIR}`, 'vitest', `drop ${COVERAGE_DIR}`]);
  });

  it('names no directory for a run holding no claim, leaving the guard to refuse', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const probe = coverage({ reportsDirectory: null });

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      probe.run
    );

    const args = mockExeca.mock.calls[0]?.[1] as string[];
    expect(args.some((argument) => argument.startsWith('--coverage.reportsDirectory'))).toBe(false);
    expect(probe.order).toEqual([]);
  });

  /**
   * The runner is handed nothing of this command's own. What it measures, it
   * measures from outside — the tree this process roots — so there is nothing
   * for a fork to be told and nothing a nested runner could inherit.
   */
  it('hands the runner no environment of its own beyond the lifeline', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const probe = coverage();

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      probe.run
    );

    expect(mockExeca).toHaveBeenCalledWith(
      'vitest',
      expect.anything(),
      expect.objectContaining({ env: { [LIFELINE_ENV]: expect.any(String) as unknown as string } })
    );
  });

  it('calls a green run a conclusive pass', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const probe = coverage();

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      probe.run
    );

    expect(probe.printed.join('\n')).toContain('CONCLUSIVE PASS');
  });

  it('calls a run that missed the thresholds inconclusive', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const probe = coverage();

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      probe.run
    );

    expect(probe.printed.join('\n')).toContain('INCONCLUSIVE');
  });

  it('marks the figures of a run whose tests failed as partial', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const probe = coverage();
    const failed: VitestJsonReport = { testResults: [{ name: 'a.test.ts', status: 'failed' }] };

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(failed),
      probe.run
    );

    expect(probe.printed.join('\n')).toContain(partialCoverageReason(1));
  });

  it('withholds the threshold verdict from a run whose tests failed', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const probe = coverage();
    const failed: VitestJsonReport = { testResults: [{ name: 'a.test.ts', status: 'failed' }] };

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(failed),
      probe.run
    );

    expect(probe.printed.join('\n')).not.toContain('INCONCLUSIVE');
  });

  it('states an absent map on a failing run as unevaluated rather than as a failing test', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const probe = coverage({ readMap: () => undefined });
    const failed: VitestJsonReport = { testResults: [{ name: 'a.test.ts', status: 'failed' }] };

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(failed),
      probe.run
    );

    expect(probe.printed.join('\n')).toContain('COVERAGE NOT EVALUATED');
  });

  it('states an absent coverage map rather than judging one', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const probe = coverage({ readMap: () => undefined });

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      probe.run
    );

    expect(probe.printed.join('\n')).toContain('COVERAGE NOT EVALUATED');
  });

  it('states a scope that measured nothing rather than judging it', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const probe = coverage({ readMap: () => ({}), include: OUTSIDE_INCLUDE });

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      probe.run
    );

    expect(probe.printed.join('\n')).toContain('EMPTY COVERAGE SCOPE');
  });

  it('names that scope from the repo root rather than from the package vitest ran in', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const probe = coverage({ readMap: () => ({}), include: OUTSIDE_INCLUDE });

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      probe.run
    );

    expect(probe.printed.join('\n')).toContain('packages/shared/src/estimate.ts');
  });

  it('fails a run that measured nothing, which vitest itself exits clean on', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const probe = coverage({ readMap: () => ({}), include: OUTSIDE_INCLUDE });

    const exitCode = await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      probe.run
    );

    expect(exitCode).toBe(1);
  });

  it('states a scope this repository excludes from coverage in its own wording', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const probe = coverage({ readMap: () => ({}) });

    await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      probe.run
    );

    expect(probe.printed.join('\n')).toContain('NOTHING TO MEASURE');
  });

  it('leaves a run whose only module this repository excludes from coverage green', async () => {
    mockExeca.mockReturnValue(fakeChild(0));
    const probe = coverage({ readMap: () => ({}) });

    const exitCode = await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      probe.run
    );

    expect(exitCode).toBe(0);
  });

  it('hands back the code vitest exited with for a run that measured something', async () => {
    mockExeca.mockReturnValue(fakeChild(1));
    const probe = coverage();

    const exitCode = await runVitest(
      { cwd: PACKAGE_DIR, args: ['a.test.ts'] },
      DERIVED,
      watchDeps(PASSED),
      probe.run
    );

    expect(exitCode).toBe(1);
  });
});

/**
 * What a whole command line measures, and what it refuses to measure — the
 * level a substituted scope is reachable at. The entry point composes the
 * three functions below in this order and is itself excluded from coverage, so
 * a scope decision proven only at the derivation is one no command watches.
 */
describe('the scope a command line measures', () => {
  const PACKAGE_DIR = path.join(ROOT, 'scripts');
  const TEST_FILE = path.join('scripts', 'lib', 'vitest', 'coverage-scope.test.ts');
  const SIBLING = path.join('scripts', 'lib', 'vitest', 'coverage-scope.ts');
  const OTHER_TEST_FILE = path.join('scripts', 'lib', 'test-run', 'report-file.test.ts');
  /** A module in another package, which an include resolved against this one can never match. */
  const OUTSIDE = path.join('packages', 'shared', 'src', 'comparison.ts');

  function watchFs(): WatchFs {
    return fakeFs(
      [TEST_FILE, SIBLING, OTHER_TEST_FILE, OUTSIDE].map((file) => path.join(ROOT, file)),
      [ROOT, PACKAGE_DIR]
    );
  }

  /** The composition the entry point performs, driven from argv as a caller types it. */
  function scopeFor(commandLine: readonly string[]): {
    readonly invocation: Invocation;
    readonly include: readonly string[];
  } {
    const fs = watchFs();
    const request = splitCoverageRequest(commandLine);
    const invocation = planInvocation(request.rest, ROOT, fs);
    return {
      invocation,
      include: coverageIncludeFor(
        modulesUnderTest(
          {
            sources: request.sources,
            testFiles: invocation.paths,
            invocationDir: ROOT,
            packageDir: invocation.cwd,
          },
          fs
        ),
        invocation.cwd
      ),
    };
  }

  /** The run the composed scope is handed to, over the empty map such a scope produces. */
  function probeFor(include: readonly string[]): {
    readonly run: CoverageRun;
    readonly printed: string[];
  } {
    const printed: string[] = [];
    return {
      printed,
      run: {
        reportsDirectory: path.join(PACKAGE_DIR, 'coverage', 'run-a-b'),
        include,
        packageName: '@hushbox/scripts',
        rootDir: ROOT,
        claim: () => Promise.resolve(),
        readMap: () => ({}),
        drop: () => undefined,
        report: (line) => printed.push(line),
      },
    };
  }

  const deps: WatchRunDeps = {
    claimReportFile: () => Promise.resolve(path.join(ROOT, 'report.json')),
    readReport: () => ({ testResults: [{ name: 'a.test.ts', status: 'passed' }] }),
    dropReport: () => undefined,
    warn: () => undefined,
    measure: () => ({ record: () => undefined }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv(RUN_CLAIM_ENV, '');
    mockExeca.mockReturnValue(fakeChild(0));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a command line whose one named module lies outside the package', async () => {
    const { invocation, include } = scopeFor(['--coverage', TEST_FILE, '--source', OUTSIDE]);
    const probe = probeFor(include);

    const exitCode = await runVitest(invocation, DERIVED, deps, probe.run);

    expect(exitCode).toBe(1);
  });

  it('names the module it could not measure in that refusal', async () => {
    const { invocation, include } = scopeFor(['--coverage', TEST_FILE, '--source', OUTSIDE]);
    const probe = probeFor(include);

    await runVitest(invocation, DERIVED, deps, probe.run);

    expect(probe.printed.join('\n')).toContain(OUTSIDE.split(path.sep).join('/'));
  });

  it('holds that refusal when an unrelated in-package test file joins the command line', async () => {
    const { invocation, include } = scopeFor([
      '--coverage',
      TEST_FILE,
      OTHER_TEST_FILE,
      '--source',
      OUTSIDE,
    ]);
    const probe = probeFor(include);

    const exitCode = await runVitest(invocation, DERIVED, deps, probe.run);

    expect(exitCode).toBe(1);
  });

  it('refuses a command line that adds a measurable module beside the one it cannot measure', () => {
    expect(() =>
      scopeFor(['--coverage', TEST_FILE, '--source', OUTSIDE, '--source', SIBLING])
    ).toThrow(OUTSIDE);
  });

  it('refuses it before vitest is started, rather than after a verdict is in', () => {
    expect(() =>
      scopeFor(['--coverage', TEST_FILE, '--source', OUTSIDE, '--source', SIBLING])
    ).toThrow();

    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('leaves a command line every named module of which it measures alone', () => {
    expect(scopeFor(['--coverage', TEST_FILE, '--source', SIBLING]).include).toEqual([
      'lib/vitest/coverage-scope.ts',
    ]);
  });
});

/**
 * What a package-rooted invocation opens, from the one store every vitest
 * invocation records into.
 *
 * Against a real repository root, because the unit set is scoped by what is
 * still in the tree: a row naming a file nobody can open again is not work
 * about to run, and a fake disk would let one stand in for one.
 */
describe('deriveWatchWorkers', () => {
  const temporaryRoots: string[] = [];

  /** A repository holding a real file for every path named. */
  function makeRepo(...files: readonly string[]): string {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'test-watch-derivation-'));
    temporaryRoots.push(repoRoot);
    for (const relative of files) {
      const absolute = path.join(repoRoot, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, '');
    }
    return repoRoot;
  }

  afterEach(() => {
    for (const dir of temporaryRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const EMPTY_LEDGER: PoolLedger = { tasks: {}, runs: [] };

  const DB_DIR = path.join('packages', 'db');
  const FILES = ['a', 'b', 'c', 'd'].map((name) => path.join(DB_DIR, 'src', `${name}.test.ts`));

  /** A row the walls of which weigh a file at nothing in particular. */
  const WEIGHED: LedgerEntry = { wallsMs: [1000] };

  /** The rows a store holds for {@link FILES}, each weighed the same. */
  function weighedRows(): Record<string, LedgerEntry> {
    return Object.fromEntries(FILES.map((file) => [file, WEIGHED]));
  }

  /**
   * A finished run that held `peakRssKb` while `lanesAtPeak` lanes were live —
   * one rung of the ladder the projection reads.
   */
  function rungAt(lanesAtPeak: number, peakRssKb: number): RunObservation {
    return {
      concurrency: lanesAtPeak,
      taskCount: 1,
      sumWallMs: 1000,
      longestWallMs: 1000,
      makespanMs: 1000,
      fixedRssKb: 500_000,
      peakRssKb,
      lanesAtPeak,
    };
  }

  /** The derivation for an invocation naming `paths`, over the store given. */
  function derive(
    repoRoot: string,
    paths: readonly string[],
    store: PoolLedger = EMPTY_LEDGER,
    memoryBudgetKb?: number
  ): VitestWorkerDerivation {
    return deriveWatchWorkers({
      repoRoot,
      packageDir: path.join(repoRoot, DB_DIR),
      paths,
      isDirectory: (p) => !path.basename(p).includes('.'),
      readLedger: (task) => (task === VITEST_LEDGER_TASK ? store : EMPTY_LEDGER),
      maxParallelism: 24,
      memoryBudgetKb,
    });
  }

  it('opens one worker for an invocation naming one file', () => {
    const repoRoot = makeRepo(...FILES);

    const derived = derive(repoRoot, [path.join(repoRoot, FILES[0] ?? '')]);

    expect(derived.workers).toBe(1);
  });

  it('reaches that one worker from the ceiling rather than from the memory bound', () => {
    const repoRoot = makeRepo(...FILES);

    const derived = derive(repoRoot, [path.join(repoRoot, FILES[0] ?? '')]);

    expect(derived.memoryCapped).toBe(false);
  });

  it('counts a named file as a unit even where the store has never weighed it', () => {
    const repoRoot = makeRepo(...FILES);

    const derived = derive(repoRoot, [path.join(repoRoot, FILES[0] ?? '')]);

    expect(derived.units).toBe(1);
  });

  it('derives over every recorded file under the package where the invocation named no path', () => {
    const repoRoot = makeRepo(...FILES, path.join('apps', 'web', 'src', 'e.test.ts'));
    const rows = { ...weighedRows(), [path.join('apps', 'web', 'src', 'e.test.ts')]: WEIGHED };

    const derived = derive(repoRoot, [], { tasks: rows, runs: [] });

    expect(derived.units).toBe(FILES.length);
  });

  it('derives over every recorded file under a directory the invocation named', () => {
    const repoRoot = makeRepo(...FILES, path.join('apps', 'web', 'src', 'e.test.ts'));
    const rows = { ...weighedRows(), [path.join('apps', 'web', 'src', 'e.test.ts')]: WEIGHED };

    const derived = derive(repoRoot, [path.join(repoRoot, DB_DIR)], { tasks: rows, runs: [] });

    expect(derived.units).toBe(FILES.length);
  });

  /**
   * The budget binds through the ladder: four lanes have held 4,500,000 kB on
   * record and three have held 3,500,000, against a 2,600,000 kB budget, so
   * only the two-lane rung fits.
   */
  const BINDING_BUDGET_KB = 2_600_000;
  const HELD: readonly RunObservation[] = [
    rungAt(2, 2_500_000),
    rungAt(3, 3_500_000),
    rungAt(4, 4_500_000),
  ];

  it('opens fewer workers than the machine has threads where the budget binds', () => {
    const repoRoot = makeRepo(...FILES);

    const derived = derive(
      repoRoot,
      [path.join(repoRoot, DB_DIR)],
      { tasks: weighedRows(), runs: [...HELD] },
      BINDING_BUDGET_KB
    );

    expect(derived.workers).toBe(2);
  });

  it('says the memory projection is what lowered that count', () => {
    const repoRoot = makeRepo(...FILES);

    const derived = derive(
      repoRoot,
      [path.join(repoRoot, DB_DIR)],
      { tasks: weighedRows(), runs: [...HELD] },
      BINDING_BUDGET_KB
    );

    expect(derived.memoryCapped).toBe(true);
  });

  it('leaves the count unguarded where no run on record has held a width', () => {
    const repoRoot = makeRepo(...FILES);

    const derived = derive(
      repoRoot,
      [path.join(repoRoot, DB_DIR)],
      { tasks: weighedRows(), runs: [] },
      BINDING_BUDGET_KB
    );

    expect(derived.memoryGuarded).toBe(false);
  });

  /**
   * The unification's whole point on the read side: a width this path has never
   * opened is priced by whichever invocation did open it, because one store
   * holds them all.
   */
  it('projects a count against a width only another shape of run has ever held', () => {
    const repoRoot = makeRepo(...FILES);
    const batchHeld = HELD.map((row) => ({ ...row, shape: 'batch' }));

    const derived = derive(
      repoRoot,
      [path.join(repoRoot, DB_DIR)],
      { tasks: weighedRows(), runs: batchHeld },
      BINDING_BUDGET_KB
    );

    expect(derived.workers).toBe(2);
  });

  it('reads the one store, and no other', () => {
    const repoRoot = makeRepo(...FILES);
    const asked: string[] = [];

    deriveWatchWorkers({
      repoRoot,
      packageDir: path.join(repoRoot, DB_DIR),
      paths: [],
      isDirectory: () => true,
      readLedger: (task) => {
        asked.push(task);
        return EMPTY_LEDGER;
      },
      maxParallelism: 24,
      memoryBudgetKb: undefined,
    });

    expect(asked).toEqual([VITEST_LEDGER_TASK]);
  });

  /**
   * The same four units either way, so the only thing that moves between the
   * two counts is what the store says has been held.
   */
  it('lets a width recorded in the store lower a later count', () => {
    const repoRoot = makeRepo(...FILES);
    const scope = [path.join(repoRoot, DB_DIR)];

    const before = derive(repoRoot, scope, { tasks: weighedRows(), runs: [] }, BINDING_BUDGET_KB);
    const after = derive(
      repoRoot,
      scope,
      { tasks: weighedRows(), runs: [...HELD] },
      BINDING_BUDGET_KB
    );

    expect([before.workers, after.workers]).toEqual([FILES.length, 2]);
  });

  it('counts a file named beside the directory holding it once', () => {
    const repoRoot = makeRepo(...FILES);
    const named = path.join(repoRoot, FILES[0] ?? '');

    const derived = derive(repoRoot, [path.join(repoRoot, DB_DIR), named], {
      tasks: weighedRows(),
      runs: [],
    });

    expect(derived.units).toBe(FILES.length);
  });
});

/**
 * The loop this path closes, and the store it closes it in: what one run
 * measures is what the next run derives from, and every vitest invocation
 * measures into one store. Written against real ledger files rather than a
 * stand-in, because the two halves meeting is the whole claim.
 */
describe('a finished run on this path', () => {
  const temporaryRoots: string[] = [];

  /** A repository holding a real file for every path named. */
  function makeRepo(...files: readonly string[]): string {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'test-watch-store-'));
    temporaryRoots.push(repoRoot);
    for (const relative of files) {
      const absolute = path.join(repoRoot, relative);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, '');
    }
    return repoRoot;
  }

  afterEach(() => {
    for (const dir of temporaryRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const FINGERPRINT = 'testmachine1';
  const RUNNER_PID = 500;
  const PACKAGE_DIR = path.join('packages', 'db');
  const FILES = ['a', 'b', 'c', 'd'].map((name) =>
    path.join(PACKAGE_DIR, 'src', `${name}.test.ts`)
  );

  /** Ledger keys are spelled with `/` whatever the platform's separator is. */
  const KEYS = FILES.map((file) => file.split(path.sep).join('/'));

  const FIXED_COST_KB = 2_000_000;

  /** A budget the two-lane rung below fits into and the three-lane one does not. */
  const BUDGET_KB = 2_600_000;

  /** What the store says each of those widths has held. */
  const HELD_KB: Readonly<Record<number, number>> = { 2: 2_500_000, 3: 3_500_000, 4: 4_500_000 };

  /** The report a run over the first `fileCount` of those files leaves behind. */
  function reportOf(repoRoot: string, fileCount: number): VitestJsonReport {
    return {
      testResults: FILES.slice(0, fileCount).map((file) => ({
        name: path.join(repoRoot, file),
        status: 'passed',
        startTime: 1000,
        endTime: 3000,
      })),
    };
  }

  /** The store every vitest invocation on this machine records into. */
  function storeOf(repoRoot: string): string {
    return ledgerPath(repoRoot, FINGERPRINT, VITEST_LEDGER_TASK);
  }

  /** One finished package-rooted run, recorded the way this launcher records it. */
  function watchRunRecorded(repoRoot: string, lanes: number): void {
    const launched: VitestWorkerDerivation = {
      workers: lanes,
      state: 'cold-start',
      bound: 'unmeasured',
      memoryCapped: false,
      memoryGuarded: false,
      units: lanes,
    };
    measureVitestRun(RUNNER_PID, {
      repoRoot,
      track: () => ({
        stop: () => ({
          peakRssKb: HELD_KB[lanes] ?? 1_000_000,
          split: { fixedRssKb: FIXED_COST_KB },
          peakRunnerChildren: lanes,
          lanesAtPeak: lanes,
        }),
      }),
      record: (record, files) => recordVitestRun(repoRoot, FINGERPRINT, record, files),
      machineEvents: () => ({ oomKills: 0 }),
      derivation: launched,
      shape: 'package',
      report: () => undefined,
      warn: () => undefined,
    }).record(reportOf(repoRoot, lanes));
  }

  /** One finished consolidated batch, recorded the way that launcher records it. */
  function batchRunRecorded(repoRoot: string, lanes: number): void {
    recordVitestRun(
      repoRoot,
      FINGERPRINT,
      batchRunRecord({
        wallMs: 180_000,
        tracked: {
          peakRssKb: HELD_KB[lanes] ?? 1_000_000,
          split: { fixedRssKb: FIXED_COST_KB },
          peakRunnerChildren: lanes,
          lanesAtPeak: lanes,
        },
        runnerPid: RUNNER_PID,
        declaredWorkers: lanes,
        packageCount: 12,
        report: reportOf(repoRoot, lanes),
      }),
      KEYS.slice(0, lanes).map((file) => ({ file, wallMs: 2000 }))
    );
  }

  /** The widths the store says a shape has held, in the order it returns them. */
  function widthsOfShape(repoRoot: string, shape: string): number[] {
    return readLedger(storeOf(repoRoot))
      .runs.filter((row) => row.shape === shape)
      .map((row) => row.lanesAtPeak ?? 0);
  }

  /** What a later invocation of this path over the same package would open. */
  function nextRun(repoRoot: string): VitestWorkerDerivation {
    return deriveWatchWorkers({
      repoRoot,
      packageDir: path.join(repoRoot, PACKAGE_DIR),
      paths: [],
      isDirectory: () => true,
      readLedger: (task) => readLedger(ledgerPath(repoRoot, FINGERPRINT, task)),
      maxParallelism: 24,
      memoryBudgetKb: BUDGET_KB,
    });
  }

  it('leaves a wall for every file it ran in the store', () => {
    const repoRoot = makeRepo(...FILES);

    watchRunRecorded(repoRoot, FILES.length);

    expect(Object.keys(readLedger(storeOf(repoRoot)).tasks)).toEqual(KEYS);
  });

  it('files its own row at the width it held, under its own shape', () => {
    const repoRoot = makeRepo(...FILES);

    watchRunRecorded(repoRoot, 2);

    expect(widthsOfShape(repoRoot, 'package')).toEqual([2]);
  });

  /**
   * The unification, stated as the two launchers meeting: one store holds both
   * histories, and the stamp is the only thing telling them apart.
   */
  it('lands a package-rooted run and a batch in one store, each under its own shape', () => {
    const repoRoot = makeRepo(...FILES);

    watchRunRecorded(repoRoot, 2);
    batchRunRecorded(repoRoot, 4);

    expect(readLedger(storeOf(repoRoot)).runs.map((row) => [row.shape, row.lanesAtPeak])).toEqual([
      ['package', 2],
      ['batch', 4],
    ]);
  });

  /**
   * Why the stamp has to differ. A day of package-rooted one-file runs is the
   * traffic that used to force a store of its own: retention ages a width on
   * the runs of its own shape, so a shape's own window is what a width
   * survives, and two launchers sharing one stamp would put a batch's widest
   * rung behind an afternoon of single-file runs.
   */
  it('keeps a batch’s width on the ladder across a shape-window of package-rooted runs', () => {
    const repoRoot = makeRepo(...FILES);

    batchRunRecorded(repoRoot, 4);
    for (let run = 0; run < MAX_RUNS_PER_SHAPE; run += 1) watchRunRecorded(repoRoot, 2);

    expect(widthsOfShape(repoRoot, 'batch')).toEqual([4]);
  });

  it('keeps a package-rooted width on the ladder across a shape-window of batches', () => {
    const repoRoot = makeRepo(...FILES);

    watchRunRecorded(repoRoot, 2);
    for (let run = 0; run < MAX_RUNS_PER_SHAPE; run += 1) batchRunRecorded(repoRoot, 4);

    expect(widthsOfShape(repoRoot, 'package')).toEqual([2]);
  });

  /**
   * The read half of the unification: a width this path has never opened prices
   * its next count, because the run that did open it recorded into the same
   * store. Only a batch has held anything here, so a bounded count rests on the
   * batch's rows and on nothing this path measured.
   */
  it('prices its next count from a width only a batch has ever held', () => {
    const measured = makeRepo(...FILES);
    const unmeasured = makeRepo(...FILES);

    for (const lanes of [2, 3, 4]) batchRunRecorded(measured, lanes);
    for (const lanes of [2, 3, 4]) batchRunRecorded(unmeasured, lanes);
    // The widths are the only difference: the unmeasured repository's rows are
    // stripped of the peak that files them at one, so its ladder is empty while
    // its walls are identical.
    for (const name of readdirSync(storeOf(unmeasured))) {
      const file = path.join(storeOf(unmeasured), name);
      const body = JSON.parse(readFileSync(file, 'utf8')) as {
        runs: { peakRssKb?: number }[];
      };
      for (const row of body.runs) delete row.peakRssKb;
      writeFileSync(file, `${JSON.stringify(body, undefined, 2)}\n`);
    }

    expect([nextRun(unmeasured).workers, nextRun(measured).workers]).toEqual([FILES.length, 2]);
  });

  it('says a count it lowered rests on a width rather than on nothing', () => {
    const repoRoot = makeRepo(...FILES);

    for (const lanes of [2, 3, 4]) batchRunRecorded(repoRoot, lanes);

    expect(nextRun(repoRoot).memoryGuarded).toBe(true);
  });
});
