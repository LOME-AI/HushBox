/**
 * Runs the real idle daemon in a separate process with a teardown result of the
 * caller's choosing, so a suite can watch a teardown that cannot succeed
 * without a `docker compose down` anywhere near a shared stack. Written as an
 * ES module rather than TypeScript because it is a test fixture that never runs
 * inside the vitest process, so its lines are not the daemon's coverage.
 *
 * Everything below the teardown's own result is the shipped code: the singleton
 * bind, the identity claim, the poll, the record of a failing teardown and the
 * withdrawal of one.
 *
 * Spawned as `node --import tsx <this file> --port <n> --slot <n>
 * --registry-dir <dir>`, with `HB_FIXTURE_TEARDOWN_EXIT` and
 * `HB_FIXTURE_TEARDOWN_OUTPUT` saying how the teardown ends.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DAEMON_COMMAND_LINE,
  daemonArgsFrom,
  daemonLoop,
  bindSingleton,
  holdIdentity,
  liveClaimCount,
} from './idle-killer-daemon.ts';
import { clearTeardownFailure, recordTeardownFailure } from './idle-teardown-failure.ts';
import { readCommandLineOrRefuse } from '../cli/command-line.ts';

// The daemon's own grammar, so a fixture spawned with a token nothing names
// refuses exactly as the shipped entry does rather than running against a
// registry it was never pointed at.
const invocation = readCommandLineOrRefuse(DAEMON_COMMAND_LINE, process.argv.slice(2));
const args = invocation === null ? null : daemonArgsFrom(invocation.flags);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const exitCode = Number(process.env.HB_FIXTURE_TEARDOWN_EXIT);
const output = process.env.HB_FIXTURE_TEARDOWN_OUTPUT ?? '';

if (args !== null)
  await daemonLoop(
    {
      port: args.port,
      slot: args.slot,
      // Fast enough that a suite can watch the count climb, and a grace window
      // of one poll so the teardown is attempted rather than waited for.
      pollMs: 20,
      graceWindowPolls: 1,
      composeProject: 'hushbox-teardown-evidence-fixture',
      repoRoot,
    },
    {
      bindSingleton,
      holdIdentity: (port, identity, body) => holdIdentity(port, identity, body, args.registryDir),
      liveClaimCount: (slot) => liveClaimCount(slot, args.registryDir),
      composeDown: () => Promise.resolve({ exitCode, output }),
      recordTeardownFailure: (failure) =>
        recordTeardownFailure(args.port, failure, args.registryDir),
      clearTeardownFailure: () => clearTeardownFailure(args.port, args.registryDir),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      // Discarded here for the same reason it is discarded in production, which
      // is the whole reason the record beside it exists.
      log: () => undefined,
    }
  );
