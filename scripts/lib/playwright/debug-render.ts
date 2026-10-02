/**
 * Rendering a debug report for a reader: the text primitives every rendered
 * field goes through, and the markdown document the report directory leads with.
 */

import path from 'node:path';
import { isOutsideRoot } from '../path-containment.js';
import { computeProjectGrepInvert } from './browser-matrix.js';
import { ramRootRequiredBytes } from '../stack/ram-root.js';
import { BROWSER_MATRIX_PROJECTS } from './projects.js';
import { ISOLATE_STALL_MS } from './stall-windows.js';
import type {
  CoverageReport,
  DebugReport,
  FailedTest,
  FailedTestArtifacts,
  FlakyTest,
  FlattenedTestResult,
  PassedTest,
  PlaywrightStep,
  UnrunTest,
} from './debug-shapes.js';
import type { ResourceReport, ResourceSummary } from '../../resource-sampler.js';

// eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- an ANSI escape sequence opens with a control character, so matching one means naming it.
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

/** Whether the matrix would route a run of these projects, which is what the config asks of it. */
function matrixAcceptsRun(run: readonly string[]): boolean {
  try {
    for (const project of BROWSER_MATRIX_PROJECTS) computeProjectGrepInvert(project, run);
    return true;
  } catch {
    return false;
  }
}

/**
 * The projects a rerun of `project` must name for the harness to collect it.
 *
 * A `--project` selection IS the run the matrix routes against, so a run of one
 * non-chromium desktop project comprises desktop work while carrying no project
 * that can run desktop's engine-pinned specs, and the matrix refuses it before a
 * test is collected. Widening the run is what the refusal asks for, and the
 * failing project stays in it so the rerun still runs on the engine it failed on.
 *
 * Which projects to add is decided by asking the matrix which runs it accepts,
 * never by naming an engine here: a pin added to or removed from the matrix
 * moves this command with it instead of silently re-breaking it. Carriers are
 * offered in registry order, which is carrier-preference order, and the run is
 * returned as soon as the matrix accepts it — so a run it already accepts is
 * returned untouched, and a matrix that grows a second pin is answered by
 * widening further rather than by a second engine named here.
 */
function resolveRerunProjects(project: string): readonly string[] {
  const run = [project];
  for (const carrier of BROWSER_MATRIX_PROJECTS.filter((name) => name !== project)) {
    if (matrixAcceptsRun(run)) return run;
    run.push(carrier);
  }
  return run;
}

/**
 * Whether the regex grammar reads this character as syntax rather than as itself.
 *
 * Asked of the engine rather than matched against a list of metacharacters: a
 * list is a census that goes stale the moment the dialect gains one, while a
 * character whose own pattern will not compile, does not consume it when it
 * matches, or matches a character it is not, is syntax by observation in
 * whichever dialect is running.
 */
function isRegExpSyntax(character: string): boolean {
  const foreign = character === 'a' ? 'b' : 'a';
  try {
    const pattern = new RegExp(character);
    return character.replace(pattern, '') !== '' || pattern.test(foreign);
  } catch {
    return true;
  }
}

/**
 * Printable ASCII: every character either grammar in play here — the regex the
 * runner compiles, the shell that hands it over — draws its syntax from. What
 * falls outside can be read only as itself by both.
 */
const PRINTABLE_ASCII = /[ -~]/g;

/** Letters, digits, the underscore and the space, which neither grammar acts on. */
const INERT_CHARACTER = /[\w ]/;

/**
 * Every character of `text` that either grammar could act on, escaped, whatever
 * the company it keeps. This is what a title falls back to when the escaping
 * below cannot be read back as the title itself.
 */
function escapeEveryCharacter(text: string): string {
  return text.replaceAll(PRINTABLE_ASCII, (character) =>
    INERT_CHARACTER.test(character) ? character : '\\' + character
  );
}

/** The shape the runner reads as a regex literal with its own flags, not as a pattern. */
const DELIMITED_LITERAL = /^\/.*\/[gi]*$/;

/**
 * Whether the runner, handed this pattern, would select exactly `title`.
 *
 * A pattern shaped like a delimited literal answers no whatever it matches: the
 * runner reads that shape as a regex literal carrying its own flags rather than
 * as the pattern that was built (playwright's `forceRegExp`), so the argument it
 * would act on is not the one measured here.
 */
function selectsExactly(pattern: string, title: string): boolean {
  if (DELIMITED_LITERAL.test(pattern)) return false;
  try {
    return new RegExp(pattern, 'gi').exec(title)?.[0] === title;
  } catch {
    return false;
  }
}

