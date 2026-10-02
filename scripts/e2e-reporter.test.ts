import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { HOUR_MS, isoAt, TEST_DAY_START } from '@hushbox/shared/test-time';
import E2EReportWriter, {
  buildPlaywrightReport,
  captureServerApiLog,
  apiServerLogSource,
  apiServerDebugLogSource,
  runApiHealthUrl,
  captureWranglerDebugLog,
  captureCompletionGaps,
  heapProbeEnabled,
  heapProbeSamplerOptions,
  HEAP_PROBE_VARIABLE,
  DEBUG_LOG_CHUNK_BYTES,
} from './e2e-reporter.js';
import { GLOBAL_ERRORS_HEADING } from './lib/playwright/debug-render.js';
import { ramRootRequiredBytes } from './lib/stack/ram-root.js';
import { wranglerLogPath, wranglerDebugLogPath } from './wrangler-dev.js';
import { API_LIVENESS } from '../e2e/config/timeouts.js';
import type { ResourceSampler, ResourceSummary } from './resource-sampler.js';
import type { FullResult, Suite } from '@playwright/test/reporter';

// Minimal stubs matching Playwright's Reporter API shapes
interface StubStep {
  title: string;
  duration: number;
  category?: string;
  steps: StubStep[];
  error?: { message?: string };
}

interface StubTestResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  retry: number;
  duration: number;
  startTime: Date;
  errors: { message?: string; stack?: string }[];
  steps: StubStep[];
  attachments: { name: string; path?: string; body?: Buffer; contentType: string }[];
}

