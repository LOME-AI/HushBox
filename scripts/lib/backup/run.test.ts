import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AwsClient } from 'aws4fetch';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { BACKUP_LIFECYCLE_NONCURRENT_DAYS, PRIVACY_SECTIONS } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';

import {
  BACKUP_VARIABLES,
  DRILL_HOUR_UTC,
  RUSTIC_RUNTIME_LIMIT_MS,
  currentHourUtc,
  KEEP_DELETE_CEILING_DAYS,
  PRUNE_CADENCE_DAYS,
  PRUNE_RECLAMATION,
  RETENTION_LADDER,
  forgetArguments,
  isDesignatedDailyRun,
  oldestRetainedSnapshotDays,
  provisionRepository,
  publishedRetentionCeilingDays,
  pruneArguments,
  readBackupSettings,
  readDataSubset,
  repositoryConfigUrl,
  retentionCeilingDays,
  runBackup,
  rusticFailureMessage,
  shouldRunDrill,
} from './run.js';
import type { BackupDependencies, BackupSettings } from './run.js';

const HOURS_IN_DAY = 24;

/** Every variable the run reads, each carrying a value distinct from the rest. */
function completeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.values(BACKUP_VARIABLES).map((name) => [name, `value-of-${name}`])
  );
}

describe('readBackupSettings', () => {
  it('reads every address, credential and connection the run needs', () => {
    const settings = readBackupSettings(completeEnvironment());

    expect(settings.repository.bucket).toBe(`value-of-${BACKUP_VARIABLES.repositoryBucket}`);
    expect(settings.repository.root).toBe(`value-of-${BACKUP_VARIABLES.repositoryRoot}`);
    expect(settings.r2.endpoint).toBe(`value-of-${BACKUP_VARIABLES.sourceEndpoint}`);
    expect(settings.sourceBuckets).toEqual({
      media: `value-of-${BACKUP_VARIABLES.mediaBucket}`,
      'app-builds': `value-of-${BACKUP_VARIABLES.appBuildsBucket}`,
      'model-weights': `value-of-${BACKUP_VARIABLES.modelWeightsBucket}`,
    });
    expect(settings.sourceCredentials.accessKeyId).toBe(`value-of-${BACKUP_VARIABLES.sourceKeyId}`);
    expect(settings.repositoryCredentials.secretAccessKey).toBe(
      `value-of-${BACKUP_VARIABLES.repositoryKey}`
    );
    expect(settings.repositoryPassword).toBe(`value-of-${BACKUP_VARIABLES.repositoryPassword}`);
    expect(settings.snapshotDatabaseUrl).toBe(`value-of-${BACKUP_VARIABLES.snapshotDatabaseUrl}`);
  });

  it('refuses by naming every absent variable', () => {
    const environment = completeEnvironment();
    Reflect.deleteProperty(environment, BACKUP_VARIABLES.repositoryPassword);
    environment[BACKUP_VARIABLES.databaseUrl] = '';

    expect(() => readBackupSettings(environment)).toThrow(
      new RegExp(`${BACKUP_VARIABLES.databaseUrl}.*${BACKUP_VARIABLES.repositoryPassword}`)
    );
  });

  it('names no value of a variable it refuses over', () => {
    const environment = completeEnvironment();
    Reflect.deleteProperty(environment, BACKUP_VARIABLES.repositoryPassword);

    const thrown: unknown = (() => {
      try {
        readBackupSettings(environment);
        return;
      } catch (error: unknown) {
        return error;
      }
    })();

    expect((thrown as Error).message).not.toContain('value-of-');
  });
});

