/**
 * Custom Playwright Reporter — AI-Friendly E2E Debug Report
 *
 * Thin adapter: maps Playwright's live Suite/TestCase objects into the
 * existing PlaywrightReport shape from e2e-debug.ts, then feeds it through
 * the existing generateDebugReport() → writeReport() pipeline.
 */

import type {
  Reporter,
  FullResult,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';
import path from 'node:path';
import {
  generateDebugReport,
  writeReport,
  type PlaywrightReport,
  type PlaywrightSuite,
  type PlaywrightSpec,
  type PlaywrightStep,
  type PlaywrightTest,
  type PlaywrightTestResult,
} from './e2e-debug.js';

function mapStep(step: TestStep): PlaywrightStep {
  return {
    title: step.title,
    duration: step.duration,
    category: step.category,
    steps: step.steps.map((s) => mapStep(s)),
    ...(step.error?.message !== undefined && { error: step.error.message }),
  };
}

function mapTestResult(result: TestResult): PlaywrightTestResult {
  return {
    status: result.status,
    retry: result.retry,
    duration: result.duration,
    startTime: result.startTime.toISOString(),
    errors: result.errors.map((e) => ({
      ...(e.message !== undefined && { message: e.message }),
      ...(e.stack !== undefined && { stack: e.stack }),
    })),
    steps: result.steps.map((s) => mapStep(s)),
    attachments: result.attachments.map((a) => ({
      name: a.name,
      contentType: a.contentType,
      ...(a.path !== undefined && { path: a.path }),
      ...(a.body !== undefined && { body: a.body.toString('utf8') }),
    })),
  };
}

function mapTestCase(test: TestCase, projectName: string): PlaywrightSpec {
  const relativeFile = path.relative(process.cwd(), test.location.file);
  const mappedTest: PlaywrightTest = {
    projectName,
    status: test.outcome(),
    results: test.results.map((r) => mapTestResult(r)),
  };
  return {
    title: test.title,
    file: relativeFile,
    line: test.location.line,
    tests: [mappedTest],
  };
}

function mapSuite(suite: Suite): PlaywrightSuite {
  const projectName = suite.project()?.name ?? suite.title;

  return {
    title: suite.title,
    file: suite.location?.file ? path.relative(process.cwd(), suite.location.file) : '',
    specs: suite.tests.map((test) => mapTestCase(test, projectName)),
    suites: suite.suites.map((s) => mapSuite(s)),
  };
}

export function buildPlaywrightReport(rootSuite: Suite, result: FullResult): PlaywrightReport {
  return {
    suites: rootSuite.suites.map((s) => mapSuite(s)),
    config: {},
    stats: { duration: result.duration },
  };
}

export default class E2EReportWriter implements Reporter {
  private rootSuite: Suite | undefined;

  onBegin(_config: unknown, suite: Suite): void {
    this.rootSuite = suite;
  }

  onEnd(result: FullResult): void {
    if (!this.rootSuite) return;

    const report = buildPlaywrightReport(this.rootSuite, result);
    const debugReport = generateDebugReport(report);
    const reportDir = path.join(process.cwd(), 'e2e', 'report');

    const timestampedDir = writeReport(debugReport, reportDir);
    const relativePath = path.relative(process.cwd(), timestampedDir);

    const { summary } = debugReport;
    console.log(
      `\nE2E report (source of truth for debugging): ${relativePath}/REPORT.md (${String(summary.failed)} failed, ${String(summary.flaky)} flaky, ${String(summary.passed)} passed)`
    );
    console.log(`  Structured data: ${relativePath}/report.json`);
    if (summary.failed > 0) {
      console.log(`  Failed test details: ${relativePath}/failed/`);
    }
    console.log();
  }

  printsToStdio(): boolean {
    return true;
  }
}
