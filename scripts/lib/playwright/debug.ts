/**
 * E2E Debug Report Generator
 *
 * Pure functions for categorizing Playwright test results and generating
 * AI-agent-friendly reports with per-test artifact directories.
 * Used by e2e-reporter.ts (custom Playwright reporter).
 */

import {
  mkdirSync,
  rmSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  buildRerunCommand,
  errorTextOrSentinel,
  generateMarkdownReport,
  repoRelativeArtifactPath,
  slugify,
  stripAnsi,
  unlistedResultErrors,
} from './debug-render.js';
import type {
  CoverageReport,
  DebugReport,
  FailedTest,
  FailedTestArtifacts,
  FlakyTest,
  FlattenedTestResult,
  JsonReport,
  JsonTestEntry,
  LostProject,
  PassedTest,
  PlaywrightReport,
  PlaywrightSpec,
  PlaywrightSuite,
  PlaywrightTest,
  PlaywrightTestResult,
  UnrunTest,
} from './debug-shapes.js';

/**
 * The report shapes are published from here as well as from their own module,
 * because this is the door the reporter and the report's tests already come
 * through.
 */
export type * from './debug-shapes.js';

interface CategorizedTests {
  passed: PassedTest[];
  flaky: FlakyTest[];
  failed: FailedTest[];
  didNotRun: UnrunTest[];
  skipped: UnrunTest[];
}

function joinErrorMessages(test: FlattenedTestResult): string {
  return (test.errors ?? [])
    .map((e) => e.message)
    .filter((m): m is string => m !== undefined)
    .join('\n');
}

/** The entry that shows the chosen attempt's evidence; failed and flaky entries share its shape. */
function buildAttemptEntry(test: FlattenedTestResult): FailedTest & FlakyTest {
  return {
    title: test.title,
    file: test.file,
    line: test.line,
    project: test.projectName,
    attempts: test.attempts ?? test.retry + 1,
    attemptStatus: test.status,
    attemptRetry: test.retry,
    error: joinErrorMessages(test),
    duration: test.duration,
    steps: test.steps ?? [],
    artifacts: extractArtifactPaths(test),
  };
}

function buildPassedEntry(test: FlattenedTestResult): PassedTest {
  return {
    title: test.title,
    file: test.file,
    project: test.projectName,
    duration: test.duration,
  };
}

function buildUnrunEntry(test: FlattenedTestResult): UnrunTest {
  return {
    title: test.title,
    file: test.file,
    line: test.line,
    project: test.projectName,
  };
}

export function categorizeTests(tests: FlattenedTestResult[]): CategorizedTests {
  const result: CategorizedTests = {
    passed: [],
    flaky: [],
    failed: [],
    didNotRun: [],
    skipped: [],
  };

  // An outcome outside these four lands in no list, and the partition check in
  // `generateDebugReport` reports the gap rather than guessing where it belongs.
  for (const test of tests) {
    switch (test.testStatus) {
      case 'skipped': {
        const list = test.expectedStatus === 'skipped' ? result.skipped : result.didNotRun;
        list.push(buildUnrunEntry(test));
        break;
      }
      case 'flaky': {
        // Playwright's outcome is the only classifier. Deriving flakiness from the
        // chosen attempt instead ("passed with retry > 0") mislabels a serial
        // block-mate: Playwright re-runs one that already passed when a sibling in
        // the block fails, and it passes again, so every attempt is green and there
        // is no failure evidence a flaky entry could show.
        result.flaky.push(buildAttemptEntry(test));
        break;
      }
      case 'unexpected': {
        result.failed.push(buildAttemptEntry(test));
        break;
      }
      case 'expected': {
        // Whatever the final status: a `test.fail()` test that failed ended as it declared.
        result.passed.push(buildPassedEntry(test));
        break;
      }
    }
  }

  return result;
}