interface StubTestCase {
  title: string;
  location: { file: string; line: number; column: number };
  expectedStatus: StubTestResult['status'];
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
    startTime: new Date(TEST_DAY_START),
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
    expectedStatus?: StubTestResult['status'];
  } = {}
): StubTestCase {
  const outcomeVal = overrides.outcome ?? 'expected';
  return {
    title: overrides.title ?? 'test title',
    location: { file: overrides.file ?? '/abs/e2e/chat/chat.spec.ts', line: 1, column: 1 },
    expectedStatus: overrides.expectedStatus ?? 'passed',
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

/** A reporter with every external capture disabled, already begun on `rootSuite`. */
function reporterFor(rootSuite: Suite): E2EReportWriter {
  const reporter = new E2EReportWriter({
    apiLogPath: null,
    apiDebugLogPath: null,
    liveness: null,
  });
  reporter.onBegin({ projects: [], workers: 1 }, rootSuite);
  return reporter;
}

describe('e2e-reporter', () => {
  describe('buildPlaywrightReport', () => {
    it('carries each configured project and the projects it waits on onto the report', () => {
      const projects: Parameters<typeof buildPlaywrightReport>[1] = [
        { name: 'setup-admin', dependencies: [] },
        { name: 'admin', dependencies: ['setup-admin'] },
      ];
      const rootSuite = createStubSuite({ title: '', type: 'root' });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        projects,
        { status: 'passed', startTime: new Date(TEST_DAY_START), duration: 1000 }
      );

      expect(result.projects).toEqual(projects);
    });

    it('maps a root suite with one passing test', () => {
      const test = createStubTest({
        title: 'displays chat',
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
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
        [],
        { status: 'passed', startTime: new Date(), duration: 5000 }
      );

      expect(result.stats.duration).toBe(5000);
      expect(result.suites).toHaveLength(1);
      // Navigate: projectSuite → fileSuite → specs
      const fileSuiteResult = result.suites[0]!.suites![0]!;
      expect(fileSuiteResult.specs).toHaveLength(1);
      expect(fileSuiteResult.specs![0]!.title).toBe('displays chat');
      expect(fileSuiteResult.specs![0]!.file).toBe('e2e/chat/chat.spec.ts');
      expect(fileSuiteResult.specs![0]!.tests![0]!.projectName).toBe('chromium');
      expect(fileSuiteResult.specs![0]!.tests![0]!.results[0]!.status).toBe('passed');
    });

    it('falls back to the suite title when the suite has no project', () => {
      const test = createStubTest({
        title: 'orphan test',
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
      });
      const fileSuite = createStubSuite({
        title: 'standalone-suite',
        type: 'file',
        tests: [test],
      });
      const rootSuite = createStubSuite({ title: '', type: 'root', suites: [fileSuite] });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        [],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      expect(result.suites[0]!.specs![0]!.tests![0]!.projectName).toBe('standalone-suite');
    });

    it('maps failed test with attachments', () => {
      const test = createStubTest({
        title: 'broken test',
        file: `${process.cwd()}/e2e/billing/billing.spec.ts`,
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
        [],
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
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
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
        [],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      // Navigate: projectSuite → fileSuite → specs
      expect(result.suites[0]!.suites![0]!.specs![0]!.file).toBe('e2e/chat/chat.spec.ts');
    });

    it('derives suite file from suite.location when present', () => {
      const test = createStubTest({ file: `${process.cwd()}/e2e/chat/chat.spec.ts` });
      const fileSuite: StubSuite = {
        ...createStubSuite({ type: 'file', tests: [test], projectName: 'chromium' }),
        location: { file: `${process.cwd()}/e2e/chat/chat.spec.ts`, line: 1, column: 1 },
      };
      const projectSuite = createStubSuite({
        type: 'project',
        suites: [fileSuite],
        projectName: 'chromium',
      });
      const rootSuite = createStubSuite({ title: '', type: 'root', suites: [projectSuite] });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        [],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      expect(result.suites[0]!.suites![0]!.file).toBe('e2e/chat/chat.spec.ts');
    });

    it('handles nested describe suites', () => {
      const test = createStubTest({
        title: 'nested test',
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
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
        [],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      expect(result.suites[0]!.suites!).toBeDefined();
    });

    it('maps the status a test declared it expects onto PlaywrightTest', () => {
      const test = createStubTest({
        title: 'skipped on this engine',
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
        results: [createStubResult({ status: 'skipped' })],
        outcome: 'skipped',
        expectedStatus: 'skipped',
      });
      const fileSuite = createStubSuite({ type: 'file', tests: [test], projectName: 'webkit' });
      const projectSuite = createStubSuite({
        type: 'project',
        suites: [fileSuite],
        projectName: 'webkit',
      });
      const rootSuite = createStubSuite({ title: '', type: 'root', suites: [projectSuite] });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        [],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      expect(result.suites[0]!.suites![0]!.specs![0]!.tests![0]!.expectedStatus).toBe('skipped');
    });

    it('maps test outcome to PlaywrightTest status', () => {
      const test = createStubTest({
        title: 'flaky test',
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
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
        [],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      // Navigate: projectSuite → fileSuite → specs
      expect(result.suites[0]!.suites![0]!.specs![0]!.tests![0]!.status).toBe('flaky');
    });

    it('includes test location line number', () => {
      const test = createStubTest({
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
      });
      test.location.line = 42;
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
        [],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      expect(result.suites[0]!.suites![0]!.specs![0]!.line).toBe(42);
    });

    it('maps steps recursively with category and error', () => {
      const test = createStubTest({
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
        results: [
          createStubResult({
            steps: [
              {
                title: 'Send message',
                duration: 500,
                category: 'test.step',
                steps: [{ title: 'page.fill', duration: 100, category: 'pw:api', steps: [] }],
              },
              {
                title: 'expect(locator).toBeVisible',
                duration: 10_000,
                category: 'expect',
                steps: [],
                error: { message: 'Timeout' },
              },
            ],
          }),
        ],
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
        [],
        { status: 'failed', startTime: new Date(), duration: 10_000 }
      );

      const steps = result.suites[0]!.suites![0]!.specs![0]!.tests![0]!.results[0]!.steps!;
      expect(steps).toHaveLength(2);
      expect(steps[0]!.category).toBe('test.step');
      expect(steps[0]!.steps).toHaveLength(1);
      expect(steps[0]!.steps![0]!.title).toBe('page.fill');
      expect(steps[1]!.error).toBe('Timeout');
    });

    it('maps body attachments to string', () => {
      const test = createStubTest({
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
        results: [
          createStubResult({
            attachments: [
              {
                name: 'console-errors',
                body: Buffer.from('TypeError: x is not a function'),
                contentType: 'text/plain',
              },
            ],
          }),
        ],
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
        [],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      const attachments =
        result.suites[0]!.suites![0]!.specs![0]!.tests![0]!.results[0]!.attachments!;
      expect(attachments[0]!.body).toBe('TypeError: x is not a function');
      expect(attachments[0]!.contentType).toBe('text/plain');
    });

    it('includes startTime on test results', () => {
      const startedAt = TEST_DAY_START + 12 * HOUR_MS;
      const startTime = new Date(startedAt);
      const test = createStubTest({
        file: `${process.cwd()}/e2e/chat/chat.spec.ts`,
        results: [createStubResult({ startTime })],
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
        [],
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      expect(result.suites[0]!.suites![0]!.specs![0]!.tests![0]!.results[0]!.startTime).toBe(
        isoAt(startedAt)
      );
    });

    it('forwards run status and global errors', () => {
      const rootSuite = createStubSuite({ title: '', type: 'root', suites: [] });

      const result = buildPlaywrightReport(
        rootSuite as unknown as Parameters<typeof buildPlaywrightReport>[0],
        [],
        { status: 'failed', startTime: new Date(), duration: 66_000 },
        ["Error: ENOTEMPTY: directory not empty, rmdir 'test-results/x'"]
      );

      expect(result.status).toBe('failed');
      expect(result.errors).toEqual([
        "Error: ENOTEMPTY: directory not empty, rmdir 'test-results/x'",
      ]);
    });

    it('omits errors when none are given and tolerates a missing root suite', () => {
      const result = buildPlaywrightReport(undefined, [], {
        status: 'passed',
        startTime: new Date(),
        duration: 1000,
      });

      expect(result.status).toBe('passed');
      expect(result.errors).toBeUndefined();
      expect(result.suites).toEqual([]);
    });
  });
});

type SigintListener = (signal: string) => void;

describe('E2EReportWriter (interrupt handling)', () => {
  let temporaryDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let baseSigintListeners: SigintListener[];

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-reporter-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(temporaryDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    baseSigintListeners = process.listeners('SIGINT') as SigintListener[];
  });

  afterEach(() => {
    // Manual handler invocation in tests doesn't trigger `once` auto-removal,
    // so drop any SIGINT listener the reporter added to keep tests isolated.
    for (const listener of process.listeners('SIGINT') as SigintListener[]) {
      if (!baseSigintListeners.includes(listener)) {
        process.removeListener('SIGINT', listener);
      }
    }
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (temporaryDir && existsSync(temporaryDir)) {
      rmSync(temporaryDir, { recursive: true, force: true });
    }
  });

  function rootSuiteStub(): Suite {
    const test = createStubTest({
      title: 'snapshot test',
      file: `${temporaryDir}/e2e/chat/chat.spec.ts`,
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
    const rootSuite = createStubSuite({ title: '', type: 'root', suites: [projectSuite] });
    return rootSuite as unknown as Suite;
  }

  const fullResult = (status: FullResult['status']): FullResult =>
    ({ status, startTime: new Date(), duration: 1234 }) as FullResult;

  const reportBase = (): string => path.join(temporaryDir, 'e2e', 'report');

  const flushLogCount = (): number =>
    logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('E2E report')
    ).length;

  it('registers a SIGINT listener on begin', () => {
    const before = process.listenerCount('SIGINT');
    const reporter = new E2EReportWriter();

    reporter.onBegin({ projects: [], workers: 1 }, rootSuiteStub());

    expect(process.listenerCount('SIGINT')).toBe(before + 1);
  });

  it('writes a report when interrupted via SIGINT', () => {
    const reporter = new E2EReportWriter();
    reporter.onBegin({ projects: [], workers: 1 }, rootSuiteStub());

    const handler = process.listeners('SIGINT').at(-1) as SigintListener;
    handler('SIGINT');

    const base = reportBase();
    expect(existsSync(base)).toBe(true);
    const directories = readdirSync(base);
    expect(directories).toHaveLength(1);
    expect(existsSync(path.join(base, directories[0]!, 'REPORT.md'))).toBe(true);
    expect(flushLogCount()).toBe(1);
  });

  it('writes the report only once across an interrupt and onEnd', () => {
    const reporter = new E2EReportWriter();
    reporter.onBegin({ projects: [], workers: 1 }, rootSuiteStub());

    const handler = process.listeners('SIGINT').at(-1) as SigintListener;
    handler('SIGINT');
    void reporter.onEnd(fullResult('interrupted'));

    expect(flushLogCount()).toBe(1);
    expect(readdirSync(reportBase())).toHaveLength(1);
  });

  it('removes its SIGINT listener after the first signal so repeat Ctrl+C still kills', () => {
    const preexisting = process.listeners('SIGINT') as SigintListener[];
    for (const listener of preexisting) process.removeListener('SIGINT', listener);
    try {
      const reporter = new E2EReportWriter();
      reporter.onBegin({ projects: [], workers: 1 }, rootSuiteStub());
      expect(process.listenerCount('SIGINT')).toBe(1);

      process.emit('SIGINT', 'SIGINT');

      expect(process.listenerCount('SIGINT')).toBe(0);
    } finally {
      for (const listener of preexisting) process.on('SIGINT', listener);
    }
  });

  it('does not throw if writing the interrupted snapshot fails', () => {
    const reporter = new E2EReportWriter();
    // A malformed suite makes buildPlaywrightReport throw inside flush; the
    // SIGINT handler must swallow it (and log) rather than throw mid-signal.
    reporter.onBegin({ projects: [], workers: 1 }, {} as unknown as Suite);

    const handler = process.listeners('SIGINT').at(-1) as SigintListener;

    expect(() => {
      handler('SIGINT');
    }).not.toThrow();
    expect(
      errSpy.mock.calls.some(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('failed to write')
      )
    ).toBe(true);
  });

  it('reports the failed/ artifact path when there are failures', () => {
    const failing = createStubTest({
      title: 'broken test',
      file: `${temporaryDir}/e2e/chat/chat.spec.ts`,
      results: [createStubResult({ status: 'failed', errors: [{ message: 'boom' }] })],
      outcome: 'unexpected',
    });
    const fileSuite = createStubSuite({
      title: 'chat.spec.ts',
      type: 'file',
      tests: [failing],
      projectName: 'chromium',
    });
    const projectSuite = createStubSuite({
      title: 'chromium',
      type: 'project',
      suites: [fileSuite],
      projectName: 'chromium',
    });
    const rootSuite = createStubSuite({ title: '', type: 'root', suites: [projectSuite] });

    const reporter = new E2EReportWriter();
    reporter.onBegin({ projects: [], workers: 1 }, rootSuite as unknown as Suite);
    void reporter.onEnd(fullResult('failed'));

    expect(
      logSpy.mock.calls.some(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Failed test details')
      )
    ).toBe(true);
  });

  const testError = (fields: {
    message?: string;
    stack?: string;
  }): Parameters<E2EReportWriter['onError']>[0] =>
    fields as Parameters<E2EReportWriter['onError']>[0];

  const readWrittenReport = (): { md: string; json: Record<string, unknown> } => {
    const base = reportBase();
    const dir = path.join(base, readdirSync(base)[0]!);
    return {
      md: readFileSync(path.join(dir, 'REPORT.md'), 'utf8'),
      json: JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')) as Record<
        string,
        unknown
      >,
    };
  };

  it('reports FAILED with a Global Errors section, preferring the error stack', () => {
    const reporter = new E2EReportWriter();
    reporter.onBegin({ projects: [], workers: 1 }, rootSuiteStub());
    reporter.onError(
      testError({
        stack: "Error: ENOTEMPTY: directory not empty, rmdir 'test-results/x'\n    at clearOutput",
      })
    );
    void reporter.onEnd(fullResult('failed'));

    const { md, json } = readWrittenReport();
    expect(md).toContain('**Result:** FAILED');
    expect(md).toContain('## Global Errors');
    expect(md).toContain('at clearOutput');
    expect(json['status']).toBe('failed');
    expect(json['globalErrors']).toHaveLength(1);
  });

  it('falls back to the error message when there is no stack', () => {
    const reporter = new E2EReportWriter();
    reporter.onBegin({ projects: [], workers: 1 }, rootSuiteStub());
    reporter.onError(testError({ message: 'Error: ENOTEMPTY: directory not empty' }));
    void reporter.onEnd(fullResult('failed'));

    expect(readWrittenReport().md).toContain('ENOTEMPTY');
  });

  it('falls back to a placeholder when the error has neither stack nor message', () => {
    const reporter = new E2EReportWriter();
    reporter.onBegin({ projects: [], workers: 1 }, rootSuiteStub());
    reporter.onError(testError({}));
    void reporter.onEnd(fullResult('failed'));

    expect(readWrittenReport().md).toContain('Unknown global error');
  });

  it('still writes a FAILED report when a global error aborts before onBegin', () => {
    const reporter = new E2EReportWriter();
    // No onBegin: Playwright's output-dir cleanup can abort the run before the
    // report-begin task fires. The global error must still surface.
    reporter.onError(testError({ message: 'Error: ENOTEMPTY: directory not empty' }));
    void reporter.onEnd(fullResult('failed'));

    expect(existsSync(reportBase())).toBe(true);
    const { md } = readWrittenReport();
    expect(md).toContain('**Result:** FAILED');
    expect(md).toContain('ENOTEMPTY');
  });

  it('prints to stdio', () => {
    expect(new E2EReportWriter().printsToStdio()).toBe(true);
  });

  it('writes nothing when onEnd runs without a begun suite', () => {
    const before = process.listenerCount('SIGINT');
    const reporter = new E2EReportWriter();

    void reporter.onEnd(fullResult('passed'));

    expect(existsSync(reportBase())).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('writes the report and unregisters its listener on clean onEnd', () => {
    const before = process.listenerCount('SIGINT');
    const reporter = new E2EReportWriter();
    reporter.onBegin({ projects: [], workers: 1 }, rootSuiteStub());

    void reporter.onEnd(fullResult('passed'));

    const base = reportBase();
    const directories = readdirSync(base);
    expect(directories).toHaveLength(1);
    expect(existsSync(path.join(base, directories[0]!, 'report.json'))).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('captureServerApiLog / apiServerLogSource', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-reporter-apilog-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('copies the api log into the report dir as server-api.log', () => {
    const source = path.join(temporaryDir, 'wrangler.log');
    writeFileSync(source, 'NoSuchBucket stack trace\n');
    const reportDir = path.join(temporaryDir, 'report');
    mkdirSync(reportDir);

    const destination = captureServerApiLog(reportDir, source);

    expect(destination).toBe(path.join(reportDir, 'server-api.log'));
    expect(readFileSync(path.join(reportDir, 'server-api.log'), 'utf8')).toBe(
      'NoSuchBucket stack trace\n'
    );
  });

  it('returns null and writes nothing when the source log does not exist', () => {
    const reportDir = path.join(temporaryDir, 'report');
    mkdirSync(reportDir);

    expect(captureServerApiLog(reportDir, path.join(temporaryDir, 'absent.log'))).toBeNull();
    expect(captureServerApiLog(reportDir, null)).toBeNull();
    expect(existsSync(path.join(reportDir, 'server-api.log'))).toBe(false);
  });

  it('derives the source from HB_API_PORT, null when unset', () => {
    const saved = process.env['HB_API_PORT'];
    try {
      process.env['HB_API_PORT'] = '59993';
      expect(apiServerLogSource()).toBe(wranglerLogPath('59993'));
      delete process.env['HB_API_PORT'];
      expect(apiServerLogSource()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env['HB_API_PORT'];
      else process.env['HB_API_PORT'] = saved;
    }
  });
});

describe('E2EReportWriter (server-api.log capture)', () => {
  let temporaryDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-reporter-flushlog-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(temporaryDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  function reporterRootSuite(): Suite {
    const test = createStubTest({
      title: 'capture test',
      file: `${temporaryDir}/e2e/chat/chat.spec.ts`,
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
    return createStubSuite({
      title: '',
      type: 'root',
      suites: [projectSuite],
    }) as unknown as Suite;
  }

  const passedResult = (): FullResult =>
    ({ status: 'passed', startTime: new Date(), duration: 10 }) as FullResult;

  it('lands server-api.log in the run directory on flush', () => {
    const apiLog = path.join(temporaryDir, 'wrangler.log');
    writeFileSync(apiLog, 'PUT returned 404: NoSuchBucket\n');
    const reporter = new E2EReportWriter({ apiLogPath: apiLog });
    reporter.onBegin({ projects: [], workers: 1 }, reporterRootSuite());

    void reporter.onEnd(passedResult());

    const base = path.join(temporaryDir, 'e2e', 'report');
    const runDir = readdirSync(base)[0]!;
    expect(readFileSync(path.join(base, runDir, 'server-api.log'), 'utf8')).toBe(
      'PUT returned 404: NoSuchBucket\n'
    );
  });

  it('still writes the report when the api log is absent', () => {
    const reporter = new E2EReportWriter({
      apiLogPath: path.join(temporaryDir, 'absent.log'),
    });
    reporter.onBegin({ projects: [], workers: 1 }, reporterRootSuite());

    void reporter.onEnd(passedResult());

    const base = path.join(temporaryDir, 'e2e', 'report');
    const runDir = readdirSync(base)[0]!;
    expect(existsSync(path.join(base, runDir, 'report.json'))).toBe(true);
    expect(existsSync(path.join(base, runDir, 'server-api.log'))).toBe(false);
  });
});

describe('captureWranglerDebugLog / apiServerDebugLogSource', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-reporter-debuglog-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  const reportDir = (): string => {
    const dir = path.join(temporaryDir, 'report');
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const compressedCopy = (destination: string): Buffer =>
    gunzipSync(readFileSync(path.join(destination, 'server-api-debug.log.gz')));

  it('returns the path of the compressed copy', () => {
    const source = path.join(temporaryDir, 'debug.log');
    writeFileSync(source, 'workerd reload\nrequest completed\n');
    const destination = reportDir();

    expect(captureWranglerDebugLog(destination, source)).toBe(
      path.join(destination, 'server-api-debug.log.gz')
    );
  });

  it('writes the compressed copy in place of a tail file', () => {
    const source = path.join(temporaryDir, 'debug.log');
    writeFileSync(source, 'workerd reload\nrequest completed\n');
    const destination = reportDir();

    captureWranglerDebugLog(destination, source);

    expect(readdirSync(destination)).toEqual(['server-api-debug.log.gz']);
  });

  it('keeps the whole of a log that spans several chunks, its first block included', () => {
    const source = path.join(temporaryDir, 'debug.log');
    const firstBlock = `--- ${isoAt(TEST_DAY_START)} info\nTHE FIRST BLOCK\n---\n\n`;
    const line = `${'x'.repeat(99)}\n`;
    const lines = Math.ceil((DEBUG_LOG_CHUNK_BYTES * 2) / line.length);
    writeFileSync(source, firstBlock + line.repeat(lines) + 'THE LAST LINE\n');
    const destination = reportDir();

    captureWranglerDebugLog(destination, source);

    const restored = compressedCopy(destination);
    expect(restored.subarray(0, firstBlock.length).toString('utf8')).toBe(firstBlock);
    expect(restored.equals(readFileSync(source))).toBe(true);
  });

  it('round-trips a line that straddles a chunk boundary', () => {
    const source = path.join(temporaryDir, 'debug.log');
    const content = 'first line\nstraddlé across a boundary\nlast line\n';
    writeFileSync(source, content);
    // The boundary falls between the two bytes of `é`, inside the second line.
    const chunkBytes = Buffer.byteLength('first line\nstraddl') + 1;
    const destination = reportDir();

    captureWranglerDebugLog(destination, source, chunkBytes);

    expect(compressedCopy(destination).toString('utf8')).toBe(content);
  });

  it('captures an empty log as a gzip that decompresses to nothing', () => {
    const source = path.join(temporaryDir, 'debug.log');
    writeFileSync(source, '');
    const destination = reportDir();

    captureWranglerDebugLog(destination, source);

    expect(compressedCopy(destination)).toHaveLength(0);
  });

  it('returns null and writes nothing when the source is absent or unset', () => {
    const destination = reportDir();

    expect(captureWranglerDebugLog(destination, path.join(temporaryDir, 'absent.log'))).toBeNull();
    expect(captureWranglerDebugLog(destination, null)).toBeNull();
    expect(readdirSync(destination)).toEqual([]);
  });

  it('derives the debug source and the health url from HB_API_PORT, null when unset', () => {
    const saved = process.env['HB_API_PORT'];
    try {
      process.env['HB_API_PORT'] = '59993';
      expect(apiServerDebugLogSource()).toBe(wranglerDebugLogPath('59993'));
      expect(runApiHealthUrl()).toBe('http://localhost:59993/health');
      delete process.env['HB_API_PORT'];
      expect(apiServerDebugLogSource()).toBeNull();
      expect(runApiHealthUrl()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env['HB_API_PORT'];
      else process.env['HB_API_PORT'] = saved;
    }
  });
});

describe('E2EReportWriter (api liveness watchdog)', () => {
  let temporaryDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let parkedSigintListeners: SigintListener[];

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-reporter-liveness-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(temporaryDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The trip emits a real SIGINT in this process. Park every other listener
    // so only the reporter's own sees it, and restore them afterwards.
    parkedSigintListeners = process.listeners('SIGINT') as SigintListener[];
    for (const listener of parkedSigintListeners) process.removeListener('SIGINT', listener);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const listener of process.listeners('SIGINT') as SigintListener[]) {
      process.removeListener('SIGINT', listener);
    }
    for (const listener of parkedSigintListeners) process.on('SIGINT', listener);
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  const rootSuite = (): Suite => {
    const test = createStubTest({
      title: 'liveness test',
      file: `${temporaryDir}/e2e/chat/chat.spec.ts`,
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
    return createStubSuite({
      title: '',
      type: 'root',
      suites: [projectSuite],
    }) as unknown as Suite;
  };

  const deadApi = (): E2EReportWriter =>
    new E2EReportWriter({
      apiLogPath: null,
      apiDebugLogPath: null,
      liveness: {
        endpoint: 'http://localhost:59993/health',
        probe: () => Promise.resolve({ ok: false, detail: 'timeout' }),
      },
    });

  const runToTrip = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(
      API_LIVENESS.PROBE_CADENCE * (API_LIVENESS.TRIP_FAILURES + 1)
    );
  };

  const written = (): { md: string; json: Record<string, unknown> } => {
    const base = path.join(temporaryDir, 'e2e', 'report');
    const dir = path.join(base, readdirSync(base)[0]!);
    return {
      md: readFileSync(path.join(dir, 'REPORT.md'), 'utf8'),
      json: JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')) as Record<
        string,
        unknown
      >,
    };
  };

  it('still writes the report when the watchdog trips', async () => {
    const reporter = deadApi();
    reporter.onBegin({ projects: [], workers: 1 }, rootSuite());

    await runToTrip();

    const { md, json } = written();
    expect(json['status']).toBe('interrupted');
    expect(md).toContain('## Global Errors');
  });

  it('names the dead endpoint in the run-level errors it records', async () => {
    const reporter = deadApi();
    reporter.onBegin({ projects: [], workers: 1 }, rootSuite());

    await runToTrip();

    const { json } = written();
    expect((json['globalErrors'] as string[])[0]).toContain('GET http://localhost:59993/health');
  });

  it('aborts by emitting an in-process signal rather than killing the process', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const reporter = deadApi();
    reporter.onBegin({ projects: [], workers: 1 }, rootSuite());

    await runToTrip();

    expect(kill).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(0);
    kill.mockRestore();
  });

  it('probes nothing when the run has no api endpoint to probe', async () => {
    const probe = vi.fn(() => Promise.resolve({ ok: false, detail: 'timeout' }));
    const reporter = new E2EReportWriter({
      apiLogPath: null,
      apiDebugLogPath: null,
      liveness: null,
    });
    reporter.onBegin({ projects: [], workers: 1 }, rootSuite());

    await runToTrip();
    void reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 } as FullResult);

    expect(probe).not.toHaveBeenCalled();
    const { json } = written();
    expect(json['globalErrors']).toBeUndefined();
  });

  it('stops probing once the run ends', async () => {
    const probe = vi.fn(() => Promise.resolve({ ok: true, detail: '200' }));
    const reporter = new E2EReportWriter({
      apiLogPath: null,
      apiDebugLogPath: null,
      liveness: { endpoint: 'http://localhost:59993/health', probe },
    });
    reporter.onBegin({ projects: [], workers: 1 }, rootSuite());
    await vi.advanceTimersByTimeAsync(API_LIVENESS.PROBE_CADENCE * 2);
    const taken = probe.mock.calls.length;
    expect(taken).toBeGreaterThan(0);

    void reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 } as FullResult);
    await vi.advanceTimersByTimeAsync(API_LIVENESS.PROBE_CADENCE * 5);

    expect(probe.mock.calls.length).toBe(taken);
  });
});

describe('E2EReportWriter (wrangler debug log capture)', () => {
  let temporaryDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-reporter-debugflush-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(temporaryDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('lands server-api-debug.log.gz in the run directory on flush', () => {
    const debugLog = path.join(temporaryDir, 'wrangler-debug.log');
    writeFileSync(debugLog, 'Ready on http://localhost:1\n');
    const test = createStubTest({
      title: 'capture test',
      file: `${temporaryDir}/e2e/chat/chat.spec.ts`,
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
    }) as unknown as Suite;

    const reporter = new E2EReportWriter({
      apiLogPath: null,
      apiDebugLogPath: debugLog,
      liveness: null,
    });
    reporter.onBegin({ projects: [], workers: 1 }, rootSuite);
    void reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 10 } as FullResult);

    const base = path.join(temporaryDir, 'e2e', 'report');
    const runDir = readdirSync(base)[0]!;
    const compressed = readFileSync(path.join(base, runDir, 'server-api-debug.log.gz'));
    expect(gunzipSync(compressed).toString('utf8')).toBe('Ready on http://localhost:1\n');
  });
});

describe(`the ${HEAP_PROBE_VARIABLE} switch`, () => {
  it('reads on as the probe being wanted', () => {
    expect(heapProbeEnabled({ [HEAP_PROBE_VARIABLE]: 'on' })).toBe(true);
  });

  it('reads off as the probe being unwanted', () => {
    expect(heapProbeEnabled({ [HEAP_PROBE_VARIABLE]: 'off' })).toBe(false);
  });

  it('refuses an unset switch rather than choosing an arm', () => {
    expect(() => heapProbeEnabled({})).toThrow(HEAP_PROBE_VARIABLE);
  });

  it('refuses a value that is neither arm', () => {
    expect(() => heapProbeEnabled({ [HEAP_PROBE_VARIABLE]: 'true' })).toThrow(HEAP_PROBE_VARIABLE);
  });

  it('leaves the sampler its own probe when the switch is on', () => {
    expect(heapProbeSamplerOptions({ [HEAP_PROBE_VARIABLE]: 'on' }).openHeapProbe).toBeUndefined();
  });

  it('hands the sampler no probe to open when the switch is off', () => {
    const { openHeapProbe } = heapProbeSamplerOptions({ [HEAP_PROBE_VARIABLE]: 'off' });

    expect(openHeapProbe?.()).toBeNull();
  });
});

describe('captureCompletionGaps', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-reporter-completion-gaps-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  const completionBlock = (instantMs: number): string =>
    `--- ${isoAt(instantMs)} info\n{"level":"info","msg":"request completed","route":"/health","method":"GET","statusCode":200,"latencyMs":4}\n---\n\n`;

  it('writes the score of the whole debug log beside the report', () => {
    const source = path.join(temporaryDir, 'debug.log');
    const busy = Array.from({ length: 10 }, (_, index) => TEST_DAY_START + index * 50);
    const resumedAt = (busy.at(-1) ?? 0) + 8000;
    const after = Array.from({ length: 10 }, (_, index) => resumedAt + index * 50);
    writeFileSync(source, [...busy, ...after].map((ms) => completionBlock(ms)).join(''));
    const destination = path.join(temporaryDir, 'report');
    mkdirSync(destination, { recursive: true });

    expect(captureCompletionGaps(destination, source, TEST_DAY_START)).toBe(
      path.join(destination, 'api-completion-gaps.json')
    );
    const written = JSON.parse(
      readFileSync(path.join(destination, 'api-completion-gaps.json'), 'utf8')
    ) as { windowCount: number; longestSeconds: number };
    expect(written.windowCount).toBe(1);
    expect(written.longestSeconds).toBe(8);
  });

  it('scores only what the log recorded once this run had begun', () => {
    const source = path.join(temporaryDir, 'debug.log');
    const earlier = Array.from({ length: 10 }, (_, index) => TEST_DAY_START + index * 50);
    const runStart = TEST_DAY_START + HOUR_MS;
    const busy = Array.from({ length: 10 }, (_, index) => runStart + index * 50);
    writeFileSync(source, [...earlier, ...busy].map((ms) => completionBlock(ms)).join(''));
    const destination = path.join(temporaryDir, 'report');
    mkdirSync(destination, { recursive: true });

    captureCompletionGaps(destination, source, runStart);

    const written = JSON.parse(
      readFileSync(path.join(destination, 'api-completion-gaps.json'), 'utf8')
    ) as { completions: number };
    expect(written.completions).toBe(10);
  });

  it('writes nothing when the run named no debug log', () => {
    const destination = path.join(temporaryDir, 'report');
    mkdirSync(destination, { recursive: true });

    expect(captureCompletionGaps(destination, null, TEST_DAY_START)).toBeNull();
    expect(existsSync(path.join(destination, 'api-completion-gaps.json'))).toBe(false);
  });
});

describe('E2EReportWriter (coverage loss decides the run status)', () => {
  let temporaryDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-reporter-coverage-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(temporaryDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  /** One project whose test produced a result, plus `lost` projects whose tests produced none. */
  function rootSuiteWithLostProjects(lost: string[]): Suite {
    const projectSuite = (projectName: string, results: StubTestResult[]): StubSuite =>
      createStubSuite({
        title: projectName,
        type: 'project',
        projectName,
        suites: [
          createStubSuite({
            title: 'chat.spec.ts',
            type: 'file',
            projectName,
            tests: [
              createStubTest({
                title: `${projectName} test`,
                file: `${temporaryDir}/e2e/chat/chat.spec.ts`,
                results,
              }),
            ],
          }),
        ],
      });
    return createStubSuite({
      title: '',
      type: 'root',
      suites: [
        projectSuite('chromium', [createStubResult()]),
        ...lost.map((projectName) => projectSuite(projectName, [])),
      ],
    }) as unknown as Suite;
  }

  /** One project whose one test produced a result that no report list can hold. */
  function rootSuiteWithUnlistedTest(): Suite {
    // An outcome outside the declared union is what a Playwright release adding an
    // outcome would hand the reporter at runtime; the cast stands in for that value.
    const unknownOutcome = 'retried' as string as 'expected';
    return createStubSuite({
      title: '',
      type: 'root',
      suites: [
        createStubSuite({
          title: 'chromium',
          type: 'project',
          projectName: 'chromium',
          suites: [
            createStubSuite({
              title: 'chat.spec.ts',
              type: 'file',
              projectName: 'chromium',
              tests: [
                createStubTest({
                  title: 'chromium test',
                  file: `${temporaryDir}/e2e/chat/chat.spec.ts`,
                  outcome: unknownOutcome,
                }),
              ],
            }),
          ],
        }),
      ],
    }) as unknown as Suite;
  }

  const endWith = (status: FullResult['status']): FullResult =>
    ({ status, startTime: new Date(TEST_DAY_START), duration: 10 }) as FullResult;

  it('blames a lost project on the failed setup project the run config makes it wait on', async () => {
    const projectSuite = (projectName: string, test: StubTestCase): StubSuite =>
      createStubSuite({
        title: projectName,
        type: 'project',
        projectName,
        suites: [
          createStubSuite({ title: 'admin.spec.ts', type: 'file', projectName, tests: [test] }),
        ],
      });
    const file = `${temporaryDir}/e2e/admin/admin.spec.ts`;
    const rootSuite = createStubSuite({
      title: '',
      type: 'root',
      suites: [
        projectSuite(
          'setup-admin',
          createStubTest({
            title: 'serves the console',
            file,
            outcome: 'unexpected',
            results: [createStubResult({ status: 'failed' })],
          })
        ),
        projectSuite(
          'admin',
          createStubTest({ title: 'opens the console', file, outcome: 'skipped', results: [] })
        ),
      ],
    }) as unknown as Suite;
    const reporter = new E2EReportWriter({
      apiLogPath: null,
      apiDebugLogPath: null,
      liveness: null,
    });
    reporter.onBegin(
      {
        projects: [
          { name: 'setup-admin', dependencies: [] },
          { name: 'admin', dependencies: ['setup-admin'] },
        ],
        workers: 1,
      },
      rootSuite
    );

    await reporter.onEnd(endWith('failed'));

    const base = path.join(temporaryDir, 'e2e', 'report');
    const runDir = path.join(base, readdirSync(base)[0]!);
    const json = JSON.parse(readFileSync(path.join(runDir, 'report.json'), 'utf8')) as {
      coverage?: { lost: unknown[] };
    };
    expect(json.coverage?.lost).toEqual([
      {
        project: 'admin',
        tests: 1,
        reason: 'dependency-failed',
        dependencies: [{ project: 'setup-admin', failedTests: 1 }],
      },
    ]);
  });

  it('fails a passing run that lost a project, guarding a coincidence rather than a path reachable today', async () => {
    const reporter = reporterFor(rootSuiteWithLostProjects(['firefox']));

    await expect(reporter.onEnd(endWith('passed'))).resolves.toEqual({ status: 'failed' });
  });

  it('records the escalated status in the report a machine reads, not the one the runner computed', async () => {
    const reporter = reporterFor(rootSuiteWithLostProjects(['firefox']));

    await reporter.onEnd(endWith('passed'));

    const base = path.join(temporaryDir, 'e2e', 'report');
    const runDir = path.join(base, readdirSync(base)[0]!);
    const json = JSON.parse(readFileSync(path.join(runDir, 'report.json'), 'utf8')) as {
      status?: string;
    };
    expect(json.status).toBe('failed');
  });

  it('fails a passing run in which a test with a result is in no report list', async () => {
    const reporter = reporterFor(rootSuiteWithUnlistedTest());

    await expect(reporter.onEnd(endWith('passed'))).resolves.toEqual({ status: 'failed' });
  });

  it('leaves a run that covered every project in its report passing', async () => {
    const reporter = reporterFor(rootSuiteWithLostProjects([]));

    await expect(reporter.onEnd(endWith('passed'))).resolves.toBeUndefined();
  });

  it('leaves an interrupted run interrupted, so its exit still tells a signal from a failure', async () => {
    const reporter = reporterFor(rootSuiteWithLostProjects(['firefox']));

    await expect(reporter.onEnd(endWith('interrupted'))).resolves.toBeUndefined();
  });

  const stdout = (): string =>
    logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');

  const writtenReportPath = (): string => {
    const base = path.join('e2e', 'report');
    return path.join(base, readdirSync(path.join(temporaryDir, base))[0]!, 'REPORT.md');
  };

  it('tells stdout how many projects produced no result', async () => {
    const reporter = reporterFor(rootSuiteWithLostProjects(['firefox', 'webkit']));

    await reporter.onEnd(endWith('failed'));

    expect(stdout()).toContain('Lost coverage: 2 project(s) produced no result');
  });

  it('points stdout at the report section that says why each project produced no result', async () => {
    const reporter = reporterFor(rootSuiteWithLostProjects(['firefox']));

    await reporter.onEnd(endWith('failed'));

    expect(stdout()).toContain(`under ${GLOBAL_ERRORS_HEADING} in ${writtenReportPath()}`);
  });

  it('names in stdout a section heading the written report carries', async () => {
    const reporter = reporterFor(rootSuiteWithLostProjects(['firefox']));

    await reporter.onEnd(endWith('failed'));

    const section = /why each did is under (.+) in /.exec(stdout())?.[1];
    const report = readFileSync(path.join(temporaryDir, writtenReportPath()), 'utf8');
    expect(report.split('\n')).toContain(`## ${section ?? ''}`);
  });

  it('prints no lost-coverage line when every project produced a result', async () => {
    const reporter = reporterFor(rootSuiteWithLostProjects([]));

    await reporter.onEnd(endWith('failed'));

    expect(stdout()).not.toContain('Lost coverage');
  });

  it('prints one stdout line counting the tests with a result that no report list holds', async () => {
    const reporter = reporterFor(rootSuiteWithUnlistedTest());

    await reporter.onEnd(endWith('passed'));

    expect(stdout()).toContain(
      `  Unlisted results: 1 test(s) produced a result that no report list holds; see ${GLOBAL_ERRORS_HEADING} in ${writtenReportPath()}`
    );
  });

  it('points stdout at a report section that holds the unlisted results', async () => {
    const reporter = reporterFor(rootSuiteWithUnlistedTest());

    await reporter.onEnd(endWith('passed'));

    const section = /no report list holds; see (.+) in /.exec(stdout())?.[1];
    const lines = readFileSync(path.join(temporaryDir, writtenReportPath()), 'utf8').split('\n');
    const sectionStart = lines.indexOf(`## ${section ?? ''}`);
    expect(sectionStart).toBeGreaterThan(-1);
    expect(lines.slice(sectionStart).some((line) => line.startsWith('Unlisted results:'))).toBe(
      true
    );
  });

  it('prints no unlisted-results line when the report lists every test with a result', async () => {
    const reporter = reporterFor(rootSuiteWithLostProjects([]));

    await reporter.onEnd(endWith('passed'));

    expect(stdout()).not.toContain('Unlisted results');
  });

  it('does not call a run aborted when its only global errors are lost coverage', async () => {
    const reporter = reporterFor(rootSuiteWithLostProjects(['firefox']));

    await reporter.onEnd(endWith('failed'));

    // The whole word aborted only: the resource summary can print a heap-OOM aborts count.
    expect(stdout()).not.toMatch(/\baborted\b/i);
  });

  it('counts only harness errors in the stdout global error count when coverage is also lost', async () => {
    const reporter = reporterFor(rootSuiteWithLostProjects(['firefox', 'webkit']));
    reporter.onError({ message: 'setup threw' });

    await reporter.onEnd(endWith('failed'));

    expect(stdout()).toContain(', 1 global error(s))');
  });
});

describe('E2EReportWriter (a listing is not a run)', () => {
  let temporaryDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-reporter-listing-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(temporaryDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  /** Every project holding the tests it configured, not one of them with a result. */
  function listedSuite(): Suite {
    const projectSuite = (projectName: string): StubSuite =>
      createStubSuite({
        title: projectName,
        type: 'project',
        projectName,
        suites: [
          createStubSuite({
            title: 'chat.spec.ts',
            type: 'file',
            projectName,
            tests: [
              createStubTest({
                title: `${projectName} test`,
                file: `${temporaryDir}/e2e/chat/chat.spec.ts`,
                results: [],
                outcome: 'skipped',
              }),
            ],
          }),
        ],
      });
    return createStubSuite({
      title: '',
      type: 'root',
      suites: [projectSuite('chromium'), projectSuite('firefox')],
    }) as unknown as Suite;
  }

  const endWith = (status: FullResult['status']): FullResult =>
    ({ status, startTime: new Date(TEST_DAY_START), duration: 10 }) as FullResult;

  it('leaves the status of a listing alone, which executed nothing rather than losing it', async () => {
    const reporter = reporterFor(listedSuite());

    await expect(reporter.onEnd(endWith('passed'))).resolves.toBeUndefined();
  });

  it('writes no report for a listing, which produced no run to debug', async () => {
    const reporter = reporterFor(listedSuite());

    await reporter.onEnd(endWith('passed'));

    expect(existsSync(path.join(temporaryDir, 'e2e', 'report'))).toBe(false);
  });

  it('still reports an abort that left every test without a result', async () => {
    const reporter = reporterFor(listedSuite());
    reporter.onError({ message: 'api died' });

    await reporter.onEnd(endWith('interrupted'));

    const base = path.join(temporaryDir, 'e2e', 'report');
    expect(readdirSync(base)).toHaveLength(1);
  });
});

describe('E2EReportWriter (the RAM root against the run’s workers)', () => {
  const MIB = 1024 ** 2;
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-reporter-workers-'));
    vi.spyOn(process, 'cwd').mockReturnValue(temporaryDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  /** A sampler whose run saw the RAM root reach `peakBytes`, and nothing else. */
  function samplerPeakingAt(peakBytes: number): ResourceSampler {
    const summary: ResourceSummary = {
      durationMs: 10,
      sampleCount: 1,
      cores: 4,
      totalMemBytes: 8 * 1024 ** 3,
      cpu: { peak: 0, avg: 0 },
      mem: { peak: 0, avg: 0 },
      load: { peak: 0 },
      isolateStalls: null,
      diskPeaks: null,
      dStateWaits: null,
      ramRootPeakBytes: peakBytes,
    };
    return { start: (): void => undefined, stop: () => ({ summary, samples: [] }) };
  }

  it('measures the RAM root’s peak against what the configured workers need', async () => {
    const reporter = new E2EReportWriter({
      apiLogPath: null,
      apiDebugLogPath: null,
      liveness: null,
      sampler: samplerPeakingAt(300 * MIB),
    });
    reporter.onBegin(
      { projects: [], workers: 9 },
      createStubSuite({ title: '', type: 'root' }) as unknown as Suite
    );

    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 10 } as FullResult);

    const base = path.join(temporaryDir, 'e2e', 'report');
    const report = readFileSync(path.join(base, readdirSync(base)[0]!, 'REPORT.md'), 'utf8');
    expect(report).toContain(
      `300 MiB of the ${String(ramRootRequiredBytes(9) / MIB)} MiB a run of 9 workers is sized for`
    );
  });
});
