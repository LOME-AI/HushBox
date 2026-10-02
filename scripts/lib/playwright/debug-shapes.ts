/**
 * The shapes an E2E debug report is built from: Playwright's own JSON reporter
 * output on the way in, and the categorized report and its serialized forms on
 * the way out.
 */

import type { ResourceReport, ResourceSummary } from '../../resource-sampler.js';
import type { ResourceScan } from '../../resource-scan.js';

export interface PlaywrightError {
  message?: string;
  stack?: string;
}

export interface PlaywrightStep {
  title: string;
  duration: number;
  category?: string;
  steps?: PlaywrightStep[];
  error?: string;
}

export interface PlaywrightAttachment {
  name: string;
  path?: string;
  body?: string;
  contentType?: string;
}

// Result of a single test run attempt (retry)
export interface PlaywrightTestResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  retry: number;
  duration: number;
  startTime?: string;
  errors?: PlaywrightError[];
  steps?: PlaywrightStep[];
  attachments?: PlaywrightAttachment[];
}

// Test entry per project (contains array of retry attempts)
export interface PlaywrightTest {
  projectName: string;
  status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  /** The status the test declared it would end in; `skipped` only for a declared skip. */
  expectedStatus: PlaywrightTestResult['status'];
  results: PlaywrightTestResult[];
}

// Spec contains title/file and array of tests per project
export interface PlaywrightSpec {
  title: string;
  file: string;
  line?: number | undefined;
  tests?: PlaywrightTest[];
}

// Internal flattened type for categorization. `testStatus` mirrors Playwright's
// per-test.outcome() and is the sole authority for flaky categorization, so it
// is required — an omission would otherwise fall back to a second classifier
// that disagrees with Playwright. `attempts` is the total number of results
// across retries.
export interface FlattenedTestResult {
  title: string;
  file: string;
  line?: number | undefined;
  projectName: string;
  testStatus: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  expectedStatus: PlaywrightTest['expectedStatus'];
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  retry: number;
  attempts?: number;
  duration: number;
  errors?: PlaywrightError[];
  steps?: PlaywrightStep[];
  attachments?: PlaywrightAttachment[];
}

export interface PlaywrightSuite {
  title: string;
  file: string;
  specs?: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}

// Overall run outcome from Playwright's FullResult. Anything other than
// 'passed' means the run did not complete cleanly, even when no individual test
// is counted as failed (e.g. an aborted output-dir cleanup or a Ctrl+C).
export type RunStatus = 'passed' | 'failed' | 'timedout' | 'interrupted';

/** A project the run's config declares, and the projects it waits on. */
export interface PlaywrightProject {
  name: string;
  dependencies: readonly string[];
}

export interface PlaywrightReport {
  suites: PlaywrightSuite[];
  config: Record<string, unknown>;
  /** Every project the run's config declares: the only statement of which project gates which. */
  projects: readonly PlaywrightProject[];
  stats: {
    duration: number;
  };
  status?: RunStatus;
  // Run-level errors reported via reporter.onError — global setup throwing, a
  // webServer crash, or output-dir cleanup failing before any test runs.
  errors?: string[];
}

export interface PassedTest {
  title: string;
  file: string;
  project: string;
  duration: number;
}

export interface FlakyTest {
  title: string;
  file: string;
  line?: number | undefined;
  project: string;
  attempts: number;
  attemptStatus: FlattenedTestResult['status'];
  attemptRetry: number;
  error: string;
  duration: number;
  steps: PlaywrightStep[];
  artifacts: FailedTestArtifacts;
}

/**
 * A test that produced a result but no verdict: every attempt it recorded was
 * skipped or interrupted.
 */
export interface UnrunTest {
  title: string;
  file: string;
  line?: number | undefined;
  project: string;
}

export interface FailedTestArtifacts {
  trace: string | undefined;
  screenshot: string | undefined;
  video: string | undefined;
  consoleErrors: string | undefined;
  apiErrors: string | undefined;
  pageSnapshot: string | undefined;
  harFiles: string[];
}

export interface FailedTest {
  title: string;
  file: string;
  line?: number | undefined;
  project: string;
  attempts: number;
  attemptStatus: FlattenedTestResult['status'];
  attemptRetry: number;
  error: string;
  duration: number;
  steps: PlaywrightStep[];
  artifacts: FailedTestArtifacts;
}

