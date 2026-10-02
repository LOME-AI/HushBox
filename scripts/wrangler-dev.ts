import { execa } from 'execa';
import { createWriteStream, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedEnvPaths } from './generate-env.js';
import { stackModeFrom } from './with-env.js';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { missingPortVariable } from './lib/stack/generated-port.js';
import { e2eRamPaths } from './lib/stack/ram-root.js';
import { startDevCronTicker } from './cron-trigger.js';
import type { unstable_startWorker } from 'wrangler';
import type { StackMode } from './lib/stack/port-plan.js';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const API_WORKER_ENTRY = path.join(SCRIPTS_DIR, 'lib', 'wrangler', 'api-worker-entry.ts');

export function wranglerLogPath(port: string): string {
  return path.join(REPO_ROOT, 'apps', 'api', `.wrangler-${port}.log`);
}

/**
 * The backend env file wrangler loads for a stack.
 *
 * Passed explicitly rather than left to wrangler's own `.dev.vars` discovery,
 * which finds one file and so cannot tell the two stacks apart: an end-to-end
 * run would take the development stack's server values — its API origin, its
 * sandbox origin, its ports. Absolute, because wrangler resolves the path
 * against its working directory and this process is spawned from more than one.
 * The path comes from the generator that writes the file, so neither side can
 * move without the other.
 */
export function wranglerEnvFilePath(stackMode: StackMode): string {
  return path.join(REPO_ROOT, generatedEnvPaths(stackMode).backend);
}

/**
 * Where miniflare keeps a stack's local state — its R2 objects, KV pairs,
 * Durable Object storage and caches.
 *
 * Per stack because two wrangler processes sharing one directory is silently
 * broken: there is no lock and no warning, and a measured run of interleaved
 * Durable Object writes lost nearly half of them. Passed explicitly rather than
 * left to the default, which is one directory for every process of this
 * checkout.
 *
 * The development and test stacks' roots, and the E2E stack's off Linux, sit
 * under the directory wrangler would have chosen anyway, so emptying the local
 * store by any route that names `.wrangler/` or its `state/` tree empties
 * theirs. On Linux the E2E stack's root is in its RAM root instead, outside the
 * repository, which no such route reaches: the reset that recreates the E2E
 * data plane is what empties it. Absolute, because wrangler resolves the flag
 * against its working directory and the processes that pass it run from more
 * than one.
 */
export function wranglerPersistPath(stackMode: StackMode): string {
  const inRam = stackMode === 'e2e' ? e2eRamPaths()?.persist : undefined;
  return inRam ?? path.join(REPO_ROOT, 'apps', 'api', '.wrangler', 'state', stackMode);
}

/**
 * Where wrangler writes its own debug log for this port. Wrangler appends every
 * message to this file *before* applying its log level, so it is the only
 * complete record of a run the terminal deliberately keeps quiet: lifecycle
 * markers, the proxy's internal errors, and the app's per-request lines all
 * land here while the terminal shows errors only.
 *
 * Per-port for the same reason the tee is: two worktrees run two dev servers.
 */
export function wranglerDebugLogPath(port: string): string {
  return path.join(REPO_ROOT, 'apps', 'api', `.wrangler-debug-${port}.log`);
}

export interface ApiWorkerPorts {
  readonly port: number;
  readonly inspectorPort: number;
}

function portFrom(env: NodeJS.ProcessEnv, variable: string, stackMode: StackMode): number {
  const value = env[variable];
  if (!value) {
    throw new Error(missingPortVariable(variable, stackMode));
  }
  const port = Number(value);
  if (!Number.isInteger(port)) {
    throw new TypeError(`${variable} is not a port number: ${value}`);
  }
  return port;
}

/** The API Worker's server and inspector ports, from the stack's generated env. */
export function apiWorkerPorts(env: NodeJS.ProcessEnv, stackMode: StackMode): ApiWorkerPorts {
  return {
    port: portFrom(env, 'HB_API_PORT', stackMode),
    inspectorPort: portFrom(env, 'HB_API_INSPECTOR_PORT', stackMode),
  };
}

/**
 * Whether the stack's Worker re-bundles and reloads on a file change: only a
 * stack a developer edits live. An E2E run must test the code it started with,
 * and a reload drops every request in flight — a change to a file's metadata
 * alone is enough to trigger one.
 */
export function watchesSource(stackMode: StackMode): boolean {
  return stackMode !== 'e2e';
}

