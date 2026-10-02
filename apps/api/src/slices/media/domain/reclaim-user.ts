import { z } from 'zod';
import { chunkedWork } from '../../../lib/jobs/index.js';
import { MEDIA_PREFIX, validateMediaKey } from '../ports/index.js';
import { deleteSequentially } from './gc.js';
import type { ChunkResult, ChunkedJobRegistration } from '../../../lib/jobs/index.js';
import type { Storage } from '../ports/index.js';

/**
 * The deleted-account media sweep. Hard deletion cascades the DB rows in its
 * own transaction and enqueues this job with the storage keys captured
 * before the cascade (the keys die with the rows at commit, so the payload
 * is the only surviving map from account to ciphertext). R2 delete is
 * naturally idempotent, so redelivery after a crash simply re-deletes; the
 * orphan GC remains the crash-debris backstop if the job is lost entirely.
 */
export const MEDIA_RECLAIM_USER_JOB_TYPE = 'media.reclaimUser.v1';

/**
 * Deletes per chunk: the unit of work the framework's loop runs, and the
 * granularity its checkpoints land on. The bound belongs here rather than on
 * the payload — an account's object count is what it is, so capping the
 * enqueued key list would only split one unfinishable sweep into several.
 */
export const MEDIA_RECLAIM_CHUNK = 25;

const mediaKeySchema = z
  .string()
  .refine((key) => key.startsWith(MEDIA_PREFIX) && validateMediaKey(key) === null, {
    message: 'reclaim keys must be well-formed media/ object keys',
  });

export const mediaReclaimUserPayloadSchema = z.object({
  userId: z.uuid(),
  storageKeys: z.array(mediaKeySchema),
  /**
   * Resume cursor: the index of the first key this attempt must delete.
   * Defaulted at enqueue and rewritten by each checkpoint, so an attempt
   * killed mid-sweep continues where its predecessor's last committed
   * checkpoint left off instead of starting over.
   */
  nextIndex: z.number().int().min(0).default(0),
});

type MediaReclaimPayload = z.infer<typeof mediaReclaimUserPayloadSchema>;

interface MediaReclaimUserJobDeps {
  /** Resolved inside the handler so a config fault is an isolated row failure. */
  readonly resolveStorage: () => Storage;
}

export function createMediaReclaimUserJob(
  deps: MediaReclaimUserJobDeps
): ChunkedJobRegistration<typeof mediaReclaimUserPayloadSchema> {
  return {
    kind: 'chunked',
    type: MEDIA_RECLAIM_USER_JOB_TYPE,
    schema: mediaReclaimUserPayloadSchema,
    maxExecutionSeconds: 300,
    maxFailures: 8,
    idempotency: 'natural',
    shard: 'bulk',
    chunked: chunkedWork<MediaReclaimPayload, number>({
      readCursor: (payload) => payload.nextIndex,
      withCursor: (payload, nextIndex) => ({ ...payload, nextIndex }),
      runChunk: async ({ payload, cursor }): Promise<ChunkResult<MediaReclaimPayload, number>> => {
        const { storageKeys } = payload;
        if (cursor >= storageKeys.length) {
          return { kind: 'ok', result: { reclaimed: storageKeys.length } };
        }
        const storage = deps.resolveStorage();
        const chunk = storageKeys.slice(cursor, cursor + MEDIA_RECLAIM_CHUNK);
        const deleted = await deleteSequentially(storage, chunk);
        if (deleted.isErr()) {
          return { kind: 'fail', error: `media reclaim delete failed: ${deleted.error.code}` };
        }
        const resumeFrom = cursor + chunk.length;
        return resumeFrom >= storageKeys.length
          ? { kind: 'ok', result: { reclaimed: storageKeys.length } }
          : { kind: 'advance', cursor: resumeFrom };
      },
    }),
  };
}
