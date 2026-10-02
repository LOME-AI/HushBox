/**
 * Detached-process entry point for the idle-killer daemon. Spawned by
 * scripts/lib/stack/idle-killer.ts via `child_process.spawn(node, [this-file, ...])`.
 * All logic lives in idle-killer-daemon.ts; this file is only the runtime
 * wiring (env reading, real network/registry/exec) and the `daemonLoop`
 * invocation.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import {
  DAEMON_COMMAND_LINE,
  daemonArgsFrom,
  daemonLoop,
  bindSingleton,
  holdIdentity,
  liveClaimCount,
  composeDown,
  requireComposeProject,
  sleep,
} from './idle-killer-daemon.js';
import { clearTeardownFailure, recordTeardownFailure } from './idle-teardown-failure.js';
import { EMPTY_POLLS_BEFORE_TEARDOWN } from './idle-killer.js';
import { readCommandLineOrRefuse } from '../cli/command-line.js';
import { isMainModule } from '../cli/is-main.js';
import type { DaemonArgs } from './idle-killer-daemon.js';

/** How long the daemon waits between two readings of the slot's claims. */
const POLL_MS = 60_000;

/** The grammar this entry answers for, read by the entry-point argument check. */
export const COMMAND_LINE = DAEMON_COMMAND_LINE;

/* v8 ignore start -- detached-subprocess wiring; the decisions it wires are tested in idle-killer-daemon.test.ts */
async function main(args: DaemonArgs): Promise<void> {
  // Load env so we know which compose project we own. The generated file is a
  // fallback for a daemon spawned outside the env wrapper, never an override:
  // what this process was handed names the project the run that launched it is
  // using, and a caller pointing the daemon at a different project — a test at
  // a stub name, above all — must not be silently redirected onto the real one.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..', '..', '..');
  loadDotenv({ path: path.join(repoRoot, '.env.scripts') });

  const composeProject = requireComposeProject(process.env);

  await daemonLoop(
    {
      port: args.port,
      slot: args.slot,
      pollMs: POLL_MS,
      graceWindowPolls: EMPTY_POLLS_BEFORE_TEARDOWN,
      composeProject,
      repoRoot,
    },
    {
      bindSingleton,
      // Both claims go wherever the caller pointed this daemon: a registry the
      // daemon half honoured would have it vouch for its port in one place
      // while reading the runs that keep its slot alive from another.
      holdIdentity: (port, identity, body) => holdIdentity(port, identity, body, args.registryDir),
      liveClaimCount: (slot) => liveClaimCount(slot, args.registryDir),
      composeDown,
      // Beside the identity claim, in the same registry, for the same reason:
      // the port is the only thing a reader starts from.
      recordTeardownFailure: (failure) =>
        recordTeardownFailure(args.port, failure, args.registryDir),
      clearTeardownFailure: () => clearTeardownFailure(args.port, args.registryDir),
      sleep,
      log: (m) => {
        process.stdout.write(`${m}\n`);
      },
    }
  );
}

// Guard self-execution so tests can import this module's helpers without
// spawning the daemon (the spawned subprocess runs as the main module).
if (isMainModule(import.meta.url)) {
  // The line is read before anything else this process does, so a token the
  // grammar does not name is refused while the daemon is still nothing but a
  // parse. `null` is a help request answered or a refusal printed; either way
  // there is nothing to run.
  const invocation = readCommandLineOrRefuse(COMMAND_LINE, process.argv.slice(2));
  if (invocation !== null) {
    void (async () => {
      try {
        await main(daemonArgsFrom(invocation.flags));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`idle-killer-daemon error: ${message}\n`);
        process.exit(1);
      }
    })();
  }
}
/* v8 ignore stop */
