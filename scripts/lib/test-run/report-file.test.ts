import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { currentRunId } from '../claims/ownership.js';
import { RUN_CLAIM_ENV, registerRun } from '../claims/registry.js';
import {
  claimReportFile,
  dropReportFile,
  reclaimReportFiles,
  reportDirectory,
  reportFileRunId,
  runReportFile,
} from './report-file.js';

const CHECKOUT = path.join(path.sep, 'checkout-under-test', '.git');

/**
 * The run claim this file was invoked under. Registering a run inside a case
 * clears the variable on the way out, so a hook that puts back an empty string
 * leaves every later suite here creating resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];

afterAll(() => {
  expect(process.env[RUN_CLAIM_ENV]).toBe(inheritedRunClaim ?? '');
});

function write(file: string): string {
  writeFileSync(file, '{}');
  return file;
}

describe('runReportFile', () => {
  it('names a report file after the run that writes it', () => {
    const file = runReportFile(path.sep, 'a-b');

    expect(reportFileRunId(path.basename(file))).toBe('a-b');
  });

  it('gives two runners of one run non-overlapping files', () => {
    expect(runReportFile(path.sep, 'a-b')).not.toBe(runReportFile(path.sep, 'a-b'));
  });

  it('names a report no claim can be looked up for when the run holds none', () => {
    const file = runReportFile(path.sep, null);

    expect(reportFileRunId(path.basename(file))).toBeUndefined();
  });
});

describe('reportFileRunId', () => {
  it('returns undefined for a name this module never minted', () => {
    expect(reportFileRunId('hb-test-report-1-2.json')).toBeUndefined();
    expect(reportFileRunId('run-.json')).toBeUndefined();
  });

  it('reads the run off the offset findings written beside a report', () => {
    const file = runReportFile(path.sep, 'a-b');

    expect(reportFileRunId(`${path.basename(file)}.offsets.json`)).toBe('a-b');
  });
});

describe('reclaimReportFiles', () => {
  let registryDir: string;
  let directory: string;

  beforeEach(async () => {
    registryDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-report-registry-'));
    directory = await mkdtemp(path.join(os.tmpdir(), 'hushbox-report-files-'));
    process.env[RUN_CLAIM_ENV] = '';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
    await rm(registryDir, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function run<T>(body: () => Promise<T>): Promise<T> {
    return registerRun(
      { command: 'pnpm test', mode: 'test', slot: 4, gitCommonDir: CHECKOUT, registryDir },
      body
    );
  }

  it('removes a report whose owning run is gone', async () => {
    let left = '';
    await expect(
      run(() => {
        left = write(runReportFile(directory, currentRunId()));
        return Promise.reject(new Error('killed'));
      })
    ).rejects.toThrow('killed');

    const reclaim = await reclaimReportFiles(directory, { registryDir });

    expect(reclaim.removed).toEqual([left]);
    expect(existsSync(left)).toBe(false);
  });

  it('leaves a report whose owning run still holds its claim', async () => {
    await run(async () => {
      const mine = write(runReportFile(directory, currentRunId()));

      const reclaim = await reclaimReportFiles(directory, { registryDir });

      expect(reclaim.removed).toEqual([]);
      expect(existsSync(mine)).toBe(true);
    });
  });

  it('reports a report no claim accounts for and leaves it standing', async () => {
    const stranger = write(runReportFile(directory, 'a-run-nothing-registered'));

    const reclaim = await reclaimReportFiles(directory, { registryDir });

    expect(reclaim.unowned).toEqual([stranger]);
    expect(existsSync(stranger)).toBe(true);
  });

  it('leaves a file this module never named where it stands', async () => {
    const alien = write(path.join(directory, 'hb-test-report-1-2.json'));

    const reclaim = await reclaimReportFiles(directory, { registryDir });

    expect(reclaim.removed).toEqual([]);
    expect(reclaim.unowned).toEqual([]);
    expect(existsSync(alien)).toBe(true);
  });

  it('reads an absent directory as a pass with nothing to reclaim', async () => {
    await expect(
      reclaimReportFiles(path.join(directory, 'never-created'), { registryDir })
    ).resolves.toEqual({ removed: [], unowned: [] });
  });
});

describe('claimReportFile', () => {
  let registryDir: string;
  let parent: string;
  let directory: string;

  beforeEach(async () => {
    registryDir = await mkdtemp(path.join(os.tmpdir(), 'hushbox-report-registry-'));
    parent = await mkdtemp(path.join(os.tmpdir(), 'hushbox-report-claim-'));
    directory = path.join(parent, 'reports');
    process.env[RUN_CLAIM_ENV] = '';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
    await rm(registryDir, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('hands back a path inside a directory it has already created', async () => {
    const file = await claimReportFile({ directory, registryDir });

    expect(path.dirname(file)).toBe(directory);
    expect(existsSync(directory)).toBe(true);
  });

  it('collects what a dead run left before naming this one', async () => {
    let dead = '';
    await expect(
      registerRun(
        { command: 'pnpm test', mode: 'test', slot: 4, gitCommonDir: CHECKOUT, registryDir },
        async () => {
          dead = write(await claimReportFile({ directory, registryDir }));
          throw new Error('killed');
        }
      )
    ).rejects.toThrow('killed');

    await claimReportFile({ directory, registryDir });

    expect(existsSync(dead)).toBe(false);
  });
});

describe('dropReportFile', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'hushbox-report-drop-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('removes the report the run that wrote it has finished reading', () => {
    const file = write(path.join(directory, 'report.json'));

    dropReportFile(file);

    expect(existsSync(file)).toBe(false);
  });

  it('succeeds on a report that is already gone', () => {
    expect(() => {
      dropReportFile(path.join(directory, 'absent.json'));
    }).not.toThrow();
  });
});

describe('reportDirectory', () => {
  it('holds this design reports apart from the temp directory older ones went to', () => {
    expect(path.dirname(reportDirectory())).toBe(os.tmpdir());
    expect(path.basename(reportDirectory())).not.toBe('');
  });
});
