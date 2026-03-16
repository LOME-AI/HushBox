/**
 * E2E Debug Report Generator
 *
 * Pure functions for categorizing Playwright test results and generating
 * AI-agent-friendly Markdown reports with consolidated screenshots.
 * Used by e2e-reporter.ts (custom Playwright reporter).
 */

import { mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface PlaywrightError {
  message?: string;
  stack?: string;
}

export interface PlaywrightStep {
  title: string;
  duration: number;
}

export interface PlaywrightAttachment {
  name: string;
  path?: string;
}

// Result of a single test run attempt (retry)
export interface PlaywrightTestResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  retry: number;
  duration: number;
  errors?: PlaywrightError[];
  steps?: PlaywrightStep[];
  attachments?: PlaywrightAttachment[];
}

// Test entry per project (contains array of retry attempts)
export interface PlaywrightTest {
  projectName: string;
  status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  results: PlaywrightTestResult[];
}

// Spec contains title/file and array of tests per project
export interface PlaywrightSpec {
  title: string;
  file: string;
  tests?: PlaywrightTest[];
}

// Internal flattened type for categorization
export interface FlattenedTestResult {
  title: string;
  file: string;
  projectName: string;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  retry: number;
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

export interface PlaywrightReport {
  suites: PlaywrightSuite[];
  config: Record<string, unknown>;
  stats: {
    duration: number;
  };
}

export interface PassedTest {
  title: string;
  file: string;
  project: string;
}

export interface FlakyTest {
  title: string;
  file: string;
  project: string;
  attempts: number;
}

export interface FailedTestArtifacts {
  trace: string | undefined;
  screenshot: string | undefined;
  video: string | undefined;
}

export interface FailedTest {
  title: string;
  file: string;
  project: string;
  error: string;
  artifacts: FailedTestArtifacts;
}

export interface CategorizedTests {
  passed: PassedTest[];
  flaky: FlakyTest[];
  failed: FailedTest[];
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
}

// eslint-disable-next-line no-control-regex, sonarjs/no-control-regex
const ANSI_REGEX = /[\u001B\u009B][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-ORZcf-nqry=><]/g;

export function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_REGEX, '');
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}

export function buildRerunCommand(test: { title: string; file: string; project: string }): string {
  const escapedTitle = test.title.replaceAll('"', String.raw`\"`);
  return `pnpm e2e -- ${test.file} -g "${escapedTitle}" --project=${test.project}`;
}

export function screenshotFileName(test: { file: string; project: string; title: string }): string {
  return `${slugify(test.file)}--${slugify(test.project)}--${slugify(test.title)}.png`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${String(hours)}h ${String(minutes)}m ${String(seconds)}s`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`;
  return `${String(seconds)}s`;
}

export function categorizeTests(tests: FlattenedTestResult[]): CategorizedTests {
  const result: CategorizedTests = {
    passed: [],
    flaky: [],
    failed: [],
  };

  for (const test of tests) {
    if (test.status === 'skipped') {
      continue;
    }

    if (test.status === 'passed') {
      if (test.retry > 0) {
        result.flaky.push({
          title: test.title,
          file: test.file,
          project: test.projectName,
          attempts: test.retry + 1,
        });
      } else {
        result.passed.push({
          title: test.title,
          file: test.file,
          project: test.projectName,
        });
      }
    } else {
      const errors = (test.errors ?? [])
        .map((e) => e.message)
        .filter((m): m is string => m !== undefined);
      const artifacts = extractArtifactPaths(test);

      result.failed.push({
        title: test.title,
        file: test.file,
        project: test.projectName,
        error: errors.join('\n'),
        artifacts,
      });
    }
  }

  return result;
}

export function extractArtifactPaths(test: FlattenedTestResult): FailedTestArtifacts {
  const findAttachment = (name: string): string | undefined =>
    (test.attachments ?? []).find((a) => a.name === name)?.path;

  return {
    trace: findAttachment('trace'),
    screenshot: findAttachment('screenshot'),
    video: findAttachment('video'),
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
    projectName: test.projectName,
    status: result.status,
    retry: result.retry,
    duration: result.duration,
    errors: result.errors ?? [],
    steps: result.steps ?? [],
    attachments: result.attachments ?? [],
  };
}

function collectTestsFromSuite(suite: PlaywrightSuite): FlattenedTestResult[] {
  const tests: FlattenedTestResult[] = [];

  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const lastResult = test.results.at(-1);
      if (!lastResult) continue;
      tests.push(createFlattenedResult(spec, test, lastResult));
    }
  }

  for (const nestedSuite of suite.suites ?? []) {
    tests.push(...collectTestsFromSuite(nestedSuite));
  }

  return tests;
}

