import net from 'node:net';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { reportFileRunId, runReportFile } from './lib/test-run/report-file.js';
import { REPORT_ENV } from './lib/vitest/coverage-offset-reporter.js';
import { parseVerdict, serializeLine } from './lib/test-run/test-batch-protocol.js';
import { runCoverageDirectory, type CoverageDirectoryFs } from './run-package-tests.js';
import {
  batchCoveragePaths,
  batchRunRecord,
  batchRunnerEnv,
  batchVitestArgs,
  createRegistry,
  reclaimBatchCoverage,
  sendVerdicts,
  withBatchCoverageDirectory,
  withBatchReportFiles,
} from './test-batch.js';
import type { Ownership, OwnershipState } from './lib/claims/ownership.js';
import type { TrackedRunSplit } from './lib/vitest/workers.js';
import type { VitestJsonReport } from './lib/test-run/test-report.js';

interface FakeSocket {
  written: string[];
  ended: boolean;
  write: (data: string) => void;
  end: () => void;
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    written: [],
    ended: false,
    write: (data) => {
      socket.written.push(data);
    },
    end: () => {
      socket.ended = true;
    },
  };
  return socket;
}

describe('sendVerdicts', () => {
  it('sends each client its verdict and closes the socket', () => {
    const ok = fakeSocket();
    const fail = fakeSocket();
    const clients = new Map([
      ['@hushbox/api', { registration: { package: '@hushbox/api', dir: '/a' }, socket: ok }],
      ['@hushbox/db', { registration: { package: '@hushbox/db', dir: '/b' }, socket: fail }],
    ]);
    const verdicts = new Map([
      ['@hushbox/api', { ok: true, reasons: [] as readonly string[] }],
      ['@hushbox/db', { ok: false, reasons: ['failed test file: x'] as readonly string[] }],
    ]);
    sendVerdicts(clients as never, verdicts);
    expect(parseVerdict(ok.written[0]?.trimEnd() ?? '')).toEqual({ verdict: 'ok' });
    expect(parseVerdict(fail.written[0]?.trimEnd() ?? '')).toEqual({
      verdict: 'fail',
      reasons: ['failed test file: x'],
    });
    expect(ok.ended).toBe(true);
    expect(fail.ended).toBe(true);
  });

  it('fails a client no verdict was computed for', () => {
    const socket = fakeSocket();
    const clients = new Map([
      ['@hushbox/api', { registration: { package: '@hushbox/api', dir: '/a' }, socket }],
    ]);
    sendVerdicts(clients as never, new Map());
    expect(socket.written[0]).toContain('"fail"');
  });
});

