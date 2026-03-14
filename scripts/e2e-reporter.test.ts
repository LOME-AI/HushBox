import { describe, it, expect } from 'vitest';
import { buildPlaywrightReport } from './e2e-reporter.js';

// Minimal stubs matching Playwright's Reporter API shapes
interface StubTestResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  retry: number;
  duration: number;
  errors: { message?: string; stack?: string }[];
  steps: { title: string; duration: number }[];
  attachments: { name: string; path?: string; contentType: string }[];
}

interface StubTestCase {
  title: string;
  location: { file: string; line: number; column: number };
  results: StubTestResult[];
  outcome(): 'expected' | 'unexpected' | 'flaky' | 'skipped';
}

interface StubSuite {
  title: string;
  type: 'root' | 'project' | 'file' | 'describe';
  suites: StubSuite[];
  tests: StubTestCase[];
  location?: { file: string; line: number; column: number };
  project(): { name: string } | undefined;
}

function createStubResult(overrides: Partial<StubTestResult> = {}): StubTestResult {
  return {
    status: 'passed',
    retry: 0,
    duration: 1000,
    errors: [],
    steps: [],
    attachments: [],
    ...overrides,
  };
}

function createStubTest(
  overrides: {
    title?: string;
    file?: string;
    results?: StubTestResult[];
    outcome?: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  } = {}
): StubTestCase {
  const outcomeVal = overrides.outcome ?? 'expected';
  return {
    title: overrides.title ?? 'test title',
    location: { file: overrides.file ?? '/abs/e2e/web/chat.spec.ts', line: 1, column: 1 },
    results: overrides.results ?? [createStubResult()],
    outcome: () => outcomeVal,
  };
}

function createStubSuite(
  overrides: {
    title?: string;
    type?: StubSuite['type'];
    suites?: StubSuite[];
    tests?: StubTestCase[];
    projectName?: string;
  } = {}
): StubSuite {
  const name = overrides.projectName;
  return {
    title: overrides.title ?? 'Suite',
    type: overrides.type ?? 'file',
    suites: overrides.suites ?? [],
    tests: overrides.tests ?? [],
    project: () => (name ? { name } : undefined),
  };
}

describe('e2e-reporter', () => {
  describe('buildPlaywrightReport', () => {
    it('maps a root suite with one passing test', () => {
      const test = createStubTest({
        title: 'displays chat',
        file: `${process.cwd()}/e2e/web/chat.spec.ts`,
      });
      const fileSuite = createStubSuite({
        title: 'chat.spec.ts',
        type: 'file',
        tests: [test],
        projectName: 'chromium',
      });
      const projectSuite = createStubSuite({
        title: 'chromium',
        type: 'project',
        suites: [fileSuite],
        projectName: 'chromium',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'passed', startTime: new Date(), duration: 5000 }
      );

      expect(result.stats.duration).toBe(5000);
      expect(result.suites).toHaveLength(1);
      // Navigate: projectSuite → fileSuite → specs
      const fileSuiteResult = result.suites[0]!.suites![0]!;
      expect(fileSuiteResult.specs).toHaveLength(1);
      expect(fileSuiteResult.specs![0]!.title).toBe('displays chat');
      expect(fileSuiteResult.specs![0]!.file).toBe('e2e/web/chat.spec.ts');
      expect(fileSuiteResult.specs![0]!.tests![0]!.projectName).toBe('chromium');
      expect(fileSuiteResult.specs![0]!.tests![0]!.results[0]!.status).toBe('passed');
    });

    it('maps failed test with attachments', () => {
      const test = createStubTest({
        title: 'broken test',
        file: `${process.cwd()}/e2e/web/billing.spec.ts`,
        results: [
          createStubResult({
            status: 'failed',
            retry: 1,
            errors: [{ message: 'Timeout', stack: 'at line 42' }],
            attachments: [
              // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture paths, not production code
              { name: 'screenshot', path: '/tmp/screenshot.png', contentType: 'image/png' },
              // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture paths, not production code
              { name: 'trace', path: '/tmp/trace.zip', contentType: 'application/zip' },
            ],
          }),
        ],
        outcome: 'unexpected',
      });
      const fileSuite = createStubSuite({
        title: 'billing.spec.ts',
        type: 'file',
        tests: [test],
        projectName: 'webkit',
      });
      const projectSuite = createStubSuite({
        title: 'webkit',
        type: 'project',
        suites: [fileSuite],
        projectName: 'webkit',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'failed', startTime: new Date(), duration: 10_000 }
      );

      // Navigate: projectSuite → fileSuite → specs
      const spec = result.suites[0]!.suites![0]!.specs![0]!;
      const testResult = spec.tests![0]!.results[0]!;
      expect(testResult.status).toBe('failed');
      expect(testResult.retry).toBe(1);
      expect(testResult.errors![0]!.message).toBe('Timeout');
      expect(testResult.attachments![0]!.name).toBe('screenshot');
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture path, not production code
      expect(testResult.attachments![0]!.path).toBe('/tmp/screenshot.png');
    });

    it('makes file paths relative to cwd', () => {
      const test = createStubTest({
        file: `${process.cwd()}/e2e/web/chat.spec.ts`,
      });
      const fileSuite = createStubSuite({
        type: 'file',
        tests: [test],
        projectName: 'chromium',
      });
      const projectSuite = createStubSuite({
        type: 'project',
        suites: [fileSuite],
        projectName: 'chromium',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      // Navigate: projectSuite → fileSuite → specs
      expect(result.suites[0]!.suites![0]!.specs![0]!.file).toBe('e2e/web/chat.spec.ts');
    });

    it('handles nested describe suites', () => {
      const test = createStubTest({
        title: 'nested test',
        file: `${process.cwd()}/e2e/web/chat.spec.ts`,
      });
      const describeSuite = createStubSuite({
        title: 'describe block',
        type: 'describe',
        tests: [test],
        projectName: 'chromium',
      });
      const fileSuite = createStubSuite({
        title: 'chat.spec.ts',
        type: 'file',
        suites: [describeSuite],
        projectName: 'chromium',
      });
      const projectSuite = createStubSuite({
        title: 'chromium',
        type: 'project',
        suites: [fileSuite],
        projectName: 'chromium',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      // The nested test should still be found
      expect(result.suites[0]!.suites!).toBeDefined();
    });

    it('maps test outcome to PlaywrightTest status', () => {
      const test = createStubTest({
        title: 'flaky test',
        file: `${process.cwd()}/e2e/web/chat.spec.ts`,
        results: [createStubResult({ status: 'passed', retry: 1 })],
        outcome: 'flaky',
      });
      const fileSuite = createStubSuite({
        type: 'file',
        tests: [test],
        projectName: 'firefox',
      });
      const projectSuite = createStubSuite({
        type: 'project',
        suites: [fileSuite],
        projectName: 'firefox',
      });
      const rootSuite = createStubSuite({
        title: '',
        type: 'root',
        suites: [projectSuite],
      });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      // Navigate: projectSuite → fileSuite → specs
      expect(result.suites[0]!.suites![0]!.specs![0]!.tests![0]!.status).toBe('flaky');
    });
  });
});
