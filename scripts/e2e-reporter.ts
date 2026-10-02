/**
 * Custom Playwright Reporter — AI-Friendly E2E Debug Report
 *
 * Thin adapter: maps Playwright's live Suite/TestCase objects into the
 * existing PlaywrightReport shape from lib/playwright/debug.ts, then feeds it through
 * the existing generateDebugReport() → writeReport() pipeline.
 */

import path from 'node:path';
import { closeSync, copyFileSync, existsSync, openSync, readSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
  generateDebugReport,
  writeReport,
  type PlaywrightProject,
  type PlaywrightReport,
  type PlaywrightSuite,
  type PlaywrightSpec,
  type PlaywrightStep,
  type PlaywrightTest,
  type PlaywrightTestResult,
  type CoverageReport,
} from './lib/playwright/debug.js';
import { GLOBAL_ERRORS_HEADING } from './lib/playwright/debug-render.js';
import { apiHealthUrl } from './lib/playwright/api-health.js';
import { wranglerDebugLogPath, wranglerLogPath } from './wrangler-dev.js';
import {
  createApiLivenessWatchdog,
  createHealthProbe,
  type ApiLivenessProbe,
  type ApiLivenessWatchdog,
} from './api-liveness-watchdog.js';
import {
  createResourceSampler,
  formatResourceStdout,
  type ResourceReport,
  type ResourceSampler,
  type ResourceSamplerOptions,
} from './resource-sampler.js';
import { scoreWranglerDebugLog } from './lib/playwright/stall-windows.js';
import { scanResourceErrors, type ResourceScan, type ScanEntry } from './resource-scan.js';
import type {
  Reporter,
  FullResult,
  Suite,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';

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
    expectedStatus: test.expectedStatus,
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

export function buildPlaywrightReport(
  rootSuite: Suite | undefined,
  projects: readonly PlaywrightProject[],
  result: FullResult,
  globalErrors: string[] = []
): PlaywrightReport {
  return {
    suites: rootSuite ? rootSuite.suites.map((s) => mapSuite(s)) : [],
    config: {},
    projects,
    stats: { duration: result.duration },
    status: result.status,
    ...(globalErrors.length > 0 && { errors: globalErrors }),
  };
}

export interface ApiLivenessOptions {
  /** The URL the watchdog samples; quoted in the reason it records. */
  endpoint: string;
  /** Overridable for tests; defaults to a real bounded GET of `endpoint`. */
  probe?: ApiLivenessProbe;
}

export interface E2EReportWriterOptions {
  /**
   * Absolute path to the api worker's teed log (see wrangler-dev.ts). Overridable
   * for tests; defaults to the log for the current run's HB_API_PORT.
   */
  apiLogPath?: string | null;
  /**
   * Absolute path to wrangler's own debug log (see wrangler-dev.ts). Overridable
   * for tests; defaults to the log for the current run's HB_API_PORT.
   */
  apiDebugLogPath?: string | null;
  /**
   * What the liveness watchdog probes. Null disables it — a run with no API
   * port has nothing to watch, and inventing an endpoint would abort on a
   * connection refusal that means only that the port was never set.
   */
  liveness?: ApiLivenessOptions | null;
  /** Overridable for tests; the default samples this machine, the heap probe as its switch sets it. */
  sampler?: ResourceSampler;
}

function apiPort(): string | null {
  const port = process.env['HB_API_PORT'];
  return port === undefined || port === '' ? null : port;
}

/** What the watchdog probes when the caller names nothing: this run's own API. */
function defaultLiveness(): ApiLivenessOptions | null {
  const endpoint = runApiHealthUrl();
  return endpoint === null ? null : { endpoint };
}

/**
 * The api worker's stdout/stderr is teed to a per-port log by wrangler-dev.ts.
 * Derive that path from the run's HB_API_PORT so flush() can snapshot it into
 * the report dir; null when the port is unset (nothing to capture).
 */
export function apiServerLogSource(): string | null {
  const port = apiPort();
  return port === null ? null : wranglerLogPath(port);
}

/**
 * Wrangler's own debug log for this run — the complete record, written before
 * the log-level check, that the quiet terminal deliberately does not show.
 */
export function apiServerDebugLogSource(): string | null {
  const port = apiPort();
  return port === null ? null : wranglerDebugLogPath(port);
}

/** The API worker's liveness route for this run; null when the port is unset. */
export function runApiHealthUrl(): string | null {
  const port = apiPort();
  return port === null ? null : apiHealthUrl(port);
}

/**
 * Snapshot the api worker log into the report dir as `server-api.log` so
 * server-side stacks (e.g. `NoSuchBucket`/`UNAVAILABLE`) are captured as a
 * report artifact rather than being lost with the ephemeral worker process —
 * the report dir is the single source of truth for E2E debugging. A missing
 * source (no port, or the worker never wrote a log) is a no-op, never a
 * failure: the report itself must still land.
 */
export function captureServerApiLog(reportDir: string, source: string | null): string | null {
  if (source === null || !existsSync(source)) return null;
  const destination = path.join(reportDir, 'server-api.log');
  copyFileSync(source, destination);
  return destination;
}

/**
 * How much of wrangler's debug log one gzip member holds. The log runs to tens
 * of megabytes, so it is compressed a chunk at a time rather than read whole.
 */
export const DEBUG_LOG_CHUNK_BYTES = 4 * 1_048_576;

/**
 * Snapshot the whole of wrangler's debug log into the report dir as
 * `server-api-debug.log.gz`. The dev server truncates the log on its next
 * start, and this copy is what survives it.
 *
 * Synchronous because the flush is reached from a signal handler. Each chunk
 * becomes its own gzip member; `gunzip` and `zcat` read the concatenation as
 * one stream. Same contract as {@link captureServerApiLog}: a missing source is
 * a no-op, never a failure.
 *
 * @param chunkBytes Overridable for tests, which prove a line straddling a
 * boundary survives.
 */
export function captureWranglerDebugLog(
  reportDir: string,
  source: string | null,
  chunkBytes = DEBUG_LOG_CHUNK_BYTES
): string | null {
  if (source === null || !existsSync(source)) return null;
  const destination = path.join(reportDir, 'server-api-debug.log.gz');
  const input = openSync(source, 'r');
  try {
    const output = openSync(destination, 'w');
    try {
      const buffer = Buffer.alloc(chunkBytes);
      let read = readSync(input, buffer, 0, chunkBytes, null);
      // The first member is written even when empty: a zero-byte file is not a gzip.
      do {
        writeFileSync(output, gzipSync(buffer.subarray(0, read)));
        read = readSync(input, buffer, 0, chunkBytes, null);
      } while (read > 0);
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
  return destination;
}

/**
 * The switch deciding whether this run attaches the inspector heap probe.
 *
 * It exists so the probe's own cost can be measured: the probe is the only
 * reader of the isolate's heap, so a run with it on cannot be compared against
 * one with it off unless something can turn it off. Declared in the env
 * registry with per-mode values (`packages/shared/src/env/env.config.ts`),
 * because that is the only way a variable exists here — and because the
 * generated env files are loaded with `override: true`
 * (`scripts/with-env.ts`), an ambient shell variable of this name is discarded
 * before the reporter ever reads it. Flipping the arm means changing the
 * registry value and regenerating, which is what keeps the two arms on record
 * rather than in someone's shell history.
 */
export const HEAP_PROBE_VARIABLE = 'E2E_HEAP_PROBE';

const HEAP_PROBE_ON = 'on';
const HEAP_PROBE_OFF = 'off';

/**
 * Whether this run wants the probe. Absent or unrecognised is a crash, never a
 * default: a measurement arm silently chosen by a fallback is the failure this
 * switch exists to prevent.
 */
export function heapProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const declared = env[HEAP_PROBE_VARIABLE];
  if (declared === HEAP_PROBE_ON) return true;
  if (declared === HEAP_PROBE_OFF) return false;
  throw new Error(
    `${HEAP_PROBE_VARIABLE} must be "${HEAP_PROBE_ON}" or "${HEAP_PROBE_OFF}" — run \`pnpm generate:env --mode=e2e\` to regenerate the stack env files from the registry`
  );
}

/**
 * What the switch means to the sampler: with the probe off it is handed an
 * opener that answers no probe, which is the sampler's own "nothing to read"
 * path. With it on the sampler keeps its default opener, so the arm that
 * measures the probe runs exactly the code every ordinary run does.
 */
export function heapProbeSamplerOptions(
  env: NodeJS.ProcessEnv = process.env
): ResourceSamplerOptions {
  return heapProbeEnabled(env) ? {} : { openHeapProbe: (): null => null };
}

/**
 * Score the whole of wrangler's debug log for traffic-gated completion gaps into
 * `api-completion-gaps.json` beside the report. The isolate's freezes are not
 * this file's: they are read from the heap probe into the report's resources.
 *
 * Scored at flush, from the live file, because the dev server truncates it on
 * its next start. Scored from `runStartMs` because the dev server outlives the
 * run: an untruncated log holds every earlier run against the same server, and
 * counting those would put one run's gaps in another's report.
 *
 * Same contract as the captures beside it: a missing source is a no-op, never
 * a failure.
 */
export function captureCompletionGaps(
  reportDir: string,
  source: string | null,
  runStartMs: number
): string | null {
  if (source === null || !existsSync(source)) return null;
  const destination = path.join(reportDir, 'api-completion-gaps.json');
  const score = scoreWranglerDebugLog(source, { sinceMs: runStartMs });
  writeFileSync(destination, `${JSON.stringify(score, null, 2)}\n`);
  return destination;
}

/**
 * The status a run must be given despite the one the runner computed, or
 * `undefined` to leave the runner's alone. This is the whole escalation rule,
 * and it is one function because two readers depend on it — the status written
 * into `report.json` and the status {@link E2EReportWriter.onEnd} answers the
 * runner with — and a machine-readable outcome that disagrees with the exit
 * code is worse than either alone.
 *
 * A lost project is escalated because nothing else in the system guarantees it
 * is: every path that removes a project today also fails, times out or
 * interrupts the run, so the non-zero exit such a run gets is a coincidence of
 * two unrelated conditions rather than a consequence of the loss. This makes the
 * loss itself sufficient, so a later change to the runner's status rules cannot
 * turn a run that examined a third of the matrix green.
 *
 * A test with a result that no report list holds is escalated for the same
 * reason: missing from every list, it reads as one that passed.
 *
 * Only a would-be-`passed` run is escalated. An interrupted run already exits
 * non-zero, and overwriting its status would trade the exit code that says "a
 * signal stopped this" for one that says "a test failed".
 */
function escalatedStatusFor(
  runStatus: FullResult['status'],
  coverage: CoverageReport | undefined
): 'failed' | undefined {
  if (runStatus !== 'passed' || !coverage) return undefined;
  return coverage.lost.length > 0 || coverage.unlistedTests > 0 ? 'failed' : undefined;
}

/**
 * Kept apart from the global error count and its abort heading, which are the harness's alone:
 * a project can produce no result in a run that completed.
 */
function lostCoverageLine(
  coverage: CoverageReport | undefined,
  reportPath: string
): string | undefined {
  const lost = coverage?.lost.length ?? 0;
  if (lost === 0) return undefined;
  return `  Lost coverage: ${String(lost)} project(s) produced no result; why each did is under ${GLOBAL_ERRORS_HEADING} in ${reportPath}`;
}

/**
 * Kept apart from the global error count for the same reason as {@link lostCoverageLine}, and
 * printed because the summary counts only listed tests, so without it a run failed for an
 * unlisted test states no cause.
 */
function unlistedResultsLine(
  coverage: CoverageReport | undefined,
  reportPath: string
): string | undefined {
  const unlisted = coverage?.unlistedTests ?? 0;
  if (unlisted === 0) return undefined;
  return `  Unlisted results: ${String(unlisted)} test(s) produced a result that no report list holds; see ${GLOBAL_ERRORS_HEADING} in ${reportPath}`;
}

/**
 * Whether this report describes a listing — `playwright test --list`, which
 * loads the whole configuration and executes nothing — rather than a run.
 *
 * Told apart from a run that lost coverage by scope and outcome together, both
 * already in hand. A dispatched test records a result even when it is skipped,
 * so a test with none was never dispatched; and every way a real run leaves
 * tests undispatched — a failed setup project, the failure cap, a timeout, a
 * signal — ends it as something other than `passed` or leaves a run-level error
 * behind. So a `passed`, error-free report whose configured tests carry not one
 * result anywhere is a load that ran nothing, never a run that lost everything.
 *
 * A listing has no run to debug, and a report of one would claim its whole
 * matrix as lost coverage.
 */
function isListing(
  runStatus: FullResult['status'],
  globalErrorCount: number,
  coverage: CoverageReport | undefined
): boolean {
  if (runStatus !== 'passed' || globalErrorCount > 0 || coverage === undefined) return false;
  return coverage.testsInReport > 0 && coverage.executedTests === 0;
}

/** What was sampled and scanned, with the worker count that sizes the RAM root where the run began. */
function resourceReportOf(
  sampled: Pick<ResourceReport, 'summary' | 'samples'>,
  scan: ResourceScan,
  workers: number | undefined
): ResourceReport {
  return { ...sampled, scan, ...(workers === undefined ? {} : { workers }) };
}

export default class E2EReportWriter implements Reporter {
  private rootSuite: Suite | undefined;
  private projects: readonly PlaywrightProject[] = [];
  private written = false;
  /**
   * The status this reporter overrode the run's with, or `undefined` when it
   * left the runner's own status alone. Decided once, by {@link escalatedStatusFor};
   * the written report and the status {@link E2EReportWriter.onEnd} answers both read it.
   */
  private escalatedStatus: 'failed' | undefined;
  private startMs = 0;
  /** The configured Playwright worker count, from the config the run began with. */
  private workers: number | undefined;
  private readonly apiLogPath: string | null;
  private readonly apiDebugLogPath: string | null;
  private readonly watchdog: ApiLivenessWatchdog | null;
  private readonly sampler: ResourceSampler;

  constructor(options: E2EReportWriterOptions = {}) {
    this.apiLogPath = options.apiLogPath === undefined ? apiServerLogSource() : options.apiLogPath;
    this.apiDebugLogPath =
      options.apiDebugLogPath === undefined ? apiServerDebugLogSource() : options.apiDebugLogPath;
    this.watchdog = this.createWatchdog(options.liveness);
    this.sampler = options.sampler ?? createResourceSampler(undefined, heapProbeSamplerOptions());
  }

  private createWatchdog(
    configured: ApiLivenessOptions | null | undefined
  ): ApiLivenessWatchdog | null {
    const liveness = configured === undefined ? defaultLiveness() : configured;
    if (liveness === null) return null;
    return createApiLivenessWatchdog({
      endpoint: liveness.endpoint,
      probe: liveness.probe ?? createHealthProbe(liveness.endpoint),
      onTrip: this.onLivenessTrip,
    });
  }

  /**
   * Record the reason BEFORE interrupting: the flush that follows the signal is
   * what puts it in the report, and a run that died with no stated cause is the
   * failure this watchdog exists to prevent.
   */
  private readonly onLivenessTrip = (reason: string): void => {
    this.globalErrors.push(reason);
    process.emit('SIGINT', 'SIGINT');
  };
  // Run-level errors collected via onError. Kept so flush() can mark an aborted
  // run as FAILED even when no individual test failed (or no test ran at all).
  private readonly globalErrors: string[] = [];

  // Bound once so the same reference can be added and removed as a SIGINT listener.
  private readonly onInterrupt = (): void => {
    // A signal listener must never throw; an interrupted run can leave partial
    // trace artifacts that the writer rejects. Write a best-effort snapshot and
    // log on failure so Playwright's own SIGINT handlers still exit the process.
    this.watchdog?.stop();
    try {
      this.flush({
        status: 'interrupted',
        startTime: new Date(this.startMs),
        duration: Date.now() - this.startMs,
      });
    } catch (error) {
      console.error(`E2E report: failed to write interrupted snapshot: ${String(error)}`);
    }
  };

  /** Narrower than Playwright's `FullConfig`, which it accepts: the report reads only the project graph and the worker count. */
  onBegin(
    config: { readonly projects: readonly PlaywrightProject[]; readonly workers: number },
    suite: Suite
  ): void {
    this.rootSuite = suite;
    this.projects = config.projects.map(({ name, dependencies }) => ({ name, dependencies }));
    this.workers = config.workers;
    this.startMs = Date.now();
    this.sampler.start();
    this.watchdog?.start();
    // The report must survive an interrupt, and two paths can reach it.
    // Playwright's runner does call onEnd after one — an in-process SIGINT
    // yields run status `interrupted`, then onEnd, onExit and exit code 130 —
    // but playwright-core installs its own SIGINT handler for any launch
    // passing `handleSIGINT`, and that one exits the process itself. Flush
    // synchronously here so neither path can lose the report; the `written`
    // guard makes whichever runs second a no-op. `once` so a second Ctrl+C
    // falls through and still kills.
    //
    // The liveness watchdog's abort rides this same path, which is why it
    // records its reason before signalling.
    process.once('SIGINT', this.onInterrupt);
  }

  onError(error: TestError): void {
    // Global errors (global setup throwing, a webServer crash, output-dir
    // cleanup failing before any test runs) arrive here, never as a test
    // result. Capture them so the report reflects the abort instead of a
    // misleading "0 failed → PASSED".
    this.globalErrors.push(error.stack ?? error.message ?? 'Unknown global error');
  }

  /**
   * Returning a status here is the only way a reporter can decide a run's
   * outcome, and the outcome is the exit code: Playwright's runner takes this
   * value over the one it computed, and maps anything but `passed` and
   * `interrupted` to exit 1. The hook is typed to carry that status only
   * through a promise, hence the resolved one; the body itself stays
   * synchronous, so nothing can run between writing the report and answering.
   */
  onEnd(result: FullResult): Promise<{ status: FullResult['status'] } | undefined> {
    process.removeListener('SIGINT', this.onInterrupt);
    this.watchdog?.stop();
    this.flush(result);
    return Promise.resolve(
      this.escalatedStatus === undefined ? undefined : { status: this.escalatedStatus }
    );
  }

  private flush(result: FullResult): void {
    if (this.written) return;
    // A run that aborted before onBegin has no rootSuite; still emit a report
    // when there are global errors so the failure is visible rather than silent.
    if (!this.rootSuite && this.globalErrors.length === 0) return;
    this.written = true;

    const report = buildPlaywrightReport(this.rootSuite, this.projects, result, this.globalErrors);
    const debugReport = generateDebugReport(report);

    const sampled = this.sampler.stop();

    if (isListing(result.status, this.globalErrors.length, debugReport.coverage)) return;

    // Attach resource time-series + a log scan for resource-exhaustion symptoms
    // (pthread/EAGAIN, EMFILE, OOM, browser crashes) the report already collects.
    const scanEntries: ScanEntry[] = [...debugReport.failed, ...debugReport.flaky].flatMap((t) => {
      const test = `${t.file} › ${t.title}`;
      return [
        { test, text: t.error },
        { test, text: t.artifacts.consoleErrors ?? '' },
        { test, text: t.artifacts.apiErrors ?? '' },
      ];
    });
    const resources = resourceReportOf(sampled, scanResourceErrors(scanEntries), this.workers);
    debugReport.resources = resources;

    // Decided before the report is written, so the report carries the status the
    // run will exit on rather than the one the runner computed without it.
    this.escalatedStatus = escalatedStatusFor(result.status, debugReport.coverage);
    if (this.escalatedStatus !== undefined) debugReport.status = this.escalatedStatus;

    const reportDir = path.join(process.cwd(), 'e2e', 'report');

    const runDir = writeReport(debugReport, reportDir);
    captureServerApiLog(runDir, this.apiLogPath);
    captureWranglerDebugLog(runDir, this.apiDebugLogPath);
    captureCompletionGaps(runDir, this.apiDebugLogPath, this.startMs);
    const relativePath = path.relative(process.cwd(), runDir);

    const { summary } = debugReport;
    const globalErrorNote =
      this.globalErrors.length > 0 ? `, ${String(this.globalErrors.length)} global error(s)` : '';
    console.log(
      `\nE2E report (source of truth for debugging): ${relativePath}/REPORT.md (${String(summary.failed)} failed, ${String(summary.flaky)} flaky, ${String(summary.passed)} passed${globalErrorNote})`
    );
    console.log(`  Structured data: ${relativePath}/report.json`);
    if (summary.failed > 0) {
      console.log(`  Failed test details: ${relativePath}/failed/`);
    }
    if (this.globalErrors.length > 0) {
      console.log(`  Global errors (run aborted): ${relativePath}/REPORT.md`);
    }
    const coverageFindings = [
      lostCoverageLine(debugReport.coverage, `${relativePath}/REPORT.md`),
      unlistedResultsLine(debugReport.coverage, `${relativePath}/REPORT.md`),
    ].filter((line) => line !== undefined);
    for (const line of coverageFindings) console.log(line);
    console.log(formatResourceStdout(resources));
    console.log();
  }

  printsToStdio(): boolean {
    return true;
  }
}