describe('the retention ladder and the prune flags', () => {
  it('spells the forget ladder as flags', () => {
    expect(forgetArguments()).toEqual([
      'forget',
      '--keep-last',
      '1',
      '--keep-hourly',
      '48',
      '--keep-daily',
      '30',
      '--keep-weekly',
      '7',
    ]);
  });

  it('prunes with reclamation neither tolerated nor budgeted', () => {
    expect(pruneArguments()).toEqual([
      'prune',
      '--max-unused',
      '0',
      '--max-repack',
      'unlimited',
      '--keep-delete',
      '1d',
    ]);
  });

  it('takes the oldest snapshot a ladder retains from its longest tier', () => {
    expect(oldestRetainedSnapshotDays(RETENTION_LADDER)).toBe(49);
    expect(
      oldestRetainedSnapshotDays({
        'keep-last': 1,
        'keep-hourly': 48,
        'keep-daily': 90,
        'keep-weekly': 7,
      })
    ).toBe(90);
  });
});

describe('retentionCeilingDays', () => {
  it('adds the four stages of the deletion chain', () => {
    expect(retentionCeilingDays()).toBe(
      oldestRetainedSnapshotDays(RETENTION_LADDER) +
        PRUNE_CADENCE_DAYS +
        KEEP_DELETE_CEILING_DAYS +
        BACKUP_LIFECYCLE_NONCURRENT_DAYS
    );
  });

  it('refuses to state a ceiling when prune tolerates unused data', () => {
    expect(() => retentionCeilingDays({ ...PRUNE_RECLAMATION, 'max-unused': '5%' })).toThrow(
      /tolerat/i
    );
  });

  it('refuses to state a ceiling when prune caps how much it may repack', () => {
    expect(() => retentionCeilingDays({ ...PRUNE_RECLAMATION, 'max-repack': '10%' })).toThrow(
      /budget/i
    );
  });

  it('refuses to state a ceiling when prune holds a marked pack for another span', () => {
    expect(() => retentionCeilingDays({ ...PRUNE_RECLAMATION, 'keep-delete': '30d' })).toThrow(
      /30d/
    );
  });

  it('stays inside the ceiling the privacy policy publishes', () => {
    expect(retentionCeilingDays()).toBeLessThanOrEqual(publishedRetentionCeilingDays());
  });
});

describe('publishedRetentionCeilingDays', () => {
  it('reads the number out of the published retention commitment', () => {
    expect(publishedRetentionCeilingDays()).toBe(90);
  });

  it('refuses when no published point states a bound in days', () => {
    const withoutTheCommitment = PRIVACY_SECTIONS.map((section) =>
      section.id === 'data-retention'
        ? { ...section, simplyPut: 'You can delete your account at any time.', points: [] }
        : section
    );

    expect(() => publishedRetentionCeilingDays(withoutTheCommitment)).toThrow(/no published/i);
  });
});

describe('shouldRunDrill', () => {
  it('is true for exactly one hour of an undispatched day', () => {
    const hours = [...Array.from({ length: HOURS_IN_DAY }).keys()];

    expect(hours.filter((hour) => shouldRunDrill(hour, false))).toEqual([DRILL_HOUR_UTC]);
  });

  it('is true at every hour of a dispatched run', () => {
    for (let hour = 0; hour < HOURS_IN_DAY; hour += 1) {
      expect(shouldRunDrill(hour, true)).toBe(true);
    }
  });

  it('designates one run a day for the prune, whatever the dispatch flag says', () => {
    const hours = [...Array.from({ length: HOURS_IN_DAY }).keys()];

    expect(hours.filter((hour) => isDesignatedDailyRun(hour))).toEqual([DRILL_HOUR_UTC]);
  });
});

describe('readDataSubset', () => {
  it('reads a different twenty-fourth each hour and the whole repository each day', () => {
    const subsets = [...Array.from({ length: HOURS_IN_DAY }).keys()].map((hour) =>
      readDataSubset(hour)
    );

    expect(new Set(subsets).size).toBe(HOURS_IN_DAY);
    expect(subsets[0]).toBe('1/24');
    expect(subsets[HOURS_IN_DAY - 1]).toBe('24/24');
  });
});

describe('currentHourUtc', () => {
  it('reads the hour of the day out of an instant', () => {
    expect(currentHourUtc(TEST_DAY_START)).toBe(new Date(TEST_DAY_START).getUTCHours());
    expect(currentHourUtc(TEST_DAY_START + 5 * HOUR_MS)).toBe(
      (new Date(TEST_DAY_START).getUTCHours() + 5) % HOURS_IN_DAY
    );
  });
});