export function extractArtifactPaths(test: FlattenedTestResult): FailedTestArtifacts {
  const attachments = test.attachments ?? [];
  const findPath = (name: string): string | undefined =>
    attachments.find((a) => a.name === name)?.path;

  function collectLabeledBodies(prefix: string): string | undefined {
    const matches = attachments.filter((a) => a.name.startsWith(`${prefix}-`) && a.body);
    if (matches.length === 0) return undefined;
    if (matches.length === 1) {
      const match = matches[0];
      if (!match) return undefined;
      return match.body;
    }
    return matches
      .map((a) => {
        const label = a.name.slice(prefix.length + 1);
        return `--- ${label} ---\n${a.body ?? ''}`;
      })
      .join('\n\n');
  }

  function collectLabeledPaths(prefix: string): string[] {
    return attachments
      .filter(
        (a): a is typeof a & { path: string } =>
          a.name.startsWith(`${prefix}-`) && a.path !== undefined
      )
      .map((a) => a.path);
  }

  return {
    trace: findPath('trace'),
    screenshot: findPath('screenshot'),
    video: findPath('video'),
    consoleErrors: collectLabeledBodies('console-errors'),
    apiErrors: collectLabeledBodies('api-errors'),
    pageSnapshot: collectLabeledBodies('page-snapshot'),
    harFiles: collectLabeledPaths('har'),
  };
}

function createFlattenedResult(
  spec: PlaywrightSpec,
  test: PlaywrightTest,
  result: PlaywrightTestResult
): FlattenedTestResult {
  return {
    title: spec.title,
    file: spec.file,
    line: spec.line,
    projectName: test.projectName,
    testStatus: test.status,
    expectedStatus: test.expectedStatus,
    status: result.status,
    retry: result.retry,
    attempts: test.results.length,
    duration: result.duration,
    errors: result.errors ?? [],
    steps: result.steps ?? [],
    attachments: result.attachments ?? [],
  };
}

/**
 * The attempt whose data the report shows. A whole result is chosen, never a
 * merge of several — error, steps, screenshot and trace always describe the
 * same attempt.
 */
function chooseResult(test: PlaywrightTest): PlaywrightTestResult | undefined {
  const final = test.results.at(-1);

  // For flaky tests (final attempt passed after retries), surface the
  // last failing attempt's data — that's the one with the trace, screenshot,
  // error message, and steps worth debugging.
  if (test.status === 'flaky') {
    return (
      test.results
        .toReversed()
        .find(
          (r) => r.status !== 'passed' && r.status !== 'skipped' && r.status !== 'interrupted'
        ) ?? final
    );
  }

  if (test.status === 'skipped') return final;

  // Any other outcome was decided by an attempt that ran. A skipped attempt says
  // nothing about the test: it is a serial group's re-run that stopped at an
  // earlier sibling's failure before reaching this one.
  const ran = test.results.filter((r) => r.status !== 'skipped');
  const latest = ran.at(-1) ?? final;
  if (!latest || latest.status === 'passed') return latest;

  // A failure: prefer the latest attempt that recorded a trace. Playwright's
  // `retain-on-first-failure` mode traces only attempt 0, so the final attempt
  // of a retried failure carries none and the report would offer nothing to
  // replay.
  return ran.toReversed().find((r) => hasTrace(r)) ?? latest;
}

function hasTrace(result: PlaywrightTestResult): boolean {
  return (result.attachments ?? []).find((a) => a.name === 'trace')?.path !== undefined;
}

function collectTestsFromSuite(suite: PlaywrightSuite): FlattenedTestResult[] {
  const tests: FlattenedTestResult[] = [];

  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const chosen = chooseResult(test);
      if (!chosen) continue;
      tests.push(createFlattenedResult(spec, test, chosen));
    }
  }

  for (const nestedSuite of suite.suites ?? []) {
    tests.push(...collectTestsFromSuite(nestedSuite));
  }

  return tests;
}

