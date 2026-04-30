import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@hushbox/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@hushbox/db');
  return {
    ...actual,
    createDb: vi.fn(() => ({ mocked: 'db' })),
  };
});

vi.mock('aws4fetch', () => ({
  AwsClient: class MockAwsClient {
    fetch = vi.fn();
    sign = vi.fn();
  },
}));

const runR2GcMock = vi.fn();
vi.mock('./services/gc/r2-gc.js', () => ({
  runR2Gc: runR2GcMock,
}));

const { scheduledHandler } = await import('./scheduled.js');
import type { Bindings } from './types.js';

const baseEnv: Bindings = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  APP_VERSION: '0.0.0',
  R2_S3_ENDPOINT: 'http://localhost:9000',
  R2_ACCESS_KEY_ID: 'minioadmin',
  R2_SECRET_ACCESS_KEY: 'minioadmin',
  R2_BUCKET_MEDIA: 'hushbox-media-dev',
};

const baseEvent = { cron: '0 3 * * *', scheduledTime: Date.now() };
const baseCtx = { waitUntil: vi.fn() };

describe('scheduledHandler', () => {
  beforeEach(() => {
    runR2GcMock.mockReset();
  });

  it('invokes runR2Gc and logs the result', async () => {
    runR2GcMock.mockResolvedValueOnce({
      scanned: 10,
      orphansFound: 2,
      deleted: 2,
      bytesReclaimed: 4096,
      durationMs: 123,
    });
    const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await scheduledHandler(baseEvent, baseEnv, baseCtx);
      expect(runR2GcMock).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        'r2-gc',
        expect.objectContaining({ scanned: 10, deleted: 2 })
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('throws when DATABASE_URL is missing so Cloudflare records cron failure', async () => {
    const env = { ...baseEnv, DATABASE_URL: '' };

    await expect(scheduledHandler(baseEvent, env, baseCtx)).rejects.toThrow(
      'DATABASE_URL is required for the scheduled handler'
    );
    expect(runR2GcMock).not.toHaveBeenCalled();
  });

  it('rethrows on runR2Gc failure so Cloudflare records cron failure', async () => {
    runR2GcMock.mockRejectedValueOnce(new Error('r2 unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(scheduledHandler(baseEvent, baseEnv, baseCtx)).rejects.toThrow('r2 unavailable');
      expect(errorSpy).toHaveBeenCalledWith('r2-gc failed', expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });
});
