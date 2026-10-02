import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import {
  currentHourUtc,
  provisionRepository,
  readBackupSettings,
  runBackup,
} from './lib/backup/run.js';
import type { CommandSpec } from './lib/cli/command-line.js';
import type { RunSummary } from './lib/backup/reconcile.js';
import type { BackupSettings, RunBackupOptions } from './lib/backup/run.js';

/**
 * One backup cycle, run identically by the hourly workflow and by a developer
 * against the local stack. Everything it needs is a registry variable, so the
 * only difference between the two is which stack's values are loaded.
 */

export const COMMAND_LINE = {
  command: 'pnpm backup',
  summary:
    'Runs one backup cycle: dumps the database, snapshots the object buckets into the encrypted repository, verifies it, and applies the retention ladder.',
  flags: [
    {
      flag: '--dispatched',
      kind: 'boolean',
      summary:
        'Treat the run as one a person asked for, which always restores the newest dump and proves it.',
    },
    {
      flag: '--provision',
      kind: 'boolean',
      summary:
        'Create the repository and back nothing up. One explicit act, run once before the first scheduled run; it refuses a repository that already exists.',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

export interface BackupCommandOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
  /**
   * The instant the run started; the hour of it decides what this run does.
   * Read through a function rather than handed in as a value, because the
   * caller's read would then run before the line is parsed: an entry point acts
   * only on a line its own grammar has accepted.
   */
  readonly now: () => number;
  /**
   * What each word of the line does. Handed in rather than defaulted here: a
   * default is a branch only the entry point below takes, so it can never be
   * driven from a test, and an undriven branch in the module that decides
   * whether a backup happens at all is the wrong place to carry one.
   */
  readonly run: (options: RunBackupOptions) => Promise<RunSummary>;
  readonly provision: (settings: BackupSettings) => Promise<void>;
  readonly write?: (text: string) => void;
}

/**
 * Reads the command line and the environment, then either creates the
 * repository or runs one cycle against it.
 */
export async function runBackupCommand(options: BackupCommandOptions): Promise<void> {
  const invocation = readCommandLine(COMMAND_LINE, options.argv, options.write);
  if (invocation === null) return;
  const settings = readBackupSettings(options.env);
  if (invocation.flags['--provision']) {
    if (invocation.flags['--dispatched']) {
      throw new Error(
        'pnpm backup: --provision creates the repository and backs nothing up, so it takes no other flag. Run it alone, then run the cycle.'
      );
    }
    await options.provision(settings);
    return;
  }
  await options.run({
    settings,
    hourUtc: currentHourUtc(options.now()),
    dispatched: invocation.flags['--dispatched'],
  });
}

/* v8 ignore start -- CLI wiring; runBackupCommand is covered by its own tests */
if (isMainModule(import.meta.url)) {
  await runMain(() =>
    runBackupCommand({
      env: process.env,
      argv: process.argv.slice(2),
      now: () => Date.now(),
      run: runBackup,
      provision: provisionRepository,
    })
  );
}
/* v8 ignore stop */
