import { describe, expect, it } from 'vitest';

import {
  DownloadRateTracker,
  estimateEtaSeconds,
  formatBytesProgress,
  formatEta,
  formatSpeed,
} from './tts-download-progress';

const MB = 1_048_576;
const KB = 1024;

describe('formatBytesProgress', () => {
  it('renders loaded with one decimal MB and total as integer MB', () => {
    expect(formatBytesProgress(32.4 * MB, 88 * MB)).toBe('32.4 / 88 MB');
  });

  it('shows 0.0 when nothing loaded yet', () => {
    expect(formatBytesProgress(0, 88 * MB)).toBe('0.0 / 88 MB');
  });

  it('shows the full size when loaded == total', () => {
    expect(formatBytesProgress(88 * MB, 88 * MB)).toBe('88.0 / 88 MB');
  });

  it('rounds total to nearest integer MB', () => {
    expect(formatBytesProgress(10 * MB, 87.6 * MB)).toBe('10.0 / 88 MB');
  });
});

describe('formatSpeed', () => {
  it('uses MB/s with one decimal at or above 1 MB/s', () => {
    expect(formatSpeed(4.23 * MB)).toBe('4.2 MB/s');
  });

  it('uses KB/s for sub-MB rates', () => {
    expect(formatSpeed(512 * KB)).toBe('512 KB/s');
  });

  it('formats exactly 1 MB/s as MB/s', () => {
    expect(formatSpeed(1 * MB)).toBe('1.0 MB/s');
  });
});

describe('formatEta', () => {
  it('reports "<1s left" for sub-second remaining', () => {
    expect(formatEta(0.4)).toBe('<1s left');
  });

  it('reports whole seconds under a minute', () => {
    expect(formatEta(12)).toBe('12s left');
  });

  it('reports minutes + seconds when over a minute', () => {
    expect(formatEta(75)).toBe('1m 15s left');
  });

  it('rounds seconds to nearest whole', () => {
    expect(formatEta(12.6)).toBe('13s left');
  });
});

describe('estimateEtaSeconds', () => {
  it('returns remaining bytes divided by speed', () => {
    expect(estimateEtaSeconds(20 * MB, 88 * MB, 4 * MB)).toBe(17);
  });

  it('returns 0 once loaded reaches total', () => {
    expect(estimateEtaSeconds(88 * MB, 88 * MB, 4 * MB)).toBe(0);
  });

  it('returns null when speed is zero', () => {
    expect(estimateEtaSeconds(10 * MB, 88 * MB, 0)).toBeNull();
  });
});

describe('DownloadRateTracker', () => {
  it('returns null bytes-per-second from a single sample', () => {
    const tracker = new DownloadRateTracker();
    tracker.record(0, 0);
    expect(tracker.bytesPerSecond()).toBeNull();
  });

  it('computes bytes-per-second across two samples', () => {
    const tracker = new DownloadRateTracker();
    tracker.record(0, 0);
    tracker.record(2 * MB, 1000);
    expect(tracker.bytesPerSecond()).toBe(2 * MB);
  });

  it('drops samples older than the rolling window', () => {
    const tracker = new DownloadRateTracker(3000);
    tracker.record(0, 0); // dropped — older than (now - 3s)
    tracker.record(1 * MB, 500); // dropped
    tracker.record(5 * MB, 4000);
    tracker.record(7 * MB, 5000);
    // Window now contains samples at t=4000 and t=5000 only.
    expect(tracker.bytesPerSecond()).toBe(2 * MB);
  });

  it('returns null when only one sample remains after windowing', () => {
    const tracker = new DownloadRateTracker(1000);
    tracker.record(0, 0);
    tracker.record(1 * MB, 5000);
    expect(tracker.bytesPerSecond()).toBeNull();
  });

  it('returns null when delta time is zero (duplicate timestamps)', () => {
    const tracker = new DownloadRateTracker();
    tracker.record(0, 1000);
    tracker.record(1 * MB, 1000);
    expect(tracker.bytesPerSecond()).toBeNull();
  });

  it('returns null when bytes did not advance', () => {
    const tracker = new DownloadRateTracker();
    tracker.record(5 * MB, 0);
    tracker.record(5 * MB, 1000);
    expect(tracker.bytesPerSecond()).toBeNull();
  });

  it('reset() clears samples', () => {
    const tracker = new DownloadRateTracker();
    tracker.record(0, 0);
    tracker.record(1 * MB, 1000);
    tracker.reset();
    expect(tracker.bytesPerSecond()).toBeNull();
  });
});
