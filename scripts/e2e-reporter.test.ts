import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FullResult, Suite } from '@playwright/test/reporter';
import E2EReportWriter, { buildPlaywrightReport } from './e2e-reporter.js';

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
    startTime: new Date('2026-01-01T00:00:00Z'),
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
    location: { file: overrides.file ?? '/abs/e2e/chat/chat.spec.ts', line: 1, column: 1 },
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
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      expect(result.suites[0]!.suites!).toBeDefined();
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
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      const attachments =
        result.suites[0]!.suites![0]!.specs![0]!.tests![0]!.results[0]!.attachments!;
      expect(attachments[0]!.body).toBe('TypeError: x is not a function');
      expect(attachments[0]!.contentType).toBe('text/plain');
    });

    it('includes startTime on test results', () => {
      const startTime = new Date('2026-03-21T12:00:00Z');
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
        { status: 'passed', startTime: new Date(), duration: 1000 }
      );

      expect(result.suites[0]!.suites![0]!.specs![0]!.tests![0]!.results[0]!.startTime).toBe(
        '2026-03-21T12:00:00.000Z'
      );
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

    reporter.onBegin({}, rootSuiteStub());

    expect(process.listenerCount('SIGINT')).toBe(before + 1);
  });

  it('writes a report when interrupted via SIGINT', () => {
    const reporter = new E2EReportWriter();
    reporter.onBegin({}, rootSuiteStub());

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
    reporter.onBegin({}, rootSuiteStub());

    const handler = process.listeners('SIGINT').at(-1) as SigintListener;
    handler('SIGINT');
    reporter.onEnd(fullResult('interrupted'));

    expect(flushLogCount()).toBe(1);
    expect(readdirSync(reportBase())).toHaveLength(1);
  });

  it('removes its SIGINT listener after the first signal so repeat Ctrl+C still kills', () => {
    const preexisting = process.listeners('SIGINT') as SigintListener[];
    for (const listener of preexisting) process.removeListener('SIGINT', listener);
    try {
      const reporter = new E2EReportWriter();
      reporter.onBegin({}, rootSuiteStub());
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
    reporter.onBegin({}, {} as unknown as Suite);

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
    reporter.onBegin({}, rootSuite as unknown as Suite);
    reporter.onEnd(fullResult('failed'));

    expect(
      logSpy.mock.calls.some(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Failed test details')
      )
    ).toBe(true);
  });

  it('prints to stdio', () => {
    expect(new E2EReportWriter().printsToStdio()).toBe(true);
  });

  it('writes nothing when onEnd runs without a begun suite', () => {
    const before = process.listenerCount('SIGINT');
    const reporter = new E2EReportWriter();

    reporter.onEnd(fullResult('passed'));

    expect(existsSync(reportBase())).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('writes the report and unregisters its listener on clean onEnd', () => {
    const before = process.listenerCount('SIGINT');
    const reporter = new E2EReportWriter();
    reporter.onBegin({}, rootSuiteStub());

    reporter.onEnd(fullResult('passed'));

    const base = reportBase();
    const directories = readdirSync(base);
    expect(directories).toHaveLength(1);
    expect(existsSync(path.join(base, directories[0]!, 'report.json'))).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
