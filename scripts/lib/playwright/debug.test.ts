import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import {
  DAY_MS,
  freezeClock,
  HOUR_MS,
  isoAt,
  setClock,
  TEST_DAY_END,
  TEST_DAY_START,
} from '@hushbox/shared/test-time';
import { formatGateReport, isBlocked, scanBlobs } from '../../privacy-gate.js';
import { summarizeSamples } from '../../resource-sampler.js';
import { ramRootRequiredBytes } from '../stack/ram-root.js';
import { computeProjectGrepInvert } from './browser-matrix.js';
import { ALL_PROJECT_NAMES, BROWSER_MATRIX_PROJECTS } from './projects.js';
import {
  categorizeTests,
  extractArtifactPaths,
  generateDebugReport,
  generateJsonReport,
  mergeHarFiles,
  extractTraceArchive,
  writePerTestArtifacts,
  serializeTestForJson,
  writeReport,
  enforceRetentionLimit,
  type DebugReport,
  type FailedTest,
  type FailedTestArtifacts,
  type FlakyTest,
  type FlattenedTestResult,
  type JsonReport,
  type JsonTestEntry,
  type PlaywrightAttachment,
  type PlaywrightReport,
  type PlaywrightSpec,
  type PlaywrightStep,
  type PlaywrightTest,
  type PlaywrightTestResult,
} from './debug.js';
import {
  buildRerunCommand,
  formatDuration,
  generateMarkdownReport,
  renderGlobalErrors,
  renderIsolateStallSection,
  renderResourceSection,
  renderSteps,
  slugify,
  stripAnsi,
} from './debug-render.js';
import type { GateFindings } from '../../privacy-gate.js';
import type { ResourceReport, ResourceSample } from '../../resource-sampler.js';
import type { TextBlobEntry } from '../privacy/rules.js';
import type { IsolateStall } from './stall-windows.js';

function makeTraceZip(workDir: string, zipName: string, files: Record<string, string>): string {
  const zipPath = path.join(workDir, zipName);
  const zip = new AdmZip();
  for (const [relativePath, contents] of Object.entries(files)) {
    zip.addFile(relativePath, Buffer.from(contents));
  }
  zip.writeZip(zipPath);
  return zipPath;
}

/**
 * Drop keys from a fixture to mirror report JSON whose optional fields are
 * absent. The reader casts that JSON without validating, so values missing
 * fields the types declare required are real runtime inputs.
 */