/** Settings whose every value is a marker no other field carries. */
function markerSettings(): BackupSettings {
  return readBackupSettings(
    Object.fromEntries(
      Object.entries(BACKUP_VARIABLES).map(([field, name]) => [
        name,
        field.toLowerCase().includes('url')
          ? `postgres://user:marker-${field}@host.invalid/db`
          : `marker-${field}`,
      ])
    )
  );
}

interface Recorded {
  readonly steps: string[];
  readonly deps: BackupDependencies;
  readonly cleaned: () => boolean;
  readonly configDirectory: () => string;
  readonly passwordDuringRun: () => string | undefined;
}

function recordingDependencies(
  overrides: Partial<BackupDependencies> = {},
  provisioned = true
): Recorded {
  const steps: string[] = [];
  let cleaned = false;
  let configDirectory = '';
  let passwordDuringRun: string | undefined;
  const deps: BackupDependencies = {
    ensureRustic: () => {
      steps.push('ensure-rustic');
      return Promise.resolve('rustic');
    },
    dumpDatabase: (options) => {
      steps.push(`dump ${path.basename(options.outDir)}`);
      return Promise.resolve({
        snapshotId: 'snapshot',
        tables: { one: 1 },
        migrationHead: 'head',
        formatVersion: 1,
      });
    },
    writeConfig: async () => {
      steps.push('write-config');
      passwordDuringRun = process.env['RUSTIC_PASSWORD'];
      configDirectory = await mkdtemp(path.join(os.tmpdir(), 'hb-run-test-'));
      return {
        path: path.join(configDirectory, 'rustic.toml'),
        cleanup: async () => {
          cleaned = true;
          await rm(configDirectory, { recursive: true, force: true });
        },
      };
    },
    rustic: (_rusticPath, _configPath, args) => {
      steps.push(`rustic ${args.join(' ')}`);
      return Promise.resolve();
    },
    reconcile: () => {
      steps.push('reconcile');
      return Promise.resolve([]);
    },
    spotCheck: (options) => {
      steps.push(`spot-check ${options.label}`);
      return Promise.resolve({ label: options.label, status: 'passed' as const });
    },
    runDrill: () => {
      steps.push('drill');
      return Promise.resolve({ tablesChecked: 1, passed: true, mismatches: [] });
    },
    readRepoInfo: () => {
      steps.push('repoinfo');
      return Promise.resolve({ logicalBytes: 10, storedBytes: 5 });
    },
    writeSummary: (line) => {
      steps.push(`summary ${line.slice(0, 9)}`);
    },
    // A real client rather than a stand-in: its constructor takes literals and
    // opens nothing, so the pipeline is handed the type it actually passes on.
    createClient: () =>
      new AwsClient({
        accessKeyId: 'recorded',
        secretAccessKey: 'recorded',
        service: 's3',
        region: 'auto',
      }),
    repositoryProvisioned: () => {
      steps.push('repository-provisioned');
      return Promise.resolve(provisioned);
    },
    ...overrides,
  };
  return {
    steps,
    deps,
    cleaned: () => cleaned,
    configDirectory: () => configDirectory,
    passwordDuringRun: () => passwordDuringRun,
  };
}

describe('repositoryConfigUrl', () => {
  it('addresses the configuration object a provisioned repository holds', () => {
    expect(
      repositoryConfigUrl({
        endpoint: 'https://store.invalid',
        region: 'us-east-1',
        bucket: 'a-bucket',
        root: 'repository',
      })
    ).toBe('https://store.invalid/a-bucket/repository/config');
  });

  it('joins an endpoint that ends in a slash without doubling it', () => {
    expect(
      repositoryConfigUrl({
        endpoint: 'https://store.invalid//',
        region: 'us-east-1',
        bucket: 'a-bucket',
        root: 'repository',
      })
    ).toBe('https://store.invalid/a-bucket/repository/config');
  });
});

