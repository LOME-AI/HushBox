import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ledgerPath, readLedger, writeLedger, type PoolLedger } from './ledger.js';
import {
  countPhysicalCores,
  describeMachine,
  expandCpuList,
  fingerprintOf,
  machineFingerprint,
  performanceCoreCount,
  type CpuTopologyEntry,
  type MachineDescriptor,
} from './machine.js';

const DESCRIPTOR: MachineDescriptor = {
  platform: 'linux',
  arch: 'x64',
  cpuModel: '13th Gen Intel(R) Core(TM) i9-13900H',
  threads: 20,
  totalMemBytes: 33_294_872_576,
};

function cpu(index: number, coreId: string, packageId = '0'): CpuTopologyEntry {
  return { cpu: index, coreId, packageId };
}

describe('expandCpuList', () => {
  it('expands a hyphenated range', () => {
    expect(expandCpuList('0-3')).toEqual([0, 1, 2, 3]);
  });

  it('expands a comma-separated mixture of ranges and singletons', () => {
    expect(expandCpuList('0-1,4,6-7')).toEqual([0, 1, 4, 6, 7]);
  });

  it('ignores entries it cannot parse rather than yielding NaN', () => {
    expect(expandCpuList('0-1,,x,3')).toEqual([0, 1, 3]);
    // A range whose upper bound is unreadable is dropped whole.
    expect(expandCpuList('1-x,4')).toEqual([4]);
  });

  it('is empty for empty input', () => {
    expect(expandCpuList('   ')).toEqual([]);
  });
});

describe('countPhysicalCores', () => {
  it('counts distinct package/core pairs rather than threads', () => {
    // Four SMT threads over two physical cores.
    const entries = [cpu(0, '0'), cpu(1, '0'), cpu(2, '1'), cpu(3, '1')];
    expect(countPhysicalCores(entries)).toBe(2);
  });

  it('does not merge identical core ids from different packages', () => {
    expect(countPhysicalCores([cpu(0, '0', '0'), cpu(1, '0', '1')])).toBe(2);
  });

  it('counts only the performance tier when one is given', () => {
    // Six P threads over three P cores, plus two E cores outside the tier.
    const entries = [
      cpu(0, '0'),
      cpu(1, '0'),
      cpu(2, '1'),
      cpu(3, '1'),
      cpu(4, '2'),
      cpu(5, '2'),
      cpu(6, '3'),
      cpu(7, '4'),
    ];
    expect(countPhysicalCores(entries, new Set([0, 1, 2, 3, 4, 5]))).toBe(3);
  });

  it('is undefined when nothing could be read', () => {
    expect(countPhysicalCores([])).toBeUndefined();
  });

  it('is undefined when the tier matches no cpu', () => {
    expect(countPhysicalCores([cpu(0, '0')], new Set([9]))).toBeUndefined();
  });
});

describe('fingerprintOf', () => {
  it('is stable for the same machine', () => {
    expect(fingerprintOf(DESCRIPTOR)).toBe(fingerprintOf({ ...DESCRIPTOR }));
  });

  it('is a short hex string usable as a directory name', () => {
    expect(fingerprintOf(DESCRIPTOR)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('separates two machines that differ in anything shaping a schedule', () => {
    const base = fingerprintOf(DESCRIPTOR);
    expect(fingerprintOf({ ...DESCRIPTOR, platform: 'darwin' })).not.toBe(base);
    expect(fingerprintOf({ ...DESCRIPTOR, arch: 'arm64' })).not.toBe(base);
    expect(fingerprintOf({ ...DESCRIPTOR, cpuModel: 'Apple M3 Max' })).not.toBe(base);
  });

  it('is unmoved by the thread count an allocation decides', () => {
    const fewerThreads: MachineDescriptor = { ...DESCRIPTOR, threads: 4 };
    expect(fingerprintOf(fewerThreads)).toBe(fingerprintOf(DESCRIPTOR));
  });

  it('is unmoved by the total memory an allocation decides', () => {
    const lessMemory: MachineDescriptor = { ...DESCRIPTOR, totalMemBytes: 8_589_934_592 };
    expect(fingerprintOf(lessMemory)).toBe(fingerprintOf(DESCRIPTOR));
  });

  it('does not collide when two components swap values', () => {
    const a = fingerprintOf({ ...DESCRIPTOR, platform: 'a', arch: 'bb' });
    const b = fingerprintOf({ ...DESCRIPTOR, platform: 'ab', arch: 'b' });
    expect(a).not.toBe(b);
  });
});

describe('reading this machine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('describes both its shape and the numbers its allocation decides', () => {
    const descriptor = describeMachine();
    expect(descriptor.platform).toBe(process.platform);
    expect(descriptor.arch).toBe(process.arch);
    expect(descriptor.cpuModel.length).toBeGreaterThan(0);
    expect(descriptor.threads).toBe(os.availableParallelism());
    expect(descriptor.totalMemBytes).toBeGreaterThan(0);
  });

  it('fingerprints it as a short hex id, the same one twice running', () => {
    expect(machineFingerprint()).toMatch(/^[0-9a-f]{12}$/);
    expect(machineFingerprint()).toBe(machineFingerprint());
  });

  it('counts at least one core and never more than the machine has threads', () => {
    // The ceiling is only a starting point, so an unreadable topology costs a
    // couple of runs rather than a wrong answer — but it must stay in range.
    const cores = performanceCoreCount();
    expect(Number.isInteger(cores)).toBe(true);
    expect(cores).toBeGreaterThanOrEqual(1);
    expect(cores).toBeLessThanOrEqual(os.availableParallelism());
  });
});