/**
 * The dependency edges the runner acts on, read off the run's own config, so a
 * project the config adds is covered with no change here. A project the config
 * gives no dependency has none to blame, and a loss it suffers is reported as
 * one this report cannot attribute.
 */
function dependenciesByProject(report: PlaywrightReport): Map<string, readonly string[]> {
  return new Map(report.projects.map((project) => [project.name, project.dependencies]));
}

interface ProjectTally {
  configured: number;
  executed: number;
  /** Tests Playwright's own outcome calls unexpected — the rule it drops a dependent project on. */
  unexpected: number;
}

/**
 * Per-project tallies over the tests the run CONFIGURED, including the ones it
 * never ran. A test the runner never reached carries no result at all, which is
 * what tells it apart from one that was skipped: a skip still records a result.
 */
function tallyConfiguredTests(suite: PlaywrightSuite, tally: Map<string, ProjectTally>): void {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const entry = tally.get(test.projectName) ?? { configured: 0, executed: 0, unexpected: 0 };
      entry.configured += 1;
      if (test.results.length > 0) entry.executed += 1;
      if (test.status === 'unexpected') entry.unexpected += 1;
      tally.set(test.projectName, entry);
    }
  }

  for (const nested of suite.suites ?? []) {
    tallyConfiguredTests(nested, tally);
  }
}

type FailedDependencies = NonNullable<LostProject['dependencies']>;

/**
 * Every one of `dependencies` with a failed test, in the order given. The runner
 * drops a dependent when any one of its dependencies fails, so each failed one is
 * a cause in its own right and none stands for the others.
 */
function failedDependencies(
  dependencies: readonly string[],
  tally: Map<string, ProjectTally>
): FailedDependencies {
  return dependencies.flatMap((dependency) => {
    const failedTests = tally.get(dependency)?.unexpected ?? 0;
    return failedTests > 0 ? [{ project: dependency, failedTests }] : [];
  });
}

function describeLoss(
  project: string,
  configured: number,
  failed: FailedDependencies,
  status: PlaywrightReport['status']
): LostProject {
  // Order is load-bearing: an aborted run can also have dropped a project for a
  // failed dependency, and only that cause carries a remedy the operator can act on.
  if (failed.length > 0) {
    return { project, tests: configured, reason: 'dependency-failed', dependencies: failed };
  }
  if (status === 'timedout' || status === 'interrupted') {
    return { project, tests: configured, reason: 'run-cut-short' };
  }
  return { project, tests: configured, reason: 'unexplained' };
}

/** What the report holds against what executed, and every project that produced nothing. */
function projectCoverage(report: PlaywrightReport, listedTests: number): CoverageReport {
  const tally = new Map<string, ProjectTally>();
  for (const suite of report.suites) {
    tallyConfiguredTests(suite, tally);
  }
  const dependencies = dependenciesByProject(report);

  const lost: LostProject[] = [];
  let testsInReport = 0;
  let executedTests = 0;
  let executedProjects = 0;
  for (const [project, counts] of tally) {
    testsInReport += counts.configured;
    executedTests += counts.executed;
    if (counts.executed > 0) {
      executedProjects += 1;
      continue;
    }
    const failed = failedDependencies(dependencies.get(project) ?? [], tally);
    lost.push(describeLoss(project, counts.configured, failed, report.status));
  }

  return {
    projectsInReport: tally.size,
    executedProjects,
    testsInReport,
    executedTests,
    // {@link categorizeTests} places a test in at most one list, so the difference counts omissions only.
    unlistedTests: executedTests - listedTests,
    lost,
  };
}

const LIST = new Intl.ListFormat('en', { type: 'conjunction' });

/**
 * One run-level error per project that produced nothing. It is an error rather
 * than a note because the alternative is a pass count that reads as a coverage
 * claim it cannot support: the report's output for a third of the matrix is
 * otherwise identical to its output for all of it.
 */