describe('rusticFailureMessage', () => {
  it('reports nothing about an invocation that exited zero', () => {
    expect(
      rusticFailureMessage(['forget', '--keep-last', '1'], { exitCode: 0, timedOut: false })
    ).toBeUndefined();
  });

  it('names the subcommand and the status an invocation failed with', () => {
    expect(rusticFailureMessage(['check'], { exitCode: 3, timedOut: false })).toBe(
      'runBackup: rustic check exited 3'
    );
  });

  it('names the limit an invocation was killed at rather than a status', () => {
    expect(rusticFailureMessage(['backup'], { exitCode: undefined, timedOut: true })).toBe(
      `runBackup: rustic backup ran past its limit of ${String(RUSTIC_RUNTIME_LIMIT_MS)} ms and was killed`
    );
  });

  it('says an invocation reached no exit status when none came back', () => {
    expect(rusticFailureMessage(['prune'], { exitCode: undefined, timedOut: false })).toBe(
      'runBackup: rustic prune reached no exit status'
    );
  });

  it('reports a failure of an invocation carrying no subcommand at all', () => {
    expect(rusticFailureMessage([], { exitCode: 1, timedOut: false })).toBe(
      'runBackup: rustic no subcommand exited 1'
    );
  });
});

describe('provisionRepository', () => {
  it('creates the repository and takes its profile away again', async () => {
    const recorded = recordingDependencies();

    await provisionRepository(markerSettings(), recorded.deps);

    expect(recorded.steps).toEqual(['ensure-rustic', 'write-config', 'rustic init']);
    expect(recorded.cleaned()).toBe(true);
    expect(existsSync(recorded.configDirectory())).toBe(false);
    expect(recorded.passwordDuringRun()).toBe('marker-repositoryPassword');
    expect(process.env['RUSTIC_PASSWORD']).toBeUndefined();
  });
});