export function generateDebugReport(report: PlaywrightReport): DebugReport {
  const allTests: FlattenedTestResult[] = [];

  for (const suite of report.suites) {
    allTests.push(...collectTestsFromSuite(suite));
  }

  const categorized = categorizeTests(allTests);

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
  };
}

const MAX_ERROR_LENGTH = 2000;

function renderHeader(summary: DebugReportSummary): string[] {
  const status = summary.failed > 0 ? 'FAILED' : 'PASSED';
  return [
    '# E2E Test Report',
    '',
    `**Date:** ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    `**Duration:** ${formatDuration(summary.duration)}`,
    `**Result:** ${status} (${String(summary.passed)} passed, ${String(summary.flaky)} flaky, ${String(summary.failed)} failed)`,
  ];
}

function truncateError(rawError: string): string {
  const error = stripAnsi(rawError);
  if (error.length > MAX_ERROR_LENGTH) {
    return error.slice(0, MAX_ERROR_LENGTH) + '\n... (truncated)';
  }
  return error;
}

function renderSingleFailedTest(test: FailedTest): string[] {
  const lines: string[] = [
    '',
    `#### ${test.title} [${test.project}]`,
    '',
    `**Re-run:** \`${buildRerunCommand(test)}\``,
    '',
    '**Error:**',
    '```',
    truncateError(test.error),
    '```',
    '',
  ];

  if (test.artifacts.screenshot) {
    const fname = screenshotFileName(test);
    lines.push(`**Screenshot:** \`e2e/report/screenshots/${fname}\``);
  } else {
    lines.push('**Screenshot:** none');
  }

  return lines;
}

function renderFailedTests(failed: FailedTest[]): string[] {
  if (failed.length === 0) return [];

  const lines: string[] = ['', '---', '', '## Failed Tests'];

  const byFile = new Map<string, FailedTest[]>();
  for (const test of failed) {
    const existing = byFile.get(test.file) ?? [];
    existing.push(test);
    byFile.set(test.file, existing);
  }

  for (const [file, tests] of byFile) {
    lines.push('', `### \`${file}\``);
    for (const test of tests) {
      lines.push(...renderSingleFailedTest(test));
    }
  }

  return lines;
}

function renderFlakyTests(flaky: FlakyTest[]): string[] {
  if (flaky.length === 0) return [];

  const lines: string[] = [
    '',
    '---',
    '',
    '## Flaky Tests',
    '',
    '| Test | File | Project | Attempts |',
    '|------|------|---------|----------|',
  ];
  for (const test of flaky) {
    lines.push(`| ${test.title} | \`${test.file}\` | ${test.project} | ${String(test.attempts)} |`);
  }
  return lines;
}

function renderPassedTests(passed: PassedTest[]): string[] {
  if (passed.length === 0) return [];

  const lines: string[] = [
    '',
    '---',
    '',
    `## Passed Tests (${String(passed.length)})`,
    '',
    '<details>',
    '<summary>Expand</summary>',
    '',
  ];
  for (const test of passed) {
    lines.push(`- ${test.title} [\`${test.file}\`] [${test.project}]`);
  }
  lines.push('', '</details>');
  return lines;
}

export function generateMarkdownReport(report: DebugReport): string {
  const lines: string[] = [
    ...renderHeader(report.summary),
    ...renderFailedTests(report.failed),
    ...renderFlakyTests(report.flaky),
    ...renderPassedTests(report.passed),
    '',
  ];
  return lines.join('\n');
}

const MAX_REPORTS = 10;

export function enforceRetentionLimit(baseDir: string, maxReports: number): void {
  if (!existsSync(baseDir)) return;

  const entries = readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b));

  const toDelete = entries.slice(0, Math.max(0, entries.length - maxReports));
  for (const name of toDelete) {
    rmSync(path.join(baseDir, name), { recursive: true, force: true });
  }
}

export function writeReport(report: DebugReport, baseDir: string): string {
  const timestamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
  const reportDir = path.join(baseDir, timestamp);

  mkdirSync(path.join(reportDir, 'screenshots'), { recursive: true });

  for (const test of report.failed) {
    if (test.artifacts.screenshot && existsSync(test.artifacts.screenshot)) {
      const destination = path.join(reportDir, 'screenshots', screenshotFileName(test));
      copyFileSync(test.artifacts.screenshot, destination);
    }
  }

  const markdown = generateMarkdownReport(report);
  writeFileSync(path.join(reportDir, 'REPORT.md'), markdown, 'utf8');

  enforceRetentionLimit(baseDir, MAX_REPORTS);

  return reportDir;
}