/**
 * Why a project the run configured produced no test result at all. The two
 * causes have different remedies, which is why the report names which one it
 * was: a failed dependency is repaired by fixing that dependency's tests, a
 * cut-short run by making the run fit its budget.
 */
export type CoverageLossReason = 'dependency-failed' | 'run-cut-short' | 'unexplained';

/** A configured project that produced no result, and what accounts for it. */
export interface LostProject {
  project: string;
  /** Tests the run configured for the project, none of which produced a result. */
  tests: number;
  reason: CoverageLossReason;
  /** Every dependency project whose failures removed this one, in the config's order, when that is the reason. */
  dependencies?: readonly { project: string; failedTests: number }[];
}

/**
 * What the run set out to cover against what it actually covered. A pass count
 * alone cannot be read as a coverage claim — a run that examined a third of the
 * matrix prints the same shape as one that examined all of it — so every report
 * carries both numbers and names whatever produced nothing.
 */
export interface CoverageReport {
  /** Projects holding at least one test in the report — not the set the run configured, which the report does not carry. */
  projectsInReport: number;
  /** Of those, the projects holding at least one test that produced a result; a skipped result counts. */
  executedProjects: number;
  /** Tests in the report — every test of every project above, executed or not. */
  testsInReport: number;
  /** Tests that produced a result, a skipped result included — never "tests that ran". */
  executedTests: number;
  /**
   * Tests that produced a result and that none of the report's test lists holds; zero when
   * the lists hold each such test once. Every reader of that condition reads this field.
   */
  unlistedTests: number;
  lost: LostProject[];
}

export interface DebugReportSummary {
  total: number;
  passed: number;
  flaky: number;
  failed: number;
  duration: number;
}

export interface DebugReport {
  summary: DebugReportSummary;
  passed: PassedTest[];
  flaky: FlakyTest[];
  failed: FailedTest[];
  /** Tests that never ran to a verdict although no skip was declared: unproven, not passed. */
  didNotRun: UnrunTest[];
  /** Tests that declared a skip. */
  skipped: UnrunTest[];
  /** Resource time-series + log-scan, attached by the reporter when sampled. */
  resources?: ResourceReport;
  /** Overall run outcome; present when the reporter forwards it. */
  status?: RunStatus;
  /** Run-level errors not tied to any single test. */
  globalErrors?: string[];
  /** Configured versus executed coverage, computed in `scripts/lib/playwright/debug.ts`. */
  coverage?: CoverageReport;
}

export interface JsonTestEntry {
  title: string;
  file: string;
  line?: number | undefined;
  project: string;
  attempts: number;
  duration: number;
  error: string;
  rerunCommand: string;
  steps: PlaywrightStep[];
  /**
   * `screenshot`, `trace`, `video` and `harFiles` are repo-relative paths, and
   * absent where the artifact has no repo-relative form. The other three carry
   * captured text, not a location.
   */
  artifacts: {
    screenshot: string | undefined;
    trace: string | undefined;
    video: string | undefined;
    consoleErrors: string | undefined;
    apiErrors: string | undefined;
    pageSnapshot: string | undefined;
    harFiles: string[];
  };
}

export interface JsonPassedEntry {
  title: string;
  file: string;
  project: string;
  duration: number;
}

/** Lean resource view for report.json (full series lives in resource-timeline.json). */
export interface JsonResources {
  summary: ResourceSummary;
  scan: ResourceScan;
}

export interface JsonReport {
  /**
   * The run's day, matching `REPORT.md`'s Date line beside it. A report is an
   * artifact and `docs/AGENT-RULES.md` §Privacy caps a written date at a day;
   * the ordering a time of day was buying is carried by the run directory's
   * own ordinal.
   */
  date: string;
  summary: DebugReportSummary;
  status?: RunStatus;
  globalErrors?: string[];
  coverage?: CoverageReport;
  failed: JsonTestEntry[];
  flaky: JsonTestEntry[];
  didNotRun: UnrunTest[];
  skipped: UnrunTest[];
  passed: JsonPassedEntry[];
  resources?: JsonResources;
}
