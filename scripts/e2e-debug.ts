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
  results: PlaywrightTestResult[];
}

// Spec contains title/file and array of tests per project
export interface PlaywrightSpec {
  title: string;
  file: string;
  line?: number | undefined;
  tests?: PlaywrightTest[];
}

// Internal flattened type for categorization
export interface FlattenedTestResult {
  title: string;
  file: string;
  line?: number | undefined;
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
  duration: number;
}

export interface FlakyTest {
  title: string;
  file: string;
  project: string;
  attempts: number;
  failureError?: string;
  failureArtifacts?: FailedTestArtifacts;
  steps?: PlaywrightStep[];
}

export interface FailedTestArtifacts {
  trace: string | undefined;
  screenshot: string | undefined;
  video: string | undefined;
  consoleErrors: string | undefined;
  pageSnapshot: string | undefined;
  harFiles: string[];
}

export interface FailedTest {
  title: string;
  file: string;
  line?: number | undefined;
  project: string;
  error: string;
  duration: number;
  steps: PlaywrightStep[];
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

export interface JsonTestEntry {
  title: string;
  file: string;
  line?: number | undefined;
  project: string;
  duration: number;
  error: string;
  rerunCommand: string;
  steps: PlaywrightStep[];
  artifacts: {
    screenshot: string | undefined;
    trace: string | undefined;
    video: string | undefined;
    consoleErrors: string | undefined;
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

export interface JsonReport {
  timestamp: string;
  summary: DebugReportSummary;
  failed: JsonTestEntry[];
  flaky: JsonTestEntry[];
  passed: JsonPassedEntry[];
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

export function formatDuration(ms: number): string {
  if (ms > 0 && ms < 1000) return `${String(ms)}ms`;

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const tenths = Math.floor((ms % 1000) / 100);

  if (hours > 0) return `${String(hours)}h ${String(minutes)}m ${String(seconds)}s`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`;
  if (tenths > 0) return `${String(seconds)}.${String(tenths)}s`;
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
          duration: test.duration,
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
        line: test.line,
        project: test.projectName,
        error: errors.join('\n'),
        duration: test.duration,
        steps: test.steps ?? [],
        artifacts,
      });
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

const MAX_STEP_DEPTH = 2;

export function renderSteps(steps: PlaywrightStep[], depth = 0): string {
  if (depth >= MAX_STEP_DEPTH) return '';

  const indent = '  '.repeat(depth);
  const lines: string[] = [];

  for (const step of steps) {
    const durationString = formatDuration(step.duration);
    const failMarker = step.error ? ' **FAILED**' : '';
    lines.push(`${indent}- ${step.title} (${durationString})${failMarker}`);

    if (step.steps && step.steps.length > 0) {
      const nested = renderSteps(step.steps, depth + 1);
      if (nested) lines.push(nested);
    }
  }

  return lines.join('\n');
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
  const slug = slugify(`${test.file}--${test.project}--${test.title}`);
  const location = test.line ? `${test.file}:${String(test.line)}` : test.file;

  const lines: string[] = [
    '',
    `#### ${test.title} [${test.project}]`,
    '',
    `**File:** \`${location}\``,
    `**Duration:** ${formatDuration(test.duration)}`,
    `**Re-run:** \`${buildRerunCommand(test)}\``,
    '',
    '**Error:**',
    '```',
    truncateError(test.error),
    '```',
  ];

  if (test.steps.length > 0) {
    lines.push('', '**Steps:**', renderSteps(test.steps));
  }

  if (test.artifacts.consoleErrors) {
    lines.push('', `**Console Errors:** See \`failed/${slug}/console-errors.txt\``);
  }

  if (test.artifacts.pageSnapshot) {
    lines.push(`**Page Snapshot:** See \`failed/${slug}/page-snapshot.txt\``);
  }

  if (test.artifacts.trace) {
    lines.push(`**Trace:** \`npx playwright show-trace ${test.artifacts.trace}\``);
  }

  if (test.artifacts.screenshot) {
    lines.push(`**Screenshot:** \`failed/${slug}/screenshot.png\``);
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
    '---',
    '',
    '*This report is the single source of truth for E2E debugging. See `report.json` for structured data and `failed/` for per-test artifacts.*',
    '',
  ];
  return lines.join('\n');
}

export function generateJsonReport(report: DebugReport): JsonReport {
  return {
    timestamp: new Date().toISOString(),
    summary: report.summary,
    failed: report.failed.map((test) => ({
      title: test.title,
      file: test.file,
      line: test.line,
      project: test.project,
      duration: test.duration,
      error: stripAnsi(test.error),
      rerunCommand: buildRerunCommand(test),
      steps: test.steps,
      artifacts: {
        screenshot: test.artifacts.screenshot,
        trace: test.artifacts.trace,
        video: test.artifacts.video,
        consoleErrors: test.artifacts.consoleErrors,
        pageSnapshot: test.artifacts.pageSnapshot,
        harFiles: test.artifacts.harFiles,
      },
    })),
    flaky: report.flaky.map((test) => ({
      title: test.title,
      file: test.file,
      project: test.project,
      duration: 0,
      error: test.failureError ?? '',
      rerunCommand: buildRerunCommand(test),
      steps: test.steps ?? [],
      artifacts: {
        screenshot: test.failureArtifacts?.screenshot,
        trace: test.failureArtifacts?.trace,
        video: test.failureArtifacts?.video,
        consoleErrors: test.failureArtifacts?.consoleErrors,
        pageSnapshot: test.failureArtifacts?.pageSnapshot,
        harFiles: test.failureArtifacts?.harFiles ?? [],
      },
    })),
    passed: report.passed.map((test) => ({
      title: test.title,
      file: test.file,
      project: test.project,
      duration: test.duration,
    })),
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

export function writePerTestArtifacts(test: FailedTest, testDir: string): void {
  mkdirSync(testDir, { recursive: true });

  writeFileSync(path.join(testDir, 'error.txt'), stripAnsi(test.error), 'utf8');
  writeFileSync(path.join(testDir, 'steps.json'), JSON.stringify(test.steps, null, 2), 'utf8');

  if (test.artifacts.consoleErrors) {
    writeFileSync(path.join(testDir, 'console-errors.txt'), test.artifacts.consoleErrors, 'utf8');
  }

  if (test.artifacts.pageSnapshot) {
    writeFileSync(path.join(testDir, 'page-snapshot.txt'), test.artifacts.pageSnapshot, 'utf8');
  }

  if (test.artifacts.screenshot && existsSync(test.artifacts.screenshot)) {
    copyFileSync(test.artifacts.screenshot, path.join(testDir, 'screenshot.png'));
  }

  if (test.artifacts.harFiles.length > 0) {
    mergeHarFiles(test.artifacts.harFiles, path.join(testDir, 'network.har'));
  }
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
  mkdirSync(reportDir, { recursive: true });

  for (const test of report.failed) {
    const slug = slugify(`${test.file}--${test.project}--${test.title}`);
    writePerTestArtifacts(test, path.join(reportDir, 'failed', slug));
  }

  for (const test of report.flaky) {
    if (test.failureArtifacts) {
      const slug = slugify(`${test.file}--${test.project}--${test.title}`);
      const flakyAsFailedTest: FailedTest = {
        title: test.title,
        file: test.file,
        project: test.project,
        error: test.failureError ?? '',
        duration: 0,
        steps: test.steps ?? [],
        artifacts: test.failureArtifacts,
      };
      writePerTestArtifacts(flakyAsFailedTest, path.join(reportDir, 'flaky', slug));
    }
  }

  const markdown = generateMarkdownReport(report);
  writeFileSync(path.join(reportDir, 'REPORT.md'), markdown, 'utf8');

  const jsonReport = generateJsonReport(report);
  writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(jsonReport, null, 2), 'utf8');

  enforceRetentionLimit(baseDir, MAX_REPORTS);

  return reportDir;
}