/**
 * A `-g` argument that selects exactly `title`.
 *
 * `-g` is a regex, so a title carrying grammar — a quantifier, a group, a
 * wildcard — selects something other than itself or nothing at all, while the
 * printed command still looks like it worked. Per-character escaping is checked
 * against what the runner would select before it is returned, because a
 * character can be syntax in company it is not alone (`{` opens a quantifier
 * only before digits); an escape the runner would not select the title with
 * gives way to escaping every character, which no grammar can read as
 * anything else.
 */
function buildGrepPattern(title: string): string {
  const escaped = title.replaceAll(PRINTABLE_ASCII, (character) =>
    isRegExpSyntax(character) ? '\\' + character : character
  );
  return selectsExactly(escaped, title) ? escaped : escapeEveryCharacter(title);
}

/**
 * Backslash-escape what a shell still expands inside double quotes: `$`, a
 * backtick, `"`, and the backslash itself (POSIX §2.2.3 Double-Quotes). It runs
 * over the escaped pattern, so a backslash the regex escaping produced is doubled
 * here and the shell hands the runner back the pattern that was built.
 */
function quoteForDoubleQuotes(argument: string): string {
  return argument.replaceAll(/[$`"\\]/g, String.raw`\$&`);
}

export function buildRerunCommand(test: { title: string; file: string; project: string }): string {
  const escapedTitle = quoteForDoubleQuotes(buildGrepPattern(test.title));
  const projects = resolveRerunProjects(test.project)
    .map((project) => `--project=${project}`)
    .join(' ');
  return `pnpm e2e -- ${test.file} -g "${escapedTitle}" ${projects}`;
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

// A run is a failure when any test failed, the run carries a non-passed status
// (aborted/timed-out/interrupted), or a run-level error was reported. The last
// two matter when zero tests ran: a global abort must never render as PASSED.
function isRunFailed(report: DebugReport): boolean {
  if (report.summary.failed > 0) return true;
  if ((report.globalErrors ?? []).length > 0) return true;
  return report.status !== undefined && report.status !== 'passed';
}

/**
 * The pass count above reads as a claim about the whole matrix; these numbers are
 * what make it falsifiable. Both halves count one predicate — a test that produced
 * a result, which a skip does — so neither says "ran". Neither denominator is the
 * run's configured set: a project a filter emptied leaves no test to count.
 */
function renderCoverageLine(coverage: CoverageReport | undefined): string[] {
  if (!coverage) return [];
  return [
    `**Coverage:** ${String(coverage.executedProjects)} of ${String(coverage.projectsInReport)} projects in the report produced results (${String(coverage.executedTests)} of ${String(coverage.testsInReport)} tests in the report produced results)`,
  ];
}

function renderHeader(report: DebugReport): string[] {
  const { summary } = report;
  const status = isRunFailed(report) ? 'FAILED' : 'PASSED';
  return [
    '# E2E Test Report',
    '',
    // Day resolution, like the run directory name beside it: a report is an
    // artifact, and `docs/AGENT-RULES.md` §Privacy caps a written date at a day.
    // The directory's run ordinal carries the ordering a time of day was buying.
    `**Date:** ${new Date().toISOString().slice(0, 10)}`,
    `**Duration:** ${formatDuration(summary.duration)}`,
    `**Result:** ${status} (${String(summary.passed)} passed, ${String(summary.flaky)} flaky, ${String(summary.failed)} failed)`,
    ...renderCoverageLine(report.coverage),
  ];
}

export const GLOBAL_ERRORS_HEADING = 'Global Errors';

/**
 * The run-level error for a report whose lists miss a test with a result. It
 * escalates as a lost project does, because a test missing from every list
 * reads as one that passed. The report appends these entries and Global Errors
 * counts them through this one function, so the two cannot disagree on how many
 * there are.
 */
export function unlistedResultErrors(coverage: CoverageReport): string[] {
  if (coverage.unlistedTests === 0) return [];
  return [
    `Unlisted results: the tests in the report that produced results (${String(coverage.executedTests)}) include ${String(coverage.unlistedTests)} that no report list holds. ` +
      'Each such test belongs in exactly one of failed, flaky, did not run, skipped or passed, so its ' +
      'outcome is unaccounted for, not passed.',
  ];
}

export function renderGlobalErrors(report: DebugReport): string[] {
  const errors = report.globalErrors ?? [];
  if (errors.length === 0) return [];

  // `scripts/lib/playwright/debug.ts` appends to the harness's own errors one entry per
  // `coverage.lost` project and the entries of {@link unlistedResultErrors}, so any entry
  // beyond those came from the harness.
  const { coverage } = report;
  const unlistedEntries = coverage === undefined ? 0 : unlistedResultErrors(coverage).length;
  const harnessErrors = errors.length - (coverage?.lost.length ?? 0) - unlistedEntries;
  const scope =
    'Run-level errors not tied to a single test (global setup, a webServer, output-directory cleanup, a configured project that produced no result, or a test with a result that no report list holds).';
  const lines = [
    '',
    '---',
    '',
    `## ${GLOBAL_ERRORS_HEADING}`,
    '',
    harnessErrors > 0
      ? `${scope} The run did not complete normally.`
      : `${scope} Every entry here is a finding this report derived from the results rather than an error the harness raised, which a run that completed leaves as readily as one that ended early, so this section does not say which this run was.`,
  ];
  for (const error of errors) {
    lines.push('', '```', stripAnsi(error), '```');
  }
  return lines;
}

const NOT_MEASURED = 'not measured';

/** The devices that were ever busy, which are the ones a stall can be laid at. */
function renderDiskLine(peaks: ResourceSummary['diskPeaks']): string {
  const label = '**Disk utilisation, peak per device:**';
  if (peaks === null) return `${label} ${NOT_MEASURED}`;
  const busy = peaks.filter(({ peakUtilisationPct }) => peakUtilisationPct > 0);
  if (busy.length === 0) return `${label} no device was busy in any sample`;
  const listed = busy.map(
    ({ device, peakUtilisationPct }) => `${device} ${String(peakUtilisationPct)}%`
  );
  return `${label} ${listed.join(' · ')}`;
}

function renderDStateLine(waits: ResourceSummary['dStateWaits']): string {
  if (waits === null) return `**Most frequent D-state waits:** ${NOT_MEASURED}`;
  if (waits.length === 0) return '**Most frequent D-state waits:** no thread was seen in D state';
  const listed = waits.map(({ wchan, seen }) => `\`${wchan}\` ×${String(seen)}`);
  return `**Most frequent D-state waits, threads seen in each summed over the samples:** ${listed.join(' · ')}`;
}

const MIB = 1024 ** 2;

function mebibytes(bytes: number): string {
  return `${String(Math.round(bytes / MIB))} MiB`;
}

/** The RAM root's peak, against what {@link ramRootRequiredBytes} sizes a run of its workers for. */
function renderRamRootLine(peakBytes: number | null, workers: number | undefined): string {
  const label = '**E2E RAM root, peak use:**';
  if (peakBytes === null) return `${label} ${NOT_MEASURED}`;
  if (workers === undefined) return `${label} ${mebibytes(peakBytes)}`;
  return (
    `${label} ${mebibytes(peakBytes)} of the ${mebibytes(ramRootRequiredBytes(workers))} ` +
    `a run of ${String(workers)} workers is sized for`
  );
}

export function renderResourceSection(resources?: ResourceReport): string[] {
  if (!resources) return [];
  const { summary, scan } = resources;
  const gib = (summary.totalMemBytes / 1024 ** 3).toFixed(1);
  const lines = [
    '',
    '## Resource Usage',
    '',
    `**Window:** ${formatDuration(summary.durationMs)} · ${String(summary.cores)} cores · ${gib}G RAM · ${String(summary.sampleCount)} samples`,
    '',
    '| Metric | Peak | Avg |',
    '| --- | --- | --- |',
    `| CPU | ${String(summary.cpu.peak)}% | ${String(summary.cpu.avg)}% |`,
    `| Memory | ${String(summary.mem.peak)}% | ${String(summary.mem.avg)}% |`,
    `| Load (1m) | ${String(summary.load.peak)} | — |`,
  ];
  if (summary.heap) {
    lines.push(`| API heap | ${String(summary.heap.peak)} MB | ${String(summary.heap.avg)} MB |`);
  }
  if (summary.heapOomAborts !== undefined) {
    lines.push('', `**API heap-OOM aborts:** ${String(summary.heapOomAborts)}`);
  }
  lines.push(
    '',
    renderDiskLine(summary.diskPeaks),
    '',
    renderDStateLine(summary.dStateWaits),
    '',
    renderRamRootLine(summary.ramRootPeakBytes, resources.workers)
  );

  if (scan.totalHits > 0) {
    lines.push('', `**Resource-limit errors:** ${String(scan.totalHits)}`);
    for (const c of scan.categories) {
      lines.push(`- ${c.name} ×${String(c.count)} (tests: ${c.tests.join(', ')})`);
    }
  }

  return lines;
}

/** A run-frame instant or length, in seconds to the hundredth, halves rounded up. */
function runSeconds(ms: number): string {
  return `${(Math.round(ms / 10) / 100).toFixed(2)} s`;
}

/**
 * The windows in which the API worker's isolate answered no heap probe, or the
 * statement that nothing measured them. A run with no freeze and a run nobody
 * watched must not read alike, so the two are worded apart.
 */
export function renderIsolateStallSection(resources?: ResourceReport): string[] {
  if (!resources) return [];
  const stalls = resources.summary.isolateStalls;
  const bound = runSeconds(ISOLATE_STALL_MS);
  const lines = ['', '## API Isolate Freezes', ''];
  if (stalls === null) {
    lines.push(
      'Not measured: no heap probe was sent, so the probe was off or never connected to the API worker.'
    );
    return lines;
  }
  if (stalls.length === 0) {
    lines.push(`None: no heap probe waited ${bound} or longer for its reply.`);
    return lines;
  }

  const totalSeconds = stalls.reduce((sum, stall) => sum + stall.seconds, 0);
  const windows = stalls.length === 1 ? 'window' : 'windows';
  lines.push(
    `${String(stalls.length)} ${windows}, ${runSeconds(totalSeconds * 1000)} in all, in which the API worker's isolate left a heap probe unanswered for ${bound} or longer. Instants are from the start of sampling, the frame of \`resource-timeline.json\`.`,
    '',
    '| Froze after | Froze by | Released | Length |',
    '| --- | --- | --- | --- |'
  );
  for (const stall of stalls) {
    const after = stall.onsetAfterMs === null ? 'no earlier reply' : runSeconds(stall.onsetAfterMs);
    const release = stall.releaseMs === null ? 'no reply' : runSeconds(stall.releaseMs);
    lines.push(
      `| ${after} | ${runSeconds(stall.onsetByMs)} | ${release} | ${runSeconds(stall.seconds * 1000)} |`
    );
  }
  return lines;
}

function truncateError(rawError: string): string {
  const error = stripAnsi(rawError);
  if (error.length > MAX_ERROR_LENGTH) {
    return error.slice(0, MAX_ERROR_LENGTH) + '\n... (truncated)';
  }
  return error;
}

/**
 * The error text, or a sentinel naming the attempt that recorded none. An
 * attempt legitimately carries no error text — `retain-on-first-failure` keeps
 * nothing for a retry that follows a passing attempt, and `chooseResult` may
 * pick exactly that one — and rendering that absence as blank leaves a failed
 * or flaky test indistinguishable from a passing one. The closing statement is
 * dropped when the chosen attempt itself passed, so the sentence never denies
 * the status it just printed.
 */
export function errorTextOrSentinel(
  text: string,
  attempt: Pick<FailedTest, 'attemptStatus' | 'attemptRetry'>
): string {
  if (text.trim() !== '') return text;
  const absence = `NO ERROR TEXT RECORDED. The chosen attempt (status ${attempt.attemptStatus}, retry ${String(attempt.attemptRetry)}) carried none`;
  if (attempt.attemptStatus === 'passed') return `${absence}.`;
  return `${absence}; this test did not pass.`;
}

/** A path relative to the repository root, or nothing for one outside it. */
function insideRoot(artifactPath: string, repoRoot: string): string | undefined {
  const relative = path.relative(repoRoot, artifactPath);
  if (relative === '' || isOutsideRoot(path, repoRoot, artifactPath)) return undefined;
  return relative;
}

/**
 * An artifact path expressed relative to the repository root, so a rendered
 * report never carries the absolute path of the machine that generated it
 * (`docs/AGENT-RULES.md` §Privacy). A path outside the root has no runnable
 * repo-relative form — and its relative form would still spell out the machine
 * layout — so it is named through `copy`, the report directory's copy of it,
 * where the caller has one, and callers render nothing for it otherwise.
 */
export function repoRelativeArtifactPath(
  artifactPath: string,
  repoRoot: string,
  copy?: string
): string | undefined {
  const relative = insideRoot(artifactPath, repoRoot);
  if (relative !== undefined || copy === undefined) return relative;
  return insideRoot(copy, repoRoot);
}

interface RenderableTest {
  title: string;
  file: string;
  line?: number | undefined;
  project: string;
  attemptStatus: FlattenedTestResult['status'];
  attemptRetry: number;
  duration: number;
  error: string;
  steps: PlaywrightStep[];
  artifacts: FailedTestArtifacts;
  attempts: number;
}

/** The extracted trace directory, plus the viewer command when the archive has a repo-relative form. */
function renderTraceLine(
  trace: string,
  artifactDir: 'failed' | 'flaky',
  slug: string,
  repoRoot: string
): string {
  const extracted = `**Trace:** \`${artifactDir}/${slug}/trace/\` (extracted)`;
  const relative = repoRelativeArtifactPath(trace, repoRoot);
  return relative === undefined
    ? extracted
    : `${extracted} or \`npx playwright show-trace ${relative}\` (viewer)`;
}

function renderSingleTest(
  test: RenderableTest,
  artifactDir: 'failed' | 'flaky',
  repoRoot: string
): string[] {
  const slug = slugify(`${test.file}--${test.project}--${test.title}`);
  const location = test.line ? `${test.file}:${String(test.line)}` : test.file;

  const attemptNoun = test.attempts === 1 ? 'attempt' : 'attempts';
  const header = `#### ${test.title} [${test.project}] (${String(test.attempts)} ${attemptNoun})`;

  const lines: string[] = [
    '',
    header,
    '',
    `**File:** \`${location}\``,
    `**Duration:** ${formatDuration(test.duration)}`,
    `**Re-run:** \`${buildRerunCommand(test)}\``,
    '',
    '**Error:**',
    '```',
    errorTextOrSentinel(truncateError(test.error), test),
    '```',
  ];

  if (test.steps.length > 0) {
    lines.push('', '**Steps:**', renderSteps(test.steps));
  }

  if (test.artifacts.consoleErrors) {
    lines.push('', `**Console Errors:** See \`${artifactDir}/${slug}/console-errors.txt\``);
  }

  if (test.artifacts.apiErrors) {
    lines.push(`**API Errors:** See \`${artifactDir}/${slug}/api-errors.txt\``);
  }

  if (test.artifacts.pageSnapshot) {
    lines.push(`**Page Snapshot:** See \`${artifactDir}/${slug}/page-snapshot.txt\``);
  }

  if (test.artifacts.trace) {
    lines.push(renderTraceLine(test.artifacts.trace, artifactDir, slug, repoRoot));
  }

  if (test.artifacts.screenshot) {
    lines.push(`**Screenshot:** \`${artifactDir}/${slug}/screenshot.png\``);
  } else {
    lines.push('**Screenshot:** none');
  }

  return lines;
}

function renderFailedTests(failed: FailedTest[], repoRoot: string): string[] {
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
      lines.push(...renderSingleTest(test, 'failed', repoRoot));
    }
  }

  return lines;
}

