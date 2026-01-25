import { describe, it, expect } from 'vitest';
import {
  parsePlaywrightJson,
  categorizeTests,
  extractArtifactPaths,
  generateDebugReport,
  type FlattenedTestResult,
  type PlaywrightReport,
  type PlaywrightSpec,
  type PlaywrightTest,
  type PlaywrightTestResult,
} from './e2e-debug.js';

describe('e2e-debug', () => {
  describe('parsePlaywrightJson', () => {
    it('parses valid JSON from stdin content', () => {
      const input = JSON.stringify({
        suites: [],
        config: {},
        stats: { duration: 1000 },
      });

      const result = parsePlaywrightJson(input);

      expect(result).toEqual({
        suites: [],
        config: {},
        stats: { duration: 1000 },
      });
    });

    it('throws on invalid JSON', () => {
      expect(() => parsePlaywrightJson('not json')).toThrow();
    });

    it('throws on empty input', () => {
      expect(() => parsePlaywrightJson('')).toThrow();
    });
  });

  describe('categorizeTests', () => {
    const createTestResult = (
      overrides: Partial<FlattenedTestResult> = {}
    ): FlattenedTestResult => ({
      title: 'test title',
      file: 'path/to/test.spec.ts',
      projectName: 'chromium',
      status: 'passed',
      retry: 0,
      duration: 1000,
      errors: [],
      steps: [],
      attachments: [],
      ...overrides,
    });

    it('categorizes passed tests', () => {
      const tests = [createTestResult({ status: 'passed', retry: 0 })];

      const result = categorizeTests(tests);

      expect(result.passed).toHaveLength(1);
      expect(result.flaky).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });

    it('categorizes flaky tests (passed on retry)', () => {
      const tests = [createTestResult({ status: 'passed', retry: 1 })];

      const result = categorizeTests(tests);

      expect(result.passed).toHaveLength(0);
      expect(result.flaky).toHaveLength(1);
      expect(result.flaky[0]?.attempts).toBe(2);
      expect(result.failed).toHaveLength(0);
    });

    it('categorizes failed tests', () => {
      const tests = [createTestResult({ status: 'failed', retry: 2 })];

      const result = categorizeTests(tests);

      expect(result.passed).toHaveLength(0);
      expect(result.flaky).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
    });

    it('categorizes timed out tests as failed', () => {
      const tests = [createTestResult({ status: 'timedOut' })];

      const result = categorizeTests(tests);

      expect(result.failed).toHaveLength(1);
    });

    it('categorizes interrupted tests as failed', () => {
      const tests = [createTestResult({ status: 'interrupted' })];

      const result = categorizeTests(tests);

      expect(result.failed).toHaveLength(1);
    });

    it('skips skipped tests', () => {
      const tests = [createTestResult({ status: 'skipped' })];

      const result = categorizeTests(tests);

      expect(result.passed).toHaveLength(0);
      expect(result.flaky).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });

    it('handles multiple tests of different statuses', () => {
      const tests = [
        createTestResult({ title: 'passed test', status: 'passed', retry: 0 }),
        createTestResult({ title: 'flaky test', status: 'passed', retry: 2 }),
        createTestResult({ title: 'failed test', status: 'failed' }),
        createTestResult({ title: 'skipped test', status: 'skipped' }),
      ];

      const result = categorizeTests(tests);

      expect(result.passed).toHaveLength(1);
      expect(result.flaky).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
    });
  });

  describe('extractArtifactPaths', () => {
    it('extracts trace path from attachments', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [{ name: 'trace', path: 'test-results/test-chromium/trace.zip' }],
      };

      const result = extractArtifactPaths(test);

      expect(result.trace).toBe('test-results/test-chromium/trace.zip');
    });

    it('extracts screenshot path from attachments', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [{ name: 'screenshot', path: 'test-results/test-chromium/test-failed-1.png' }],
      };

      const result = extractArtifactPaths(test);

      expect(result.screenshot).toBe('test-results/test-chromium/test-failed-1.png');
    });

    it('extracts video path from attachments', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [{ name: 'video', path: 'test-results/test-chromium/video.webm' }],
      };

      const result = extractArtifactPaths(test);

      expect(result.video).toBe('test-results/test-chromium/video.webm');
    });

    it('extracts all artifact types', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [
          { name: 'trace', path: 'trace.zip' },
          { name: 'screenshot', path: 'screenshot.png' },
          { name: 'video', path: 'video.webm' },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.trace).toBe('trace.zip');
      expect(result.screenshot).toBe('screenshot.png');
      expect(result.video).toBe('video.webm');
    });

    it('returns undefined for missing artifacts', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [],
      };

      const result = extractArtifactPaths(test);

      expect(result.trace).toBeUndefined();
      expect(result.screenshot).toBeUndefined();
      expect(result.video).toBeUndefined();
    });
  });

  describe('generateDebugReport', () => {
    const createReport = (suites: PlaywrightReport['suites'] = []): PlaywrightReport => ({
      suites,
      config: {},
      stats: { duration: 5000 },
    });

    const createSuite = (
      specs: PlaywrightReport['suites'][number]['specs'] = []
    ): PlaywrightReport['suites'][number] => ({
      title: 'Suite',
      file: 'test.spec.ts',
      specs,
      suites: [],
    });

    // Helper to create a spec with the new nested structure
    const createSpec = (
      title: string,
      file: string,
      tests: PlaywrightTest[] = []
    ): PlaywrightSpec => ({
      title,
      file,
      tests,
    });

    // Helper to create a test with results array
    const createTest = (projectName: string, results: PlaywrightTestResult[]): PlaywrightTest => ({
      projectName,
      status: 'expected',
      results,
    });

    // Helper to create a test result
    const createResult = (overrides: Partial<PlaywrightTestResult> = {}): PlaywrightTestResult => ({
      status: 'passed',
      retry: 0,
      duration: 1000,
      errors: [],
      steps: [],
      attachments: [],
      ...overrides,
    });

    it('generates summary with correct counts', () => {
      const report = createReport([
        createSuite([
          createSpec('passed test', 'test.spec.ts', [
            createTest('chromium', [createResult({ status: 'passed' })]),
          ]),
          createSpec('failed test', 'test.spec.ts', [
            createTest('chromium', [createResult({ status: 'failed' })]),
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.summary.total).toBe(2);
      expect(result.summary.passed).toBe(1);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.duration).toBe(5000);
    });

    it('includes passed test details', () => {
      const report = createReport([
        createSuite([
          createSpec('should work', 'e2e/chat.spec.ts', [
            createTest('chromium', [createResult({ status: 'passed' })]),
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.passed).toHaveLength(1);
      expect(result.passed[0]).toEqual({
        title: 'should work',
        file: 'e2e/chat.spec.ts',
        project: 'chromium',
      });
    });

    it('includes flaky test details with attempt count', () => {
      const report = createReport([
        createSuite([
          createSpec('flaky test', 'e2e/chat.spec.ts', [
            createTest('firefox', [createResult({ status: 'passed', retry: 2 })]),
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.flaky).toHaveLength(1);
      expect(result.flaky[0]).toEqual({
        title: 'flaky test',
        file: 'e2e/chat.spec.ts',
        project: 'firefox',
        attempts: 3,
      });
    });

    it('includes failed test details with error and artifacts', () => {
      const report = createReport([
        createSuite([
          createSpec('broken test', 'e2e/billing.spec.ts', [
            createTest('webkit', [
              createResult({
                status: 'failed',
                retry: 1,
                duration: 2000,
                errors: [{ message: 'Timeout', stack: 'at line 42' }],
                steps: [{ title: 'Click button', duration: 100 }],
                attachments: [
                  { name: 'trace', path: 'test-results/broken-webkit/trace.zip' },
                  { name: 'screenshot', path: 'test-results/broken-webkit/screenshot.png' },
                ],
              }),
            ]),
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toEqual({
        title: 'broken test',
        file: 'e2e/billing.spec.ts',
        project: 'webkit',
        error: 'Timeout',
        artifacts: {
          trace: 'test-results/broken-webkit/trace.zip',
          screenshot: 'test-results/broken-webkit/screenshot.png',
          video: undefined,
        },
      });
    });

    it('handles nested suites', () => {
      const report: PlaywrightReport = {
        suites: [
          {
            title: 'Outer Suite',
            file: 'test.spec.ts',
            specs: [],
            suites: [
              {
                title: 'Inner Suite',
                file: 'test.spec.ts',
                specs: [
                  {
                    title: 'nested test',
                    file: 'test.spec.ts',
                    tests: [
                      {
                        projectName: 'chromium',
                        status: 'expected',
                        results: [
                          {
                            status: 'passed',
                            retry: 0,
                            duration: 500,
                            errors: [],
                            steps: [],
                            attachments: [],
                          },
                        ],
                      },
                    ],
                  },
                ],
                suites: [],
              },
            ],
          },
        ],
        config: {},
        stats: { duration: 500 },
      };

      const result = generateDebugReport(report);

      expect(result.summary.total).toBe(1);
      expect(result.passed).toHaveLength(1);
    });

    it('outputs valid JSON structure', () => {
      const report = createReport([]);

      const result = generateDebugReport(report);

      expect(() => JSON.stringify(result)).not.toThrow();
      const parsed = structuredClone(result);
      expect(parsed.summary).toBeDefined();
      expect(parsed.passed).toEqual([]);
      expect(parsed.flaky).toEqual([]);
      expect(parsed.failed).toEqual([]);
    });

    it('handles suites with undefined specs and suites arrays', () => {
      const report: PlaywrightReport = {
        suites: [
          {
            title: 'Suite without specs/suites',
            file: 'test.spec.ts',
          },
        ],
        config: {},
        stats: { duration: 100 },
      };

      const result = generateDebugReport(report);

      expect(result.summary.total).toBe(0);
      expect(result.passed).toHaveLength(0);
    });

    it('handles specs with undefined tests array', () => {
      const report: PlaywrightReport = {
        suites: [
          {
            title: 'Suite',
            file: 'test.spec.ts',
            specs: [
              {
                title: 'Spec without tests',
                file: 'test.spec.ts',
              },
            ],
          },
        ],
        config: {},
        stats: { duration: 100 },
      };

      const result = generateDebugReport(report);

      expect(result.summary.total).toBe(0);
      expect(result.passed).toHaveLength(0);
    });
  });
});
