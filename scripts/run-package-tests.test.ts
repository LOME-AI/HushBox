import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { withScratchDirectory } from './lib/scratch-directory.js';
import { REPORT_ENV } from './lib/vitest/coverage-offset-reporter.js';
import { serializeLine } from './lib/test-run/test-batch-protocol.js';
import {
  claimAndReclaimCoverage,
  deriveShortName,
  dropCoverageDirectory,
  dropFlag,
  dropSeparators,
  flagValue,
  coverageNotEvaluatedExitCode,
  coverageDirectoryFs,
  coverageDirectoryRunId,
  noTestsCollectedExitCode,
  offsetDivergenceExitCode,
  poleExitCode,
  reclaimCoverageDirectories,
  refuseFileSelection,
  requireCoverageRunId,
  runBatched,
  runCoverageDirectory,
  measureVitestRun,
  runSolo,
  vacuousScopeExitCode,
  warnPartialCoverage,
  type CoverageDirectoryFs,
  type MeasuredRunDeps,
  type SoloDeps,
} from './run-package-tests.js';
import { noTestFilesCollectedReason, partialCoverageReason } from './lib/vitest/coverage-scope.js';
import { COVERAGE_RUN_ROUTES } from './lib/test-run/test-routes.js';
import { RUN_CLAIM_ENV, registerRun } from './lib/claims/registry.js';
import { currentRunId, readOwnership } from './lib/claims/ownership.js';
import type { Ownership, OwnershipState } from './lib/claims/ownership.js';
import type { VitestJsonReport } from './lib/test-run/test-report.js';
import type {
  MachineMemoryEvents,
  TestFileMeasurement,
  TrackedRunSplit,
  VitestRunRecord,
  VitestWorkerDerivation,
} from './lib/vitest/workers.js';

const REPO_ROOT = '/repo';
const PACKAGE_DIR = '/repo/apps/api';
const MEASURED_FILE = path.join(PACKAGE_DIR, 'src', 'a.ts');
const TEMPORARY_REPORT = path.join(path.sep, 'reports', 'run-a-b.one.json');

/** A report of a run that collected one quick test file — the healthy shape. */
const COLLECTED_REPORT = {
  testResults: [{ name: path.join(PACKAGE_DIR, 'a.test.ts'), startTime: 0, endTime: 10 }],
} as const;

/** A count no default produces, so a launch line carrying it can only have taken it here. */
const SOLO_DERIVED: VitestWorkerDerivation = {
  workers: 7,
  state: 'derived',
  bound: 'memory',
  memoryCapped: true,
  memoryGuarded: true,
  units: 12,
};

/** The pid the stand-in runner below announces itself under. */
const SOLO_RUNNER_PID = 8765;

