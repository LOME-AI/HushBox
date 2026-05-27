import { execa } from 'execa';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

export function wranglerLogPath(port: string): string {
  return path.join(REPO_ROOT, 'apps', 'api', `.wrangler-${port}.log`);
}

function teeStreamErrorHandler(label: string): (error: Error) => void {
  return (error) => {
    console.warn(`wrangler-dev tee ${label} error: ${error.message}`);
  };
}

/**
 * Spawn wrangler dev with stdout/stderr teed to apps/api/.wrangler-<port>.log.
 *
 * Single source of truth for how wrangler dev runs in this repo: port, stdio,
 * log file, and log level all decided here. Callers (apps/api package script,
 * playwright.config.ts, mobile-test, ad-hoc `pnpm dev`) pass no wrangler flags
 * — if anything needs to vary, change it here, not at the callsite.
 *
 * The log file is truncated on every restart — that's the only bound. A
 * long-lived `pnpm dev` session can grow the file without limit; the
 * deliverable to maestro-results is the bounded slice produced by
 * scripts/lib/extract-mobile-api-log.ts, so unbounded raw-log growth is
 * acceptable for a .gitignore'd local artifact.
 *
 * `--log-level error` silences wrangler's per-request INFO lines (which lack
 * headers and would duplicate the per-request log emitted by the request-log
 * middleware in apps/api/src/middleware/request-log.ts).
 */
export async function runWranglerDev(extraArgs: string[]): Promise<number> {
  const port = process.env['HB_API_PORT'];
  if (!port) {
    throw new Error('HB_API_PORT is not set — run pnpm generate:env first');
  }

  const logStream = createWriteStream(wranglerLogPath(port), { flags: 'w' });

  const subprocess = execa(
    'wrangler',
    ['dev', '--port', port, '--log-level', 'error', ...extraArgs],
    { stdio: ['inherit', 'pipe', 'pipe'], reject: false }
  );

  // Tee both pipes to the terminal (preserving the interactive UX) and to
  // the log file (preserving content for post-hoc debugging). `end: false`
  // keeps the destination open across both stdout and stderr ends; we close
  // the log stream explicitly in the finally block.
  subprocess.stdout.pipe(process.stdout, { end: false });
  subprocess.stdout.pipe(logStream, { end: false });
  subprocess.stderr.pipe(process.stderr, { end: false });
  subprocess.stderr.pipe(logStream, { end: false });

  // Defensive: surface stream errors (disk full, EACCES on apps/api/) as a
  // single warn line instead of an unhandled 'error' event that would crash
  // the dev process. The terminal stream stays usable either way.
  logStream.on('error', teeStreamErrorHandler('log'));
  subprocess.stdout.on('error', teeStreamErrorHandler('stdout'));
  subprocess.stderr.on('error', teeStreamErrorHandler('stderr'));

  try {
    const result = await subprocess;
    return typeof result.exitCode === 'number' ? result.exitCode : 1;
  } finally {
    logStream.end();
  }
}

/* v8 ignore start -- CLI entry point exercised via apps/api dev script */
if (isMainModule(import.meta.url)) {
  await runMain(() => runWranglerDev(process.argv.slice(2)));
}
/* v8 ignore stop */