describe('createRegistry', () => {
  async function connectAndSend(
    port: number,
    message: string
  ): Promise<{ reply: string | undefined; socket: net.Socket }> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.write(message);
      });
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('\n')) {
          resolve({ reply: buffer, socket });
        }
      });
      // A registrant the registry accepts gets no reply until verdicts land.
      setTimeout(() => {
        resolve({ reply: undefined, socket });
      }, 300);
    });
  }

  it('accepts an expected registrant silently and tells others to run solo', async () => {
    const missed = new Map([['@hushbox/api', '/repo/apps/api']]);
    const registry = createRegistry(missed);
    await new Promise<void>((resolve) => {
      registry.server.listen(0, '127.0.0.1', resolve);
    });
    const address = registry.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('no port');
    }

    const expected = await connectAndSend(
      address.port,
      serializeLine({ package: '@hushbox/api', dir: '/repo/apps/api' })
    );
    expect(expected.reply).toBeUndefined();
    expect(registry.clients.has('@hushbox/api')).toBe(true);

    const unexpected = await connectAndSend(
      address.port,
      serializeLine({ package: '@hushbox/web', dir: '/repo/apps/web' })
    );
    expect(unexpected.reply).toContain('solo');

    // A duplicate registrant is refused even once verdicts exist.
    registry.verdicts = new Map([['@hushbox/api', { ok: true, reasons: [] }]]);
    const late = await connectAndSend(
      address.port,
      serializeLine({ package: '@hushbox/api', dir: '/repo/apps/api' })
    );
    expect(late.reply).toContain('solo');

    expected.socket.destroy();
    unexpected.socket.destroy();
    late.socket.destroy();
    await new Promise<void>((resolve) => {
      registry.server.close(() => {
        resolve();
      });
    });
  });

  it('answers a late expected registrant with its verdict immediately', async () => {
    const missed = new Map([['@hushbox/db', '/repo/packages/db']]);
    const registry = createRegistry(missed);
    registry.verdicts = new Map([['@hushbox/db', { ok: false, reasons: ['failed test file: x'] }]]);
    await new Promise<void>((resolve) => {
      registry.server.listen(0, '127.0.0.1', resolve);
    });
    const address = registry.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('no port');
    }
    const late = await connectAndSend(
      address.port,
      serializeLine({ package: '@hushbox/db', dir: '/repo/packages/db' })
    );
    expect(late.reply).toContain('fail');
    late.socket.destroy();
    await new Promise<void>((resolve) => {
      registry.server.close(() => {
        resolve();
      });
    });
  });

  it('signals onRegistration for each accepted registrant', async () => {
    const missed = new Map([
      ['@hushbox/api', '/repo/apps/api'],
      ['@hushbox/db', '/repo/packages/db'],
    ]);
    const registry = createRegistry(missed);
    let signals = 0;
    registry.onRegistration = () => {
      signals += 1;
    };
    await new Promise<void>((resolve) => {
      registry.server.listen(0, '127.0.0.1', resolve);
    });
    const address = registry.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('no port');
    }
    const first = await connectAndSend(
      address.port,
      serializeLine({ package: '@hushbox/api', dir: '/repo/apps/api' })
    );
    const second = await connectAndSend(
      address.port,
      serializeLine({ package: '@hushbox/db', dir: '/repo/packages/db' })
    );
    expect(signals).toBe(2);
    first.socket.destroy();
    second.socket.destroy();
    await new Promise<void>((resolve) => {
      registry.server.close(() => {
        resolve();
      });
    });
  });
});

describe('batchVitestArgs', () => {
  const ARGS_INPUT = {
    repoRoot: '/repo',
    workers: 10,
    directories: ['packages/db', 'apps/web'],
    coverageInclude: ['packages/db/src/**'],
    reportsDirectory: '/repo/.cache/coverage/run',
    reportFile: '/repo/.cache/reports/report.json',
  };

  it('declares the worker count the derivation produced', () => {
    expect(batchVitestArgs(ARGS_INPUT)).toContain('--maxWorkers=10');
  });

  it('names every directory the batch covers', () => {
    expect(batchVitestArgs(ARGS_INPUT)).toEqual(
      expect.arrayContaining(['packages/db', 'apps/web'])
    );
  });

  it('names no override of the pool, which is what would bypass one fork per file', () => {
    expect(
      batchVitestArgs(ARGS_INPUT).filter((argument) => /^--(no-)?pool/.test(argument))
    ).toEqual([]);
  });

  it('names no override of file parallelism, for the same reason', () => {
    expect(
      batchVitestArgs(ARGS_INPUT).filter((argument) => /^--(no-)?fileParallelism/i.test(argument))
    ).toEqual([]);
  });

  it('names the coverage scope of every covered package', () => {
    expect(batchVitestArgs(ARGS_INPUT)).toContain('--coverage.include=packages/db/src/**');
  });

  it('names the report the batch reads its verdicts back out of', () => {
    expect(batchVitestArgs(ARGS_INPUT)).toContain(
      '--outputFile.json=/repo/.cache/reports/report.json'
    );
  });
});

describe('batchRunnerEnv', () => {
  it('publishes the file the coverage-offset scan reports into', () => {
    expect(batchRunnerEnv('/offsets.json')[REPORT_ENV]).toBe('/offsets.json');
  });
});

describe('batchCoveragePaths', () => {
  it('gives two concurrent batches different coverage directories', () => {
    expect(batchCoveragePaths('/repo', 'a-b').reportsDirectory).not.toBe(
      batchCoveragePaths('/repo', 'c-d').reportsDirectory
    );
  });

  it('keys the directory through the shared run-keying helper', () => {
    expect(batchCoveragePaths('/repo', 'a-b').reportsDirectory).toBe(
      runCoverageDirectory('/repo', 'a-b')
    );
  });

  it('points the empty-scope guard at the directory the run wrote to', () => {
    const paths = batchCoveragePaths('/repo', 'a-b');
    expect(paths.coverageFile).toBe(path.join(paths.reportsDirectory, 'coverage-final.json'));
  });
});

