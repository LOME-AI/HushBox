import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { createJobRegistry } from '../../../lib/jobs/index.js';
import { errAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { mediaObjectKey } from '../ports/index.js';
import { createScratchBucket, unwrap } from '../adapters/test-fixtures.js';
import {
  MEDIA_RECLAIM_CHUNK,
  MEDIA_RECLAIM_USER_JOB_TYPE,
  createMediaReclaimUserJob,
  mediaReclaimUserPayloadSchema,
} from './reclaim-user.js';
import type { z } from 'zod';
import type { ExecutionBudget, JobOutcome } from '../../../lib/jobs/index.js';
import type { ScratchBucket } from '../adapters/test-fixtures.js';
import type { Storage } from '../ports/index.js';

/**
 * The deleted-account media sweep, exercised directly against a scratch MinIO
 * bucket (the owning-slice invocation seam — the dispatcher wiring is covered
 * by the jobs lib suites). The framework owns the chunk loop, so every case
 * here runs it the way the dispatcher does: a payload and an execution budget.
 */

type Payload = z.infer<typeof mediaReclaimUserPayloadSchema>;

const BYTES = new Uint8Array([7, 7, 7]);

/** Two full chunks and a short one — the shape that proves resume, not restart. */
const MULTI_CHUNK_KEYS = MEDIA_RECLAIM_CHUNK * 2 + 1;

/** A non-terminating sweep must fail the test rather than hang it. */
const ATTEMPT_BOUND = 10;

/** The registered budget, as the dispatcher would floor it for a fresh row. */
const EXECUTION_BUDGET_MS = 300_000;

function newMediaKey(): string {
  return mediaObjectKey({
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    objectId: crypto.randomUUID(),
  });
}

function payloadOf(storageKeys: readonly string[]): Payload {
  return { userId: crypto.randomUUID(), storageKeys: [...storageKeys], nextIndex: 0 };
}

/** A budget nothing spends: one execution runs every chunk the work has. */
function unspentBudget(): ExecutionBudget {
  return { totalMs: EXECUTION_BUDGET_MS, now: () => TEST_DAY_START };
}

/**
 * A budget the first chunk spends whole, so control comes back at every chunk
 * boundary — the cadence a five-minute budget gives an account large enough to
 * fill it, made deterministic.
 */
function oneChunkBudget(): ExecutionBudget {
  let readings = 0;
  return {
    totalMs: EXECUTION_BUDGET_MS,
    now: () => {
      readings += 1;
      // The loop reads the clock once on entry and once after each chunk.
      return readings === 1 ? TEST_DAY_START : TEST_DAY_START + EXECUTION_BUDGET_MS;
    },
  };
}

describe('media.reclaimUser.v1 registration', () => {
  it('registers cleanly with the bulk shard, natural idempotency, and its payload schema', () => {
    const registry = createJobRegistry();
    registry.register(createMediaReclaimUserJob({ resolveStorage: () => ({}) as Storage }));

    const registered = registry.get(MEDIA_RECLAIM_USER_JOB_TYPE);
    expect(registered?.shard).toBe('bulk');
    expect(registered?.idempotency).toBe('natural');
    expect(registered?.schema).toBe(mediaReclaimUserPayloadSchema);
    expect(registered?.maxExecutionSeconds).toBe(300);
  });

  it('declares the chunked shape, its work scaling with the account it reclaims', () => {
    expect(createMediaReclaimUserJob({ resolveStorage: () => ({}) as Storage }).kind).toBe(
      'chunked'
    );
  });

  it('rejects a payload whose key is outside the media/ class', () => {
    const parsed = mediaReclaimUserPayloadSchema.safeParse(
      payloadOf(['inputs/not-a-media-key/object'])
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects a payload whose userId is not a uuid', () => {
    const parsed = mediaReclaimUserPayloadSchema.safeParse({
      userId: 'someone',
      storageKeys: [newMediaKey()],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a payload of well-formed media keys', () => {
    const parsed = mediaReclaimUserPayloadSchema.safeParse(payloadOf([newMediaKey()]));
    expect(parsed.success).toBe(true);
  });

  it('defaults the resume index to the first key for a freshly enqueued payload', () => {
    const parsed = mediaReclaimUserPayloadSchema.parse({
      userId: crypto.randomUUID(),
      storageKeys: [newMediaKey()],
    });
    expect(parsed.nextIndex).toBe(0);
  });

  it('rejects a resume index below the first key', () => {
    const parsed = mediaReclaimUserPayloadSchema.safeParse({
      userId: crypto.randomUUID(),
      storageKeys: [newMediaKey()],
      nextIndex: -1,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('media.reclaimUser.v1 sweep against MinIO', () => {
  let scratch: ScratchBucket;

  beforeAll(async () => {
    scratch = await createScratchBucket();
  });

  afterAll(async () => {
    await scratch.destroy();
  });

  async function put(key: string): Promise<void> {
    await unwrap(scratch.storage.put(key, BYTES, { contentType: 'application/octet-stream' }));
  }

  async function exists(key: string): Promise<boolean> {
    return (await unwrap(scratch.storage.head(key))) !== null;
  }

  /** One execution of the registered loop, exactly as the dispatcher runs it. */
  function runExecution(
    payload: Payload,
    budget: ExecutionBudget,
    storage: Storage = scratch.storage
  ): Promise<JobOutcome> {
    return createMediaReclaimUserJob({ resolveStorage: () => storage }).chunked.runChunks(
      payload,
      budget
    );
  }

  /** Records every key the sweep asks the bucket to delete, in order. */
  function recordingStorage(deleted: string[]): Storage {
    return {
      ...scratch.storage,
      delete: (key: string) => {
        deleted.push(key);
        return scratch.storage.delete(key);
      },
    };
  }

  /**
   * The dispatcher's re-claim loop, in miniature: each execution resumes from
   * the row's last committed payload, and every checkpoint round-trips through
   * the registered schema exactly as a claimed row's payload does.
   */
  async function driveToTerminal(
    payload: Payload,
    budget: () => ExecutionBudget,
    storage?: Storage
  ): Promise<{ readonly outcome: JobOutcome; readonly executions: number }> {
    let current = payload;
    for (let executions = 1; executions <= ATTEMPT_BOUND; executions += 1) {
      const outcome = await runExecution(current, budget(), storage ?? scratch.storage);
      if (outcome.kind !== 'yield') return { outcome, executions };
      current = mediaReclaimUserPayloadSchema.parse(outcome.checkpoint);
    }
    throw new Error('media reclaim never reached a terminal outcome');
  }

  it("deletes every one of the deleted account's objects", async () => {
    const keys = [newMediaKey(), newMediaKey()];
    for (const key of keys) await put(key);

    const outcome = await runExecution(payloadOf(keys), unspentBudget());

    expect(outcome).toEqual({ kind: 'ok', result: { reclaimed: 2 } });
    expect(await exists(keys[0] ?? '')).toBe(false);
    expect(await exists(keys[1] ?? '')).toBe(false);
  });

  it('a redelivered payload whose keys are already gone still succeeds', async () => {
    const keys = [newMediaKey()];

    const outcome = await runExecution(payloadOf(keys), unspentBudget());

    expect(outcome.kind).toBe('ok');
  });

  /**
   * The redrive path: `apps/api/src/dev/seed-admin-targets.ts` mints a dead
   * reclaim row with an empty key list precisely so redriving it is the
   * idempotent no-op the jobs doctrine requires.
   */
  it('a cursor already at the end of the key list succeeds without touching storage', async () => {
    let resolved = 0;
    const job = createMediaReclaimUserJob({
      resolveStorage: () => {
        resolved += 1;
        return scratch.storage;
      },
    });

    const outcome = await job.chunked.runChunks(payloadOf([]), unspentBudget());

    expect(resolved).toBe(0);
    expect(outcome).toEqual({ kind: 'ok', result: { reclaimed: 0 } });
  });

  it("completes a sweep no single execution's budget could cover, leaving no object behind", async () => {
    const keys = Array.from({ length: MULTI_CHUNK_KEYS }, () => newMediaKey());
    await Promise.all(keys.map((key) => put(key)));

    const { outcome } = await driveToTerminal(payloadOf(keys), oneChunkBudget);

    expect(outcome).toEqual({ kind: 'ok', result: { reclaimed: MULTI_CHUNK_KEYS } });
    expect(await Promise.all(keys.map((key) => exists(key)))).not.toContain(true);
  });

  it('hands control back at the chunk boundary once the budget is spent', async () => {
    const keys = Array.from({ length: MULTI_CHUNK_KEYS }, () => newMediaKey());

    const { executions } = await driveToTerminal(payloadOf(keys), oneChunkBudget);

    expect(executions).toBe(Math.ceil(MULTI_CHUNK_KEYS / MEDIA_RECLAIM_CHUNK));
  });

  it('sweeps every chunk in one execution while the budget is not nearly spent', async () => {
    const keys = Array.from({ length: MULTI_CHUNK_KEYS }, () => newMediaKey());

    const { executions, outcome } = await driveToTerminal(payloadOf(keys), unspentBudget);

    expect(executions).toBe(1);
    expect(outcome).toEqual({ kind: 'ok', result: { reclaimed: MULTI_CHUNK_KEYS } });
  });

  it('deletes each key exactly once, in payload order, however many chunks one execution runs', async () => {
    const keys = Array.from({ length: MULTI_CHUNK_KEYS }, () => newMediaKey());
    const deleted: string[] = [];

    await driveToTerminal(payloadOf(keys), unspentBudget, recordingStorage(deleted));

    expect(deleted).toEqual(keys);
  });

  it('resumes at the checkpoint after a kill rather than restarting at the first key', async () => {
    const keys = Array.from({ length: MULTI_CHUNK_KEYS }, () => newMediaKey());
    const firstExecution = await runExecution(payloadOf(keys), oneChunkBudget());
    if (firstExecution.kind !== 'yield') throw new Error('expected a checkpoint after chunk one');
    const resumed = mediaReclaimUserPayloadSchema.parse(firstExecution.checkpoint);

    const secondChunk: string[] = [];
    await runExecution(resumed, oneChunkBudget(), recordingStorage(secondChunk));

    expect(secondChunk).toEqual(keys.slice(MEDIA_RECLAIM_CHUNK, MEDIA_RECLAIM_CHUNK * 2));
  });

  it('re-running a chunk whose checkpoint was lost succeeds against the already-deleted keys', async () => {
    const keys = Array.from({ length: MULTI_CHUNK_KEYS }, () => newMediaKey());
    await Promise.all(keys.map((key) => put(key)));
    const payload = payloadOf(keys);
    const first = await runExecution(payload, oneChunkBudget());

    const replayed = await runExecution(payload, oneChunkBudget());

    expect(replayed).toEqual(first);
  });

  it('a failing delete surfaces as a retryable failure carrying the error code', async () => {
    const failing: Storage = {
      ...scratch.storage,
      delete: () => errAsync(unavailableError('storage unreachable')),
    };

    const outcome = await runExecution(payloadOf([newMediaKey()]), unspentBudget(), failing);

    expect(outcome).toEqual({ kind: 'fail', error: 'media reclaim delete failed: unavailable' });
  });
});