function withoutKeys<T extends object>(value: T, keys: readonly string[]): T {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as T;
}

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

    it('formats sub-minute durations with tenths of a second', () => {
      expect(formatDuration(5500)).toBe('5.5s');
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
        project: 'chromium',
      });
      expect(result).toBe(
        String.raw`pnpm e2e -- e2e/chat/chat.spec.ts -g "handles \"edge\" case" --project=chromium`
      );
    });

    it('appends the carrier project the matrix invariant demands of the run', () => {
      const result = buildRerunCommand({
        title: 'displays UI',
        file: 'e2e/chat/chat.spec.ts',
        project: 'webkit',
      });
      expect(result).toBe(
        'pnpm e2e -- e2e/chat/chat.spec.ts -g "displays UI" --project=webkit --project=chromium'
      );
    });

    it('builds a command the matrix accepts for every project the registry defines', () => {
      for (const project of ALL_PROJECT_NAMES) {
        const command = buildRerunCommand({
          title: 'displays UI',
          file: 'e2e/chat/chat.spec.ts',
          project,
        });
        const run = [...command.matchAll(/--project=(\S+)/g)].map((match) => match[1] ?? '');
        // What `playwright.config.ts` does with the run it read off argv: the
        // {@link computeProjectGrepInvert} call its testProject builder makes for
        // every matrix project, which is where the refusal fires.
        expect(() => {
          for (const name of BROWSER_MATRIX_PROJECTS) computeProjectGrepInvert(name, run);
        }, `${project}: ${command}`).not.toThrow();
      }
    });

    /** The `-g` argument as the printed command's double quotes hand it to the runner. */
    function grepPatternFrom(command: string): string {
      const quoted = /-g "(.*)" --project/.exec(command)?.[1] ?? '';
      return quoted.replaceAll(/\\([$`"\\])/g, '$1');
    }

    /** What the runner selects with: the `-g` argument compiled the way `forceRegExp` compiles it. */
    function selectionOf(command: string, title: string): string | undefined {
      return new RegExp(grepPatternFrom(command), 'gi').exec(title)?.[0];
    }

    /**
     * Titles the suite holds today whose characters the regex grammar acts on. Each
     * carries a quantifier that a `-g` argument would apply to the character before
     * it, so the unescaped command is accepted and selects nothing.
     */
    const TITLES_CARRYING_GRAMMAR = [
      'a Smart Model send persists two llm_completions rows (classifier + inference)',
      'single mode: clicking a row commits + closes the modal immediately',
      'write+ member can fork, tabs visible to both users',
    ];

    it('selects the title it names when the title carries regex grammar', () => {
      for (const title of TITLES_CARRYING_GRAMMAR) {
        const command = buildRerunCommand({
          title,
          file: 'e2e/chat/chat.spec.ts',
          project: 'chromium',
        });
        expect(selectionOf(command, title), command).toBe(title);
      }
    });

    it('selects only the title it names when the title carries a wildcard', () => {
      const title = 'classifier picks claude-opus-4.6 → response nametag shows Opus';
      const command = buildRerunCommand({
        title,
        file: 'e2e/chat/smart-model.spec.ts',
        project: 'chromium',
      });

      expect(selectionOf(command, title), command).toBe(title);
      expect(selectionOf(command, title.replace('4.6', '4x6')), command).toBeUndefined();
    });

    it('selects a title whose characters are grammar only in company', () => {
      const title = 'retries {3} times';
      const command = buildRerunCommand({
        title,
        file: 'e2e/chat/chat.spec.ts',
        project: 'chromium',
      });
      expect(selectionOf(command, title), command).toBe(title);
    });

    it('selects a title whose characters spell a pattern that will not compile', () => {
      const title = 'retries {2,1} times';
      const command = buildRerunCommand({
        title,
        file: 'e2e/chat/chat.spec.ts',
        project: 'chromium',
      });
      expect(selectionOf(command, title), command).toBe(title);
    });

    it('leaves the shell nothing to expand in the printed command', () => {
      const title = 'reads `whoami` from the $HOME banner';
      const command = buildRerunCommand({
        title,
        file: 'e2e/chat/chat.spec.ts',
        project: 'chromium',
      });
      const quoted = /-g "(.*)" --project/.exec(command)?.[1] ?? '';

      expect(quoted, command).not.toMatch(/(?<!\\)[$`]/);
      expect(selectionOf(command, title), command).toBe(title);
    });

    it('never prints a pattern the runner would read as a regex literal', () => {
      const title = '/chat/';
      const command = buildRerunCommand({
        title,
        file: 'e2e/chat/chat.spec.ts',
        project: 'chromium',
      });

      expect(grepPatternFrom(command), command).not.toMatch(/^\/.*\/[gi]*$/);
    });
  });

  describe('categorizeTests', () => {
    const createTestResult = (
      overrides: Partial<FlattenedTestResult> = {}
    ): FlattenedTestResult => ({
      title: 'test title',
      file: 'path/to/test.spec.ts',
      projectName: 'chromium',
      testStatus: 'expected',
      expectedStatus: 'passed',
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

    it('defaults attempts, error, and steps for flaky tests missing optional fields', () => {
      // Report JSON is cast, not validated, at the read boundary — these
      // fields really can be absent at runtime despite the required types.
      const tests = [
        withoutKeys(createTestResult({ testStatus: 'flaky', status: 'failed', retry: 1 }), [
          'attempts',
          'errors',
          'steps',
          'attachments',
        ]),
      ];

      const result = categorizeTests(tests);

      expect(result.flaky).toHaveLength(1);
      expect(result.flaky[0]?.attempts).toBe(2);
      expect(result.flaky[0]?.error).toBe('');
      expect(result.flaky[0]?.steps).toEqual([]);
    });

    it('defaults error and steps for failed tests missing optional fields', () => {
      const tests = [
        withoutKeys(createTestResult({ testStatus: 'unexpected', status: 'failed' }), [
          'errors',
          'steps',
          'attachments',
        ]),
      ];

      const result = categorizeTests(tests);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.error).toBe('');
      expect(result.failed[0]?.steps).toEqual([]);
    });

    it('categorizes flaky tests (testStatus flaky, data from failing attempt)', () => {
      // Collector surfaces the failing attempt's data but tags testStatus='flaky'
      // and records the total attempt count on the flattened result.
      const tests = [
        createTestResult({
          testStatus: 'flaky',
          status: 'failed',
          retry: 0,
          attempts: 2,
          errors: [{ message: 'race' }],
          duration: 1500,
        }),
      ];

      const result = categorizeTests(tests);

      expect(result.passed).toHaveLength(0);
      expect(result.flaky).toHaveLength(1);
      expect(result.flaky[0]?.attempts).toBe(2);
      expect(result.flaky[0]?.error).toBe('race');
      expect(result.flaky[0]?.duration).toBe(1500);
      expect(result.failed).toHaveLength(0);
    });

    it('flaky tests carry full artifacts (trace, screenshot, console errors, har)', () => {
      const tests = [
        createTestResult({
          testStatus: 'flaky',
          status: 'failed',
          retry: 1,
          attempts: 3,
          line: 42,
          errors: [{ message: 'Timeout' }],
          steps: [{ title: 'click send', duration: 100 }],
          attachments: [
            { name: 'trace', path: 'trace.zip' },
            { name: 'screenshot', path: 'shot.png' },
            { name: 'video', path: 'video.webm' },
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

      expect(result.flaky).toHaveLength(1);
      const flake = result.flaky[0];
      expect(flake?.line).toBe(42);
      expect(flake?.steps).toEqual([{ title: 'click send', duration: 100 }]);
      expect(flake?.artifacts.trace).toBe('trace.zip');
      expect(flake?.artifacts.screenshot).toBe('shot.png');
      expect(flake?.artifacts.video).toBe('video.webm');
      expect(flake?.artifacts.consoleErrors).toBe('TypeError: x');
      expect(flake?.artifacts.harFiles).toEqual(['network.har']);
    });

    it('categorizes failed tests', () => {
      const tests = [createTestResult({ testStatus: 'unexpected', status: 'failed', retry: 2 })];

      const result = categorizeTests(tests);

      expect(result.passed).toHaveLength(0);
      expect(result.flaky).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
    });

    it('categorizes timed out tests as failed', () => {
      const tests = [createTestResult({ testStatus: 'unexpected', status: 'timedOut' })];

      const result = categorizeTests(tests);

      expect(result.failed).toHaveLength(1);
    });

    it('categorizes an unexpected outcome as failed even when its chosen attempt passed', () => {
      const tests = [
        createTestResult({ testStatus: 'unexpected', expectedStatus: 'failed', status: 'passed' }),
      ];

      const result = categorizeTests(tests);

      expect(result.failed).toHaveLength(1);
      expect(result.passed).toHaveLength(0);
    });

    it('lists a test that failed as its declaration expected under passed, in no other list', () => {
      const tests = [
        createTestResult({ testStatus: 'expected', expectedStatus: 'failed', status: 'failed' }),
      ];

      const result = categorizeTests(tests);

      expect(result.passed).toHaveLength(1);
      expect(result.failed).toHaveLength(0);
      expect(result.flaky).toHaveLength(0);
      expect(result.didNotRun).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
    });

    it('categorizes interrupted tests as failed', () => {
      const tests = [createTestResult({ testStatus: 'unexpected', status: 'interrupted' })];

      const result = categorizeTests(tests);

      expect(result.failed).toHaveLength(1);
    });

    it('a passed retry Playwright reports as expected is not flaky', () => {
      const tests = [
        createTestResult({ testStatus: 'expected', status: 'passed', retry: 1, attempts: 2 }),
      ];

      const result = categorizeTests(tests);

      expect(result.flaky).toHaveLength(0);
      expect(result.passed).toHaveLength(1);
    });

    it('lists a declared skip under skipped, in no other list', () => {
      const tests = [
        createTestResult({ testStatus: 'skipped', expectedStatus: 'skipped', status: 'skipped' }),
      ];

      const result = categorizeTests(tests);

      expect(result.skipped).toHaveLength(1);
      expect(result.didNotRun).toHaveLength(0);
      expect(result.passed).toHaveLength(0);
      expect(result.flaky).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });

    it('handles multiple tests of different statuses', () => {
      const tests = [
        createTestResult({ title: 'passed test', status: 'passed', retry: 0 }),
        createTestResult({
          title: 'flaky test',
          testStatus: 'flaky',
          status: 'failed',
          retry: 1,
          attempts: 3,
          errors: [{ message: 'boom' }],
        }),
        createTestResult({ title: 'failed test', testStatus: 'unexpected', status: 'failed' }),
        createTestResult({ title: 'skipped test', testStatus: 'skipped', status: 'skipped' }),
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
          testStatus: 'unexpected',
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
          testStatus: 'unexpected',
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
        testStatus: 'unexpected',
        expectedStatus: 'passed',
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
        testStatus: 'unexpected',
        expectedStatus: 'passed',
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
        testStatus: 'unexpected',
        expectedStatus: 'passed',
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
        testStatus: 'unexpected',
        expectedStatus: 'passed',
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
        testStatus: 'unexpected',
        expectedStatus: 'passed',
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
      expect(result.apiErrors).toBeUndefined();
      expect(result.pageSnapshot).toBeUndefined();
      expect(result.harFiles).toEqual([]);
    });

    it('extracts labeled console-errors body from attachments', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        testStatus: 'unexpected',
        expectedStatus: 'passed',
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

    it('extracts labeled api-errors body from attachments', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        testStatus: 'unexpected',
        expectedStatus: 'passed',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [
          {
            name: 'api-errors-authenticatedPage',
            body: `${isoAt(TEST_DAY_START)} 500 Internal Server Error POST /api/chat/abc/stream\n  body: {"code":"BILLING_ERROR"}`,
            contentType: 'text/plain',
          },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.apiErrors).toBe(
        `${isoAt(TEST_DAY_START)} 500 Internal Server Error POST /api/chat/abc/stream\n  body: {"code":"BILLING_ERROR"}`
      );
    });

    it('concatenates multiple labeled api-errors bodies with headers', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        testStatus: 'unexpected',
        expectedStatus: 'passed',
        status: 'failed',
        retry: 0,
        duration: 1000,
        errors: [],
        steps: [],
        attachments: [
          {
            name: 'api-errors-unauthenticatedPage-1',
            body: '500 GET /api/conversations/xyz',
            contentType: 'text/plain',
          },
          {
            name: 'api-errors-authenticatedPage',
            body: '404 POST /api/links/abc',
            contentType: 'text/plain',
          },
        ],
      };

      const result = extractArtifactPaths(test);

      expect(result.apiErrors).toContain('--- unauthenticatedPage-1 ---');
      expect(result.apiErrors).toContain('--- authenticatedPage ---');
      expect(result.apiErrors).toContain('500 GET /api/conversations/xyz');
      expect(result.apiErrors).toContain('404 POST /api/links/abc');
    });

    it('concatenates multiple labeled page-snapshot bodies with headers', () => {
      const test: FlattenedTestResult = {
        title: 'test',
        file: 'test.spec.ts',
        projectName: 'chromium',
        testStatus: 'unexpected',
        expectedStatus: 'passed',
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
        testStatus: 'unexpected',
        expectedStatus: 'passed',
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
        testStatus: 'unexpected',
        expectedStatus: 'passed',
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
      projects: [],
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

    const createSpec = (
      title: string,
      file: string,
      tests: PlaywrightTest[] = []
    ): PlaywrightSpec => ({
      title,
      file,
      tests,
    });

    const createTest = (
      projectName: string,
      results: PlaywrightTestResult[],
      status: PlaywrightTest['status'] = 'expected'
    ): PlaywrightTest => ({
      projectName,
      status,
      expectedStatus: 'passed',
      results,
    });

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
            createTest('chromium', [createResult({ status: 'failed' })], 'unexpected'),
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.summary.total).toBe(2);
      expect(result.summary.passed).toBe(1);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.duration).toBe(5000);
    });

    it('defaults missing errors, steps, and attachments on a result to empty lists', () => {
      const report = createReport([
        createSuite([
          createSpec('sparse result', 'test.spec.ts', [
            createTest(
              'chromium',
              [withoutKeys(createResult({ status: 'failed' }), ['errors', 'steps', 'attachments'])],
              'unexpected'
            ),
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.error).toBe('');
      expect(result.failed[0]?.steps).toEqual([]);
    });

    it('a serial block-mate re-run after a sibling failure is passed, not flaky', () => {
      const report = createReport([
        createSuite([
          createSpec('serial block-mate', 'test.spec.ts', [
            {
              projectName: 'chromium',
              status: 'expected',
              expectedStatus: 'passed',
              results: [
                createResult({ status: 'passed', retry: 0 }),
                createResult({ status: 'passed', retry: 1 }),
              ],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.passed).toHaveLength(1);
      expect(result.flaky).toHaveLength(0);
      expect(result.summary.flaky).toBe(0);
    });

    it('skips tests that recorded no results at all', () => {
      const report = createReport([
        createSuite([
          createSpec('never ran', 'test.spec.ts', [
            { projectName: 'chromium', status: 'expected', expectedStatus: 'passed', results: [] },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.summary.total).toBe(0);
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

    it('flaky tests surface the last failing attempt artifacts', () => {
      const report = createReport([
        createSuite([
          createSpec('flaky test', 'e2e/chat.spec.ts', [
            {
              projectName: 'firefox',
              status: 'flaky',
              expectedStatus: 'passed',
              results: [
                createResult({
                  status: 'failed',
                  retry: 0,
                  duration: 2000,
                  errors: [{ message: 'race condition' }],
                  steps: [{ title: 'step1', duration: 100 }],
                  attachments: [
                    { name: 'trace', path: 'failing-trace.zip' },
                    { name: 'screenshot', path: 'failing-shot.png' },
                    {
                      name: 'console-errors-authenticatedPage',
                      body: 'TypeError: bang',
                      contentType: 'text/plain',
                    },
                  ],
                }),
                createResult({
                  status: 'passed',
                  retry: 1,
                  duration: 3000,
                  attachments: [{ name: 'trace', path: 'passing-trace.zip' }],
                }),
              ],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.flaky).toHaveLength(1);
      expect(result.flaky[0]).toMatchObject({
        title: 'flaky test',
        file: 'e2e/chat.spec.ts',
        project: 'firefox',
        attempts: 2,
        error: 'race condition',
        duration: 2000,
        steps: [{ title: 'step1', duration: 100 }],
        artifacts: {
          trace: 'failing-trace.zip',
          screenshot: 'failing-shot.png',
          consoleErrors: 'TypeError: bang',
        },
      });
    });

    it('failed tests surface the attempt that recorded a trace', () => {
      const report = createReport([
        createSuite([
          createSpec('broken test', 'e2e/chat.spec.ts', [
            {
              projectName: 'chromium',
              status: 'unexpected',
              expectedStatus: 'passed',
              results: [
                createResult({
                  status: 'failed',
                  retry: 0,
                  duration: 2000,
                  errors: [{ message: 'first failure' }],
                  steps: [{ title: 'first attempt step', duration: 100 }],
                  attachments: [
                    { name: 'trace', path: 'first-attempt-trace.zip' },
                    { name: 'screenshot', path: 'first-attempt-shot.png' },
                  ],
                }),
                createResult({
                  status: 'failed',
                  retry: 1,
                  duration: 3000,
                  errors: [{ message: 'retry failure' }],
                  steps: [{ title: 'retry step', duration: 200 }],
                  attachments: [{ name: 'screenshot', path: 'retry-shot.png' }],
                }),
              ],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({
        error: 'first failure',
        duration: 2000,
        steps: [{ title: 'first attempt step', duration: 100 }],
        artifacts: {
          trace: 'first-attempt-trace.zip',
          screenshot: 'first-attempt-shot.png',
        },
      });
    });

    it('failed tests with no trace on any attempt use the final attempt', () => {
      const report = createReport([
        createSuite([
          createSpec('broken test', 'e2e/chat.spec.ts', [
            {
              projectName: 'chromium',
              status: 'unexpected',
              expectedStatus: 'passed',
              results: [
                createResult({
                  status: 'failed',
                  retry: 0,
                  duration: 2000,
                  errors: [{ message: 'first failure' }],
                  attachments: [{ name: 'screenshot', path: 'first-attempt-shot.png' }],
                }),
                createResult({
                  status: 'failed',
                  retry: 1,
                  duration: 3000,
                  errors: [{ message: 'retry failure' }],
                  attachments: [{ name: 'screenshot', path: 'retry-shot.png' }],
                }),
              ],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({
        error: 'retry failure',
        duration: 3000,
        artifacts: {
          trace: undefined,
          screenshot: 'retry-shot.png',
        },
      });
    });

    it('includes failed test details with error and artifacts', () => {
      const report = createReport([
        createSuite([
          createSpec('broken test', 'e2e/billing.spec.ts', [
            createTest(
              'webkit',
              [
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
              ],
              'unexpected'
            ),
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toEqual({
        title: 'broken test',
        file: 'e2e/billing.spec.ts',
        project: 'webkit',
        attempts: 1,
        attemptStatus: 'failed',
        attemptRetry: 1,
        error: 'Timeout',
        duration: 2000,
        steps: [{ title: 'Click button', duration: 100 }],
        artifacts: {
          trace: 'test-results/broken-webkit/trace.zip',
          screenshot: 'test-results/broken-webkit/screenshot.png',
          video: undefined,
          consoleErrors: undefined,
          apiErrors: undefined,
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
                        expectedStatus: 'passed',
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
        projects: [],
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
        projects: [],
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
        projects: [],
        stats: { duration: 100 },
      };

      const result = generateDebugReport(report);

      expect(result.summary.total).toBe(0);
      expect(result.passed).toHaveLength(0);
    });

    it('carries the chosen attempt status and retry onto the failed entry', () => {
      const report = createReport([
        createSuite([
          createSpec('broken test', 'e2e/chat.spec.ts', [
            {
              projectName: 'chromium',
              status: 'unexpected',
              expectedStatus: 'passed',
              results: [
                createResult({ status: 'failed', retry: 0, duration: 1000 }),
                createResult({ status: 'timedOut', retry: 1, duration: 2000 }),
              ],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.failed[0]).toMatchObject({ attemptStatus: 'timedOut', attemptRetry: 1 });
    });

    it('carries the chosen attempt status and retry onto the flaky entry', () => {
      const report = createReport([
        createSuite([
          createSpec('flaky test', 'e2e/chat.spec.ts', [
            {
              projectName: 'chromium',
              status: 'flaky',
              expectedStatus: 'passed',
              results: [
                createResult({ status: 'failed', retry: 0, duration: 1000 }),
                createResult({ status: 'passed', retry: 1, duration: 2000 }),
              ],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.flaky[0]).toMatchObject({ attemptStatus: 'failed', attemptRetry: 0 });
    });

    it('lists a test that failed and was then skipped on a serial re-run as failed', () => {
      const report = createReport([
        createSuite([
          createSpec('regenerates a reply', 'e2e/chat/regeneration.spec.ts', [
            {
              projectName: 'chromium',
              status: 'unexpected',
              expectedStatus: 'passed',
              results: [
                createResult({
                  status: 'failed',
                  retry: 0,
                  errors: [{ message: 'attempt 0 failure' }],
                  attachments: [{ name: 'trace', path: 'attempt-0-trace.zip' }],
                }),
                createResult({ status: 'skipped', retry: 1, duration: 0 }),
              ],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({
        title: 'regenerates a reply',
        attemptRetry: 0,
        error: 'attempt 0 failure',
        artifacts: { trace: 'attempt-0-trace.zip' },
      });
    });

    it('carries the attempt count onto the failed entry', () => {
      const report = createReport([
        createSuite([
          createSpec('broken test', 'e2e/chat.spec.ts', [
            {
              projectName: 'chromium',
              status: 'unexpected',
              expectedStatus: 'passed',
              results: [
                createResult({ status: 'failed', retry: 0 }),
                createResult({ status: 'failed', retry: 1 }),
                createResult({ status: 'skipped', retry: 2, duration: 0 }),
              ],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.failed[0]?.attempts).toBe(3);
    });

    it('carries the attempt count onto the failed entry of the json report', () => {
      const report = createReport([
        createSuite([
          createSpec('regenerates a reply', 'e2e/chat/regeneration.spec.ts', [
            {
              projectName: 'chromium',
              status: 'unexpected',
              expectedStatus: 'passed',
              results: [
                createResult({ status: 'failed', retry: 0 }),
                createResult({ status: 'skipped', retry: 1, duration: 0 }),
              ],
            },
          ]),
        ]),
      ]);

      const json = generateJsonReport(generateDebugReport(report));

      expect(json.failed[0]?.attempts).toBe(2);
    });

    it('builds an untraced failed entry from its latest attempt that ran, not a later skip', () => {
      const report = createReport([
        createSuite([
          createSpec('regenerates a reply', 'e2e/chat/regeneration.spec.ts', [
            {
              projectName: 'chromium',
              status: 'unexpected',
              expectedStatus: 'passed',
              results: [
                createResult({ status: 'failed', retry: 0, errors: [{ message: 'first' }] }),
                createResult({ status: 'timedOut', retry: 1, errors: [{ message: 'second' }] }),
                createResult({ status: 'skipped', retry: 2, duration: 0 }),
              ],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({
        attemptStatus: 'timedOut',
        attemptRetry: 1,
        error: 'second',
      });
    });

    it('never builds a failed entry from a skipped attempt, even one carrying a trace', () => {
      const report = createReport([
        createSuite([
          createSpec('regenerates a reply', 'e2e/chat/regeneration.spec.ts', [
            {
              projectName: 'chromium',
              status: 'unexpected',
              expectedStatus: 'passed',
              results: [
                createResult({ status: 'failed', retry: 0, errors: [{ message: 'ran' }] }),
                createResult({
                  status: 'skipped',
                  retry: 1,
                  duration: 0,
                  attachments: [{ name: 'trace', path: 'skipped-attempt-trace.zip' }],
                }),
              ],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.failed[0]).toMatchObject({ attemptRetry: 0, error: 'ran' });
    });

    it('lists a test that passed and was then skipped on a serial re-run as passed', () => {
      const report = createReport([
        createSuite([
          createSpec('opens the chat', 'e2e/chat/regeneration.spec.ts', [
            {
              projectName: 'chromium',
              status: 'expected',
              expectedStatus: 'passed',
              results: [
                createResult({ status: 'passed', retry: 0 }),
                createResult({ status: 'skipped', retry: 1, duration: 0 }),
              ],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.passed).toEqual([
        {
          title: 'opens the chat',
          file: 'e2e/chat/regeneration.spec.ts',
          project: 'chromium',
          duration: 1000,
        },
      ]);
    });

    it('lists a test that never ran, with no skip declared, under didNotRun', () => {
      const report = createReport([
        createSuite([
          {
            title: 'regenerates twice',
            file: 'e2e/chat/regeneration.spec.ts',
            line: 130,
            tests: [
              {
                projectName: 'chromium',
                status: 'skipped',
                expectedStatus: 'passed',
                results: [
                  createResult({ status: 'skipped', retry: 0, duration: 0 }),
                  createResult({ status: 'skipped', retry: 1, duration: 0 }),
                ],
              },
            ],
          },
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.didNotRun).toEqual([
        {
          title: 'regenerates twice',
          file: 'e2e/chat/regeneration.spec.ts',
          line: 130,
          project: 'chromium',
        },
      ]);
    });

    it('lists every test with a result in exactly one report list', () => {
      // Generator: every outcome, crossed with every declared status, crossed with every
      // attempt sequence of zero, one or two results over the five result statuses.
      const outcomes: PlaywrightTest['status'][] = ['expected', 'unexpected', 'flaky', 'skipped'];
      const statuses: PlaywrightTestResult['status'][] = [
        'passed',
        'failed',
        'timedOut',
        'skipped',
        'interrupted',
      ];
      const sequences: PlaywrightTestResult['status'][][] = [
        [],
        ...statuses.map((only) => [only]),
        ...statuses.flatMap((first) => statuses.map((second) => [first, second])),
      ];
      const specs: PlaywrightSpec[] = [];
      const titlesWithResults: string[] = [];
      for (const status of outcomes) {
        for (const expectedStatus of statuses) {
          for (const sequence of sequences) {
            const title = `${status} expecting ${expectedStatus} [${sequence.join(', ')}]`;
            const results = sequence.map((attempt, retry) =>
              createResult({ status: attempt, retry })
            );
            specs.push(
              createSpec(title, 'e2e/grid.spec.ts', [
                { projectName: 'chromium', status, expectedStatus, results },
              ])
            );
            if (results.length > 0) titlesWithResults.push(title);
          }
        }
      }

      const result = generateDebugReport(createReport([createSuite(specs)]));

      const listed = [
        ...result.failed,
        ...result.flaky,
        ...result.passed,
        ...result.didNotRun,
        ...result.skipped,
      ].map((test) => test.title);
      const byTitle = (a: string, b: string): number => a.localeCompare(b);
      expect(listed.toSorted(byTitle)).toEqual(titlesWithResults.toSorted(byTitle));
      expect(listed).toHaveLength(result.coverage?.executedTests ?? Number.NaN);
      expect(result.coverage?.unlistedTests).toBe(0);
    });

    it('raises a run-level error when a test with a result is in no list', () => {
      // An outcome outside the declared union is what a Playwright release adding an
      // outcome would hand the report at runtime; the cast stands in for that value.
      const unknownOutcome = 'retried' as string as PlaywrightTest['status'];
      const report = createReport([
        createSuite([
          createSpec('regenerates a reply', 'e2e/chat/regeneration.spec.ts', [
            {
              projectName: 'chromium',
              status: unknownOutcome,
              expectedStatus: 'passed',
              results: [createResult({ status: 'failed' })],
            },
          ]),
        ]),
      ]);

      const result = generateDebugReport(report);

      expect(result.coverage).toMatchObject({ executedTests: 1, unlistedTests: 1 });
      expect(result.globalErrors).toEqual([
        'Unlisted results: the tests in the report that produced results (1) include 1 that no report list holds. ' +
          'Each such test belongs in exactly one of failed, flaky, did not run, skipped or passed, so its ' +
          'outcome is unaccounted for, not passed.',
      ]);
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
        didNotRun: [],
        skipped: [],
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

    it('lists each passed test with its duration', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 1, flaky: 0, failed: 0, duration: 2500 },
        didNotRun: [],
        skipped: [],
        passed: [
          { title: 'test one', file: 'e2e/chat/chat.spec.ts', project: 'chromium', duration: 2500 },
        ],
        flaky: [],
        failed: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('- test one [`e2e/chat/chat.spec.ts`] [chromium] (2.5s)');
    });

    it('lists each test that did not run under its own section, with its location', () => {
      const report: DebugReport = {
        summary: { total: 0, passed: 0, flaky: 0, failed: 0, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [],
        didNotRun: [
          {
            title: 'regenerates twice',
            file: 'e2e/chat/regeneration.spec.ts',
            line: 130,
            project: 'firefox',
          },
        ],
        skipped: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('## Did Not Run (1)');
      expect(md).toContain('- regenerates twice [`e2e/chat/regeneration.spec.ts:130`] [firefox]');
    });

    it('names only the file of a test that did not run when its line is unknown', () => {
      const report: DebugReport = {
        summary: { total: 0, passed: 0, flaky: 0, failed: 0, duration: 1000 },
        passed: [],
        flaky: [],
        failed: [],
        didNotRun: [
          { title: 'regenerates twice', file: 'e2e/chat/regeneration.spec.ts', project: 'firefox' },
        ],
        skipped: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('- regenerates twice [`e2e/chat/regeneration.spec.ts`] [firefox]');
    });

    it('shows FAILED result with failed test details', () => {
      const report: DebugReport = {
        summary: { total: 2, passed: 1, flaky: 0, failed: 1, duration: 10_000 },
        didNotRun: [],
        skipped: [],
        passed: [
          { title: 'test one', file: 'e2e/chat/chat.spec.ts', project: 'chromium', duration: 1000 },
        ],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/billing/billing.spec.ts',
            project: 'webkit',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'Timeout waiting for selector',
            duration: 10_000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: '/abs/path/screenshot.png',
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
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

    it('names a single attempt in the singular', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/billing/billing.spec.ts',
            project: 'webkit',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'Timeout waiting for selector',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md.split('\n')).toContain('#### broken test [webkit] (1 attempt)');
    });

    it('includes the line number in the location when known', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/billing/billing.spec.ts',
            line: 42,
            project: 'webkit',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'boom',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('e2e/billing/billing.spec.ts:42');
    });

    it('points at the page snapshot artifact when one was captured', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/billing/billing.spec.ts',
            project: 'webkit',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'boom',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: '- document:\n  - main: content',
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('page-snapshot.txt');
    });

    it('groups failed tests by file', () => {
      const report: DebugReport = {
        summary: { total: 3, passed: 0, flaky: 0, failed: 3, duration: 5000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test A',
            file: 'e2e/chat/chat.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'error A',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
          {
            title: 'test B',
            file: 'e2e/chat/chat.spec.ts',
            project: 'firefox',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'error B',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
          {
            title: 'test C',
            file: 'e2e/billing/billing.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'error C',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      const chatHeadingCount = (md.match(/### `e2e\/chat\/chat\.spec\.ts`/g) ?? []).length;
      expect(chatHeadingCount).toBe(1);
      expect(md).toContain('#### test A [chromium]');
      expect(md).toContain('#### test B [firefox]');
      expect(md).toContain('### `e2e/billing/billing.spec.ts`');
    });

    it('renders flaky tests with full failure details and flaky/ artifact paths', () => {
      const report: DebugReport = {
        summary: { total: 2, passed: 1, flaky: 1, failed: 0, duration: 5000 },
        didNotRun: [],
        skipped: [],
        passed: [
          { title: 'stable', file: 'e2e/chat/chat.spec.ts', project: 'chromium', duration: 1000 },
        ],
        flaky: [
          {
            title: 'flaky test',
            file: 'e2e/chat/chat.spec.ts',
            project: 'firefox',
            attemptStatus: 'failed',
            attemptRetry: 0,
            attempts: 3,
            error: 'race condition',
            duration: 2000,
            steps: [{ title: 'click', duration: 100 }],
            artifacts: {
              trace: 'trace.zip',
              screenshot: 'shot.png',
              video: undefined,
              consoleErrors: 'TypeError',
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
        failed: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('## Flaky Tests');
      expect(md).toContain('flaky test');
      expect(md).toContain('race condition');
      // Per-test artifact links point at flaky/, not failed/.
      expect(md).toContain('flaky/e2e-chat-chat-spec-ts-firefox-flaky-test');
      expect(md).not.toContain('failed/e2e-chat-chat-spec-ts-firefox-flaky-test');
    });

    it('renders API Errors line when apiErrors present', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'test error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: '500 POST /api/chat/abc/stream',
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**API Errors:** See `failed/');
      expect(md).toContain('/api-errors.txt`');
    });

    it('omits API Errors line when apiErrors absent', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'test error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: 'TypeError',
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).not.toContain('**API Errors:**');
    });

    it('renders API Errors line under flaky/ for flaky tests', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 1, failed: 0, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [
          {
            title: 'flaky test',
            file: 'e2e/chat/chat.spec.ts',
            project: 'firefox',
            attemptStatus: 'failed',
            attemptRetry: 0,
            attempts: 2,
            error: 'race',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: '429 POST /api/chat/xyz/stream',
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
        failed: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**API Errors:** See `flaky/');
      expect(md).toContain('/api-errors.txt`');
    });

    it('strips ANSI codes from error messages', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: '\u001B[31mError\u001B[0m: failed',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
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
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: longError,
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
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
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: '/some/path/screenshot.png',
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
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
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
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
        didNotRun: [],
        skipped: [],
        passed: [{ title: 'test', file: 'e2e/test.spec.ts', project: 'chromium', duration: 1000 }],
        flaky: [],
        failed: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain('**Duration:** 2m 34s');
    });

    it('dates the report to the day, carrying no time of day', () => {
      freezeClock(TEST_DAY_END);
      const report: DebugReport = {
        summary: { total: 1, passed: 1, flaky: 0, failed: 0, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [{ title: 'test', file: 'e2e/test.spec.ts', project: 'chromium', duration: 1000 }],
        flaky: [],
        failed: [],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain(`**Date:** ${isoAt(TEST_DAY_END).slice(0, 10)}\n`);
    });

    it('names the chosen attempt in place of an empty error block', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'silent failure',
            file: 'e2e/chat/chat.spec.ts',
            project: 'chromium',
            attempts: 2,
            attemptStatus: 'timedOut',
            attemptRetry: 1,
            error: '',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain(
        'NO ERROR TEXT RECORDED. The chosen attempt (status timedOut, retry 1) carried none; this test did not pass.'
      );
    });

    it('never denies a passing status it just printed in the empty error block', () => {
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'evidence-free entry',
            file: 'e2e/chat/chat.spec.ts',
            project: 'chromium',
            attempts: 2,
            attemptStatus: 'passed',
            attemptRetry: 1,
            error: '',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report);

      expect(md).toContain(
        'NO ERROR TEXT RECORDED. The chosen attempt (status passed, retry 1) carried none.'
      );
      expect(md).not.toContain('this test did not pass');
    });

    it('renders the trace viewer command as a path relative to the repository root', () => {
      const repoRoot = path.join(path.sep, 'srv', 'checkout');
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/chat/chat.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'boom',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: path.join(repoRoot, 'test-results', 'broken-chromium', 'trace.zip'),
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report, repoRoot);

      expect(md).toContain(
        `npx playwright show-trace ${path.join('test-results', 'broken-chromium', 'trace.zip')}`
      );
    });

    it('renders no absolute path for a trace stored under the repository root', () => {
      const repoRoot = path.join(path.sep, 'home', 'someone', 'checkout');
      const tracePath = path.join(repoRoot, 'test-results', 'broken-chromium', 'trace.zip');
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/chat/chat.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'boom',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: tracePath,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report, repoRoot);

      expect(md).not.toContain(tracePath);
      expect(md).not.toContain(repoRoot);
    });

    it('offers only the extracted trace when the archive sits outside the repository root', () => {
      const repoRoot = path.join(path.sep, 'srv', 'checkout');
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/chat/chat.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'boom',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: path.join(path.sep, 'var', 'tmp', 'stray', 'trace.zip'),
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const md = generateMarkdownReport(report, repoRoot);

      expect(md).not.toContain('show-trace');
      expect(md).toContain('(extracted)');
    });
  });

  describe('renderGlobalErrors', () => {
    const reportWith = (globalErrors?: string[]): DebugReport => ({
      summary: { total: 0, passed: 0, flaky: 0, failed: 0, duration: 0 },
      didNotRun: [],
      skipped: [],
      passed: [],
      flaky: [],
      failed: [],
      ...(globalErrors && { globalErrors }),
    });

    it('returns no lines when there are no global errors', () => {
      expect(renderGlobalErrors(reportWith())).toEqual([]);
    });

    it('renders a section containing the error text', () => {
      const lines = renderGlobalErrors(reportWith(['Error: ENOTEMPTY: directory not empty']));

      expect(lines).toContain('## Global Errors');
      expect(lines).toContain('Error: ENOTEMPTY: directory not empty');
    });

    it('strips ANSI colour codes from the error text', () => {
      const esc = String.fromCodePoint(27);
      const lines = renderGlobalErrors(reportWith([`${esc}[31mboom${esc}[0m`]));

      expect(lines).toContain('boom');
    });
  });

  describe('run status and global errors', () => {
    const abortedReport = (): PlaywrightReport => ({
      suites: [],
      config: {},
      projects: [],
      stats: { duration: 66_000 },
      status: 'failed',
      errors: [
        "Error: ENOTEMPTY: directory not empty, rmdir 'test-results/chat-image-generation-firefox'",
      ],
    });

    it('generateDebugReport propagates run status and global errors', () => {
      const result = generateDebugReport(abortedReport());

      expect(result.status).toBe('failed');
      expect(result.globalErrors).toEqual([
        "Error: ENOTEMPTY: directory not empty, rmdir 'test-results/chat-image-generation-firefox'",
      ]);
      expect(result.summary.failed).toBe(0);
    });

    it('generateDebugReport omits status and globalErrors for a clean run', () => {
      const result = generateDebugReport({
        suites: [],
        config: {},
        projects: [],
        stats: { duration: 1000 },
      });

      expect(result.status).toBeUndefined();
      expect(result.globalErrors).toBeUndefined();
    });

    it('generateMarkdownReport shows FAILED when the run aborted with zero failed tests', () => {
      const md = generateMarkdownReport(generateDebugReport(abortedReport()));

      expect(md).toContain('**Result:** FAILED');
      expect(md).toContain('## Global Errors');
      expect(md).toContain('ENOTEMPTY');
    });

    it('generateMarkdownReport says the run ended early when a harness error is the only global error', () => {
      const md = generateMarkdownReport(generateDebugReport(abortedReport()));

      expect(md).toContain('The run did not complete normally.');
    });

    it('generateMarkdownReport stays PASSED and omits the section for a clean run', () => {
      const md = generateMarkdownReport(
        generateDebugReport({
          suites: [],
          config: {},
          projects: [],
          stats: { duration: 1000 },
          status: 'passed',
        })
      );

      expect(md).toContain('**Result:** PASSED');
      expect(md).not.toContain('## Global Errors');
    });

    it('generateMarkdownReport stays PASSED when the only test that did not pass failed as declared', () => {
      const result: PlaywrightTestResult = { status: 'passed', retry: 0, duration: 1000 };
      const md = generateMarkdownReport(
        generateDebugReport({
          suites: [
            {
              title: 'chromium',
              file: '',
              specs: [
                {
                  title: 'sends a message',
                  file: 'e2e/chat.spec.ts',
                  tests: [
                    {
                      projectName: 'chromium',
                      status: 'expected',
                      expectedStatus: 'passed',
                      results: [result],
                    },
                  ],
                },
                {
                  title: 'fails the way it declares',
                  file: 'e2e/fixtures.spec.ts',
                  tests: [
                    {
                      projectName: 'chromium',
                      status: 'expected',
                      expectedStatus: 'failed',
                      results: [{ ...result, status: 'failed' }],
                    },
                  ],
                },
              ],
              suites: [],
            },
          ],
          config: {},
          projects: [],
          stats: { duration: 1000 },
          status: 'passed',
        })
      );

      expect(md).toContain('**Result:** PASSED');
    });

    it('generateMarkdownReport shows FAILED on an interrupted run with no test failures', () => {
      const md = generateMarkdownReport(
        generateDebugReport({
          suites: [],
          config: {},
          projects: [],
          stats: { duration: 1000 },
          status: 'interrupted',
        })
      );

      expect(md).toContain('**Result:** FAILED');
    });

    it('generateJsonReport includes status and globalErrors when present', () => {
      const json = generateJsonReport(generateDebugReport(abortedReport()));

      expect(json.status).toBe('failed');
      expect(json.globalErrors).toHaveLength(1);
    });

    it('generateJsonReport omits status and globalErrors for a clean run', () => {
      const json = generateJsonReport(
        generateDebugReport({ suites: [], config: {}, projects: [], stats: { duration: 1000 } })
      );

      expect(json.status).toBeUndefined();
      expect(json.globalErrors).toBeUndefined();
    });
  });

  describe('project coverage', () => {
    const attempt = (status: PlaywrightTestResult['status']): PlaywrightTestResult => ({
      status,
      retry: 0,
      duration: 1000,
      errors: [],
      steps: [],
      attachments: [],
    });

    interface PlannedTest {
      readonly title: string;
      readonly results: PlaywrightTestResult[];
      readonly status?: PlaywrightTest['status'];
      readonly expectedStatus?: PlaywrightTest['expectedStatus'];
    }

    const projectSuite = (
      project: string,
      tests: readonly PlannedTest[]
    ): PlaywrightReport['suites'][number] => ({
      title: project,
      file: '',
      specs: tests.map((test) => ({
        title: test.title,
        file: `e2e/${project}.spec.ts`,
        tests: [
          {
            projectName: project,
            status: test.status ?? 'expected',
            expectedStatus: test.expectedStatus ?? 'passed',
            results: test.results,
          },
        ],
      })),
      suites: [],
    });

    /** The dependency graph a real run's config declares for the projects these tests name. */
    const REAL_RUN_PROJECTS: PlaywrightReport['projects'] = [
      { name: 'setup-chromium', dependencies: [] },
      { name: 'setup-firefox', dependencies: [] },
      { name: 'setup-webkit', dependencies: [] },
      { name: 'setup-admin', dependencies: [] },
      { name: 'admin', dependencies: ['setup-admin'] },
      { name: 'chromium', dependencies: ['setup-chromium'] },
      { name: 'firefox', dependencies: ['setup-firefox'] },
      { name: 'webkit', dependencies: ['setup-webkit'] },
    ];

    const runOf = (
      suites: PlaywrightReport['suites'],
      status?: PlaywrightReport['status'],
      projects: PlaywrightReport['projects'] = REAL_RUN_PROJECTS
    ): PlaywrightReport => ({
      suites,
      config: {},
      projects,
      stats: { duration: 5000 },
      ...(status !== undefined && { status }),
    });

    /** A setup project that failed, and the project the runner therefore removed. */
    const droppedByFailedSetup = (): PlaywrightReport =>
      runOf(
        [
          projectSuite('setup-chromium', [
            { title: 'authenticates alice', results: [attempt('failed')], status: 'unexpected' },
          ]),
          projectSuite('chromium', [
            { title: 'sends a message', results: [], status: 'skipped' },
            { title: 'forks a conversation', results: [], status: 'skipped' },
          ]),
        ],
        'failed'
      );

    it('tallies the projects and tests in the report against what executed', () => {
      const result = generateDebugReport(droppedByFailedSetup());

      expect(result.coverage).toMatchObject({
        projectsInReport: 2,
        executedProjects: 1,
        testsInReport: 3,
        executedTests: 1,
      });
    });

    it('blames the failed setup project when a dependent project produced no result', () => {
      const result = generateDebugReport(droppedByFailedSetup());

      expect(result.coverage?.lost).toEqual([
        {
          project: 'chromium',
          tests: 2,
          reason: 'dependency-failed',
          dependencies: [{ project: 'setup-chromium', failedTests: 1 }],
        },
      ]);
      expect(result.globalErrors).toEqual([
        'Lost coverage: project "chromium" produced no result for any of its configured tests (2). ' +
          'Its dependency project "setup-chromium" has failed tests (1), so the runner removed "chromium" from the run. ' +
          'Those tests are unproven, not passed — fix the setup failure and re-run.',
      ]);
    });

    it('reports a project the run never reached as cut short when the run timed out', () => {
      const result = generateDebugReport(
        runOf(
          [
            projectSuite('chromium', [{ title: 'sends a message', results: [attempt('passed')] }]),
            projectSuite('firefox', [{ title: 'sends a message', results: [], status: 'skipped' }]),
          ],
          'timedout'
        )
      );

      expect(result.coverage?.lost).toEqual([
        { project: 'firefox', tests: 1, reason: 'run-cut-short' },
      ]);
      expect(result.globalErrors).toEqual([
        'Lost coverage: project "firefox" produced no result for any of its configured tests (1). ' +
          'The run ended as "timedout", so the project was cut short rather than removed. ' +
          'Those tests are unproven, not passed — the run must finish before its pass count means anything.',
      ]);
    });

    it('states that nothing in the report accounts for a loss it cannot attribute', () => {
      const result = generateDebugReport(
        runOf([
          projectSuite('admin', [{ title: 'opens the console', results: [], status: 'skipped' }]),
        ])
      );

      expect(result.coverage?.lost).toEqual([
        { project: 'admin', tests: 1, reason: 'unexplained' },
      ]);
      expect(result.globalErrors).toEqual([
        'Lost coverage: project "admin" produced no result for any of its configured tests (1). ' +
          'No setup project of it failed, and the run reported neither a timeout nor an interruption, ' +
          'so this report cannot name the cause — a run stopped by the failure cap reports neither. ' +
          'Those tests are unproven, not passed.',
      ]);
    });

    it('blames the failed setup project over the abort when a cut-short run also dropped it', () => {
      const result = generateDebugReport(
        runOf(
          [
            projectSuite('setup-chromium', [
              { title: 'authenticates alice', results: [attempt('failed')], status: 'unexpected' },
            ]),
            projectSuite('chromium', [
              { title: 'sends a message', results: [], status: 'skipped' },
            ]),
          ],
          'timedout'
        )
      );

      expect(result.coverage?.lost).toEqual([
        {
          project: 'chromium',
          tests: 1,
          reason: 'dependency-failed',
          dependencies: [{ project: 'setup-chromium', failedTests: 1 }],
        },
      ]);
      expect(result.globalErrors?.[0]).toContain('fix the setup failure and re-run');
    });

    it('blames the failed admin setup project when the admin project produced no result', () => {
      const result = generateDebugReport(
        runOf(
          [
            projectSuite('setup-admin', [
              { title: 'serves the console', results: [attempt('failed')], status: 'unexpected' },
            ]),
            projectSuite('admin', [
              { title: 'opens the console', results: [], status: 'skipped' },
              { title: 'locks a user', results: [], status: 'skipped' },
            ]),
          ],
          'failed'
        )
      );

      expect(result.coverage?.lost).toEqual([
        {
          project: 'admin',
          tests: 2,
          reason: 'dependency-failed',
          dependencies: [{ project: 'setup-admin', failedTests: 1 }],
        },
      ]);
      expect(result.globalErrors).toEqual([
        'Lost coverage: project "admin" produced no result for any of its configured tests (2). ' +
          'Its dependency project "setup-admin" has failed tests (1), so the runner removed "admin" from the run. ' +
          'Those tests are unproven, not passed — fix the setup failure and re-run.',
      ]);
    });

    it('names every dependency with a failed test, in the order the config declares them', () => {
      const result = generateDebugReport(
        runOf(
          [
            projectSuite('setup-c', [
              { title: 'prepares c', results: [attempt('failed')], status: 'unexpected' },
            ]),
            projectSuite('setup-b', [{ title: 'prepares b', results: [attempt('passed')] }]),
            projectSuite('setup-a', [
              { title: 'prepares a', results: [attempt('failed')], status: 'unexpected' },
              { title: 'prepares a again', results: [attempt('failed')], status: 'unexpected' },
            ]),
            projectSuite('dependent', [
              { title: 'uses all three', results: [], status: 'skipped' },
            ]),
          ],
          'failed',
          [
            { name: 'setup-a', dependencies: [] },
            { name: 'setup-b', dependencies: [] },
            { name: 'setup-c', dependencies: [] },
            { name: 'dependent', dependencies: ['setup-a', 'setup-b', 'setup-c'] },
          ]
        )
      );

      expect(result.coverage?.lost).toEqual([
        {
          project: 'dependent',
          tests: 1,
          reason: 'dependency-failed',
          dependencies: [
            { project: 'setup-a', failedTests: 2 },
            { project: 'setup-c', failedTests: 1 },
          ],
        },
      ]);
      expect(result.globalErrors).toEqual([
        'Lost coverage: project "dependent" produced no result for any of its configured tests (1). ' +
          'Its dependency projects "setup-a" and "setup-c" have failed tests (2 and 1), so the runner removed "dependent" from the run. ' +
          'Those tests are unproven, not passed — fix the setup failure and re-run.',
      ]);
    });

    it('blames no failed setup project that the config does not make a dependency', () => {
      const result = generateDebugReport(
        runOf(
          [
            projectSuite('setup-chromium', [
              { title: 'authenticates alice', results: [attempt('failed')], status: 'unexpected' },
            ]),
            projectSuite('chromium', [
              { title: 'sends a message', results: [], status: 'skipped' },
            ]),
          ],
          undefined,
          [
            { name: 'setup-chromium', dependencies: [] },
            { name: 'chromium', dependencies: [] },
          ]
        )
      );

      expect(result.coverage?.lost).toEqual([
        { project: 'chromium', tests: 1, reason: 'unexplained' },
      ]);
    });

    it('keeps a project whose only test was skipped out of the lost set', () => {
      const result = generateDebugReport(
        runOf([
          projectSuite('webkit', [
            {
              title: 'skipped on this engine',
              results: [attempt('skipped')],
              status: 'skipped',
              expectedStatus: 'skipped',
            },
          ]),
        ])
      );

      expect(result.coverage?.lost).toEqual([]);
      expect(result.globalErrors).toBeUndefined();
    });

    it('keeps a project that produced some results out of the lost set', () => {
      const result = generateDebugReport(
        runOf(
          [
            projectSuite('chromium', [
              { title: 'sends a message', results: [attempt('passed')] },
              { title: 'never started', results: [], status: 'skipped' },
            ]),
          ],
          'timedout'
        )
      );

      expect(result.coverage?.lost).toEqual([]);
      expect(result.coverage?.executedTests).toBe(1);
      expect(result.coverage?.testsInReport).toBe(2);
    });

    it('keeps a run-level error the runner reported alongside a coverage error', () => {
      const report = droppedByFailedSetup();
      report.errors = ['Error: webServer exited early'];

      expect(generateDebugReport(report).globalErrors).toHaveLength(2);
    });

    it('carries the in-report and the executed counts in the markdown headline', () => {
      const md = generateMarkdownReport(generateDebugReport(droppedByFailedSetup()));

      expect(md).toContain(
        '**Coverage:** 1 of 2 projects in the report produced results (1 of 3 tests in the report produced results)'
      );
    });

    it('states each lost project in the markdown prose', () => {
      const md = generateMarkdownReport(generateDebugReport(droppedByFailedSetup()));

      expect(md).toContain('## Global Errors');
      expect(md).toContain('Lost coverage: project "chromium"');
      expect(md).toContain('**Result:** FAILED');
    });

    it('does not say the run ended early when every global error is lost coverage', () => {
      const md = generateMarkdownReport(generateDebugReport(droppedByFailedSetup()));

      expect(md).not.toContain('The run did not complete normally.');
    });

    it('says lost coverage alone cannot tell a completed run from one that ended early', () => {
      const md = generateMarkdownReport(generateDebugReport(droppedByFailedSetup()));

      expect(md).toContain(
        'Every entry here is a finding this report derived from the results rather than an error the harness raised, which a run that completed leaves as readily as one that ended early, so this section does not say which this run was.'
      );
    });

    it('does not say the run ended early when the only global error is an unlisted result', () => {
      // An outcome outside the declared union is what a Playwright release adding an
      // outcome would hand the report at runtime; the cast stands in for that value.
      const unknownOutcome = 'retried' as string as PlaywrightTest['status'];
      const report = runOf(
        [projectSuite('chromium', [{ title: 'sends a message', results: [attempt('failed')] }])],
        'failed'
      );
      const test = report.suites[0]?.specs?.[0]?.tests?.[0];
      if (test) test.status = unknownOutcome;

      const md = generateMarkdownReport(generateDebugReport(report));

      expect(md).toContain('Unlisted results:');
      expect(md).not.toContain('The run did not complete normally.');
    });

    it('does not call an unlisted result a project that produced no result', () => {
      // An outcome outside the declared union is what a Playwright release adding an
      // outcome would hand the report at runtime; the cast stands in for that value.
      const unknownOutcome = 'retried' as string as PlaywrightTest['status'];
      const report = runOf(
        [projectSuite('chromium', [{ title: 'sends a message', results: [attempt('failed')] }])],
        'failed'
      );
      const test = report.suites[0]?.specs?.[0]?.tests?.[0];
      if (test) test.status = unknownOutcome;

      const md = generateMarkdownReport(generateDebugReport(report));

      expect(md).not.toContain('Every entry here is a configured project');
      expect(md).toContain(
        'Every entry here is a finding this report derived from the results rather than an error the harness raised, which a run that completed leaves as readily as one that ended early, so this section does not say which this run was.'
      );
    });

    it('still says the run ended early when a harness error sits beside lost coverage', () => {
      const report = droppedByFailedSetup();
      report.errors = ['Error: webServer exited early'];

      const md = generateMarkdownReport(generateDebugReport(report));

      expect(md).toContain('The run did not complete normally.');
    });

    it('carries the tests that did not run and the declared skips into the json report', () => {
      const json = generateJsonReport(
        generateDebugReport(
          runOf([
            projectSuite('chromium', [
              {
                title: 'regenerates twice',
                results: [attempt('skipped'), attempt('skipped')],
                status: 'skipped',
              },
              {
                title: 'skipped on this engine',
                results: [attempt('skipped')],
                status: 'skipped',
                expectedStatus: 'skipped',
              },
            ]),
          ])
        )
      );

      expect(json.didNotRun).toEqual([
        { title: 'regenerates twice', file: 'e2e/chromium.spec.ts', project: 'chromium' },
      ]);
      expect(json.skipped).toEqual([
        { title: 'skipped on this engine', file: 'e2e/chromium.spec.ts', project: 'chromium' },
      ]);
    });

    it('carries the coverage tally into the json report', () => {
      const json = generateJsonReport(generateDebugReport(droppedByFailedSetup()));

      expect(json.coverage?.lost).toHaveLength(1);
      expect(json.coverage?.executedProjects).toBe(1);
    });
  });

  describe('serializeTestForJson', () => {
    const baseArtifacts = {
      trace: 'trace.zip',
      screenshot: 'screenshot.png',
      video: 'video.webm',
      consoleErrors: 'console.txt',
      apiErrors: 'api.txt',
      pageSnapshot: 'snapshot.txt',
      harFiles: ['network.har'],
    };

    const failedSample: FailedTest = {
      title: 'sample fails',
      file: 'e2e/sample.spec.ts',
      line: 42,
      project: 'chromium',
      attempts: 1,
      attemptStatus: 'failed',
      attemptRetry: 0,
      error: '[31mBoom[0m',
      duration: 1234,
      steps: [],
      artifacts: baseArtifacts,
    };

    it('strips ANSI from the error', () => {
      const entry = serializeTestForJson(failedSample);

      expect(entry.error).toBe('Boom');
    });

    it('attaches a rerun command derived from the test', () => {
      const entry = serializeTestForJson(failedSample);

      expect(entry.rerunCommand).toBe(buildRerunCommand(failedSample));
    });

    it('builds a fresh artifacts object holding the same field values', () => {
      const entry = serializeTestForJson(failedSample);

      expect(entry.artifacts).toEqual(baseArtifacts);
      expect(entry.artifacts).not.toBe(baseArtifacts);
      // Each har path is rewritten to its repo-relative form, so the array is
      // built rather than forwarded. These fixture paths already sit under the
      // repo root, so rewriting them changes nothing but the identity.
      expect(entry.artifacts.harFiles).not.toBe(baseArtifacts.harFiles);
    });

    it('preserves the title, file, line, project, duration, and steps', () => {
      const entry = serializeTestForJson(failedSample);

      expect(entry.title).toBe(failedSample.title);
      expect(entry.file).toBe(failedSample.file);
      expect(entry.line).toBe(failedSample.line);
      expect(entry.project).toBe(failedSample.project);
      expect(entry.duration).toBe(failedSample.duration);
      expect(entry.steps).toBe(failedSample.steps);
    });

    it('serializes a flaky test with the same shape as a failed test', () => {
      const flakySample: FlakyTest = {
        title: 'sample flakes',
        file: 'e2e/flake.spec.ts',
        line: 7,
        project: 'webkit',
        attemptStatus: 'failed',
        attemptRetry: 0,
        attempts: 2,
        error: 'transient timeout',
        duration: 500,
        steps: [],
        artifacts: baseArtifacts,
      };

      const entry = serializeTestForJson(flakySample);

      expect(entry).toEqual({
        title: 'sample flakes',
        file: 'e2e/flake.spec.ts',
        line: 7,
        project: 'webkit',
        attempts: 2,
        duration: 500,
        error: 'transient timeout',
        rerunCommand: buildRerunCommand(flakySample),
        steps: flakySample.steps,
        artifacts: baseArtifacts,
      });
    });
  });

  describe('writeReport', () => {
    let temporaryDir: string;

    const simpleReport: DebugReport = {
      summary: { total: 1, passed: 1, flaky: 0, failed: 0, duration: 1000 },
      didNotRun: [],
      skipped: [],
      passed: [{ title: 'test', file: 'e2e/test.spec.ts', project: 'chromium', duration: 1000 }],
      flaky: [],
      failed: [],
    };

    afterEach(() => {
      if (temporaryDir && existsSync(temporaryDir)) {
        rmSync(temporaryDir, { recursive: true, force: true });
      }
    });

    it('creates the run subdirectory with REPORT.md', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const resultDir = writeReport(simpleReport, baseDir);

      expect(existsSync(path.join(resultDir, 'REPORT.md'))).toBe(true);
      const content = readFileSync(path.join(resultDir, 'REPORT.md'), 'utf8');
      expect(content).toContain('# E2E Test Report');
    });

    it('returns a path inside baseDir named by day and run ordinal, carrying no time of day', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const resultDir = writeReport(simpleReport, baseDir);

      expect(resultDir.startsWith(baseDir)).toBe(true);
      const dirName = path.basename(resultDir);
      expect(dirName).toMatch(/^\d{4}-\d{2}-\d{2}-run\d+$/);
    });

    it('writes per-test artifacts in failed/ directory', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');
      const sourceScreenshot = path.join(temporaryDir, 'source-screenshot.png');
      writeFileSync(sourceScreenshot, 'fake-png-data');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'test error message',
            duration: 1000,
            steps: [{ title: 'click', duration: 100 }],
            artifacts: {
              trace: undefined,
              screenshot: sourceScreenshot,
              video: undefined,
              consoleErrors: 'TypeError: x',
              apiErrors: undefined,
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

    it('writes per-test artifacts in flaky/ directory', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');
      const sourceScreenshot = path.join(temporaryDir, 'flaky-source.png');
      writeFileSync(sourceScreenshot, 'fake-png-data');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 1, failed: 0, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [
          {
            title: 'intermittent test',
            file: 'e2e/chat/flaky.spec.ts',
            project: 'webkit',
            attemptStatus: 'failed',
            attemptRetry: 0,
            attempts: 2,
            error: 'race on first attempt',
            duration: 500,
            steps: [{ title: 'wait', duration: 50 }],
            artifacts: {
              trace: undefined,
              screenshot: sourceScreenshot,
              video: undefined,
              consoleErrors: 'oops',
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
        failed: [],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-chat-flaky-spec-ts-webkit-intermittent-test';
      const flakyDir = path.join(resultDir, 'flaky', slug);
      expect(existsSync(flakyDir)).toBe(true);
      expect(existsSync(path.join(flakyDir, 'error.txt'))).toBe(true);
      expect(existsSync(path.join(flakyDir, 'steps.json'))).toBe(true);
      expect(existsSync(path.join(flakyDir, 'screenshot.png'))).toBe(true);
      expect(existsSync(path.join(flakyDir, 'console-errors.txt'))).toBe(true);
      expect(readFileSync(path.join(flakyDir, 'error.txt'), 'utf8')).toBe('race on first attempt');
    });

    it('writes api-errors.txt in failed/ directory when apiErrors set', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'test error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: '500 POST /api/chat/abc/stream\n  body: {"code":"BILLING_ERROR"}',
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-test-spec-ts-chromium-broken-test';
      const failedDir = path.join(resultDir, 'failed', slug);
      expect(existsSync(path.join(failedDir, 'api-errors.txt'))).toBe(true);
      expect(readFileSync(path.join(failedDir, 'api-errors.txt'), 'utf8')).toContain(
        'POST /api/chat/abc/stream'
      );
    });

    it('writes api-errors.txt in flaky/ directory when apiErrors set', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 1, failed: 0, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [
          {
            title: 'intermittent test',
            file: 'e2e/chat/flaky.spec.ts',
            project: 'webkit',
            attemptStatus: 'failed',
            attemptRetry: 0,
            attempts: 2,
            error: 'race condition',
            duration: 500,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: '429 POST /api/chat/abc/stream',
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
        failed: [],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-chat-flaky-spec-ts-webkit-intermittent-test';
      const flakyDir = path.join(resultDir, 'flaky', slug);
      expect(existsSync(path.join(flakyDir, 'api-errors.txt'))).toBe(true);
      expect(readFileSync(path.join(flakyDir, 'api-errors.txt'), 'utf8')).toContain(
        '429 POST /api/chat/abc/stream'
      );
    });

    it('omits api-errors.txt when apiErrors is undefined', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'no api errors test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'oops',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: 'TypeError',
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-test-spec-ts-chromium-no-api-errors-test';
      const failedDir = path.join(resultDir, 'failed', slug);
      expect(existsSync(path.join(failedDir, 'api-errors.txt'))).toBe(false);
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

    it('includes apiErrors in report.json for failed tests', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'e',
            duration: 1,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: '500 POST /api/x',
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const json = JSON.parse(
        readFileSync(path.join(resultDir, 'report.json'), 'utf8')
      ) as JsonReport;
      expect(json.failed[0]?.artifacts.apiErrors).toBe('500 POST /api/x');
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

    it('extracts trace.zip into trace/ subdirectory for failed tests', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');
      const tracePath = makeTraceZip(temporaryDir, 'trace.zip', {
        'test.trace': '{"type":"context-options","title":"failure-trace"}',
        '1-trace.network': '{"type":"resource-snapshot"}',
        'resources/src@abc.txt': '<html><body>captured</body></html>',
        'resources/page@frame-1.jpeg': 'BINARY-JPEG-DATA',
      });

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken with trace',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'oops',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: tracePath,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-test-spec-ts-chromium-broken-with-trace';
      const traceDir = path.join(resultDir, 'failed', slug, 'trace');
      expect(existsSync(path.join(traceDir, 'test.trace'))).toBe(true);
      expect(existsSync(path.join(traceDir, '1-trace.network'))).toBe(true);
      expect(existsSync(path.join(traceDir, 'resources', 'src@abc.txt'))).toBe(true);
      expect(readFileSync(path.join(traceDir, 'test.trace'), 'utf8')).toContain('failure-trace');
    });

    it('extracts trace.zip into trace/ subdirectory for flaky tests', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');
      const tracePath = makeTraceZip(temporaryDir, 'flaky-trace.zip', {
        'test.trace': '{"type":"context-options","title":"flaky-trace"}',
      });

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 1, failed: 0, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [
          {
            title: 'intermittent with trace',
            file: 'e2e/chat/flaky.spec.ts',
            project: 'webkit',
            attemptStatus: 'failed',
            attemptRetry: 0,
            attempts: 2,
            error: 'race',
            duration: 500,
            steps: [],
            artifacts: {
              trace: tracePath,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
        failed: [],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-chat-flaky-spec-ts-webkit-intermittent-with-trace';
      const traceDir = path.join(resultDir, 'flaky', slug, 'trace');
      expect(existsSync(path.join(traceDir, 'test.trace'))).toBe(true);
      expect(readFileSync(path.join(traceDir, 'test.trace'), 'utf8')).toContain('flaky-trace');
    });

    it('omits resources/page@*.jpeg frame screenshots when extracting trace', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');
      const tracePath = makeTraceZip(temporaryDir, 'jpeg-trace.zip', {
        'test.trace': '{}',
        'resources/page@frame-1.jpeg': 'JPEG-1',
        'resources/page@frame-2.jpeg': 'JPEG-2',
        'resources/src@kept.txt': 'kept-source',
        'resources/abc123.dat': 'kept-response-body',
      });

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'jpeg trim',
            file: 'e2e/t.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'e',
            duration: 1,
            steps: [],
            artifacts: {
              trace: tracePath,
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-t-spec-ts-chromium-jpeg-trim';
      const traceDir = path.join(resultDir, 'failed', slug, 'trace');
      expect(existsSync(path.join(traceDir, 'resources', 'page@frame-1.jpeg'))).toBe(false);
      expect(existsSync(path.join(traceDir, 'resources', 'page@frame-2.jpeg'))).toBe(false);
      expect(existsSync(path.join(traceDir, 'resources', 'src@kept.txt'))).toBe(true);
      expect(existsSync(path.join(traceDir, 'resources', 'abc123.dat'))).toBe(true);
    });

    it('handles missing trace zip path gracefully', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'no trace file on disk',
            file: 'e2e/t.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'e',
            duration: 1,
            steps: [],
            artifacts: {
              trace: '/nonexistent/trace.zip',
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [],
            },
          },
        ],
      };

      const resultDir = writeReport(report, baseDir);

      const slug = 'e2e-t-spec-ts-chromium-no-trace-file-on-disk';
      expect(existsSync(path.join(resultDir, 'failed', slug, 'trace'))).toBe(false);
      expect(existsSync(path.join(resultDir, 'REPORT.md'))).toBe(true);
    });

    it('handles missing artifact sources gracefully', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'test',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'error',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: undefined,
              screenshot: '/nonexistent/path/screenshot.png',
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
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

  describe('mergeHarFiles', () => {
    let workDir: string;

    afterEach(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it('merges entries from every existing har file into one archive', () => {
      workDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-debug-har-'));
      const harA = path.join(workDir, 'a.har');
      const harB = path.join(workDir, 'b.har');
      writeFileSync(harA, JSON.stringify({ log: { entries: [{ request: 'a' }] } }), 'utf8');
      writeFileSync(harB, JSON.stringify({ log: { entries: [{ request: 'b' }] } }), 'utf8');
      const outputPath = path.join(workDir, 'merged.har');

      mergeHarFiles([harA, path.join(workDir, 'missing.har'), harB], outputPath);

      const merged = JSON.parse(readFileSync(outputPath, 'utf8')) as {
        log: { entries: { request: string }[] };
      };
      expect(merged.log.entries).toEqual([{ request: 'a' }, { request: 'b' }]);
    });

    it('writes nothing when no har files exist', () => {
      workDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-debug-har-'));
      const outputPath = path.join(workDir, 'merged.har');

      mergeHarFiles([path.join(workDir, 'missing.har')], outputPath);

      expect(existsSync(outputPath)).toBe(false);
    });
  });

  describe('extractTraceArchive', () => {
    let workDir: string;

    afterEach(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it('extracts trace files while skipping directories and frame screenshots', () => {
      workDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-debug-trace-'));
      const zipPath = path.join(workDir, 'trace.zip');
      const zip = new AdmZip();
      zip.addFile('resources/', Buffer.alloc(0));
      zip.addFile('resources/page@abc.jpeg', Buffer.from('jpeg-bytes'));
      zip.addFile('test.trace', Buffer.from('{"type":"frame"}'));
      zip.writeZip(zipPath);
      const destination = path.join(workDir, 'extracted');

      extractTraceArchive(zipPath, destination);

      expect(existsSync(path.join(destination, 'test.trace'))).toBe(true);
      expect(existsSync(path.join(destination, 'resources', 'page@abc.jpeg'))).toBe(false);
    });
  });

  describe('writePerTestArtifacts', () => {
    let workDir: string;

    afterEach(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    it('writes the page snapshot artifact when one was captured', () => {
      workDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-debug-artifacts-'));
      const test: FailedTest = {
        title: 'broken test',
        file: 'e2e/chat/chat.spec.ts',
        project: 'chromium',
        attempts: 1,
        attemptStatus: 'failed',
        attemptRetry: 0,
        error: 'boom',
        duration: 1000,
        steps: [],
        artifacts: {
          trace: undefined,
          screenshot: undefined,
          video: undefined,
          consoleErrors: undefined,
          apiErrors: undefined,
          pageSnapshot: '- document:\n  - main: content',
          harFiles: [],
        },
      };
      const testDir = path.join(workDir, 'broken-test');

      writePerTestArtifacts(test, testDir);

      expect(readFileSync(path.join(testDir, 'page-snapshot.txt'), 'utf8')).toBe(
        '- document:\n  - main: content'
      );
    });

    it('names the chosen attempt in error.txt when that attempt recorded no error text', () => {
      workDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-debug-artifacts-'));
      const test: FailedTest = {
        title: 'silent failure',
        file: 'e2e/chat/chat.spec.ts',
        project: 'chromium',
        attempts: 2,
        attemptStatus: 'timedOut',
        attemptRetry: 1,
        error: '',
        duration: 1000,
        steps: [],
        artifacts: {
          trace: undefined,
          screenshot: undefined,
          video: undefined,
          consoleErrors: undefined,
          apiErrors: undefined,
          pageSnapshot: undefined,
          harFiles: [],
        },
      };
      const testDir = path.join(workDir, 'silent-failure');

      writePerTestArtifacts(test, testDir);

      expect(readFileSync(path.join(testDir, 'error.txt'), 'utf8')).toBe(
        'NO ERROR TEXT RECORDED. The chosen attempt (status timedOut, retry 1) carried none; this test did not pass.'
      );
    });
  });

  describe('report directory ordinals', () => {
    let temporaryDir: string;

    const report: DebugReport = {
      summary: { total: 1, passed: 1, flaky: 0, failed: 0, duration: 1000 },
      didNotRun: [],
      skipped: [],
      passed: [{ title: 'test', file: 'e2e/test.spec.ts', project: 'chromium', duration: 1000 }],
      flaky: [],
      failed: [],
    };

    afterEach(() => {
      vi.useRealTimers();
      if (temporaryDir && existsSync(temporaryDir)) {
        rmSync(temporaryDir, { recursive: true, force: true });
      }
    });

    it('numbers the first run of a day one', () => {
      freezeClock(TEST_DAY_START);
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      const resultDir = writeReport(report, baseDir);

      expect(path.basename(resultDir)).toBe(`${isoAt(TEST_DAY_START).slice(0, 10)}-run1`);
    });

    it('increments the ordinal for a later run on the same day', () => {
      freezeClock(TEST_DAY_START);
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      writeReport(report, baseDir);
      setClock(TEST_DAY_END);
      const second = writeReport(report, baseDir);

      expect(path.basename(second)).toBe(`${isoAt(TEST_DAY_START).slice(0, 10)}-run2`);
    });

    it('restarts the ordinal on a new day', () => {
      freezeClock(TEST_DAY_START);
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');

      writeReport(report, baseDir);
      setClock(TEST_DAY_START + DAY_MS);
      const nextDay = writeReport(report, baseDir);

      expect(path.basename(nextDay)).toBe(`${isoAt(TEST_DAY_START + DAY_MS).slice(0, 10)}-run1`);
    });

    it('continues past the highest ordinal present rather than counting directories', () => {
      freezeClock(TEST_DAY_START);
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');
      const day = isoAt(TEST_DAY_START).slice(0, 10);
      mkdirSync(path.join(baseDir, `${day}-run7`), { recursive: true });

      const resultDir = writeReport(report, baseDir);

      expect(path.basename(resultDir)).toBe(`${day}-run8`);
    });

    it('ignores other days ordinals when numbering a run', () => {
      freezeClock(TEST_DAY_START + DAY_MS);
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
      const baseDir = path.join(temporaryDir, 'report');
      const previousDay = isoAt(TEST_DAY_START).slice(0, 10);
      mkdirSync(path.join(baseDir, `${previousDay}-run9`), { recursive: true });

      const resultDir = writeReport(report, baseDir);

      expect(path.basename(resultDir)).toBe(`${isoAt(TEST_DAY_START + DAY_MS).slice(0, 10)}-run1`);
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
      for (const name of ['2020-01-01-run1', '2020-01-02-run1', '2020-01-03-run1']) {
        mkdirSync(path.join(temporaryDir, name));
      }

      enforceRetentionLimit(temporaryDir, 2, 0);

      expect(existsSync(path.join(temporaryDir, '2020-01-01-run1'))).toBe(false);
      expect(existsSync(path.join(temporaryDir, '2020-01-02-run1'))).toBe(true);
      expect(existsSync(path.join(temporaryDir, '2020-01-03-run1'))).toBe(true);
    });

    it('keeps all directories when at or under limit', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      for (const name of ['2020-01-01-run1', '2020-01-02-run1']) {
        mkdirSync(path.join(temporaryDir, name));
      }

      enforceRetentionLimit(temporaryDir, 2, 0);

      expect(existsSync(path.join(temporaryDir, '2020-01-01-run1'))).toBe(true);
      expect(existsSync(path.join(temporaryDir, '2020-01-02-run1'))).toBe(true);
    });

    it('orders same-day runs by ordinal rather than lexically', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      for (const name of ['2020-01-01-run2', '2020-01-01-run9', '2020-01-01-run10']) {
        mkdirSync(path.join(temporaryDir, name));
      }

      enforceRetentionLimit(temporaryDir, 2, 0);

      expect(existsSync(path.join(temporaryDir, '2020-01-01-run2'))).toBe(false);
      expect(existsSync(path.join(temporaryDir, '2020-01-01-run9'))).toBe(true);
      expect(existsSync(path.join(temporaryDir, '2020-01-01-run10'))).toBe(true);
    });

    it('ages instant-named directories out ahead of the same day ordinal runs', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      const day = isoAt(TEST_DAY_START).slice(0, 10);
      const legacyStart = isoAt(TEST_DAY_START).slice(0, 19).replaceAll(':', '-');
      const legacyEnd = isoAt(TEST_DAY_END).slice(0, 19).replaceAll(':', '-');
      for (const name of [legacyEnd, legacyStart, `${day}-run1`]) {
        mkdirSync(path.join(temporaryDir, name));
      }

      enforceRetentionLimit(temporaryDir, 2, 0);

      expect(existsSync(path.join(temporaryDir, legacyStart))).toBe(false);
      expect(existsSync(path.join(temporaryDir, legacyEnd))).toBe(true);
      expect(existsSync(path.join(temporaryDir, `${day}-run1`))).toBe(true);
    });

    it('ignores files, only counts directories', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      writeFileSync(path.join(temporaryDir, 'stray-file.txt'), 'data');
      mkdirSync(path.join(temporaryDir, '2020-01-01-run1'));

      enforceRetentionLimit(temporaryDir, 1, 0);

      expect(existsSync(path.join(temporaryDir, '2020-01-01-run1'))).toBe(true);
      expect(existsSync(path.join(temporaryDir, 'stray-file.txt'))).toBe(true);
    });

    it('handles nonexistent base directory gracefully', () => {
      expect(() => {
        enforceRetentionLimit('/nonexistent/path', 10, 3);
      }).not.toThrow();
    });

    /** A report directory carrying the test count `report.json` records for a run. */
    const seedRun = (name: string, total: number): void => {
      const runDir = path.join(temporaryDir, name);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        path.join(runDir, 'report.json'),
        JSON.stringify({ summary: { total, passed: total, flaky: 0, failed: 0, duration: 1000 } }),
        'utf8'
      );
    };

    it('keeps the largest run when an influx of small runs fills the recency pool', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      seedRun('2020-01-01-run1', 340);
      seedRun('2020-01-01-run2', 3);
      seedRun('2020-01-02-run1', 3);
      seedRun('2020-01-03-run1', 3);
      seedRun('2020-01-04-run1', 3);

      enforceRetentionLimit(temporaryDir, 3, 1);

      expect(existsSync(path.join(temporaryDir, '2020-01-01-run1'))).toBe(true);
      expect(existsSync(path.join(temporaryDir, '2020-01-01-run2'))).toBe(false);
    });

    it('bounds the surviving directories at the two pool sizes together', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      // Days ascending against totals descending, so the two pools are disjoint.
      for (const [index, total] of [340, 300, 260, 5, 4, 3, 2, 1].entries()) {
        seedRun(`2020-01-0${String(index + 1)}-run1`, total);
      }

      enforceRetentionLimit(temporaryDir, 3, 2);

      expect(readdirSync(temporaryDir)).toHaveLength(5);
    });

    it('grants the size pool no further slot when its pick is already the newest run', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      seedRun('2020-01-01-run1', 300);
      seedRun('2020-01-02-run1', 2);
      seedRun('2020-01-03-run1', 1);
      seedRun('2020-01-04-run1', 340);

      enforceRetentionLimit(temporaryDir, 2, 2);

      expect(readdirSync(temporaryDir).toSorted((a, b) => a.localeCompare(b))).toEqual([
        '2020-01-01-run1',
        '2020-01-03-run1',
        '2020-01-04-run1',
      ]);
    });

    it('ranks a run with no report.json below one with a recorded test count', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      mkdirSync(path.join(temporaryDir, '2020-01-01-run1'));
      seedRun('2020-01-02-run1', 1);
      seedRun('2020-01-03-run1', 340);

      enforceRetentionLimit(temporaryDir, 1, 2);

      expect(existsSync(path.join(temporaryDir, '2020-01-01-run1'))).toBe(false);
      expect(existsSync(path.join(temporaryDir, '2020-01-02-run1'))).toBe(true);
    });

    it('treats a malformed report.json as a run with no recorded test count', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      mkdirSync(path.join(temporaryDir, '2020-01-01-run1'));
      writeFileSync(
        path.join(temporaryDir, '2020-01-01-run1', 'report.json'),
        '{ truncated',
        'utf8'
      );
      seedRun('2020-01-02-run1', 1);
      seedRun('2020-01-03-run1', 340);

      enforceRetentionLimit(temporaryDir, 1, 2);

      expect(existsSync(path.join(temporaryDir, '2020-01-01-run1'))).toBe(false);
      expect(existsSync(path.join(temporaryDir, '2020-01-02-run1'))).toBe(true);
    });

    it('treats a report.json without a recorded total as a run with no test count', () => {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-retention-'));
      mkdirSync(path.join(temporaryDir, '2020-01-01-run1'));
      writeFileSync(
        path.join(temporaryDir, '2020-01-01-run1', 'report.json'),
        JSON.stringify({ summary: {} }),
        'utf8'
      );
      seedRun('2020-01-02-run1', 1);
      seedRun('2020-01-03-run1', 340);

      enforceRetentionLimit(temporaryDir, 1, 2);

      expect(existsSync(path.join(temporaryDir, '2020-01-01-run1'))).toBe(false);
      expect(existsSync(path.join(temporaryDir, '2020-01-02-run1'))).toBe(true);
    });
  });

  describe('resource usage', () => {
    const resources: ResourceReport = {
      summary: {
        durationMs: 125_000,
        sampleCount: 3,
        cores: 24,
        totalMemBytes: 32 * 1024 ** 3,
        cpu: { peak: 62, avg: 38 },
        mem: { peak: 44, avg: 30 },
        load: { peak: 19 },
        isolateStalls: null,
        diskPeaks: null,
        dStateWaits: null,
        ramRootPeakBytes: null,
      },
      samples: [
        {
          t: 0,
          cpuPct: 62,
          memPct: 44,
          load1: 19,
          disks: null,
          btrfs: null,
          dState: null,
          ramRootBytes: null,
        },
      ],
      scan: {
        totalHits: 7,
        categories: [{ name: 'process/thread limit', count: 7, tests: ['a.spec.ts › b'] }],
      },
    };

    const emptyReport = (): DebugReport =>
      generateDebugReport({ suites: [], config: {}, projects: [], stats: { duration: 1000 } });

    it('renderResourceSection returns nothing without resources', () => {
      expect(renderResourceSection()).toEqual([]);
    });

    it('renderResourceSection renders the table and error breakdown', () => {
      const md = renderResourceSection(resources).join('\n');
      expect(md).toContain('## Resource Usage');
      expect(md).toContain('| CPU | 62% | 38% |');
      expect(md).toContain('**Resource-limit errors:** 7');
      expect(md).toContain('process/thread limit ×7');
    });

    it('renderResourceSection renders the API heap row and the abort count', () => {
      const md = renderResourceSection({
        ...resources,
        summary: { ...resources.summary, heap: { peak: 412.5, avg: 190 }, heapOomAborts: 3 },
      }).join('\n');
      expect(md).toContain('| API heap | 412.5 MB | 190 MB |');
      expect(md).toContain('**API heap-OOM aborts:** 3');
    });

    it('renderResourceSection omits the heap row when the isolate was unreadable', () => {
      const md = renderResourceSection(resources).join('\n');
      expect(md).toContain('| CPU | 62% | 38% |');
      expect(md).not.toContain('API heap');
    });

    it('renderResourceSection omits the error block when there are no hits', () => {
      const md = renderResourceSection({
        ...resources,
        scan: { totalHits: 0, categories: [] },
      }).join('\n');
      expect(md).not.toContain('Resource-limit errors');
      expect(md).toContain('## Resource Usage');
    });

    const MIB = 1024 ** 2;

    /** `resources` with the Linux series `over` names measured, and a run of twelve workers. */
    const measured = (over: Partial<ResourceReport['summary']>): ResourceReport => ({
      ...resources,
      workers: 12,
      summary: { ...resources.summary, ...over },
    });

    it('renderResourceSection prints each busy device’s peak utilisation, leaving idle ones out', () => {
      const md = renderResourceSection(
        measured({
          diskPeaks: [
            { device: 'loop3', peakUtilisationPct: 100 },
            { device: 'sdb', peakUtilisationPct: 35.5 },
            { device: 'loop0', peakUtilisationPct: 0 },
          ],
        })
      ).join('\n');

      expect(md).toContain('**Disk utilisation, peak per device:** loop3 100% · sdb 35.5%');
      expect(md).not.toContain('loop0');
    });

    it('renderResourceSection says no device was busy when every one stayed idle', () => {
      const md = renderResourceSection(
        measured({ diskPeaks: [{ device: 'loop0', peakUtilisationPct: 0 }] })
      ).join('\n');

      expect(md).toContain(
        '**Disk utilisation, peak per device:** no device was busy in any sample'
      );
    });

    it('renderResourceSection prints the most frequent D-state waits', () => {
      const md = renderResourceSection(
        measured({
          dStateWaits: [
            { wchan: 'folio_wait_bit_common', seen: 41 },
            { wchan: 'btrfs_commit_transaction', seen: 9 },
          ],
        })
      ).join('\n');

      expect(md).toContain(
        '**Most frequent D-state waits, threads seen in each summed over the samples:** ' +
          '`folio_wait_bit_common` ×41 · `btrfs_commit_transaction` ×9'
      );
    });

    it('renderResourceSection says no thread was seen in D state when none was', () => {
      const md = renderResourceSection(measured({ dStateWaits: [] })).join('\n');

      expect(md).toContain('**Most frequent D-state waits:** no thread was seen in D state');
    });

    it('renderResourceSection prints the RAM root’s peak against what the run’s workers need', () => {
      const md = renderResourceSection(measured({ ramRootPeakBytes: 812 * MIB })).join('\n');

      expect(md).toContain(
        `**E2E RAM root, peak use:** 812 MiB of the ${String(ramRootRequiredBytes(12) / MIB)} MiB ` +
          'a run of 12 workers is sized for'
      );
    });

    it('renderResourceSection prints the RAM root’s peak alone for a run that never began', () => {
      const md = renderResourceSection({
        ...resources,
        summary: { ...resources.summary, ramRootPeakBytes: 812 * MIB },
      }).join('\n');

      expect(md).toContain('**E2E RAM root, peak use:** 812 MiB\n');
    });

    it('renderResourceSection states each Linux series as not measured when none was', () => {
      const md = renderResourceSection(measured({})).join('\n');

      expect(md).toContain('**Disk utilisation, peak per device:** not measured');
      expect(md).toContain('**Most frequent D-state waits:** not measured');
      expect(md).toContain('**E2E RAM root, peak use:** not measured');
    });

    it('renderResourceSection prints the three lines a fixture timeline yields', () => {
      const timeline: ResourceSample[] = [0, 2000].map((t, index) => ({
        t,
        cpuPct: 10,
        memPct: 10,
        load1: 1,
        disks: [{ device: 'loop3', utilisationPct: 60 + index * 30, inFlight: 12 }],
        btrfs: [{ devices: ['loop3'], commits: 1, commitMs: 900 }],
        dState: { folio_wait_bit_common: 2 + index },
        ramRootBytes: (300 + index * 100) * MIB,
      }));
      const md = renderResourceSection({
        ...resources,
        workers: 7,
        summary: { ...summarizeSamples(timeline, 4000), isolateStalls: null },
        samples: timeline,
      }).join('\n');

      expect(md).toContain('**Disk utilisation, peak per device:** loop3 90%');
      expect(md).toContain('`folio_wait_bit_common` ×5');
      expect(md).toContain(
        `**E2E RAM root, peak use:** 400 MiB of the ${String(ramRootRequiredBytes(7) / MIB)} MiB ` +
          'a run of 7 workers is sized for'
      );
    });

    it('generateMarkdownReport includes the resource section when present', () => {
      const report = emptyReport();
      report.resources = resources;
      expect(generateMarkdownReport(report)).toContain('## Resource Usage');
    });

    it('generateJsonReport embeds a lean resources object (no samples)', () => {
      const report = emptyReport();
      report.resources = resources;
      const json = generateJsonReport(report);
      expect(json.resources?.scan.totalHits).toBe(7);
      expect(json.resources?.summary.cpu.peak).toBe(62);
      expect(json.resources).not.toHaveProperty('samples');
    });

    it('writeReport emits resource-timeline.json when resources are present', () => {
      const report = emptyReport();
      report.resources = resources;
      const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-res-'));
      try {
        const out = writeReport(report, dir);
        const timeline = path.join(out, 'resource-timeline.json');
        expect(existsSync(timeline)).toBe(true);
        expect(JSON.parse(readFileSync(timeline, 'utf8'))).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('API isolate freezes', () => {
    const resourcesWith = (isolateStalls: IsolateStall[] | null): ResourceReport => ({
      summary: {
        durationMs: 60_000,
        sampleCount: 30,
        cores: 4,
        totalMemBytes: 8 * 1024 ** 3,
        cpu: { peak: 10, avg: 5 },
        mem: { peak: 10, avg: 5 },
        load: { peak: 1 },
        isolateStalls,
        diskPeaks: null,
        dStateWaits: null,
        ramRootPeakBytes: null,
      },
      samples: [],
      scan: { totalHits: 0, categories: [] },
    });

    const released: IsolateStall = {
      onsetAfterMs: 2005,
      onsetByMs: 4000,
      releaseMs: 14_750,
      seconds: 10.75,
    };

    it('renderIsolateStallSection returns nothing without resources', () => {
      expect(renderIsolateStallSection()).toEqual([]);
    });

    it('states that isolate freezes were not measured when no heap probe was sent', () => {
      const md = renderIsolateStallSection(resourcesWith(null)).join('\n');

      expect(md).toContain('## API Isolate Freezes');
      expect(md).toContain('Not measured');
    });

    it('states that no isolate froze when the probe saw no freeze', () => {
      const md = renderIsolateStallSection(resourcesWith([])).join('\n');

      expect(md).toContain('None:');
      expect(md).not.toContain('Not measured');
    });

    it('renders each freeze with its onset bracket, release and length', () => {
      const md = renderIsolateStallSection(resourcesWith([released])).join('\n');

      expect(md).toContain('| 2.01 s | 4.00 s | 14.75 s | 10.75 s |');
    });

    it('totals the freezes it lists', () => {
      const md = renderIsolateStallSection(
        resourcesWith([released, { ...released, seconds: 2.5 }])
      ).join('\n');

      expect(md).toContain('2 windows, 13.25 s in all');
    });

    it('counts a single freeze in the singular', () => {
      const md = renderIsolateStallSection(resourcesWith([released])).join('\n');

      expect(md).toContain('1 window, 10.75 s in all');
    });

    it('renders a freeze no reply ended as unreleased', () => {
      const md = renderIsolateStallSection(resourcesWith([{ ...released, releaseMs: null }])).join(
        '\n'
      );

      expect(md).toContain('| 2.01 s | 4.00 s | no reply | 10.75 s |');
    });

    it('renders a freeze no reply preceded with no lower onset bound', () => {
      const md = renderIsolateStallSection(
        resourcesWith([{ ...released, onsetAfterMs: null }])
      ).join('\n');

      expect(md).toContain('| no earlier reply | 4.00 s | 14.75 s | 10.75 s |');
    });

    it('generateMarkdownReport includes the isolate freeze section', () => {
      const report = generateDebugReport({
        suites: [],
        config: {},
        projects: [],
        stats: { duration: 1000 },
      });
      report.resources = resourcesWith(null);

      expect(generateMarkdownReport(report)).toContain('## API Isolate Freezes');
    });

    it('keeps a not-measured verdict in report.json rather than dropping it', () => {
      const report = generateDebugReport({
        suites: [],
        config: {},
        projects: [],
        stats: { duration: 1000 },
      });
      report.resources = resourcesWith(null);

      expect(generateJsonReport(report).resources?.summary.isolateStalls).toBeNull();
    });
  });

  describe('privacy of the emitted report', () => {
    let temporaryDir: string;

    afterEach(() => {
      vi.useRealTimers();
      if (temporaryDir && existsSync(temporaryDir)) {
        rmSync(temporaryDir, { recursive: true, force: true });
      }
    });

    /**
     * Every file under an emitted report tree, in the privacy gate's own blob
     * shape. The path is relative to the report directory so an emitted `.md`
     * still reads as prose to the rules that apply only there.
     */
    function emittedBlobs(reportDir: string): TextBlobEntry[] {
      return readdirSync(reportDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const absolute = path.join(entry.parentPath, entry.name);
          return {
            path: path.relative(reportDir, absolute).split(path.sep).join('/'),
            bytes: readFileSync(absolute),
          };
        });
    }

    /**
     * The repository's own privacy gate over an emitted report, with an empty
     * allowlist: a report is written from scratch on every run, so it must need
     * no exemption. The gate is imported rather than reimplemented — a second
     * copy of these rules would drift from the one the hooks run
     * (`docs/CODE-RULES.md` §One Implementation, Shared).
     *
     * The enumeration is the whole tree rather than a list of expected names,
     * so a file the reporter starts writing later is covered without this
     * helper being edited. That is the hole the guard exists to close: the
     * shipped gates enumerate through git, and the report tree is git-ignored,
     * so no gate has ever read a generated report.
     */
    function privacyFindingsOf(reportDir: string): GateFindings {
      return scanBlobs(emittedBlobs(reportDir), []);
    }

    /**
     * Mid-day, so the clock the reporter reads is one the rules report rather
     * than one the day-boundary carve-out exempts. Frozen at midnight a full
     * ISO timestamp passes, and the guard would prove nothing.
     */
    const RUN_INSTANT = TEST_DAY_START + 14 * HOUR_MS;

    /**
     * A synthetic checkout root. The reporter's real root is its working
     * directory, but a fixture built from that one emits a different file set
     * depending on which artifacts happen to exist on the machine running the
     * suite, and the guard's whole value is that its verdict is the same
     * everywhere.
     */
    const REPO_ROOT = path.join(path.sep, 'srv', 'checkout');

    /** The sole failed entry of a generated JSON report, refusing an empty one. */
    function soleFailedEntry(report: DebugReport, repoRoot: string): JsonTestEntry {
      const entry = generateJsonReport(report, repoRoot).failed[0];
      if (entry === undefined) throw new Error('the generated report has no failed entry');
      return entry;
    }

    /**
     * A repo-relative artifact path resolved back to the file it names. A
     * relative path that does not resolve is worse than the absolute one it
     * replaced, because it looks correct.
     */
    function resolvedFromRoot(repoRoot: string, artifactPath: string | undefined): string {
      if (artifactPath === undefined) throw new Error('the entry carries no artifact path');
      return path.resolve(repoRoot, artifactPath);
    }

    /**
     * A run carrying a failure, a flake and a pass, with the absolute artifact
     * paths Playwright hands a reporter. Absolute inputs are the point: a fixture
     * of already-relative paths would pass whatever the reporter did with them.
     */
    function playwrightRun(repoRoot: string): PlaywrightReport {
      const artifactDir = path.join(repoRoot, 'test-results', 'chat-send-chromium');
      const attachments: PlaywrightAttachment[] = [
        { name: 'trace', path: path.join(artifactDir, 'trace.zip') },
        { name: 'screenshot', path: path.join(artifactDir, 'test-failed-1.png') },
        { name: 'video', path: path.join(artifactDir, 'video.webm') },
        { name: 'har-api', path: path.join(artifactDir, 'network.har') },
        { name: 'console-errors-page', body: 'TypeError: cannot read properties of null' },
        { name: 'api-errors-page', body: '500 POST /api/chat' },
        { name: 'page-snapshot-page', body: '- main:\n  - button "Send"' },
      ];
      const failing: PlaywrightTestResult = {
        status: 'failed',
        retry: 0,
        duration: 1200,
        errors: [{ message: 'expect(locator).toBeVisible() failed' }],
        steps: [{ title: 'click Send', duration: 120 }],
        attachments,
      };
      return {
        suites: [
          {
            title: 'chat',
            file: 'e2e/chat/send.spec.ts',
            specs: [
              {
                title: 'sends a message',
                file: 'e2e/chat/send.spec.ts',
                line: 12,
                tests: [
                  {
                    projectName: 'chromium',
                    status: 'unexpected',
                    expectedStatus: 'passed',
                    results: [failing],
                  },
                ],
              },
              {
                title: 'retries a message',
                file: 'e2e/chat/send.spec.ts',
                line: 40,
                tests: [
                  {
                    projectName: 'webkit',
                    status: 'flaky',
                    expectedStatus: 'passed',
                    results: [failing, { status: 'passed', retry: 1, duration: 800 }],
                  },
                ],
              },
              {
                title: 'lists conversations',
                file: 'e2e/chat/send.spec.ts',
                line: 80,
                tests: [
                  {
                    projectName: 'chromium',
                    status: 'expected',
                    expectedStatus: 'passed',
                    results: [{ status: 'passed', retry: 0, duration: 300 }],
                  },
                ],
              },
            ],
          },
        ],
        config: {},
        projects: [],
        stats: { duration: 90_000 },
        status: 'failed',
        errors: ['global setup failed: the web server never answered'],
      };
    }

    function writeFixtureReport(): string {
      freezeClock(RUN_INSTANT);
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-privacy-'));
      const report = generateDebugReport(playwrightRun(REPO_ROOT));
      report.resources = {
        summary: {
          durationMs: 90_000,
          sampleCount: 2,
          cores: 24,
          totalMemBytes: 32 * 1024 ** 3,
          cpu: { peak: 62, avg: 38 },
          mem: { peak: 44, avg: 30 },
          load: { peak: 19 },
          isolateStalls: [
            { onsetAfterMs: 2005, onsetByMs: 4000, releaseMs: 14_750, seconds: 10.75 },
          ],
          diskPeaks: [{ device: 'loop3', peakUtilisationPct: 100 }],
          dStateWaits: [{ wchan: 'folio_wait_bit_common', seen: 4 }],
          ramRootPeakBytes: 512 * 1024 ** 2,
        },
        samples: [
          {
            t: 0,
            cpuPct: 62,
            memPct: 44,
            load1: 19,
            disks: [{ device: 'loop3', utilisationPct: 100, inFlight: 31.5 }],
            btrfs: [{ devices: ['loop3'], commits: 2, commitMs: 4100 }],
            dState: { folio_wait_bit_common: 4 },
            ramRootBytes: 512 * 1024 ** 2,
          },
        ],
        scan: { totalHits: 0, categories: [] },
      };
      return writeReport(report, path.join(temporaryDir, 'report'), REPO_ROOT);
    }

    it('enumerates every file the report tree holds, per-test artifacts included', () => {
      const reportDir = writeFixtureReport();

      const emitted = emittedBlobs(reportDir).map((blob) => blob.path);

      // Pinned rather than sampled: a guard whose enumeration silently returned
      // nothing would report no findings and look green.
      expect(new Set(emitted)).toEqual(
        new Set([
          'REPORT.md',
          'failed/e2e-chat-send-spec-ts-chromium-sends-a-message/api-errors.txt',
          'failed/e2e-chat-send-spec-ts-chromium-sends-a-message/console-errors.txt',
          'failed/e2e-chat-send-spec-ts-chromium-sends-a-message/error.txt',
          'failed/e2e-chat-send-spec-ts-chromium-sends-a-message/page-snapshot.txt',
          'failed/e2e-chat-send-spec-ts-chromium-sends-a-message/steps.json',
          'flaky/e2e-chat-send-spec-ts-webkit-retries-a-message/api-errors.txt',
          'flaky/e2e-chat-send-spec-ts-webkit-retries-a-message/console-errors.txt',
          'flaky/e2e-chat-send-spec-ts-webkit-retries-a-message/error.txt',
          'flaky/e2e-chat-send-spec-ts-webkit-retries-a-message/page-snapshot.txt',
          'flaky/e2e-chat-send-spec-ts-webkit-retries-a-message/steps.json',
          'report.json',
          'resource-timeline.json',
        ])
      );
    });

    it('emits no file the privacy gate reports on', () => {
      const reportDir = writeFixtureReport();

      const findings = privacyFindingsOf(reportDir);

      expect(formatGateReport(findings)).toBe(
        'Privacy gate: no findings. Both gates examined every blob in scope.'
      );
      expect(isBlocked(findings)).toBe(false);
    });

    it('reports a clock reading written back into an emitted file', () => {
      const reportDir = writeFixtureReport();
      const jsonPath = path.join(reportDir, 'report.json');
      const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(jsonPath, JSON.stringify({ ...json, timestamp: isoAt(RUN_INSTANT) }, null, 2));

      const findings = privacyFindingsOf(reportDir);

      expect(findings.text.map((finding) => finding.rule)).toContain('iso-datetime');
      expect(isBlocked(findings)).toBe(true);
    });

    it('reports an absolute artifact path written back into an emitted file', () => {
      const reportDir = writeFixtureReport();
      const jsonPath = path.join(reportDir, 'report.json');
      const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as { failed: JsonTestEntry[] };
      const entry = json.failed[0];
      if (entry === undefined) throw new Error('the fixture report has no failed test');
      entry.artifacts.trace = path.join(
        path.sep,
        'home',
        'someone',
        'checkout',
        'test-results',
        'trace.zip'
      );
      writeFileSync(jsonPath, JSON.stringify(json, null, 2));

      const findings = privacyFindingsOf(reportDir);

      expect(findings.text.map((finding) => finding.rule)).toContain('absolute-host-path');
      expect(isBlocked(findings)).toBe(true);
    });

    it('dates report.json to the day, carrying no time of day', () => {
      const reportDir = writeFixtureReport();

      const json = JSON.parse(
        readFileSync(path.join(reportDir, 'report.json'), 'utf8')
      ) as JsonReport;

      expect(json.date).toBe(isoAt(RUN_INSTANT).slice(0, 10));
      expect(json).not.toHaveProperty('timestamp');
    });

    it('renders artifact paths relative to the repository root', () => {
      const repoRoot = path.join(path.sep, 'srv', 'checkout');
      const artifactDir = path.join(repoRoot, 'test-results', 'broken-chromium');
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'boom',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: path.join(artifactDir, 'trace.zip'),
              screenshot: path.join(artifactDir, 'test-failed-1.png'),
              video: path.join(artifactDir, 'video.webm'),
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [path.join(artifactDir, 'network.har')],
            },
          },
        ],
      };

      const { artifacts } = soleFailedEntry(report, repoRoot);

      expect(artifacts.trace).toBe(path.join('test-results', 'broken-chromium', 'trace.zip'));
      expect(artifacts.screenshot).toBe(
        path.join('test-results', 'broken-chromium', 'test-failed-1.png')
      );
      expect(artifacts.video).toBe(path.join('test-results', 'broken-chromium', 'video.webm'));
      expect(artifacts.harFiles).toEqual([
        path.join('test-results', 'broken-chromium', 'network.har'),
      ]);
      expect(resolvedFromRoot(repoRoot, artifacts.trace)).toBe(path.join(artifactDir, 'trace.zip'));
    });

    it('omits an artifact path that has no repo-relative form', () => {
      const repoRoot = path.join(path.sep, 'srv', 'checkout');
      const elsewhere = path.join(path.sep, 'home', 'someone', 'elsewhere');
      const report: DebugReport = {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'boom',
            duration: 1000,
            steps: [],
            artifacts: {
              trace: path.join(elsewhere, 'trace.zip'),
              screenshot: undefined,
              video: undefined,
              consoleErrors: undefined,
              apiErrors: undefined,
              pageSnapshot: undefined,
              harFiles: [path.join(elsewhere, 'network.har')],
            },
          },
        ],
      };

      const { artifacts } = soleFailedEntry(report, repoRoot);

      expect(artifacts.trace).toBeUndefined();
      expect(artifacts.harFiles).toEqual([]);
    });
  });

  describe('report.json pointers to artifacts kept outside the checkout', () => {
    let temporaryDir = '';

    afterEach(() => {
      rmSync(temporaryDir, { recursive: true, force: true });
    });

    /**
     * A checkout, and an output directory beside it rather than inside it, as
     * Playwright's is when it lives on a RAM filesystem.
     */
    function scratchLayout(): { repoRoot: string; outputDir: string; baseDir: string } {
      temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-outside-'));
      const repoRoot = path.join(temporaryDir, 'checkout');
      const outputDir = path.join(temporaryDir, 'ram-root', 'test-results', 'broken-chromium');
      mkdirSync(repoRoot, { recursive: true });
      mkdirSync(outputDir, { recursive: true });
      return { repoRoot, outputDir, baseDir: path.join(repoRoot, 'e2e', 'report') };
    }

    function artifactsOf(overrides: Partial<FailedTestArtifacts>): FailedTestArtifacts {
      return {
        trace: undefined,
        screenshot: undefined,
        video: undefined,
        consoleErrors: undefined,
        apiErrors: undefined,
        pageSnapshot: undefined,
        harFiles: [],
        ...overrides,
      };
    }

    function failedReport(artifacts: FailedTestArtifacts): DebugReport {
      return {
        summary: { total: 1, passed: 0, flaky: 0, failed: 1, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [],
        failed: [
          {
            title: 'broken',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attempts: 1,
            attemptStatus: 'failed',
            attemptRetry: 0,
            error: 'boom',
            duration: 1000,
            steps: [],
            artifacts,
          },
        ],
      };
    }

    function flakyReport(artifacts: FailedTestArtifacts): DebugReport {
      return {
        summary: { total: 1, passed: 0, flaky: 1, failed: 0, duration: 1000 },
        didNotRun: [],
        skipped: [],
        passed: [],
        flaky: [
          {
            title: 'intermittent',
            file: 'e2e/test.spec.ts',
            project: 'chromium',
            attemptStatus: 'failed',
            attemptRetry: 0,
            attempts: 2,
            error: 'race',
            duration: 1000,
            steps: [],
            artifacts,
          },
        ],
        failed: [],
      };
    }

    const FAILED_SLUG = 'e2e-test-spec-ts-chromium-broken';

    function readJson(reportDir: string): JsonReport {
      return JSON.parse(readFileSync(path.join(reportDir, 'report.json'), 'utf8')) as JsonReport;
    }

    it("names the report directory's copy of a failing test's trace", () => {
      const { repoRoot, outputDir, baseDir } = scratchLayout();
      const trace = makeTraceZip(outputDir, 'trace.zip', { 'test.trace': '{}' });

      const reportDir = writeReport(failedReport(artifactsOf({ trace })), baseDir, repoRoot);

      expect(readJson(reportDir).failed[0]?.artifacts.trace).toBe(
        path.relative(repoRoot, path.join(reportDir, 'failed', FAILED_SLUG, 'trace'))
      );
    });

    it("names the report directory's copy of a flaky test's trace", () => {
      const { repoRoot, outputDir, baseDir } = scratchLayout();
      const trace = makeTraceZip(outputDir, 'trace.zip', { 'test.trace': '{}' });

      const reportDir = writeReport(flakyReport(artifactsOf({ trace })), baseDir, repoRoot);

      expect(readJson(reportDir).flaky[0]?.artifacts.trace).toBe(
        path.relative(
          repoRoot,
          path.join(reportDir, 'flaky', 'e2e-test-spec-ts-chromium-intermittent', 'trace')
        )
      );
    });

    it('renders no trace pointer where the report directory holds no copy of it', () => {
      const { repoRoot, outputDir, baseDir } = scratchLayout();
      const trace = path.join(outputDir, 'trace.zip');

      const reportDir = writeReport(failedReport(artifactsOf({ trace })), baseDir, repoRoot);

      expect(readJson(reportDir).failed[0]?.artifacts.trace).toBeUndefined();
    });

    it("names the report directory's copy of a screenshot", () => {
      const { repoRoot, outputDir, baseDir } = scratchLayout();
      const screenshot = path.join(outputDir, 'test-failed-1.png');
      writeFileSync(screenshot, 'png');

      const reportDir = writeReport(failedReport(artifactsOf({ screenshot })), baseDir, repoRoot);

      expect(readJson(reportDir).failed[0]?.artifacts.screenshot).toBe(
        path.relative(repoRoot, path.join(reportDir, 'failed', FAILED_SLUG, 'screenshot.png'))
      );
    });

    it('names the one merged network log for every HAR file it was merged from', () => {
      const { repoRoot, outputDir, baseDir } = scratchLayout();
      const harFiles = ['page.har', 'api.har'].map((name) => {
        const harPath = path.join(outputDir, name);
        writeFileSync(harPath, JSON.stringify({ log: { entries: [{ request: name }] } }));
        return harPath;
      });

      const reportDir = writeReport(failedReport(artifactsOf({ harFiles })), baseDir, repoRoot);

      expect(readJson(reportDir).failed[0]?.artifacts.harFiles).toEqual([
        path.relative(repoRoot, path.join(reportDir, 'failed', FAILED_SLUG, 'network.har')),
      ]);
    });

    it('renders no pointer for a video, of which the report directory keeps no copy', () => {
      const { repoRoot, outputDir, baseDir } = scratchLayout();
      const video = path.join(outputDir, 'video.webm');
      writeFileSync(video, 'webm');

      const reportDir = writeReport(failedReport(artifactsOf({ video })), baseDir, repoRoot);

      expect(readJson(reportDir).failed[0]?.artifacts.video).toBeUndefined();
    });

    it('keeps naming an artifact inside the checkout where it lies', () => {
      const { repoRoot, baseDir } = scratchLayout();
      const inside = path.join(repoRoot, 'test-results', 'broken-chromium');
      mkdirSync(inside, { recursive: true });
      const trace = makeTraceZip(inside, 'trace.zip', { 'test.trace': '{}' });

      const reportDir = writeReport(failedReport(artifactsOf({ trace })), baseDir, repoRoot);

      expect(readJson(reportDir).failed[0]?.artifacts.trace).toBe(
        path.join('test-results', 'broken-chromium', 'trace.zip')
      );
    });
  });
});