describe('a ledger across an allocation change', () => {
  let workDir: string;

  /** The threads the machine is re-read at: fewer than the run below opened lanes. */
  const RESIZED_THREADS = 4;

  /** A run recorded before the width a row is filed at was ever stamped on one. */
  const MEASURED = {
    concurrency: 5,
    taskCount: 18,
    sumWallMs: 1_274_000,
    longestWallMs: 299_000,
    makespanMs: 300_000,
    peakRssKb: 13_400_000,
  } satisfies PoolLedger['runs'][number];

  const LEARNED: PoolLedger = {
    tasks: { '@hushbox/api': { wallsMs: [299_000] } },
    runs: [MEASURED],
  };

  beforeEach(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'hb-pool-machine-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  /** Landed under this machine's fingerprint, read back under the resized one's. */
  function readBackAfterResize(): PoolLedger {
    writeLedger(
      ledgerPath(workDir, fingerprintOf(DESCRIPTOR), 'lint'),
      LEARNED,
      (unit) => unit in LEARNED.tasks
    );
    const resized: MachineDescriptor = {
      ...DESCRIPTOR,
      threads: RESIZED_THREADS,
      totalMemBytes: 8_589_934_592,
    };
    return readLedger(ledgerPath(workDir, fingerprintOf(resized), 'lint'));
  }

  it('carries every wall and figure back under the fingerprint the resize computes', () => {
    // A containment match rather than equality: the read also supplies figures
    // a row never stored, so equality would assert the reader derives nothing.
    // What the round trip owes is that nothing measured is dropped or altered.
    expect(readBackAfterResize()).toMatchObject(LEARNED);
  });

  it('derives the width a row was filed at instead of reading one back', () => {
    // A reader that took the width from the machine in front of it would file
    // this row at the resized allocation rather than at what the run held.
    vi.spyOn(os, 'availableParallelism').mockReturnValue(RESIZED_THREADS);
    expect(MEASURED).not.toHaveProperty('lanesAtPeak');

    const read = readBackAfterResize();

    expect(read.runs).toHaveLength(1);
    expect(read.runs[0]).toHaveProperty('lanesAtPeak');
    expect(read.runs[0]?.lanesAtPeak).not.toBe(RESIZED_THREADS);
    // Bounded by the row's own account of itself: a run held no more lanes than
    // it declared, and no more than it had units to fill them with.
    expect(read.runs[0]?.lanesAtPeak).toBeLessThanOrEqual(MEASURED.concurrency);
    expect(read.runs[0]?.lanesAtPeak).toBeLessThanOrEqual(MEASURED.taskCount);
  });

  it('holds this machine steady across a live allocation change', () => {
    const before = machineFingerprint();
    vi.spyOn(os, 'availableParallelism').mockReturnValue(3);
    vi.spyOn(os, 'totalmem').mockReturnValue(4_294_967_296);
    // Guards the simulation itself: without this the assertion below would
    // hold for a spy that never took effect.
    expect(describeMachine().threads).toBe(3);

    expect(machineFingerprint()).toBe(before);
  });
});
