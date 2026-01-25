/**
 * E2E Debug Report Generator
 *
 * Parses Playwright JSON reporter output and generates a structured debug report
 * categorizing tests as passed, flaky, or failed with detailed error information.
 */

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

export function parsePlaywrightJson(input: string): PlaywrightReport {
  if (!input.trim()) {
    throw new Error('Empty input');
  }
  return JSON.parse(input) as PlaywrightReport;
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/* v8 ignore start */
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  void (async () => {
    try {
      const input = await readStdin();
      const report = parsePlaywrightJson(input);
      const debugReport = generateDebugReport(report);
      console.log(JSON.stringify(debugReport, null, 2));
      process.exit(debugReport.summary.failed > 0 ? 1 : 0);
    } catch (error: unknown) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
