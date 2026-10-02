import { describe, expect, it } from 'vitest';
import {
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_BATCHES,
  createRetentionEntry,
  drainRetentionBatches,
} from './retention.js';

describe('drainRetentionBatches', () => {
  it('drains until a batch comes back short', async () => {
    const batches: number[] = [];
    const total = await drainRetentionBatches((batchSize) => {
      batches.push(batchSize);
      return Promise.resolve(batches.length < 3 ? batchSize : 1);
    }, 10);
    expect(batches).toEqual([10, 10, 10]);
    expect(total).toBe(21);
  });

  it('caps the number of batches per pass', async () => {
    let calls = 0;
    const total = await drainRetentionBatches((batchSize) => {
      calls += 1;
      return Promise.resolve(batchSize);
    }, 10);
    expect(calls).toBe(RETENTION_MAX_BATCHES);
    expect(total).toBe(10 * RETENTION_MAX_BATCHES);
  });
});

describe('createRetentionEntry', () => {
  it('drains the step with the retention batch size', async () => {
    const batches: number[] = [];
    const entry = createRetentionEntry('idempotency-key-purge', (batchSize) => {
      batches.push(batchSize);
      return Promise.resolve(0);
    });
    expect(entry.name).toBe('idempotency-key-purge');
    await entry.run();
    expect(batches).toEqual([RETENTION_BATCH_SIZE]);
  });
});
