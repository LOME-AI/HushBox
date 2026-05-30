import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import {
  computeCpuPercent,
  summarizeSamples,
  formatResourceStdout,
  createResourceSampler,
  type ResourceSample,
  type ResourceSummary,
} from './resource-sampler.js';
import type { ResourceScan } from './resource-scan.js';

type Cpu = ReturnType<typeof os.cpus>[number];

function cpu(idle: number, busy: number): Cpu {
  return { model: 'x', speed: 1, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } };
}

function summary(over: Partial<ResourceSummary> = {}): ResourceSummary {
  return {
    durationMs: 1000,
    sampleCount: 1,
    cores: 4,
    totalMemBytes: 8 * 1024 ** 3,
    cpu: { peak: 0, avg: 0 },
    mem: { peak: 0, avg: 0 },
    load: { peak: 0 },
    ...over,
  };
}

function scan(over: Partial<ResourceScan> = {}): ResourceScan {
  return { totalHits: 0, categories: [], ...over };
}

describe('computeCpuPercent', () => {
  it('computes busy percentage from idle/total deltas', () => {
    // total delta 100, idle delta 50 → 50% busy
    expect(computeCpuPercent([cpu(0, 0)], [cpu(50, 50)])).toBe(50);
  });

  it('returns 0 when there is no elapsed cpu time', () => {
    expect(computeCpuPercent([cpu(10, 10)], [cpu(10, 10)])).toBe(0);
  });

  it('returns 0 when there are no cores to compare', () => {
    expect(computeCpuPercent([], [])).toBe(0);
  });
});

describe('summarizeSamples', () => {
  beforeEach(() => {
    vi.spyOn(os, 'cpus').mockReturnValue([cpu(0, 0), cpu(0, 0)]);
    vi.spyOn(os, 'totalmem').mockReturnValue(16 * 1024 ** 3);
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns zeros for no samples', () => {
    const s = summarizeSamples([], 5000);
    expect(s).toMatchObject({ sampleCount: 0, cores: 2, cpu: { peak: 0, avg: 0 } });
    expect(s.totalMemBytes).toBe(16 * 1024 ** 3);
  });

  it('computes peak and average across samples', () => {
    const samples: ResourceSample[] = [
      { t: 0, cpuPct: 40, memPct: 50, load1: 2 },
      { t: 1, cpuPct: 80, memPct: 60, load1: 3 },
    ];
    const s = summarizeSamples(samples, 2000);
    expect(s.cpu).toEqual({ peak: 80, avg: 60 });
    expect(s.mem).toEqual({ peak: 60, avg: 55 });
    expect(s.load.peak).toBe(3);
    expect(s.sampleCount).toBe(2);
  });
});

describe('formatResourceStdout', () => {
  it('renders metrics and the error line (minutes duration)', () => {
    const out = formatResourceStdout({
      summary: summary({
        durationMs: 125_000,
        cpu: { peak: 62, avg: 38 },
        mem: { peak: 44, avg: 30 },
        load: { peak: 19 },
        cores: 24,
      }),
      samples: [],
      scan: scan({
        totalHits: 3,
        categories: [{ name: 'process/thread limit', count: 3, tests: ['a'] }],
      }),
    });
    expect(out).toContain('2m5s');
    expect(out).toContain('CPU     62% / 38%');
    expect(out).toContain('24 cores');
    expect(out).toContain('resource-limit errors: 3');
  });

  it('omits the error line when there are no hits (seconds duration)', () => {
    const out = formatResourceStdout({
      summary: summary({ durationMs: 5000 }),
      samples: [],
      scan: scan(),
    });
    expect(out).toContain('5s');
    expect(out).not.toContain('resource-limit errors');
  });
});

describe('createResourceSampler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('collects one sample per interval and summarizes', () => {
    vi.useFakeTimers();
    let n = 0;
    vi.spyOn(os, 'cpus').mockImplementation(() => {
      n += 1;
      return [cpu(n * 50, n * 50)];
    });
    vi.spyOn(os, 'totalmem').mockReturnValue(1000);
    vi.spyOn(os, 'freemem').mockReturnValue(400);
    vi.spyOn(os, 'loadavg').mockReturnValue([1.5, 1, 1]);

    const sampler = createResourceSampler(1000);
    sampler.start();
    vi.advanceTimersByTime(3000);
    const { summary: s, samples } = sampler.stop();

    expect(samples).toHaveLength(3);
    expect(s.sampleCount).toBe(3);
    expect(samples[0]?.cpuPct).toBe(50);
    expect(samples[0]?.memPct).toBe(60);
    expect(samples[0]?.load1).toBe(1.5);
  });

  it('records 0% memory when total memory reports as zero', () => {
    vi.useFakeTimers();
    vi.spyOn(os, 'cpus').mockReturnValue([cpu(1, 1)]);
    vi.spyOn(os, 'totalmem').mockReturnValue(0);
    vi.spyOn(os, 'freemem').mockReturnValue(0);
    vi.spyOn(os, 'loadavg').mockReturnValue([0, 0, 0]);

    const sampler = createResourceSampler(1000);
    sampler.start();
    vi.advanceTimersByTime(1000);
    const { samples } = sampler.stop();
    expect(samples[0]?.memPct).toBe(0);
  });

  it('is safe to stop without starting', () => {
    const { summary: s, samples } = createResourceSampler().stop();
    expect(samples).toEqual([]);
    expect(s.sampleCount).toBe(0);
    expect(s.durationMs).toBe(0);
  });
});
