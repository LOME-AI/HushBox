import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  categorizeTests,
  extractArtifactPaths,
  generateDebugReport,
  stripAnsi,
  slugify,
  formatDuration,
  buildRerunCommand,
  generateMarkdownReport,
  renderSteps,
  writeReport,
  enforceRetentionLimit,
  type DebugReport,
  type FlattenedTestResult,
  type JsonReport,
  type PlaywrightReport,
  type PlaywrightSpec,
  type PlaywrightStep,
  type PlaywrightTest,
  type PlaywrightTestResult,
} from './e2e-debug.js';

describe('e2e-debug', () => {
  describe('stripAnsi', () => {
    it('removes color codes from text', () => {
      const input = '\u001B[31mError\u001B[0m: something failed';
      expect(stripAnsi(input)).toBe('Error: something failed');
    });

    it('removes bold and underline codes', () => {
      const input = '\u001B[1mbold\u001B[22m \u001B[4munderline\u001B[24m';
      expect(stripAnsi(input)).toBe('bold underline');
    });

    it('passes through plain text unchanged', () => {
      const input = 'no ansi codes here';
      expect(stripAnsi(input)).toBe('no ansi codes here');
    });

    it('handles empty string', () => {
      expect(stripAnsi('')).toBe('');
    });

    it('removes multiple ANSI sequences', () => {
      const input = '\u001B[32m✓\u001B[0m \u001B[90mtest passed\u001B[0m';
      expect(stripAnsi(input)).toBe('✓ test passed');
    });
  });

  describe('slugify', () => {
    it('converts spaces to hyphens', () => {
      expect(slugify('hello world')).toBe('hello-world');
    });

    it('converts to lowercase', () => {
      expect(slugify('Hello World')).toBe('hello-world');
    });

    it('removes non-alphanumeric characters', () => {
      expect(slugify('test (chromium) #1')).toBe('test-chromium-1');
    });

    it('collapses consecutive hyphens', () => {
      expect(slugify('a---b')).toBe('a-b');
    });

    it('trims leading and trailing hyphens', () => {
      expect(slugify('--hello--')).toBe('hello');
    });

    it('handles file paths with slashes and dots', () => {
      expect(slugify('e2e/chat/chat.spec.ts')).toBe('e2e-chat-chat-spec-ts');
    });
  });

  describe('formatDuration', () => {
    it('formats seconds only', () => {
      expect(formatDuration(5000)).toBe('5s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(154_000)).toBe('2m 34s');
    });

    it('formats hours, minutes, and seconds', () => {
      expect(formatDuration(3_661_000)).toBe('1h 1m 1s');
    });

    it('formats zero duration', () => {
      expect(formatDuration(0)).toBe('0s');
    });

    it('formats exact minutes without seconds', () => {
      expect(formatDuration(120_000)).toBe('2m 0s');
    });
  });

  describe('buildRerunCommand', () => {
    it('generates rerun command with file, grep, and project', () => {
      const result = buildRerunCommand({
        title: 'displays UI',
        file: 'e2e/chat/chat.spec.ts',
        project: 'chromium',
      });
      expect(result).toBe('pnpm e2e -- e2e/chat/chat.spec.ts -g "displays UI" --project=chromium');
    });

    it('escapes double quotes in title', () => {
      const result = buildRerunCommand({
        title: 'handles "edge" case',
        file: 'e2e/chat/chat.spec.ts',
        project: 'webkit',
      });
      expect(result).toBe(
        String.raw`pnpm e2e -- e2e/chat/chat.spec.ts -g "handles \"edge\" case" --project=webkit`
      );
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

    it('propagates duration to passed tests', () => {
      const tests = [createTestResult({ status: 'passed', retry: 0, duration: 5000 })];

      const result = categorizeTests(tests);

      expect(result.passed[0]?.duration).toBe(5000);
    });

    it('propagates duration, steps, and line to failed tests', () => {
      const steps: PlaywrightStep[] = [{ title: 'click button', duration: 100 }];
      const tests = [
        createTestResult({
          status: 'failed',
          duration: 3000,
          steps,
          line: 42,
          errors: [{ message: 'timeout' }],
        }),
      ];

      const result = categorizeTests(tests);

      expect(result.failed[0]?.duration).toBe(3000);
      expect(result.failed[0]?.steps).toEqual(steps);
      expect(result.failed[0]?.line).toBe(42);
    });

    it('propagates labeled console-errors and har artifacts to failed tests', () => {
      const tests = [
        createTestResult({
          status: 'failed',
          attachments: [
            {
              name: 'console-errors-authenticatedPage',
              body: 'TypeError: x',
              contentType: 'text/plain',
            },
            { name: 'har-authenticatedPage', path: 'network.har' },
          ],
        }),
      ];

      const result = categorizeTests(tests);

      expect(result.failed[0]?.artifacts.consoleErrors).toBe('TypeError: x');
      expect(result.failed[0]?.artifacts.harFiles).toEqual(['network.har']);
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
      expect(result.consoleErrors).toBeUndefined();
      expect(result.pageSnapshot).toBeUndefined();
      expect(result.harFiles).toEqual([]);
    });

    it('extracts labeled console-errors body from attachments', () => {
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
          {
            name: 'console-errors-authenticatedPage',
            body: 'TypeError: foo is not a function',
            contentType: 'text/plain',
          },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.consoleErrors).toBe('TypeError: foo is not a function');
    });

    it('concatenates multiple labeled page-snapshot bodies with headers', () => {
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
          { name: 'page-snapshot-testDavePage', body: '- document', contentType: 'text/yaml' },
          {
            name: 'page-snapshot-authenticatedPage',
            body: '- document:\n  - main: content',
            contentType: 'text/yaml',
          },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.pageSnapshot).toContain('--- testDavePage ---');
      expect(result.pageSnapshot).toContain('--- authenticatedPage ---');
      expect(result.pageSnapshot).toContain('- document:\n  - main: content');
    });

    it('returns single page-snapshot without header when only one exists', () => {
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
          {
            name: 'page-snapshot-authenticatedPage',
            body: '- document:\n  - main: chat',
            contentType: 'text/yaml',
          },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.pageSnapshot).toBe('- document:\n  - main: chat');
      expect(result.pageSnapshot).not.toContain('---');
    });

    it('extracts labeled har path from attachments', () => {
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
          {
            name: 'har-authenticatedPage',
            path: 'test-results/test-chromium/authenticatedPage.har',
          },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.harFiles).toEqual(['test-results/test-chromium/authenticatedPage.har']);
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
        duration: 1000,
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
        duration: 2000,
        steps: [{ title: 'Click button', duration: 100 }],
        artifacts: {
          trace: 'test-results/broken-webkit/trace.zip',
          screenshot: 'test-results/broken-webkit/screenshot.png',
          video: undefined,
          consoleErrors: undefined,
          pageSnapshot: undefined,
          harFiles: [],
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

  describe('renderSteps', () => {
    it('renders flat step list', () => {
      const steps: PlaywrightStep[] = [
        { title: 'page.fill', duration: 100, category: 'pw:api' },
        { title: 'page.click', duration: 200, category: 'pw:api' },
      ];

      const result = renderSteps(steps);

      expect(result).toContain('page.fill');
      expect(result).toContain('100ms');
      expect(result).toContain('page.click');
      expect(result).toContain('200ms');
    });

    it('renders nested steps with indentation', () => {
      const steps: PlaywrightStep[] = [
        {
          title: 'Send message',
          duration: 500,
          category: 'test.step',
          steps: [
            { title: 'page.fill', duration: 100, category: 'pw:api' },
            { title: 'page.click', duration: 200, category: 'pw:api' },
          ],
        },
      ];

      const result = renderSteps(steps);
      const lines = result.split('\n');

      expect(lines[0]).toMatch(/^- /);
      expect(lines.some((l: string) => l.startsWith('  - '))).toBe(true);
    });

    it('marks failed steps', () => {
      const steps: PlaywrightStep[] = [
        {
          title: 'expect(locator).toBeVisible',
          duration: 10_000,
          category: 'expect',
          error: 'Timeout',
        },
      ];

      const result = renderSteps(steps);

      expect(result).toContain('FAILED');
    });

    it('limits nesting to 2 levels', () => {
      const steps: PlaywrightStep[] = [
        {
          title: 'level 0',
          duration: 100,
          steps: [
            {
              title: 'level 1',
              duration: 100,
              steps: [{ title: 'level 2 (should be hidden)', duration: 100 }],
            },
          ],
        },
      ];

      const result = renderSteps(steps);

      expect(result).toContain('level 0');
      expect(result).toContain('level 1');
      expect(result).not.toContain('level 2');
    });
  });

  describe('generateMarkdownReport', () => {
    it('shows PASSED result when no failures', () => {
      const report: DebugReport = {
        summary: { total: 3, passed: 3, flaky: 0, failed: 0, duration: 5000 },
        passed: [
          { title: 'test one', file: 'e2e/chat/chat.spec.ts', project: 'chromium', duration: 1000 },
          { title: 'test two', file: 'e2e/chat/chat.spec.ts', project: 'firefox', duration: 1000 },
          {
            title: 'test three',
            file: 'e2e/billing/billing.spec.ts',
            project: 'chromium',
            duration: 1000,
          },
        ],
        flaky: [],
        failed: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**Result:** PASSED');
      expect(md).toContain('3 passed');
      expect(md).toContain('## Passed Tests (3)');
      expect(md).not.toContain('## Failed Tests');
      expect(md).not.toContain('## Flaky Tests');
    });

    it('shows FAILED result with failed test details', () => {
      const report: DebugReport = {
        summary: { total: 2, passed: 1, flaky: 0, failed: 1, duration: 10_000 },
        passed: [
          { title: 'test one', file: 'e2e/chat/chat.spec.ts', project: 'chromium', duration: 1000 },
        ],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/billing/billing.spec.ts',
            project: 'webkit',
            error: 'Timeout waiting for selector',
            duration: 10_000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: '/abs/path/screenshot.png',
              video: undefined,
              consoleErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**Result:** FAILED');
      expect(md).toContain('## Failed Tests');
      expect(md).toContain('### `e2e/billing/billing.spec.ts`');
      expect(md).toContain('#### broken test [webkit]');
      expect(md).toContain('Timeout waiting for selector');
      expect(md).toContain(
        'pnpm e2e -- e2e/billing/billing.spec.ts -g "broken test" --project=webkit'
      );
    });

    it('groups failed tests by file', () => {
      const report: DebugReport = {
        summary: { total: 3, passed: 0, flaky: 0, failed: 3, duration: 5000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test A',
            file: 'e2e/chat/chat.spec.ts',
            project: 'chromium',
            error: 'error A',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
          {
            title: 'test B',
            file: 'e2e/chat/chat.spec.ts',
            project: 'firefox',
            error: 'error B',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
          {
            title: 'test C',
            file: 'e2e/billing/billing.spec.ts',
            project: 'chromium',
            error: 'error C',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      // chat.spec.ts should appear once as a heading, with both tests under it
      const chatHeadingCount = (md.match(/### `e2e\/chat\/chat\.spec\.ts`/g) ?? []).length;
      expect(chatHeadingCount).toBe(1);
      expect(md).toContain('#### test A [chromium]');
      expect(md).toContain('#### test B [firefox]');
      expect(md).toContain('### `e2e/billing/billing.spec.ts`');
    });

    it('renders flaky tests as a table', () => {
      const report: DebugReport = {
        summary: { total: 2, passed: 1, flaky: 1, failed: 0, duration: 5000 },
        passed: [
          { title: 'stable', file: 'e2e/chat/chat.spec.ts', project: 'chromium', duration: 1000 },
        ],
        flaky: [
          { title: 'flaky test', file: 'e2e/chat/chat.spec.ts', project: 'firefox', attempts: 3 },
        ],
        failed: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('## Flaky Tests');
      expect(md).toContain('| flaky test |');
      expect(md).toContain('| 3 |');
    });

    it('strips ANSI codes from error messages', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: '\u001B[31mError\u001B[0m: failed',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('Error: failed');
      expect(md).not.toContain('\u001B[31m');
    });

    it('truncates long error messages', () => {
      const longError = 'x'.repeat(3000);
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: longError,
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('... (truncated)');
      expect(md.length).toBeLessThan(longError.length);
    });

    it('shows screenshot path when present', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: '/some/path/screenshot.png',
              video: undefined,
              consoleErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**Screenshot:**');
      expect(md).toContain('failed/');
    });

    it('shows "none" when screenshot is missing', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**Screenshot:** none');
    });

    it('includes formatted duration', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 1, flaky: 0, failed: 0, duration: 154_000 },
        passed: [{ title: 'test', file: 'e2e/test.spec.ts', project: 'chromium', duration: 1000 }],
        flaky: [],
        failed: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**Duration:** 2m 34s');
    });
  });

  describe('writeReport', () => {
    let temporaryDir: string;

    const simpleReport: DebugReport = {
      summary: { total: 1, passed: 1, flaky: 0, failed: 0, duration: 1000 },
      passed: [{ title: 'test', file: 'e2e/test.spec.ts', project: 'chromium', duration: 1000 }],
      flaky: [],
      failed: [],
    };

    afterEach(() => {
      if (temporaryDir && existsSync(temporaryDir)) {
        rmSync(temporaryDir, { recursive: true, force: true });
      }
    });

    it('creates timestamped subdirectory with REPORT.md', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const resultDir = writeReport(simpleReport, baseDir);

      expect(existsSync(path.join(resultDir, 'REPORT.md'))).toBe(true);
      const content = readFileSync(path.join(resultDir, 'REPORT.md'), 'utf8');
      expect(content).toContain('# E2E Test Report');
    });

    it('returns path inside baseDir with ISO-like timestamp', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const resultDir = writeReport(simpleReport, baseDir);

      expect(resultDir.startsWith(baseDir)).toBe(true);
      const dirName = path.basename(resultDir);
      expect(dirName).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    });

    it('writes per-test artifacts in failed/ directory', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');
      const sourceScreenshot = path.join(temporaryDir, 'source-screenshot.png');
      writeFileSync(sourceScreenshot, 'fake-png-data');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'test error message',
            duration: 1000,
            steps: [{ title: 'click', duration: 100 }],
            artifacts: {
              trace: undefined,
              screenshot: sourceScreenshot,
              video: undefined,
              consoleErrors: 'TypeError: x',
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-test-spec-ts-chromium-broken-test';
      const failedDir = path.join(resultDir, 'failed', slug);
      expect(existsSync(failedDir)).toBe(true);
      expect(existsSync(path.join(failedDir, 'error.txt'))).toBe(true);
      expect(existsSync(path.join(failedDir, 'steps.json'))).toBe(true);
      expect(existsSync(path.join(failedDir, 'screenshot.png'))).toBe(true);
      expect(existsSync(path.join(failedDir, 'console-errors.txt'))).toBe(true);
      expect(readFileSync(path.join(failedDir, 'error.txt'), 'utf8')).toBe('test error message');
    });

    it('writes report.json alongside REPORT.md', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const resultDir = writeReport(simpleReport, baseDir);

      expect(existsSync(path.join(resultDir, 'report.json'))).toBe(true);
      const json = JSON.parse(
        readFileSync(path.join(resultDir, 'report.json'), 'utf8')
      ) as JsonReport;
      expect(json.summary.passed).toBe(1);
      expect(json.passed).toHaveLength(1);
    });

    it('preserves previous reports', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const oldDir = path.join(baseDir, '2020-01-01T00-00-00');
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(path.join(oldDir, 'REPORT.md'), 'old report');

      writeReport(simpleReport, baseDir);

      expect(existsSync(path.join(oldDir, 'REPORT.md'))).toBe(true);
    });

    it('handles missing artifact sources gracefully', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            error: 'error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: '/nonexistent/path/screenshot.png',
              video: undefined,
              consoleErrors: undefined,
              pageSnapshot: undefined,
              harFiles: ['/nonexistent/path/network.har'],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      expect(existsSync(path.join(resultDir, 'REPORT.md'))).toBe(true);
    });
  });

  describe('enforceRetentionLimit', () => {
    let temporaryDir: string;

    afterEach(() => {
      if (temporaryDir && existsSync(temporaryDir)) {
        rmSync(temporaryDir, { recursive: true, force: true });
      }
    });

    it('deletes oldest directories when over limit', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      for (const name of ['2020-01-01T00-00-00', '2020-01-02T00-00-00', '2020-01-03T00-00-00']) {
        mkdirSync(path.join(temporaryDir, name));
      }

      enforceRetentionLimit(temporaryDir, 2);

      expect(existsSync(path.join(temporaryDir, '2020-01-01T00-00-00'))).toBe(false);
      expect(existsSync(path.join(temporaryDir, '2020-01-02T00-00-00'))).toBe(true);
      expect(existsSync(path.join(temporaryDir, '2020-01-03T00-00-00'))).toBe(true);
    });

    it('keeps all directories when at or under limit', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      for (const name of ['2020-01-01T00-00-00', '2020-01-02T00-00-00']) {
        mkdirSync(path.join(temporaryDir, name));
      }

      enforceRetentionLimit(temporaryDir, 2);

      expect(existsSync(path.join(temporaryDir, '2020-01-01T00-00-00'))).toBe(true);
      expect(existsSync(path.join(temporaryDir, '2020-01-02T00-00-00'))).toBe(true);
    });

    it('ignores files, only counts directories', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      writeFileSync(path.join(temporaryDir, 'stray-file.txt'), 'data');
      mkdirSync(path.join(temporaryDir, '2020-01-01T00-00-00'));

      enforceRetentionLimit(temporaryDir, 1);

      expect(existsSync(path.join(temporaryDir, '2020-01-01T00-00-00'))).toBe(true);
      expect(existsSync(path.join(temporaryDir, 'stray-file.txt'))).toBe(true);
    });

    it('handles nonexistent base directory gracefully', () => {
      expect(() => {
        enforceRetentionLimit('/nonexistent/path', 10);
      }).not.toThrow();
    });
  });
});
