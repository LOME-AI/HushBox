/**
 * Custom Playwright Reporter — AI-Friendly E2E Debug Report
 *
 * Thin adapter: maps Playwright's live Suite/TestCase objects into the
 * existing PlaywrightReport shape from e2e-debug.ts, then feeds it through
 * the existing generateDebugReport() → writeReport() pipeline.
 */

import type { Reporter, FullResult, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import path from 'node:path';
import {
  generateDebugReport,
  writeReport,
  type PlaywrightReport,
  type PlaywrightSuite,
  type PlaywrightSpec,
  type PlaywrightTest,
  type PlaywrightTestResult,
} from './e2e-debug.js';

function mapTestResult(result: TestResult): PlaywrightTestResult {
  return {
    status: result.status,
    retry: result.retry,
    duration: result.duration,
    errors: result.errors.map((e) => ({
      ...(e.message !== undefined && { message: e.message }),
      ...(e.stack !== undefined && { stack: e.stack }),
    })),
    steps: result.steps.map((s) => ({ title: s.title, duration: s.duration })),
    attachments: result.attachments.map((a) => ({
      name: a.name,
      ...(a.path !== undefined && { path: a.path }),
    })),
  };
}

function mapTestCase(test: TestCase, projectName: string): PlaywrightSpec {
  const relativeFile = path.relative(process.cwd(), test.location.file);
  const mappedTest: PlaywrightTest = {
    projectName,
    status: test.outcome(),
    results: test.results.map(mapTestResult),
  };
  return {
    title: test.title,
    file: relativeFile,
    tests: [mappedTest],
  };
}

function mapSuite(suite: Suite): PlaywrightSuite {
  const projectName = suite.project()?.name ?? suite.title;

  return {
    title: suite.title,
    file: suite.location?.file
      ? path.relative(process.cwd(), suite.location.file)
      : '',
    specs: suite.tests.map((test) => mapTestCase(test, projectName)),
    suites: suite.suites.map(mapSuite),
  };
}

export function buildPlaywrightReport(rootSuite: Suite, result: FullResult): PlaywrightReport {
  return {
    suites: rootSuite.suites.map(mapSuite),
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

    writeReport(debugReport, reportDir);

    const { summary } = debugReport;
    console.log(
      `\nE2E report: e2e/report/REPORT.md (${summary.failed} failed, ${summary.flaky} flaky, ${summary.passed} passed)`
    );
    console.log('View screenshots: e2e/report/screenshots/\n');
  }

  printsToStdio(): boolean {
    return true;
  }
}