function soloDeps(overrides: Partial<SoloDeps> = {}): {
  deps: SoloDeps;
  calls: { vitestArgs: readonly string[]; childEnv: NodeJS.ProcessEnv }[];
  logs: string[];
  warnings: string[];
  measured: { runnerPid: number | undefined; derivation: VitestWorkerDerivation }[];
  recorded: (VitestJsonReport | undefined)[];
} {
  const calls: { vitestArgs: readonly string[]; childEnv: NodeJS.ProcessEnv }[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const measured: { runnerPid: number | undefined; derivation: VitestWorkerDerivation }[] = [];
  const recorded: (VitestJsonReport | undefined)[] = [];
  const deps: SoloDeps = {
    repoRoot: REPO_ROOT,
    packageDir: PACKAGE_DIR,
    packageName: 'api',
    defaultReportsDirectory: path.join(PACKAGE_DIR, 'coverage', 'run-a-b'),
    passthroughArgs: [],
    coverageInclude: ['apps/api/src/**'],
    readReport: () => COLLECTED_REPORT,
    readCoverageMap: () => ({ [path.join(PACKAGE_DIR, 'src', 'a.ts')]: {} }),
    readOffsetDivergences: () => [],
    claimReportFile: () => Promise.resolve(TEMPORARY_REPORT),
    dropReport: vi.fn(),
    claimAndReclaimCoverage: vi.fn(() => Promise.resolve({ removed: [], unowned: [] })),
    dropCoverage: vi.fn(),
    derivation: SOLO_DERIVED,
    measure: (runnerPid, derivation) => {
      measured.push({ runnerPid, derivation });
      return { record: (report) => recorded.push(report) };
    },
    exec: (vitestArgs, childEnv, started) => {
      calls.push({ vitestArgs, childEnv });
      started(SOLO_RUNNER_PID);
      return Promise.resolve(0);
    },
    log: (line) => logs.push(line),
    warn: (line) => warnings.push(line),
    ...overrides,
  };
  return { deps, calls, logs, warnings, measured, recorded };
}

describe('runCoverageDirectory', () => {
  it('names a run coverage directory after the claim the run holds', () => {
    expect(runCoverageDirectory('/pkg', 'a-b')).toBe(path.join('/pkg', 'coverage', 'run-a-b'));
  });

  it('gives two concurrent runs non-overlapping directories', () => {
    expect(runCoverageDirectory('/pkg', 'a-b')).not.toBe(runCoverageDirectory('/pkg', 'c-d'));
  });
});

describe('coverageDirectoryRunId', () => {
  it('reads back the run a coverage directory names', () => {
    expect(coverageDirectoryRunId(path.basename(runCoverageDirectory('/pkg', 'a-b')))).toBe('a-b');
  });

  it('returns undefined for a name this module never minted', () => {
    expect(coverageDirectoryRunId('coverage-final.json')).toBeUndefined();
    expect(coverageDirectoryRunId('run-')).toBeUndefined();
  });
});

describe('reclaimCoverageDirectories', () => {
  function ownershipOf(states: Readonly<Record<string, OwnershipState>>): Ownership {
    return {
      stateOfRun: (runId) =>
        runId === null || runId === undefined ? 'unowned' : (states[runId] ?? 'unowned'),
      stateOfResource: () => 'unowned',
      resourceOwner: () => undefined,
      unreadLiveRuns: [],
    };
  }

  function fsWith(
    entries: readonly string[]
  ): CoverageDirectoryFs & { readonly removed: string[] } {
    const removed: string[] = [];
    return {
      removed,
      readdir: () => entries,
      remove: (target) => {
        removed.push(target);
      },
    };
  }

  it('removes the directory of a run that died holding its claim', () => {
    const fs = fsWith(['run-dead']);
    const result = reclaimCoverageDirectories('/cov', ownershipOf({ dead: 'owned-expired' }), fs);
    expect(fs.removed).toEqual([path.join('/cov', 'run-dead')]);
    expect(result.removed).toEqual([path.join('/cov', 'run-dead')]);
  });

  it('keeps the directory of a run that still holds its claim', () => {
    const fs = fsWith(['run-live']);
    reclaimCoverageDirectories('/cov', ownershipOf({ live: 'owned-live' }), fs);
    expect(fs.removed).toEqual([]);
  });

  it('reports a directory no claim accounts for instead of removing it', () => {
    const fs = fsWith(['run-orphan']);
    const result = reclaimCoverageDirectories('/cov', ownershipOf({}), fs);
    expect(fs.removed).toEqual([]);
    expect(result.unowned).toEqual([path.join('/cov', 'run-orphan')]);
  });

  it('leaves entries that are not run coverage directories', () => {
    const fs = fsWith(['coverage-final.json', 'lcov']);
    reclaimCoverageDirectories('/cov', ownershipOf({}), fs);
    expect(fs.removed).toEqual([]);
  });

  it('does nothing when the coverage directory does not exist yet', () => {
    expect(() => {
      reclaimCoverageDirectories('/cov', ownershipOf({}), {
        readdir: () => {
          throw new Error('ENOENT');
        },
        remove: () => {
          throw new Error('must not remove');
        },
      });
    }).not.toThrow();
  });
});

describe('requireCoverageRunId', () => {
  it('names the run whose claim this process holds', () => {
    vi.stubEnv(RUN_CLAIM_ENV, path.join('/claims', 'a-b'));
    expect(requireCoverageRunId()).toBe('a-b');
  });

  it('refuses when the process holds no run claim', () => {
    vi.stubEnv(RUN_CLAIM_ENV, '');
    expect(() => requireCoverageRunId()).toThrow('holds no run claim');
  });
});

describe('argument helpers', () => {
  it('deriveShortName strips the scope from a scoped package name', () => {
    expect(deriveShortName('@hushbox/ops')).toBe('ops');
  });

  it('deriveShortName returns an unscoped name unchanged', () => {
    expect(deriveShortName('ops')).toBe('ops');
  });

  it('flagValue reads both CLI forms, first occurrence winning', () => {
    expect(flagValue(['--x=1', '--x=2'], '--x')).toBe('1');
    expect(flagValue(['--x', '3'], '--x')).toBe('3');
    expect(flagValue([], '--x')).toBeUndefined();
  });

  it('dropSeparators removes every bare separator and nothing else', () => {
    expect(dropSeparators(['--', 'a', '--', '--flag'])).toEqual(['a', '--flag']);
  });

  it('dropFlag removes the flag in both CLI forms with its value', () => {
    expect(dropFlag(['--config=x.ts', 'keep'], '--config')).toEqual(['keep']);
    expect(dropFlag(['--config', 'x.ts', 'keep'], '--config')).toEqual(['keep']);
    expect(dropFlag(['--configuration=x'], '--config')).toEqual(['--configuration=x']);
  });
});

describe('refuseFileSelection', () => {
  it('refuses a line naming a test file, naming the file it refused', () => {
    expect(() => {
      refuseFileSelection(['lib/run-cli.test.ts']);
    }).toThrow(/lib\/run-cli\.test\.ts/);
  });

  it('names every file the line asked for, not only the first', () => {
    let message = '';
    try {
      refuseFileSelection(['a.test.ts', 'b.test.ts']);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('a.test.ts');
    expect(message).toContain('b.test.ts');
  });

  it('refuses a file a package manager separator would otherwise hide from vitest', () => {
    expect(() => {
      refuseFileSelection(['--', 'a.test.ts']);
    }).toThrow(/a\.test\.ts/);
  });

  it('points the caller at the coverage route for a named test file', () => {
    expect(() => {
      refuseFileSelection(['a.test.ts']);
    }).toThrow(/pnpm test:file/);
  });

  it('names the coverage-free loop for a named test file too', () => {
    expect(() => {
      refuseFileSelection(['a.test.ts']);
    }).toThrow(/pnpm test:watch/);
  });

  it('cites the one clause naming the supported routes', () => {
    let message = '';
    try {
      refuseFileSelection(['a.test.ts']);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(COVERAGE_RUN_ROUTES);
  });

  it('accepts a line of flags alone', () => {
    expect(() => {
      refuseFileSelection(['--passWithNoTests']);
    }).not.toThrow();
  });

  it('accepts the value of a flag written in its separate form', () => {
    expect(() => {
      refuseFileSelection(['--coverage.reportsDirectory', 'elsewhere']);
    }).not.toThrow();
  });
});

describe('coverageNotEvaluatedExitCode', () => {
  it('fails a run that wrote no coverage map, naming where one was expected', () => {
    const { deps, warnings } = soloDeps();
    expect(coverageNotEvaluatedExitCode('api', '/reports', undefined, deps)).toBe(1);
    expect(warnings[0]).toContain('COVERAGE NOT EVALUATED');
    expect(warnings[0]).toContain('/reports');
  });

  it('passes a run that wrote a coverage map', () => {
    const { deps, warnings } = soloDeps();
    expect(coverageNotEvaluatedExitCode('api', '/reports', { [MEASURED_FILE]: {} }, deps)).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('leaves a written but empty map to the vacuous-scope gate', () => {
    const { deps, warnings } = soloDeps();
    expect(coverageNotEvaluatedExitCode('api', '/reports', {}, deps)).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe('vacuousScopeExitCode', () => {
  it('fails a run whose coverage scope matched no file, naming the include', () => {
    const { deps, warnings } = soloDeps();
    expect(vacuousScopeExitCode('api', {}, deps)).toBe(1);
    expect(warnings[0]).toContain('EMPTY COVERAGE SCOPE');
    expect(warnings[0]).toContain('apps/api/src/**');
  });

  it('passes a run that measured at least one file', () => {
    const { deps } = soloDeps();
    expect(vacuousScopeExitCode('api', { [MEASURED_FILE]: {} }, deps)).toBe(0);
  });

  it('does not judge a run that wrote no coverage map at all', () => {
    const { deps } = soloDeps();
    expect(vacuousScopeExitCode('api', undefined, deps)).toBe(0);
  });

  it('counts a map holding only another package files as measuring nothing', () => {
    const { deps } = soloDeps();
    expect(vacuousScopeExitCode('api', { '/repo/packages/db/src/b.ts': {} }, deps)).toBe(1);
  });
});

describe('offsetDivergenceExitCode', () => {
  it('fails when one module was measured under two offsets', () => {
    const { deps, warnings } = soloDeps({
      readOffsetDivergences: () => [
        {
          url: 'file:///repo/apps/api/src/x.ts',
          offsets: [
            { startOffset: 0, testFiles: ['a.test.ts'] },
            { startOffset: 209, testFiles: ['b.test.ts'] },
          ],
        },
      ],
    });
    expect(offsetDivergenceExitCode('api', '/findings.json', deps)).toBe(1);
    expect(warnings.join('\n')).toContain('x.ts');
  });

  it('says nothing on a clean scan', () => {
    const { deps, warnings } = soloDeps();
    expect(offsetDivergenceExitCode('api', '/findings.json', deps)).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('warns without failing when the scan left no findings file at all', () => {
    const { deps, warnings } = soloDeps({ readOffsetDivergences: () => undefined });
    expect(offsetDivergenceExitCode('api', '/findings.json', deps)).toBe(0);
    expect(warnings[0]).toContain('coverage-offset scan did not run');
  });
});

describe('noTestsCollectedExitCode', () => {
  it('fails a report listing no test file', () => {
    const warnings: string[] = [];
    const code = noTestsCollectedExitCode('api', PACKAGE_DIR, { testResults: [] }, (line) =>
      warnings.push(line)
    );
    expect(code).toBe(1);
    expect(warnings.join('\n')).toContain('NO TEST FILES COLLECTED');
  });

  it('states the shared reason verbatim rather than a wording of its own', () => {
    const warnings: string[] = [];
    noTestsCollectedExitCode('api', PACKAGE_DIR, { testResults: [] }, (line) =>
      warnings.push(line)
    );
    expect(warnings).toEqual([`[api] ${noTestFilesCollectedReason()}`]);
  });

  it('passes a report listing a test file', () => {
    const warnings: string[] = [];
    const code = noTestsCollectedExitCode('api', PACKAGE_DIR, COLLECTED_REPORT, (line) =>
      warnings.push(line)
    );
    expect(code).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('fails a report carrying no test-result list at all', () => {
    const warnings: string[] = [];
    expect(noTestsCollectedExitCode('api', PACKAGE_DIR, {}, (line) => warnings.push(line))).toBe(1);
    expect(warnings.join('\n')).toContain('NO TEST FILES COLLECTED');
  });

  it('fails a report whose only test file lies outside the package', () => {
    const warnings: string[] = [];
    const elsewhere = {
      testResults: [{ name: path.join(REPO_ROOT, 'packages', 'db', 'b.test.ts') }],
    };
    expect(
      noTestsCollectedExitCode('api', PACKAGE_DIR, elsewhere, (line) => warnings.push(line))
    ).toBe(1);
    expect(warnings.join('\n')).toContain('NO TEST FILES COLLECTED');
  });
});

describe('warnPartialCoverage', () => {
  const failedReport = {
    testResults: [
      { name: path.join(PACKAGE_DIR, 'a.test.ts'), status: 'failed' },
      { name: path.join(PACKAGE_DIR, 'b.test.ts'), status: 'failed' },
    ],
  };

  it('states the shared reason verbatim rather than a wording of its own', () => {
    const warnings: string[] = [];
    warnPartialCoverage('api', PACKAGE_DIR, failedReport, (line) => warnings.push(line));
    expect(warnings).toEqual([`[api] ${partialCoverageReason(2)}`]);
  });

  it('says nothing about a run in which no test file failed', () => {
    const warnings: string[] = [];
    warnPartialCoverage('api', PACKAGE_DIR, COLLECTED_REPORT, (line) => warnings.push(line));
    expect(warnings).toEqual([]);
  });

  it('counts only the failures under this package', () => {
    const warnings: string[] = [];
    const mixed = {
      testResults: [
        { name: path.join(PACKAGE_DIR, 'a.test.ts'), status: 'failed' },
        { name: path.join(REPO_ROOT, 'packages', 'db', 'b.test.ts'), status: 'failed' },
      ],
    };
    warnPartialCoverage('api', PACKAGE_DIR, mixed, (line) => warnings.push(line));
    expect(warnings).toEqual([`[api] ${partialCoverageReason(1)}`]);
  });
});

describe('poleExitCode', () => {
  it('fails a report containing a pole and names the file', () => {
    const warnings: string[] = [];
    const code = poleExitCode(
      'api',
      { testResults: [{ name: '/huge.test.ts', startTime: 0, endTime: 60_000 }] },
      (line) => warnings.push(line)
    );
    expect(code).toBe(1);
    expect(warnings.join('\n')).toContain('/huge.test.ts');
  });

  it('passes a report without poles', () => {
    expect(poleExitCode('api', { testResults: [] }, () => undefined)).toBe(0);
  });
});

describe('runSolo', () => {
  it('claims its own coverage directory and reclaims dead runs before running vitest', async () => {
    const { deps } = soloDeps();
    await runSolo({}, deps);
    expect(deps.claimAndReclaimCoverage).toHaveBeenCalledWith(deps.defaultReportsDirectory);
  });

  it('drops the coverage directory it created', async () => {
    const { deps } = soloDeps();
    await runSolo({}, deps);
    expect(deps.dropCoverage).toHaveBeenCalledWith(deps.defaultReportsDirectory);
  });

  it('drops the coverage directory even when the run fails', async () => {
    const { deps } = soloDeps({ exec: () => Promise.resolve(1) });
    await runSolo({}, deps);
    expect(deps.dropCoverage).toHaveBeenCalledWith(deps.defaultReportsDirectory);
  });

  it('drops the json report the gates have finished reading', async () => {
    const { deps } = soloDeps();
    await runSolo({}, deps);
    expect(deps.dropReport).toHaveBeenCalledWith(TEMPORARY_REPORT);
  });

  it('drops the offset findings written beside the report', async () => {
    const { deps } = soloDeps();
    await runSolo({}, deps);
    expect(deps.dropReport).toHaveBeenCalledWith(`${TEMPORARY_REPORT}.offsets.json`);
  });

  it('drops the json report even when the tests failed', async () => {
    const { deps } = soloDeps({ exec: () => Promise.resolve(1) });
    await runSolo({}, deps);
    expect(deps.dropReport).toHaveBeenCalledWith(TEMPORARY_REPORT);
  });

  it('drops the json report only once every gate has read it', async () => {
    const order: string[] = [];
    const { deps } = soloDeps({
      readReport: () => {
        order.push('read');
        return COLLECTED_REPORT;
      },
      dropReport: vi.fn(() => {
        order.push('drop');
      }),
    });
    await runSolo({}, deps);
    expect(order).toEqual(['read', 'drop', 'drop']);
  });

  it('drops the json report of a run whose caller supplied its own reports directory', async () => {
    const { deps } = soloDeps({ passthroughArgs: ['--coverage.reportsDirectory=/elsewhere'] });
    await runSolo({}, deps);
    expect(deps.dropReport).toHaveBeenCalledWith(TEMPORARY_REPORT);
  });

  it('leaves a supplied reports directory to its caller, neither claiming nor dropping it', async () => {
    const { deps } = soloDeps({ passthroughArgs: ['--coverage.reportsDirectory=/elsewhere'] });
    await runSolo({}, deps);
    expect(deps.claimAndReclaimCoverage).not.toHaveBeenCalled();
    expect(deps.dropCoverage).not.toHaveBeenCalled();
  });

  it('states that a failing run\u2019s coverage numbers are partial', async () => {
    const { deps, warnings } = soloDeps({
      exec: () => Promise.resolve(1),
      readReport: () => ({
        testResults: [{ name: path.join(PACKAGE_DIR, 'a.test.ts'), status: 'failed' }],
      }),
    });
    await runSolo({}, deps);
    expect(warnings).toContain(`[api] ${partialCoverageReason(1)}`);
  });

  it('reports the coverage directories no run claim accounts for', async () => {
    const { deps, warnings } = soloDeps({
      claimAndReclaimCoverage: () =>
        Promise.resolve({ removed: [], unowned: ['/repo/apps/api/coverage/run-orphan'] }),
    });
    await runSolo({}, deps);
    expect(warnings.join('\n')).toContain('/repo/apps/api/coverage/run-orphan');
  });

  it('scopes the run to the package: dir filter, root config, own coverage globs', async () => {
    const { deps, calls } = soloDeps();
    await runSolo({}, deps);
    const args = calls[0]?.vitestArgs ?? [];
    expect(args[0]).toBe('run');
    expect(args[1]).toBe(PACKAGE_DIR);
    expect(args).toContain(`--config=${path.join(REPO_ROOT, 'vitest.projects.config.ts')}`);
    expect(args).toContain('--coverage.include=apps/api/src/**');
  });

  it('defaults the reports directory and says so, leaving a supplied one in force', async () => {
    const first = soloDeps();
    await runSolo({}, first.deps);
    expect(first.calls[0]?.vitestArgs).toContain(
      `--coverage.reportsDirectory=${first.deps.defaultReportsDirectory}`
    );
    expect(first.logs.join('\n')).toContain('coverage report →');

    const second = soloDeps({ passthroughArgs: ['--coverage.reportsDirectory=/elsewhere'] });
    await runSolo({}, second.deps);
    expect(
      second.calls[0]?.vitestArgs.filter((argument) =>
        argument.startsWith('--coverage.reportsDirectory')
      )
    ).toEqual(['--coverage.reportsDirectory=/elsewhere']);
  });

  it('drops bare separators and its own --config from the passthrough', async () => {
    const { deps, calls } = soloDeps({
      passthroughArgs: ['--', '--config', 'vitest.package.config.ts', '--passWithNoTests'],
    });
    await runSolo({}, deps);
    const args = calls[0]?.vitestArgs ?? [];
    expect(args).toContain('--passWithNoTests');
    expect(args).not.toContain('--');
    expect(args.some((argument) => argument.includes('vitest.package.config.ts'))).toBe(false);
  });

  it('hands the provider the offset-findings path through the environment', async () => {
    const { deps, calls } = soloDeps();
    await runSolo({}, deps);
    expect(calls[0]?.childEnv[REPORT_ENV]).toBe(`${TEMPORARY_REPORT}.offsets.json`);
  });

  it('propagates the vitest exit code and lets the pole gate raise a passing one', async () => {
    const failing = soloDeps({ exec: () => Promise.resolve(2) });
    expect(await runSolo({}, failing.deps)).toBe(2);

    const poled = soloDeps({
      readReport: () => ({
        testResults: [{ name: '/huge.test.ts', startTime: 0, endTime: 60_000 }],
      }),
    });
    expect(await runSolo({}, poled.deps)).toBe(1);
  });

  it('fails a passing run that measured no file at all', async () => {
    const { deps, warnings } = soloDeps({ readCoverageMap: () => ({}) });
    expect(await runSolo({}, deps)).toBe(1);
    expect(warnings.join('\n')).toContain('EMPTY COVERAGE SCOPE');
  });

  it('fails a run that wrote no coverage map at all, saying coverage went unevaluated', async () => {
    const { deps, warnings } = soloDeps({ readCoverageMap: () => undefined });
    expect(await runSolo({}, deps)).toBe(1);
    expect(warnings.join('\n')).toContain('COVERAGE NOT EVALUATED');
  });

  it('says coverage went unevaluated even when vitest itself already failed', async () => {
    const { deps, warnings } = soloDeps({
      readCoverageMap: () => undefined,
      exec: () => Promise.resolve(1),
    });
    expect(await runSolo({}, deps)).toBe(1);
    expect(warnings.join('\n')).toContain('COVERAGE NOT EVALUATED');
  });

  it('judges emptiness against the default reports directory', async () => {
    const seen: string[] = [];
    const { deps } = soloDeps({
      readCoverageMap: (directory) => {
        seen.push(directory);
        return { [path.join(PACKAGE_DIR, 'src', 'a.ts')]: {} };
      },
    });
    await runSolo({}, deps);
    expect(seen).toEqual([deps.defaultReportsDirectory]);
  });

  it('judges emptiness against a supplied reports directory instead', async () => {
    const seen: string[] = [];
    const { deps } = soloDeps({
      passthroughArgs: ['--coverage.reportsDirectory=/elsewhere'],
      readCoverageMap: (directory) => {
        seen.push(directory);
        return { [path.join(PACKAGE_DIR, 'src', 'a.ts')]: {} };
      },
    });
    await runSolo({}, deps);
    expect(seen).toEqual(['/elsewhere']);
  });

  it('warns and passes vitest code through when no json report was written', async () => {
    const { deps, warnings } = soloDeps({ readReport: () => undefined });
    expect(await runSolo({}, deps)).toBe(0);
    expect(warnings.join('\n')).toContain('no json report');
  });

  it('refuses to exit zero on a run vitest passed having collected no test file', async () => {
    const { deps, warnings } = soloDeps({ readReport: () => ({ testResults: [] }) });
    expect(await runSolo({}, deps)).toBe(1);
    expect(warnings.join('\n')).toContain('NO TEST FILES COLLECTED');
  });

  it('leaves a run that collected test files alone', async () => {
    const { deps, warnings } = soloDeps();
    expect(await runSolo({}, deps)).toBe(0);
    expect(warnings.join('\n')).not.toContain('NO TEST FILES COLLECTED');
  });

  /**
   * The solo path's own measurement. This launcher names reporters on its
   * command line, which replaces the configured recorder wholesale, so the row
   * a scoped standalone run leaves is this seam's or there is none at all.
   */
  it('declares the derived worker count on the launch line', async () => {
    const { deps, calls } = soloDeps();

    await runSolo({}, deps);

    expect(calls[0]?.vitestArgs).toContain(`--maxWorkers=${String(SOLO_DERIVED.workers)}`);
  });

  it('measures the runner it started, against the derivation it launched it at', async () => {
    const { deps, measured } = soloDeps();

    await runSolo({}, deps);

    expect(measured).toEqual([{ runnerPid: SOLO_RUNNER_PID, derivation: SOLO_DERIVED }]);
  });

  /**
   * One row for one run. Two recorders on one run price a width off a peak
   * counted twice, which is worse than not pricing it at all.
   */
  it('records what the finished run collected, once', async () => {
    const { deps, recorded } = soloDeps();

    await runSolo({}, deps);

    expect(recorded).toEqual([COLLECTED_REPORT]);
  });

  it('records a run whose json report never landed', async () => {
    const { deps, recorded } = soloDeps({ readReport: () => undefined });

    await runSolo({}, deps);

    expect(recorded).toEqual([undefined]);
  });

  /**
   * A binary that fails to spawn arrives with no process id, and standing a
   * number in for it would charge some other process's children as this run's
   * workers.
   */
  it('carries the absence of a runner into the measurement rather than defaulting it', async () => {
    /** What a binary that never spawned announces itself as. */
    const noRunner: number | undefined = undefined;
    const { deps, measured } = soloDeps({
      exec: (_vitestArgs, _childEnv, started) => {
        started(noRunner);
        return Promise.resolve(1);
      },
    });

    await runSolo({}, deps);

    expect(measured[0]?.runnerPid).toBeUndefined();
  });
});

describe('runBatched', () => {
  async function withServer(
    reply: (socket: net.Socket) => void,
    run: (port: number) => Promise<void>
  ): Promise<void> {
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        reply(socket);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('no port');
    }
    try {
      await run(address.port);
    } finally {
      server.close();
    }
  }

  const registration = { package: '@hushbox/api', dir: PACKAGE_DIR };

  it('resolves ok on an ok verdict', async () => {
    await withServer(
      (socket) => {
        socket.write(serializeLine({ verdict: 'ok' }));
        socket.end();
      },
      async (port) => {
        expect(await runBatched(port, registration, () => undefined)).toBe('ok');
      }
    );
  });

  it('resolves fail on a fail verdict and surfaces the reasons', async () => {
    const warnings: string[] = [];
    await withServer(
      (socket) => {
        socket.write(serializeLine({ verdict: 'fail', reasons: ['failed test file: x'] }));
        socket.end();
      },
      async (port) => {
        expect(await runBatched(port, registration, (line) => warnings.push(line))).toBe('fail');
        expect(warnings.join('\n')).toContain('failed test file: x');
      }
    );
  });

  it('resolves solo on a solo verdict', async () => {
    await withServer(
      (socket) => {
        socket.write(serializeLine({ verdict: 'solo' }));
        socket.end();
      },
      async (port) => {
        expect(await runBatched(port, registration, () => undefined)).toBe('solo');
      }
    );
  });

  it('fails loudly when the coordinator closes without a verdict', async () => {
    const warnings: string[] = [];
    await withServer(
      (socket) => {
        socket.end();
      },
      async (port) => {
        expect(await runBatched(port, registration, (line) => warnings.push(line))).toBe('fail');
        expect(warnings.join('\n')).toContain('without a verdict');
      }
    );
  });

  it('fails loudly when no coordinator is listening', async () => {
    const idle = net.createServer();
    await new Promise<void>((resolve) => {
      idle.listen(0, '127.0.0.1', resolve);
    });
    const address = idle.address();
    if (address === null || typeof address === 'string') {
      throw new Error('no port');
    }
    const port = address.port;
    await new Promise<void>((resolve) => {
      idle.close(() => {
        resolve();
      });
    });
    const warnings: string[] = [];
    expect(await runBatched(port, registration, (line) => warnings.push(line))).toBe('fail');
    expect(warnings.join('\n')).toContain('unreachable');
  });
});

describe('coverageDirectoryFs', () => {
  it('lists the entries of a coverage directory', async () => {
    await withScratchDirectory('hb-coverage-list-', (dir) => {
      mkdirSync(path.join(dir, 'run-1'));
      expect(coverageDirectoryFs.readdir(dir)).toEqual(['run-1']);
      return Promise.resolve();
    });
  });

  it('removes a run directory with its contents', async () => {
    await withScratchDirectory('hb-coverage-remove-', (dir) => {
      const target = path.join(dir, 'run-1');
      mkdirSync(target);
      writeFileSync(path.join(target, 'coverage-final.json'), '{}');
      coverageDirectoryFs.remove(target);
      expect(existsSync(target)).toBe(false);
      return Promise.resolve();
    });
  });

  it('removing a directory that is not there is not a failure', async () => {
    await withScratchDirectory('hb-coverage-absent-', (dir) => {
      expect(() => {
        coverageDirectoryFs.remove(path.join(dir, 'run-absent'));
      }).not.toThrow();
      return Promise.resolve();
    });
  });
});

describe('claimAndReclaimCoverage', () => {
  const CHECKOUT = path.join(path.sep, 'checkout-under-test', '.git');

  /**
   * The run claim this file was invoked under. A process that inherited one
   * adopts it instead of registering a second, so a case registering a run of
   * its own has to start from none — and give the inherited one back, or every
   * later suite here creates resources no claim names.
   */
  const inheritedRunClaim = process.env[RUN_CLAIM_ENV];

  async function underRun<T>(registryDir: string, body: () => Promise<T>): Promise<T> {
    process.env[RUN_CLAIM_ENV] = '';
    try {
      return await registerRun(
        { command: 'pnpm test:file', mode: 'test', slot: 4, gitCommonDir: CHECKOUT, registryDir },
        body
      );
    } finally {
      process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
    }
  }

  it('records this run\u2019s coverage directory against its own claim', async () => {
    await withScratchDirectory('hb-coverage-claim-', async (registryDir) => {
      await withScratchDirectory('hb-coverage-tree-', async (tree) => {
        await underRun(registryDir, async () => {
          const mine = runCoverageDirectory(tree, currentRunId() ?? '');
          await claimAndReclaimCoverage(mine, registryDir);
          const ownership = await readOwnership(registryDir);

          expect(ownership.stateOfResource('directory', mine)).toBe('owned-live');
        });
      });
    });
  });

  it('claims before it creates, so a killed run leaves a claim rather than an orphan', async () => {
    await withScratchDirectory('hb-coverage-claim-', async (registryDir) => {
      await withScratchDirectory('hb-coverage-tree-', async (tree) => {
        await underRun(registryDir, async () => {
          const mine = runCoverageDirectory(tree, currentRunId() ?? '');
          await claimAndReclaimCoverage(mine, registryDir);

          expect(existsSync(mine)).toBe(false);
        });
      });
    });
  });

  it('culls the coverage directory a run that died left behind', async () => {
    await withScratchDirectory('hb-coverage-claim-', async (registryDir) => {
      await withScratchDirectory('hb-coverage-tree-', async (tree) => {
        let dead = '';
        await expect(
          underRun(registryDir, () => {
            dead = runCoverageDirectory(tree, currentRunId() ?? '');
            mkdirSync(dead, { recursive: true });
            return Promise.reject(new Error('killed'));
          })
        ).rejects.toThrow('killed');

        await underRun(registryDir, async () => {
          const mine = runCoverageDirectory(tree, currentRunId() ?? '');
          const reclaim = await claimAndReclaimCoverage(mine, registryDir);

          expect(reclaim.removed).toEqual([dead]);
          expect(existsSync(dead)).toBe(false);
        });
      });
    });
  });
});

describe('dropCoverageDirectory', () => {
  it('removes the directory and everything under it', async () => {
    await withScratchDirectory('hb-coverage-drop-', (dir) => {
      const target = path.join(dir, 'run-1');
      mkdirSync(target);
      writeFileSync(path.join(target, 'coverage-final.json'), '{}');

      dropCoverageDirectory(target);

      expect(existsSync(target)).toBe(false);
      return Promise.resolve();
    });
  });
});

describe('measureVitestRun', () => {
  const RUNNER_PID = 4321;
  const ROOT = path.resolve(REPO_ROOT);

  /**
   * A width no other figure here carries, so a row filed at it can only have
   * taken it from the reading the peak came out of.
   */
  const TRACKED: TrackedRunSplit = {
    peakRssKb: 3_000_000,
    split: { fixedRssKb: 400_000 },
    peakRunnerChildren: 8,
    lanesAtPeak: 5,
  };

  const EVENTS: MachineMemoryEvents = { oomKills: 0 };

  const COLLECTED: VitestJsonReport = {
    testResults: [
      { name: 'a.test.ts', status: 'passed', startTime: 1000, endTime: 3000 },
      { name: 'b.test.ts', status: 'passed', startTime: 1000, endTime: 2000 },
    ],
  };

  /**
   * A run over two files named the way a report names them — absolutely — so the
   * keys the rows land under are the runner's own answer rather than this
   * file's.
   */
  const RAN = ['a.test.ts', 'b.test.ts'].map((name) => path.join(ROOT, 'pkg', name));

  const WEIGHED: VitestJsonReport = {
    testResults: RAN.map((name) => ({
      name,
      status: 'passed',
      startTime: 1000,
      endTime: 3000,
    })),
  };

  interface MeasureProbe {
    readonly deps: MeasuredRunDeps;
    readonly recorded: VitestRunRecord[];
    readonly weighed: TestFileMeasurement[][];
    readonly printed: string[];
    readonly warned: string[];
    readonly tracked: (number | undefined)[];
  }

  function probe(overrides: Partial<MeasuredRunDeps> = {}): MeasureProbe {
    const recorded: VitestRunRecord[] = [];
    const weighed: TestFileMeasurement[][] = [];
    const printed: string[] = [];
    const warned: string[] = [];
    const tracked: (number | undefined)[] = [];
    return {
      recorded,
      weighed,
      printed,
      warned,
      tracked,
      deps: {
        repoRoot: ROOT,
        track: (runnerPid) => {
          tracked.push(runnerPid);
          return { stop: () => TRACKED };
        },
        record: (record, files) => {
          recorded.push(record);
          weighed.push([...files]);
          return { kind: 'recorded' };
        },
        machineEvents: () => EVENTS,
        derivation: {
          workers: 8,
          state: 'cold-start',
          bound: 'unmeasured',
          memoryCapped: false,
          memoryGuarded: false,
          units: 0,
        },
        shape: 'package',
        report: (line) => printed.push(line),
        warn: (line) => warned.push(line),
        ...overrides,
      },
    };
  }

  it('samples the tree the runner it was given is the runner of', () => {
    const harness = probe();
    measureVitestRun(RUNNER_PID, harness.deps);
    expect(harness.tracked).toEqual([RUNNER_PID]);
  });

  it('records the peak and the split the tracker reached', () => {
    const harness = probe();
    measureVitestRun(RUNNER_PID, harness.deps).record(COLLECTED);
    expect(harness.recorded[0]).toMatchObject({
      peakRssKb: 3_000_000,
      split: TRACKED.split,
      runnerPid: RUNNER_PID,
      declaredWorkers: 8,
    });
  });

  it('stamps the row with the shape of the invocation that measured it', () => {
    const harness = probe();
    measureVitestRun(RUNNER_PID, harness.deps).record(COLLECTED);
    expect(harness.recorded[0]?.shape).toBe('package');
  });

  /**
   * The stamp comes from the caller, so the two launchers sharing this
   * measurement file their histories apart: retention ages a width on the runs
   * of its own shape.
   */
  it('stamps a row of another shape with the shape that caller named', () => {
    const harness = probe({ shape: 'watch' });
    measureVitestRun(RUNNER_PID, harness.deps).record(COLLECTED);
    expect(harness.recorded[0]?.shape).toBe('watch');
  });

  it('files the row at the lanes live when it peaked, not at the count it declared', () => {
    const harness = probe();
    measureVitestRun(RUNNER_PID, harness.deps).record(COLLECTED);
    expect(harness.recorded[0]?.lanesAtPeak).toBe(5);
  });

  it('files no width where the tracker read none', () => {
    const harness = probe({
      track: () => ({ stop: () => ({ ...TRACKED, lanesAtPeak: undefined }) }),
    });
    measureVitestRun(RUNNER_PID, harness.deps).record(COLLECTED);
    expect(harness.recorded[0]?.lanesAtPeak).toBeUndefined();
  });

  it('records the one package a package-rooted run covers', () => {
    const harness = probe();
    measureVitestRun(RUNNER_PID, harness.deps).record(COLLECTED);
    expect(harness.recorded[0]?.packageCount).toBe(1);
  });

  it('records the files the report says the run collected, and their work', () => {
    const harness = probe();
    measureVitestRun(RUNNER_PID, harness.deps).record(COLLECTED);
    expect(harness.recorded[0]).toMatchObject({
      fileCount: 2,
      perFileWallMs: 1500,
      sumFileWallMs: 3000,
    });
  });

  it('records a run whose report never landed as having collected no file', () => {
    const harness = probe();
    // A run killed before the reporter wrote anything: what reaches the
    // recorder is the absence itself, which is not the same as an empty report.
    const unwritten: VitestJsonReport | undefined = undefined;
    measureVitestRun(RUNNER_PID, harness.deps).record(unwritten);
    expect(harness.recorded[0]).toMatchObject({
      fileCount: 0,
      perFileWallMs: undefined,
      sumFileWallMs: undefined,
    });
  });

  /**
   * The write half of the measurement: a run states what each file it ran was
   * weighed at, so the next run's work bound schedules walls this path
   * measured rather than only walls a batch did.
   */
  it('records a wall for every file it ran, keyed the way the ledger keys one', () => {
    const harness = probe();
    measureVitestRun(RUNNER_PID, harness.deps).record(WEIGHED);
    expect(harness.weighed[0]).toEqual([
      { file: 'pkg/a.test.ts', wallMs: 2000 },
      { file: 'pkg/b.test.ts', wallMs: 2000 },
    ]);
  });

  it('prints what the run measured where the row was recorded', () => {
    const harness = probe();
    measureVitestRun(RUNNER_PID, harness.deps).record(COLLECTED);
    expect(harness.printed.join('\n')).toMatch(/ledger row: recorded/);
    expect(harness.warned).toEqual([]);
  });

  it('warns rather than prints where the row was refused, carrying what refused it', () => {
    const harness = probe({
      record: () => ({ kind: 'refused', reason: 'the batch covered no package' }),
    });
    measureVitestRun(RUNNER_PID, harness.deps).record(COLLECTED);
    expect(harness.warned.join('\n')).toMatch(/refused — the batch covered no package/);
    expect(harness.printed).toEqual([]);
  });
});

/**
 * Against a real repository root, because the unit set is scoped by what is
 * still in the tree: a row naming a file nobody can open again is not work
 * about to run, and a fake disk would let one stand in for one.
 */