/**
 * The fields of wrangler's worker-start input this repo relies on. Wrangler's
 * own input type resolves to `any` in this install — the package that declares
 * it is not installed — so the compiler checks our spelling here and nothing
 * checks wrangler's; `api-worker-entry.integration.test.ts` measures against
 * the real runtime that `dev.watch` and `build.custom.command` still mean what
 * this sets them to.
 */
export interface ApiWorkerStartInput {
  readonly config: string;
  readonly envFiles: readonly string[];
  readonly build: { readonly custom: { readonly command: '' } };
  readonly dev: {
    readonly server: { readonly port: number };
    readonly inspector: { readonly port: number };
    readonly persist: string;
    readonly logLevel: 'error';
    readonly watch: boolean;
  };
}

/**
 * How the stack's API Worker starts. The dev registry is left unset: nothing
 * binds to this Worker by name, and setting it would register the development
 * and E2E Workers under one name in one machine-wide registry.
 *
 * The config's `[build]` command is cleared for every local stack: it builds
 * nothing the local Worker bundles, since off a production build the growth
 * extractor it runs leaves the committed index standing, and what it reads is
 * the marketing build output every stack of this checkout shares. Cleared with
 * the empty string because wrangler takes the config's command whenever this
 * one is absent or undefined; `wrangler deploy` reads no input and still runs it.
 */
export function apiWorkerStartInput(
  stackMode: StackMode,
  ports: ApiWorkerPorts
): ApiWorkerStartInput {
  return {
    config: path.join(REPO_ROOT, 'apps', 'api', 'wrangler.toml'),
    envFiles: [wranglerEnvFilePath(stackMode)],
    build: { custom: { command: '' } },
    dev: {
      server: { port: ports.port },
      inspector: { port: ports.inspectorPort },
      persist: wranglerPersistPath(stackMode),
      logLevel: 'error',
      watch: watchesSource(stackMode),
    },
  };
}

/**
 * Refuses any argument to the API Worker's launcher or its entry: how the
 * Worker runs is decided in this module, so a flag at a call site would be a
 * second place deciding it.
 */
export function refuseArguments(argv: readonly string[]): void {
  if (argv.length > 0) {
    throw new Error(
      `scripts/wrangler-dev.ts takes no arguments (got: ${argv.join(' ')}) — how the API Worker runs is decided there, so change it there rather than at the call site`
    );
  }
}

/** What the Worker entry watches on a started Worker: its build failing. */
export interface ApiWorker {
  readonly raw: { once(event: 'buildFailed', listener: () => void): unknown };
}

/** The running-worker handle wrangler's programmatic start resolves to. */
export type RuntimeWorker = Awaited<ReturnType<typeof unstable_startWorker>>;

/**
 * Starts a Worker through wrangler's programmatic API. Imported on call rather
 * than at load: wrangler fixes its debug-log path when its module initialises,
 * so only the process that carries `WRANGLER_LOG_PATH` may load it.
 */
export async function startWorkerRuntime(input: ApiWorkerStartInput): Promise<RuntimeWorker> {
  const { unstable_startWorker } = await import('wrangler');
  return unstable_startWorker(input);
}

/**
 * What a Worker's own run leaves in its persist root and the weights seed never
 * writes: Durable Object storage, and the per-request trace collector's store.
 */
const WORKER_RUN_STATE = [path.join('v3', 'do'), path.join('v3', 'observability')];

/**
 * Refuses to start the E2E Worker over a persist root an earlier Worker ran in.
 * The bring-up empties the root and the seed writes neither entry, so one
 * standing here was put back by something outside this repository — a tool
 * syncing the checkout has restored a whole earlier run's state this way — and
 * the suite would run against state no seed made.
 */
function refuseWorkerRunState(persistRoot: string): void {
  for (const entry of WORKER_RUN_STATE) {
    const directory = path.join(persistRoot, entry);
    if (!existsSync(directory)) continue;
    const file = readdirSync(directory, { recursive: true, withFileTypes: true }).find((found) =>
      found.isFile()
    );
    const stale = file === undefined ? directory : path.join(file.parentPath, file.name);
    throw new Error(
      `wrangler-dev: refusing to start the E2E Worker over ${persistRoot}, which already holds ` +
        `${path.relative(persistRoot, stale)} — state an earlier Worker left and no seed writes. ` +
        '`pnpm e2e:prepare` empties this root; if the entry is back after it, something outside ' +
        'this repository is restoring it.'
    );
  }
}