function coverageErrors(coverage: CoverageReport, status: PlaywrightReport['status']): string[] {
  return coverage.lost.map((loss) => {
    const opening = `Lost coverage: project "${loss.project}" produced no result for any of its configured tests (${String(loss.tests)}).`;
    if (loss.dependencies) {
      const several = loss.dependencies.length > 1;
      const names = LIST.format(loss.dependencies.map((dependency) => `"${dependency.project}"`));
      const counts = LIST.format(
        loss.dependencies.map((dependency) => String(dependency.failedTests))
      );
      return (
        `${opening} Its dependency ${several ? 'projects' : 'project'} ${names} ${several ? 'have' : 'has'} ` +
        `failed tests (${counts}), so the runner removed "${loss.project}" from the run. ` +
        'Those tests are unproven, not passed — fix the setup failure and re-run.'
      );
    }
    if (loss.reason === 'run-cut-short') {
      return (
        `${opening} The run ended as "${String(status)}", so the project was cut short rather than removed. ` +
        'Those tests are unproven, not passed — the run must finish before its pass count means anything.'
      );
    }
    // A run stopped by `maxFailures` reports "failed", exactly as one that ran
    // every test does, so the status field cannot establish that the run finished.
    // The message claims only what the field does say: no timeout, no interruption.
    return (
      `${opening} No setup project of it failed, and the run reported neither a timeout nor an interruption, ` +
      'so this report cannot name the cause — a run stopped by the failure cap reports neither. ' +
      'Those tests are unproven, not passed.'
    );
  });
}

export function generateDebugReport(report: PlaywrightReport): DebugReport {
  const allTests: FlattenedTestResult[] = [];

  for (const suite of report.suites) {
    allTests.push(...collectTestsFromSuite(suite));
  }

  const categorized = categorizeTests(allTests);
  const listedTests =
    categorized.failed.length +
    categorized.flaky.length +
    categorized.passed.length +
    categorized.didNotRun.length +
    categorized.skipped.length;
  const coverage = projectCoverage(report, listedTests);
  const globalErrors = [
    ...(report.errors ?? []),
    ...coverageErrors(coverage, report.status),
    ...unlistedResultErrors(coverage),
  ];

  return {
    summary: {
      total: categorized.passed.length + categorized.flaky.length + categorized.failed.length,
      passed: categorized.passed.length,
      flaky: categorized.flaky.length,
      failed: categorized.failed.length,
      duration: report.stats.duration,
    },
    passed: categorized.passed,
    flaky: categorized.flaky,
    failed: categorized.failed,
    didNotRun: categorized.didNotRun,
    skipped: categorized.skipped,
    coverage,
    ...(report.status !== undefined && { status: report.status }),
    ...(globalErrors.length > 0 && { globalErrors }),
  };
}

/** Where a test's report directory keeps its copies of the artifacts Playwright recorded. */
function artifactCopiesIn(testDir: string): { screenshot: string; trace: string; har: string } {
  return {
    screenshot: path.join(testDir, 'screenshot.png'),
    trace: path.join(testDir, 'trace'),
    har: path.join(testDir, 'network.har'),
  };
}

/** The directory a test's copied artifacts are written to under a run's report directory. */
function testDirIn(
  reportDir: string,
  outcome: 'failed' | 'flaky',
  test: FailedTest | FlakyTest
): string {
  return path.join(reportDir, outcome, slugify(`${test.file}--${test.project}--${test.title}`));
}

/**
 * The test's JSON entry. Given `testDir`, where its artifacts were copied, an
 * artifact kept outside the checkout is named by its copy there, which exists
 * only where the source did.
 */
