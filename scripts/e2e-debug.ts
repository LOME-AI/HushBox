/**
 * E2E Debug Report Generator
 *
 * Pure functions for categorizing Playwright test results and generating
 * AI-agent-friendly Markdown reports with consolidated screenshots.
 * Used by e2e-reporter.ts (custom Playwright reporter).
 */

import { mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
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

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-ORZcf-nqry=><]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildRerunCommand(test: { title: string; file: string; project: string }): string {
  const escapedTitle = test.title.replace(/"/g, '\\"');
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

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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

export function generateMarkdownReport(report: DebugReport): string {
  const lines: string[] = [];
  const { summary } = report;
  const status = summary.failed > 0 ? 'FAILED' : 'PASSED';

  lines.push('# E2E Test Report');
  lines.push('');
  lines.push(`**Date:** ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);
  lines.push(`**Duration:** ${formatDuration(summary.duration)}`);
  lines.push(
    `**Result:** ${status} (${summary.passed} passed, ${summary.flaky} flaky, ${summary.failed} failed)`
  );

  if (report.failed.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Failed Tests');

    const byFile = new Map<string, FailedTest[]>();
    for (const test of report.failed) {
      const existing = byFile.get(test.file) ?? [];
      existing.push(test);
      byFile.set(test.file, existing);
    }

    for (const [file, tests] of byFile) {
      lines.push('');
      lines.push(`### \`${file}\``);

      for (const test of tests) {
        lines.push('');
        lines.push(`#### ${test.title} [${test.project}]`);
        lines.push('');
        lines.push(`**Re-run:** \`${buildRerunCommand(test)}\``);
        lines.push('');

        let error = stripAnsi(test.error);
        if (error.length > MAX_ERROR_LENGTH) {
          error = error.slice(0, MAX_ERROR_LENGTH) + '\n... (truncated)';
        }
        lines.push('**Error:**');
        lines.push('```');
        lines.push(error);
        lines.push('```');
        lines.push('');

        if (test.artifacts.screenshot) {
          const fname = screenshotFileName(test);
          lines.push(`**Screenshot:** \`e2e/report/screenshots/${fname}\``);
        } else {
          lines.push('**Screenshot:** none');
        }
      }
    }
  }

  if (report.flaky.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Flaky Tests');
    lines.push('');
    lines.push('| Test | File | Project | Attempts |');
    lines.push('|------|------|---------|----------|');
    for (const test of report.flaky) {
      lines.push(`| ${test.title} | \`${test.file}\` | ${test.project} | ${test.attempts} |`);
    }
  }

  if (report.passed.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`## Passed Tests (${report.passed.length})`);
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>Expand</summary>');
    lines.push('');
    for (const test of report.passed) {
      lines.push(`- ${test.title} [\`${test.file}\`] [${test.project}]`);
    }
    lines.push('');
    lines.push('</details>');
  }

  lines.push('');
  return lines.join('\n');
}

export function writeReport(report: DebugReport, reportDir: string): void {
  rmSync(reportDir, { recursive: true, force: true });
  mkdirSync(path.join(reportDir, 'screenshots'), { recursive: true });

  for (const test of report.failed) {
    if (test.artifacts.screenshot && existsSync(test.artifacts.screenshot)) {
      const dest = path.join(reportDir, 'screenshots', screenshotFileName(test));
      copyFileSync(test.artifacts.screenshot, dest);
    }
  }

  const markdown = generateMarkdownReport(report);
  writeFileSync(path.join(reportDir, 'REPORT.md'), markdown, 'utf8');
}