function teeStreamErrorHandler(label: string): (error: Error) => void {
  /* v8 ignore next 3 -- fires only on a rare tee-stream 'error' event; the wiring is covered, the handler is a defensive logger */
  return (error) => {
    console.warn(`wrangler-dev tee ${label} error: ${error.message}`);
  };
}

/**
 * workerd emits these on the API process's stderr whenever a client drops a
 * connection mid-response — routine under E2E, where Playwright closes pages
 * while chat SSE streams are still in flight. They originate in workerd's C++
 * I/O layer, below the JS `await` point, so the app's own disconnect guards
 * (the SSE writer's connection check, fire-and-forget's catch, the billing
 * `waitUntil(...).catch`) can't intercept them. They are not failures.
 *
 * Matched lines are dropped from the *terminal* only. The raw stderr is still
 * teed verbatim to apps/api/.wrangler-<port>.log, so nothing is hidden — this
 * de-noises the interactive view without losing the record. Patterns are
 * deliberately narrow so a genuine error is never swallowed.
 */
const SUPPRESSED_STDERR_PATTERNS: readonly RegExp[] = [
  // kj socket write to an already-closed peer: "disconnected: ::write(...): Broken pipe".
  /disconnected:.*Broken pipe/,
  // Companion frame of the broken-pipe report: a "stack:" line of raw workerd
  // address frames (each token ends in @<hex>). A real JS stack is "  at ...",
  // never this shape, so it stays visible.
  /^\s*stack:\s+\S+@[0-9a-f]+(?:\s+\S+@[0-9a-f]+)*\s*$/,
  // A pending subrequest canceled when the request context tears down after the
  // client disconnects; surfaced by workerd as an uncaught rejection, no JS stack.
  /Uncaught (?:\(in promise\) )?Error: Network connection lost/,
  // Workerd brackets error blocks with blank lines. With the error message
  // itself suppressed above, those bare blanks would still pass through and
  // surface in Playwright's webServer output as `[API]` prefix with nothing
  // after it (the prefix is added per stderr line regardless of content). A
  // blank stderr line carries no information; the log file retains everything
  // verbatim, so dropping them from the terminal is purely cosmetic de-noising.
  /^\s*$/,
];

export function isSuppressedStderrLine(line: string): boolean {
  return SUPPRESSED_STDERR_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Line-buffering Transform that drops {@link isSuppressedStderrLine} matches.
 * Buffers across chunk boundaries so a line split between two writes is matched
 * as a whole; the trailing partial line (no newline yet) is held until flush.
 */
export function createStderrFilter(): Transform {
  let buffer = '';
  return new Transform({
    transform(chunk: unknown, _encoding, callback): void {
      /* v8 ignore next -- stream is not objectMode, so chunk is always a Buffer */
      buffer += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const lines = buffer.split('\n');
      /* v8 ignore next -- split always yields at least one element, so pop never returns undefined */
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!isSuppressedStderrLine(line)) {
          this.push(`${line}\n`);
        }
      }
      callback();
    },
    flush(callback): void {
      if (buffer.length > 0 && !isSuppressedStderrLine(buffer)) {
        this.push(buffer);
      }
      callback();
    },
  });
}

/**
 * Run the API Worker in a child process — `lib/wrangler/api-worker-entry.ts`,
 * which starts it through wrangler's programmatic API with the input
 * {@link apiWorkerStartInput} builds — with stdout/stderr teed to
 * apps/api/.wrangler-<port>.log and wrangler's own debug log captured at
 * {@link wranglerDebugLogPath}.
 *
 * Single source of truth for how the API Worker runs in this repo, in every
 * stack: the ports, the backend env file, persistence, whether it watches its
 * source, stdio, the log files and the log level are all decided here. Callers
 * (apps/api package script, playwright.config.ts, mobile-test, ad-hoc
 * `pnpm dev`) pass no arguments, and one is refused — if anything needs to
 * vary, change it here, not at the callsite.
 *
 * Programmatic rather than the `wrangler dev` command because the command has
 * no way to turn file watching off, and the E2E Worker must not reload
 * mid-run; one start path for every stack keeps the E2E run exercising the
 * development Worker's launch.
 *
 * Both files are truncated on every restart — that's the only bound. A
 * long-lived `pnpm dev` session can grow them without limit; the
 * deliverable to maestro-results is the bounded slice produced by
 * scripts/lib/mobile/extract-mobile-api-log.ts, so unbounded raw-log growth is
 * acceptable for a .gitignore'd local artifact.
 *
 * The cron ticker armed here is what makes the Worker's `[triggers]` schedules
 * run locally: the local runtime registers them but fires none, so without it a
 * cron entry has never executed against the local stack. It is promptness only
 * — a fire that fails is reported and the dev server carries on.
 *
 * The `error` log level silences wrangler's per-request INFO lines (which lack
 * headers and would duplicate the per-request log emitted by the request-log
 * middleware in apps/api/src/middleware/request-log.ts). It is set twice
 * because the programmatic API splits it: `WRANGLER_LOG` sets the logger's
 * level and `dev.logLevel` only scopes the start and teardown. Nothing is lost
 * by that: the debug log holds every level regardless, so the quiet terminal
 * and the complete record coexist rather than trading off.
 */
