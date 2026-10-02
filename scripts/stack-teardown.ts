/**
 * Tears this checkout's stack down, refusing while another run is live on its
 * slot.
 *
 * A teardown runs `docker compose -p <project> down` with no `-v`, so it removes
 * the containers and networks on the slot, and with them whatever a container
 * holds that no named volume backs — the Redis keyspace, say. Every volume the
 * compose file names survives it, so the Postgres data and the MinIO objects do
 * too; a wipe, which passes `{ volumes: true }`, is what takes those. Either way
 * the slot's stack goes out from under whatever is running against it, which is
 * what the guard exists for: the bare `docker compose down` this replaces asked
 * nothing before doing it, while the idle daemon beside it has always torn a slot
 * down only when no run had claimed it — so the two destructive paths a developer
 * can reach disagreed about whether a slot in use may be destroyed.
 *
 * The check runs in this process, immediately before the destruction, and
 * disregards this invocation's own run claim: the env wrapper registers one for
 * every command it wraps, so a check counting every live claim would count
 * itself, and a check in a separate process would leave a window between the
 * answer and the act. {@link assertSlotFreeToTearDown} states both.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { composeProjectName } from './lib/cli/worktree.js';
import { composeDown } from './lib/stack/idle-killer-daemon.js';
import { stackSlotFrom } from './lib/stack/stack-slot.js';
import { assertSlotFreeToTearDown } from './lib/stack/teardown-guard.js';
import type { ComposeDownResult } from './lib/stack/idle-killer-daemon.js';

export interface StackTeardownDeps {
  /** Refuses while a run other than this one holds the slot. */
  readonly assertSlotFree: (slot: number) => Promise<void>;
  readonly composeDown: (project: string, repoRoot: string) => Promise<ComposeDownResult>;
}

/**
 * The compose project is derived from the slot rather than read from the
 * environment, so this destroys the project the bring-up in
 * `scripts/lib/stack/ensure-stack.ts` created for the slot the guard just
 * cleared, and a stale variable cannot point the two at different stacks.
 */
export async function tearDownStack(
  slot: number,
  repoRoot: string,
  deps: StackTeardownDeps
): Promise<void> {
  await deps.assertSlotFree(slot);

  const result = await deps.composeDown(composeProjectName(slot), repoRoot);
  if (result.exitCode !== 0) {
    const ending =
      result.exitCode === null ? 'ended by a signal' : `exit ${String(result.exitCode)}`;
    throw new Error(
      `stack teardown: tearing down slot ${String(slot)} failed (${ending}): ${result.output}`
    );
  }
}

export const COMMAND_LINE = {
  command: 'tsx scripts/stack-teardown.ts',
  summary: "Tears this checkout's stack down, refusing while another run is live on its slot.",
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point: the real registry, the real slot and the real compose command */
if (isMainModule(import.meta.url)) {
  await runMain(() => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    return tearDownStack(
      stackSlotFrom(process.env),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      { assertSlotFree: assertSlotFreeToTearDown, composeDown }
    );
  });
}
/* v8 ignore stop */
