import type { CronEntry } from './cron.js';

/**
 * Daily retention deletes. Each pass drains bounded batches with a hard
 * per-pass cap, so a backlog never holds long locks and never runs
 * unbounded; whatever a capped pass leaves, the next day's pass takes.
 * Read paths never depend on any of these having run.
 */

export const RETENTION_BATCH_SIZE = 500;

export const RETENTION_MAX_BATCHES = 10;

type RetentionStep = (batchSize: number) => Promise<number>;

export async function drainRetentionBatches(
  step: RetentionStep,
  batchSize: number
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
    const deleted = await step(batchSize);
    total += deleted;
    if (deleted < batchSize) break;
  }
  return total;
}

export function createRetentionEntry(name: string, step: RetentionStep): CronEntry {
  return {
    name,
    run: async (): Promise<void> => {
      await drainRetentionBatches(step, RETENTION_BATCH_SIZE);
    },
  };
}