describe('batchRunRecord', () => {
  /**
   * A width no other figure on the row carries, so a row filed at it can only
   * have taken it from the reading the peak came out of.
   */
  const TRACKED: TrackedRunSplit = {
    peakRssKb: 19_000_000,
    split: { fixedRssKb: 2_000_000 },
    peakRunnerChildren: 19,
    lanesAtPeak: 11,
  };

  const COLLECTED: VitestJsonReport = {
    testResults: [
      { name: 'a.test.ts', status: 'passed', startTime: 1000, endTime: 3000 },
      { name: 'b.test.ts', status: 'passed', startTime: 1000, endTime: 2000 },
    ],
  };

  function record(report: VitestJsonReport | undefined): ReturnType<typeof batchRunRecord> {
    return batchRunRecord({
      wallMs: 180_000,
      tracked: TRACKED,
      runnerPid: 4321,
      declaredWorkers: 19,
      packageCount: 12,
      report,
    });
  }

  it('stamps the row with the shape of the invocation that measured it', () => {
    expect(record(COLLECTED).shape).toBe('batch');
  });

  it('files the row at the lanes live when it peaked, not at the count it declared', () => {
    expect(record(COLLECTED).lanesAtPeak).toBe(11);
  });

  it('carries the whole tree’s peak and the split that peak divided into', () => {
    expect(record(COLLECTED)).toMatchObject({
      peakRssKb: TRACKED.peakRssKb,
      split: TRACKED.split,
      peakRunnerChildren: TRACKED.peakRunnerChildren,
    });
  });

  it('records the packages the batch covered and the files they amounted to', () => {
    expect(record(COLLECTED)).toMatchObject({ packageCount: 12, fileCount: 2 });
  });

  it('weighs the files the report could weigh', () => {
    expect(record(COLLECTED)).toMatchObject({ perFileWallMs: 1500, sumFileWallMs: 3000 });
  });

  /**
   * A batch killed before the reporter wrote anything collected an unknown
   * number of files, which is a different fact from having collected none — but
   * the row can only state what it knows.
   */
  it('records a batch whose report never landed as having collected no file', () => {
    const unwritten: VitestJsonReport | undefined = undefined;
    expect(record(unwritten)).toMatchObject({
      fileCount: 0,
      perFileWallMs: undefined,
      sumFileWallMs: undefined,
    });
  });
});

describe('reclaimBatchCoverage', () => {
  function ownershipOf(states: Readonly<Record<string, OwnershipState>>): Ownership {
    return {
      stateOfRun: (runId) =>
        runId === null || runId === undefined ? 'unowned' : (states[runId] ?? 'unowned'),
      stateOfResource: () => 'unowned',
      resourceOwner: () => undefined,
      unreadLiveRuns: [],
    };
  }

  function recordingFs(
    entries: readonly string[]
  ): CoverageDirectoryFs & { readonly listed: string[]; readonly removed: string[] } {
    const listed: string[] = [];
    const removed: string[] = [];
    return {
      listed,
      removed,
      readdir: (dir) => {
        listed.push(dir);
        return entries;
      },
      remove: (target) => {
        removed.push(target);
      },
    };
  }

  it('collects the directory a batch that died left behind', () => {
    const fs = recordingFs(['run-dead']);
    reclaimBatchCoverage('/repo', ownershipOf({ dead: 'owned-expired' }), fs);
    expect(fs.removed).toEqual([runCoverageDirectory('/repo', 'dead')]);
  });

  it('keeps the directory a concurrent batch is still writing', () => {
    const fs = recordingFs(['run-live']);
    reclaimBatchCoverage('/repo', ownershipOf({ live: 'owned-live' }), fs);
    expect(fs.removed).toEqual([]);
  });

  it('sweeps the directory holding this batch coverage directory', () => {
    const fs = recordingFs([]);
    reclaimBatchCoverage('/repo', ownershipOf({}), fs);
    expect(fs.listed).toEqual([path.dirname(batchCoveragePaths('/repo', 'a-b').reportsDirectory)]);
  });
});