export function serializeTestForJson(
  test: FailedTest | FlakyTest,
  repoRoot = process.cwd(),
  testDir?: string
): JsonTestEntry {
  const copies = testDir === undefined ? undefined : artifactCopiesIn(testDir);
  const pointer = (artifactPath: string, copy: string | undefined): string | undefined =>
    repoRelativeArtifactPath(
      artifactPath,
      repoRoot,
      copy !== undefined && existsSync(copy) ? copy : undefined
    );
  const relative = (artifactPath: string | undefined, copy?: string): string | undefined =>
    artifactPath === undefined ? undefined : pointer(artifactPath, copy);
  return {
    title: test.title,
    file: test.file,
    line: test.line,
    project: test.project,
    attempts: test.attempts,
    duration: test.duration,
    error: stripAnsi(test.error),
    rerunCommand: buildRerunCommand(test),
    steps: test.steps,
    artifacts: {
      screenshot: relative(test.artifacts.screenshot, copies?.screenshot),
      trace: relative(test.artifacts.trace, copies?.trace),
      // The report directory keeps no copy of a video.
      video: relative(test.artifacts.video),
      consoleErrors: test.artifacts.consoleErrors,
      apiErrors: test.artifacts.apiErrors,
      pageSnapshot: test.artifacts.pageSnapshot,
      // HAR files outside the checkout are all named by the one log they were merged into.
      harFiles: [
        ...new Set(
          test.artifacts.harFiles
            .map((harPath) => pointer(harPath, copies?.har))
            .filter((harPath) => harPath !== undefined)
        ),
      ],
    },
  };
}

/**
 * The run's JSON report. Given `reportDir`, the directory the tests' artifacts
 * were copied into, its pointers can name those copies.
 */
export function generateJsonReport(
  report: DebugReport,
  repoRoot = process.cwd(),
  reportDir?: string
): JsonReport {
  const entry = (test: FailedTest | FlakyTest, outcome: 'failed' | 'flaky'): JsonTestEntry =>
    serializeTestForJson(
      test,
      repoRoot,
      reportDir === undefined ? undefined : testDirIn(reportDir, outcome, test)
    );
  return {
    date: new Date().toISOString().slice(0, 10),
    summary: report.summary,
    ...(report.status !== undefined && { status: report.status }),
    ...(report.globalErrors &&
      report.globalErrors.length > 0 && { globalErrors: report.globalErrors }),
    ...(report.coverage && { coverage: report.coverage }),
    failed: report.failed.map((test) => entry(test, 'failed')),
    flaky: report.flaky.map((test) => entry(test, 'flaky')),
    didNotRun: report.didNotRun,
    skipped: report.skipped,
    passed: report.passed.map((test) => ({
      title: test.title,
      file: test.file,
      project: test.project,
      duration: test.duration,
    })),
    ...(report.resources && {
      resources: {
        summary: report.resources.summary,
        scan: report.resources.scan,
      },
    }),
  };
}

export function mergeHarFiles(harPaths: string[], outputPath: string): void {
  const allEntries: unknown[] = [];
  for (const harPath of harPaths) {
    if (!existsSync(harPath)) continue;
    const raw = readFileSync(harPath, 'utf8');
    const har = JSON.parse(raw) as { log: { entries: unknown[] } };
    allEntries.push(...har.log.entries);
  }
  if (allEntries.length === 0) return;
  const merged = {
    log: {
      version: '1.2',
      entries: allEntries,
    },
  };
  writeFileSync(outputPath, JSON.stringify(merged, null, 2), 'utf8');
}

const TRACE_FRAME_JPEG = /^resources\/page@[^/]+\.jpeg$/;

export function extractTraceArchive(zipPath: string, destinationDir: string): void {
  if (!existsSync(zipPath)) return;
  mkdirSync(destinationDir, { recursive: true });
  // Drop the visual frame screenshots (resources/page@*.jpeg); the DOM
  // snapshots (in *.trace) and captured sources (resources/src@*.txt) remain.
  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (TRACE_FRAME_JPEG.test(entry.entryName)) continue;
    zip.extractEntryTo(entry, destinationDir, true, true);
  }
}