describe('runBackup', () => {
  it('runs every step of an ordinary hour in order, and no drill or prune', async () => {
    const recorded = recordingDependencies();

    await runBackup(
      { settings: markerSettings(), hourUtc: DRILL_HOUR_UTC + 1, dispatched: false },
      recorded.deps
    );

    expect(recorded.steps).toEqual([
      'repository-provisioned',
      'ensure-rustic',
      'dump dump',
      'write-config',
      'rustic backup',
      'reconcile',
      'spot-check media',
      'spot-check app-builds',
      'spot-check model-weights',
      `rustic check --read-data --read-data-subset ${readDataSubset(DRILL_HOUR_UTC + 1)}`,
      `rustic ${forgetArguments().join(' ')}`,
      'repoinfo',
      'summary - backup:',
    ]);
  });

  it('drills and prunes on the day’s designated run', async () => {
    const recorded = recordingDependencies();

    const summary = await runBackup(
      { settings: markerSettings(), hourUtc: DRILL_HOUR_UTC, dispatched: false },
      recorded.deps
    );

    expect(recorded.steps).toContain('drill');
    expect(recorded.steps).toContain(`rustic ${pruneArguments().join(' ')}`);
    expect(recorded.steps.indexOf('drill')).toBeLessThan(
      recorded.steps.findIndex((step) => step.startsWith('rustic check'))
    );
    expect(summary.drillPassed).toBe(true);
  });

  it('drills but does not prune on a dispatched run at another hour', async () => {
    const recorded = recordingDependencies();

    await runBackup(
      { settings: markerSettings(), hourUtc: DRILL_HOUR_UTC + 2, dispatched: true },
      recorded.deps
    );

    expect(recorded.steps).toContain('drill');
    expect(recorded.steps).not.toContain(`rustic ${pruneArguments().join(' ')}`);
  });

  it('reports what it reconciled, spot-checked and measured', async () => {
    const recorded = recordingDependencies();

    const summary = await runBackup(
      { settings: markerSettings(), hourUtc: 0, dispatched: false },
      recorded.deps
    );

    expect(summary).toEqual({
      logicalBytes: 10,
      storedBytes: 5,
      reconciled: true,
      spotChecks: [
        { label: 'media', status: 'passed' },
        { label: 'app-builds', status: 'passed' },
        { label: 'model-weights', status: 'passed' },
      ],
    });
  });

  it('puts no configured value on any rustic command line', async () => {
    const recorded = recordingDependencies();

    await runBackup(
      { settings: markerSettings(), hourUtc: DRILL_HOUR_UTC, dispatched: true },
      recorded.deps
    );

    expect(recorded.steps.join(' ')).not.toContain('marker-');
  });

  it('hands the repository password to rustic through the environment alone', async () => {
    const recorded = recordingDependencies();
    const before = process.env['RUSTIC_PASSWORD'];

    await runBackup({ settings: markerSettings(), hourUtc: 0, dispatched: false }, recorded.deps);

    expect(recorded.passwordDuringRun()).toBe('marker-repositoryPassword');
    expect(process.env['RUSTIC_PASSWORD']).toBe(before);
  });

  it('refuses a repository nothing has provisioned, before it reads a database', async () => {
    const recorded = recordingDependencies({}, false);

    await expect(
      runBackup({ settings: markerSettings(), hourUtc: 0, dispatched: false }, recorded.deps)
    ).rejects.toThrow(/not provisioned/);

    expect(recorded.steps).toEqual(['repository-provisioned']);
  });

  /**
   * The refusal is read in two places by two people. On a failed scheduled job
   * an operator reads it, and the workflow exists so that the production
   * credentials never leave the environment holding them — so a refusal naming
   * only the developer command directs that operator to do the one thing the
   * design prevents. The workflow is named by its path, which resolves, and the
   * input by its backticked spelling, which the local command's `--provision`
   * does not contain.
   */
  const BACKUP_WORKFLOW = '.github/workflows/backup.yml';

  async function provisioningRefusal(): Promise<string> {
    const thrown: unknown = await runBackup(
      { settings: markerSettings(), hourUtc: 0, dispatched: false },
      recordingDependencies({}, false).deps
    ).catch((error: unknown) => error);
    return (thrown as Error).message;
  }

  it('points an operator at a provisioning route that keeps credentials off a personal machine', async () => {
    const workflow = path.resolve(import.meta.dirname, '../../..', BACKUP_WORKFLOW);
    const dispatchInputs = Object.keys(
      (
        parseYaml(readFileSync(workflow, 'utf8')) as {
          on: { workflow_dispatch: { inputs: Record<string, unknown> } };
        }
      ).on.workflow_dispatch.inputs
    );

    const message = await provisioningRefusal();

    expect(existsSync(workflow)).toBe(true);
    expect(dispatchInputs).toHaveLength(1);
    expect(message).toContain(BACKUP_WORKFLOW);
    expect(message).toContain(`\`${dispatchInputs[0] ?? ''}\``);
  });

  it('still tells a developer the local command that provisions a repository', async () => {
    expect(await provisioningRefusal()).toContain('pnpm backup --provision');
  });

  it('names the repository it found nothing at, and no credential', async () => {
    const recorded = recordingDependencies({}, false);

    const thrown: unknown = await runBackup(
      { settings: markerSettings(), hourUtc: 0, dispatched: false },
      recorded.deps
    ).catch((error: unknown) => error);

    expect((thrown as Error).message).toContain('marker-repositoryBucket');
    expect((thrown as Error).message).toContain('marker-repositoryRoot');
    expect((thrown as Error).message).not.toContain('marker-repositoryPassword');
  });

  it('removes its work directory and its profile even when a step fails', async () => {
    const recorded = recordingDependencies({
      reconcile: () => Promise.reject(new Error('reconcile: a bucket and its snapshot disagree')),
    });

    await expect(
      runBackup({ settings: markerSettings(), hourUtc: 0, dispatched: false }, recorded.deps)
    ).rejects.toThrow(/disagree/);

    expect(recorded.cleaned()).toBe(true);
    expect(existsSync(recorded.configDirectory())).toBe(false);
    expect(process.env['RUSTIC_PASSWORD']).toBeUndefined();
  });
});