describe('withBatchCoverageDirectory', () => {
  function droppingFs(): CoverageDirectoryFs & { readonly removed: string[] } {
    const removed: string[] = [];
    return {
      removed,
      readdir: () => [],
      remove: (target) => {
        removed.push(target);
      },
    };
  }

  it('drops the coverage directory when the batch throws part-way', async () => {
    const fs = droppingFs();
    await expect(
      withBatchCoverageDirectory('/repo/coverage/run-a', fs, () => {
        throw new SyntaxError('Unexpected end of JSON input');
      })
    ).rejects.toThrow('Unexpected end of JSON input');
    expect(fs.removed).toEqual(['/repo/coverage/run-a']);
  });

  it('reraises what the batch threw', async () => {
    const fs = droppingFs();
    await expect(
      withBatchCoverageDirectory('/repo/coverage/run-a', fs, () =>
        Promise.reject(new Error('coverage map missing'))
      )
    ).rejects.toThrow('coverage map missing');
  });

  it('drops the coverage directory when the batch passes', async () => {
    const fs = droppingFs();
    await withBatchCoverageDirectory('/repo/coverage/run-a', fs, () =>
      Promise.resolve(new Map([['@hushbox/scripts', { ok: true, reasons: [] }]]))
    );
    expect(fs.removed).toEqual(['/repo/coverage/run-a']);
  });

  it('drops the coverage directory when the batch reports failing tests', async () => {
    const fs = droppingFs();
    await withBatchCoverageDirectory('/repo/coverage/run-a', fs, () =>
      Promise.resolve(new Map([['@hushbox/scripts', { ok: false, reasons: ['tests failed'] }]]))
    );
    expect(fs.removed).toEqual(['/repo/coverage/run-a']);
  });

  it('hands back the verdicts the batch produced', async () => {
    const verdicts = new Map([['@hushbox/scripts', { ok: true, reasons: [] }]]);
    await expect(
      withBatchCoverageDirectory('/repo/coverage/run-a', droppingFs(), () =>
        Promise.resolve(verdicts)
      )
    ).resolves.toBe(verdicts);
  });
});

describe('withBatchReportFiles', () => {
  const CLAIMED = runReportFile('/reports', 'a-b');

  function droppingClaim(): {
    readonly claim: () => Promise<string>;
    readonly drop: (file: string) => void;
    readonly dropped: string[];
  } {
    const dropped: string[] = [];
    return {
      claim: () => Promise.resolve(CLAIMED),
      drop: (file) => {
        dropped.push(file);
      },
      dropped,
    };
  }

  it('writes the offset findings beside the report the run claimed', async () => {
    const seam = droppingClaim();
    let seen = '';
    await withBatchReportFiles(seam.claim, seam.drop, (files) => {
      seen = files.offsetFile;
      return Promise.resolve(new Map());
    });
    expect(seen).toBe(`${CLAIMED}.offsets.json`);
  });

  it('leaves the offset findings attributable to the run that wrote them', async () => {
    const seam = droppingClaim();
    let seen = '';
    await withBatchReportFiles(seam.claim, seam.drop, (files) => {
      seen = files.offsetFile;
      return Promise.resolve(new Map());
    });
    expect(reportFileRunId(path.basename(seen))).toBe('a-b');
  });

  it('drops both files when the batch passes', async () => {
    const seam = droppingClaim();
    await withBatchReportFiles(seam.claim, seam.drop, () => Promise.resolve(new Map()));
    expect(seam.dropped).toEqual([CLAIMED, `${CLAIMED}.offsets.json`]);
  });

  it('drops both files when the batch throws part-way', async () => {
    const seam = droppingClaim();
    await expect(
      withBatchReportFiles(seam.claim, seam.drop, () => {
        throw new SyntaxError('Unexpected end of JSON input');
      })
    ).rejects.toThrow('Unexpected end of JSON input');
    expect(seam.dropped).toEqual([CLAIMED, `${CLAIMED}.offsets.json`]);
  });

  it('reraises what the batch threw', async () => {
    const seam = droppingClaim();
    await expect(
      withBatchReportFiles(seam.claim, seam.drop, () =>
        Promise.reject(new Error('coverage map missing'))
      )
    ).rejects.toThrow('coverage map missing');
  });

  it('hands back the verdicts the batch produced', async () => {
    const seam = droppingClaim();
    const verdicts = new Map([['@hushbox/scripts', { ok: true, reasons: [] }]]);
    await expect(
      withBatchReportFiles(seam.claim, seam.drop, () => Promise.resolve(verdicts))
    ).resolves.toBe(verdicts);
  });
});