export async function runWranglerDev(
  argv: readonly string[],
  persistPathFor: (stackMode: StackMode) => string = wranglerPersistPath
): Promise<number> {
  refuseArguments(argv);
  const stackMode = stackModeFrom(process.env);
  const port = String(apiWorkerPorts(process.env, stackMode).port);
  if (stackMode === 'e2e') refuseWorkerRunState(persistPathFor(stackMode));

  const logStream = createWriteStream(wranglerLogPath(port), { flags: 'w' });

  // Wrangler appends to its debug log and never rotates one given an explicit
  // path, so truncating here is what keeps the file a record of this run rather
  // than of every run since the checkout. Synchronous, and before the spawn, so
  // wrangler cannot append between the two.
  const debugLogPath = wranglerDebugLogPath(port);
  writeFileSync(debugLogPath, '');

  const subprocess = execa(
    process.execPath,
    ['--no-warnings', '--import', 'tsx', API_WORKER_ENTRY],
    {
      stdio: ['inherit', 'pipe', 'pipe'],
      reject: false,
      env: {
        WRANGLER_LOG_PATH: debugLogPath,
        // The terminal's level; the debug log records every level regardless.
        WRANGLER_LOG: 'error',
        // Miniflare's per-request trace collector is gated only by this variable —
        // `[observability] enabled = false` in wrangler.toml does not reach it — and
        // its fsync per request on workerd's single thread stalls the Worker for seconds.
        X_LOCAL_OBSERVABILITY: 'false',
      },
    }
  );

  // Every deployed schedule, at its real cadence, against this dev server.
  // Declines under E2E, where each spec fires the schedule it is about.
  const cronTicker = startDevCronTicker(process.env);

  // Tee both pipes to the terminal (preserving the interactive UX) and to
  // the log file (preserving content for post-hoc debugging). `end: false`
  // keeps the destination open across both stdout and stderr ends; we close
  // the log stream explicitly in the finally block.
  //
  // stderr reaches the terminal through a filter that drops benign workerd
  // disconnect noise (see SUPPRESSED_STDERR_PATTERNS); the log file still
  // receives the unfiltered stderr, so the record is complete.
  const stderrFilter = createStderrFilter();
  subprocess.stdout.pipe(process.stdout, { end: false });
  subprocess.stdout.pipe(logStream, { end: false });
  stderrFilter.pipe(process.stderr, { end: false });
  subprocess.stderr.pipe(stderrFilter);
  subprocess.stderr.pipe(logStream, { end: false });

  // Defensive: surface stream errors (disk full, EACCES on apps/api/) as a
  // single warn line instead of an unhandled 'error' event that would crash
  // the dev process. The terminal stream stays usable either way.
  logStream.on('error', teeStreamErrorHandler('log'));
  stderrFilter.on('error', teeStreamErrorHandler('stderr-filter'));
  subprocess.stdout.on('error', teeStreamErrorHandler('stdout'));
  subprocess.stderr.on('error', teeStreamErrorHandler('stderr'));

  try {
    const result = await subprocess;
    return typeof result.exitCode === 'number' ? result.exitCode : 1;
  } finally {
    cronTicker?.stop();
    logStream.end();
  }
}

/* v8 ignore start -- CLI entry point exercised via apps/api dev script */
if (isMainModule(import.meta.url)) {
  await runMain(() => runWranglerDev(process.argv.slice(2)));
}
/* v8 ignore stop */