function renderFlakyTests(flaky: FlakyTest[], repoRoot: string): string[] {
  if (flaky.length === 0) return [];

  const lines: string[] = ['', '---', '', '## Flaky Tests'];

  const byFile = new Map<string, FlakyTest[]>();
  for (const test of flaky) {
    const existing = byFile.get(test.file) ?? [];
    existing.push(test);
    byFile.set(test.file, existing);
  }

  for (const [file, tests] of byFile) {
    lines.push('', `### \`${file}\``);
    for (const test of tests) {
      lines.push(...renderSingleTest(test, 'flaky', repoRoot));
    }
  }

  return lines;
}

function renderDidNotRunTests(didNotRun: UnrunTest[]): string[] {
  if (didNotRun.length === 0) return [];

  const lines: string[] = [
    '',
    '---',
    '',
    `## Did Not Run (${String(didNotRun.length)})`,
    '',
    'Each of these produced a result but no verdict: no attempt ran to completion, and none declared a skip. They are unproven, not passed.',
    '',
  ];
  for (const test of didNotRun) {
    const location = test.line ? `${test.file}:${String(test.line)}` : test.file;
    lines.push(`- ${test.title} [\`${location}\`] [${test.project}]`);
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
    lines.push(
      `- ${test.title} [\`${test.file}\`] [${test.project}] (${formatDuration(test.duration)})`
    );
  }
  lines.push('', '</details>');
  return lines;
}

export function generateMarkdownReport(report: DebugReport, repoRoot = process.cwd()): string {
  const lines: string[] = [
    ...renderHeader(report),
    ...renderGlobalErrors(report),
    ...renderResourceSection(report.resources),
    ...renderIsolateStallSection(report.resources),
    ...renderFailedTests(report.failed, repoRoot),
    ...renderFlakyTests(report.flaky, repoRoot),
    ...renderDidNotRunTests(report.didNotRun),
    ...renderPassedTests(report.passed),
    '',
    '---',
    '',
    '*This report is the single source of truth for E2E debugging. See `report.json` for structured data and `failed/` for per-test artifacts.*',
    '',
  ];
  return lines.join('\n');
}