export function writePerTestArtifacts(test: FailedTest, testDir: string): void {
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    path.join(testDir, 'error.txt'),
    errorTextOrSentinel(stripAnsi(test.error), test),
    'utf8'
  );
  writeFileSync(path.join(testDir, 'steps.json'), JSON.stringify(test.steps, null, 2), 'utf8');

  if (test.artifacts.consoleErrors) {
    writeFileSync(path.join(testDir, 'console-errors.txt'), test.artifacts.consoleErrors, 'utf8');
  }

  if (test.artifacts.apiErrors) {
    writeFileSync(path.join(testDir, 'api-errors.txt'), test.artifacts.apiErrors, 'utf8');
  }

  if (test.artifacts.pageSnapshot) {
    writeFileSync(path.join(testDir, 'page-snapshot.txt'), test.artifacts.pageSnapshot, 'utf8');
  }

  const copies = artifactCopiesIn(testDir);

  if (test.artifacts.screenshot && existsSync(test.artifacts.screenshot)) {
    copyFileSync(test.artifacts.screenshot, copies.screenshot);
  }

  if (test.artifacts.harFiles.length > 0) {
    mergeHarFiles(test.artifacts.harFiles, copies.har);
  }

  if (test.artifacts.trace) {
    extractTraceArchive(test.artifacts.trace, copies.trace);
  }
}

/**
 * How many of the most recent runs retention keeps, whatever their size: the
 * debugging window, deep enough to hold the run that just failed and the
 * handful before it that a bisect walks back through.
 */
const RECENT_REPORTS_KEPT = 10;

/**
 * How many of the largest runs by recorded test count retention keeps, whatever
 * their age. A full-matrix run and the comparison run beside it are two, and a
 * third holds the earlier full run a regression is measured against; below three
 * a comparison cannot survive intact, which is the loss this pool exists to
 * prevent. The archive is therefore bounded at
 * {@link RECENT_REPORTS_KEPT} + {@link LARGEST_REPORTS_KEPT} directories.
 */
const LARGEST_REPORTS_KEPT = 3;

/**
 * A report directory name: the UTC day, then the run's ordinal within that day.
 * The name is cited in documents that get committed, so it stays at day
 * resolution; the ordinal carries the only thing a time of day was buying, which
 * is the order of runs inside a day. It is unpadded, so ordering these names
 * lexically is wrong from the tenth run of a day onward.
 */
const REPORT_DIRECTORY_NAME = /^(\d{4}-\d{2}-\d{2})-run(\d+)$/;

/**
 * Sort key over report directory names, oldest first: day, then ordinal.
 * Directories minted before names dropped to day resolution carry an instant
 * where the ordinal now sits; they order among themselves by that instant and
 * ahead of every ordinal-named run of the same day, all of which postdate the
 * change. They are never renamed — the tree is git-ignored, and the retention
 * limit removes them in turn.
 */
function reportSortKey(name: string): readonly [string, number, string] {
  const day = name.slice(0, 10);
  const ordinal = REPORT_DIRECTORY_NAME.exec(name)?.[2];
  return ordinal === undefined ? [day, -1, name] : [day, Number(ordinal), ''];
}

function compareReportDirectories(a: string, b: string): number {
  const [dayA, ordinalA, restA] = reportSortKey(a);
  const [dayB, ordinalB, restB] = reportSortKey(b);
  return dayA.localeCompare(dayB) || ordinalA - ordinalB || restA.localeCompare(restB);
}

/** The next unused `<day>-run<n>` in `baseDir`, continuing that day's highest ordinal. */
function nextReportDirectoryName(baseDir: string, day: string): string {
  const existing = existsSync(baseDir)
    ? readdirSync(baseDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];

  let highest = 0;
  for (const name of existing) {
    const parsed = REPORT_DIRECTORY_NAME.exec(name);
    if (parsed?.[1] === day) highest = Math.max(highest, Number(parsed[2]));
  }

  return `${day}-run${String(highest + 1)}`;
}

