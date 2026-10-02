import { describe, expect, it } from 'vitest';

import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';

import { COMMAND_LINE, runBackupCommand } from './backup.js';
import { BACKUP_VARIABLES } from './lib/backup/run.js';
import type { BackupSettings, RunBackupOptions } from './lib/backup/run.js';
import type { RunSummary } from './lib/backup/reconcile.js';
import type { CommandSpec } from './lib/cli/command-line.js';

/** Every variable the run reads, each carrying a value of its own. */
function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.values(BACKUP_VARIABLES).map((name) => [name, `value-of-${name}`])
  );
}

const SUMMARY: RunSummary = {
  logicalBytes: 2,
  storedBytes: 1,
  reconciled: true,
  spotChecks: [],
};

interface Recording {
  readonly calls: RunBackupOptions[];
  readonly provisioned: BackupSettings[];
  readonly printed: string[];
  run: (options: RunBackupOptions) => Promise<RunSummary>;
  provision: (settings: BackupSettings) => Promise<void>;
  write: (text: string) => void;
}

function recording(): Recording {
  const calls: RunBackupOptions[] = [];
  const provisioned: BackupSettings[] = [];
  const printed: string[] = [];
  return {
    calls,
    provisioned,
    printed,
    run: (options) => {
      calls.push(options);
      return Promise.resolve(SUMMARY);
    },
    provision: (settings) => {
      provisioned.push(settings);
      return Promise.resolve();
    },
    write: (text) => {
      printed.push(text);
    },
  };
}

describe('runBackupCommand', () => {
  it('runs the cycle at the hour the clock says, unasked-for', async () => {
    const recorded = recording();

    await runBackupCommand({
      env: environment(),
      argv: [],
      now: () => TEST_DAY_START + 7 * HOUR_MS,
      run: recorded.run,
      provision: recorded.provision,
      write: recorded.write,
    });

    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]?.hourUtc).toBe(new Date(TEST_DAY_START + 7 * HOUR_MS).getUTCHours());
    expect(recorded.calls[0]?.dispatched).toBe(false);
    expect(recorded.calls[0]?.settings.repository.bucket).toBe(
      `value-of-${BACKUP_VARIABLES.repositoryBucket}`
    );
  });

  it('marks a run asked for by hand', async () => {
    const recorded = recording();

    await runBackupCommand({
      env: environment(),
      argv: ['--dispatched'],
      now: () => TEST_DAY_START,
      run: recorded.run,
      provision: recorded.provision,
      write: recorded.write,
    });

    expect(recorded.calls[0]?.dispatched).toBe(true);
  });

  it('prints its usage and backs nothing up when asked for help', async () => {
    const recorded = recording();

    await runBackupCommand({
      env: environment(),
      argv: ['--help'],
      now: () => TEST_DAY_START,
      run: recorded.run,
      provision: recorded.provision,
      write: recorded.write,
    });

    expect(recorded.calls).toEqual([]);
    expect(recorded.printed.join('')).toContain(COMMAND_LINE.command);
  });

  it('refuses an incomplete environment by naming what is absent', async () => {
    const recorded = recording();
    const incomplete = environment();
    Reflect.deleteProperty(incomplete, BACKUP_VARIABLES.repositoryBucket);

    await expect(
      runBackupCommand({
        env: incomplete,
        argv: [],
        now: () => TEST_DAY_START,
        run: recorded.run,
        provision: recorded.provision,
        write: recorded.write,
      })
    ).rejects.toThrow(BACKUP_VARIABLES.repositoryBucket);
    expect(recorded.calls).toEqual([]);
  });

  it('creates the repository and backs nothing up when asked to provision', async () => {
    const recorded = recording();

    await runBackupCommand({
      env: environment(),
      argv: ['--provision'],
      now: () => TEST_DAY_START,
      run: recorded.run,
      provision: recorded.provision,
      write: recorded.write,
    });

    expect(recorded.provisioned).toHaveLength(1);
    expect(recorded.provisioned[0]?.repository.bucket).toBe(
      `value-of-${BACKUP_VARIABLES.repositoryBucket}`
    );
    expect(recorded.calls).toEqual([]);
  });

  it('refuses to provision and back up in one invocation', async () => {
    const recorded = recording();

    await expect(
      runBackupCommand({
        env: environment(),
        argv: ['--provision', '--dispatched'],
        now: () => TEST_DAY_START,
        run: recorded.run,
        provision: recorded.provision,
        write: recorded.write,
      })
    ).rejects.toThrow(/takes no other flag/);

    expect(recorded.provisioned).toEqual([]);
    expect(recorded.calls).toEqual([]);
  });
});

describe('COMMAND_LINE', () => {
  it('does not declare itself a command that only reports', () => {
    const spec: CommandSpec = COMMAND_LINE;

    expect(spec.effect).toBeUndefined();
  });
});