/**
 * The test count a run's `report.json` recorded, or `undefined` when the
 * directory states none — a run killed before its report was written, or a
 * directory this writer did not make. Such a run competes for the recency pool
 * only: it cannot be ranked by a size it never claimed.
 */
function recordedTestCount(runDir: string): number | undefined {
  const reportFile = path.join(runDir, 'report.json');
  if (!existsSync(reportFile)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(reportFile, 'utf8')) as {
      summary?: { total?: unknown };
    };
    const total = parsed.summary?.total;
    return typeof total === 'number' ? total : undefined;
  } catch {
    // Unreadable as JSON is the same fact as absent: the run stated no size.
    return undefined;
  }
}

/**
 * Two independent pools, because a count-based limit lets ten three-minute runs
 * evict a full-matrix run whose evidence nothing else holds: the `maxRecent`
 * newest runs survive for ordinary debugging, and the `maxLargest` runs with the
 * highest recorded test count survive whatever their age. A run in either pool
 * survives; a run in both occupies one slot in each and buys neither pool a
 * further one, so the survivors number at most `maxRecent + maxLargest`.
 *
 * Test count rather than duration is the size measure: a run that aborts early
 * is short in time but large in intent, and that is the shape that was lost.
 */
export function enforceRetentionLimit(
  baseDir: string,
  maxRecent: number,
  maxLargest: number
): void {
  if (!existsSync(baseDir)) return;

  const entries = readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted(compareReportDirectories);

  const sized: { name: string; testCount: number }[] = [];
  for (const name of entries) {
    const testCount = recordedTestCount(path.join(baseDir, name));
    if (testCount !== undefined) sized.push({ name, testCount });
  }

  const kept = new Set([
    ...entries.slice(Math.max(0, entries.length - Math.max(0, maxRecent))),
    ...sized
      // Largest first; equal counts are broken by recency, newest first.
      .toSorted((a, b) => b.testCount - a.testCount || compareReportDirectories(b.name, a.name))
      .slice(0, Math.max(0, maxLargest))
      .map((entry) => entry.name),
  ]);

  for (const name of entries) {
    if (kept.has(name)) continue;
    rmSync(path.join(baseDir, name), { recursive: true, force: true });
  }
}

export function writeReport(
  report: DebugReport,
  baseDir: string,
  repoRoot = process.cwd()
): string {
  const day = new Date().toISOString().slice(0, 10);
  const reportDir = path.join(baseDir, nextReportDirectoryName(baseDir, day));
  mkdirSync(reportDir, { recursive: true });

  for (const test of report.failed) {
    writePerTestArtifacts(test, testDirIn(reportDir, 'failed', test));
  }

  for (const test of report.flaky) {
    // FlakyTest shares FailedTest's artifact shape, so the same writer works.
    writePerTestArtifacts(
      {
        title: test.title,
        file: test.file,
        line: test.line,
        project: test.project,
        attempts: test.attempts,
        attemptStatus: test.attemptStatus,
        attemptRetry: test.attemptRetry,
        error: test.error,
        duration: test.duration,
        steps: test.steps,
        artifacts: test.artifacts,
      },
      testDirIn(reportDir, 'flaky', test)
    );
  }

  const markdown = generateMarkdownReport(report, repoRoot);
  writeFileSync(path.join(reportDir, 'REPORT.md'), markdown, 'utf8');

  const jsonReport = generateJsonReport(report, repoRoot, reportDir);
  writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(jsonReport, null, 2), 'utf8');

  if (report.resources) {
    writeFileSync(
      path.join(reportDir, 'resource-timeline.json'),
      JSON.stringify(report.resources.samples, null, 2),
      'utf8'
    );
  }

  enforceRetentionLimit(baseDir, RECENT_REPORTS_KEPT, LARGEST_REPORTS_KEPT);

  return reportDir;
}
