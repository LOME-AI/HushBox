/**
 * MinIO bucket-readiness gate.
 *
 * Container health is not storage readiness: `minio` can be healthy while a
 * bucket does not exist yet (cold volume before `minio-setup` lands, a crash
 * between MinIO start and setup, a wiped volume under warm containers, or a
 * bucket added to the compose file after the volume was made). Serving the API
 * before the media bucket exists turns every media `storage.put` into
 * `NoSuchBucket` → UNAVAILABLE, and a backup run against a missing source
 * bucket fails the same way, so stack bring-up blocks on the buckets actually
 * existing — never on `minio-setup` merely having been started.
 *
 * Every bucket rather than one: `mc mb -p` creates them all in one pass and is
 * idempotent, so the gate that waits for the whole set costs a probe each and
 * makes a bucket added to the compose file appear on the next bring-up.
 *
 * Which buckets is one stack's own: the deps name them, resolved from the
 * loaded environment, so a bring-up gates the buckets its run will actually
 * write to rather than whichever ones a constant here spelled.
 *
 * Pure orchestration; the docker probes/runners are injected by the CLI
 * wiring (ensure-stack-cli.ts).
 */

export interface BucketReadyDeps {
  /** The stack's buckets, as the loaded environment names them. */
  readonly buckets: readonly string[];
  /** True iff that bucket exists on the running MinIO instance. */
  probeBucket: (bucket: string) => Promise<boolean>;
  /** Run bucket creation to completion; must reject on failure. */
  runBucketSetup: () => Promise<void>;
}

async function missingBuckets(deps: BucketReadyDeps): Promise<string[]> {
  const missing: string[] = [];
  for (const bucket of deps.buckets) {
    if (!(await deps.probeBucket(bucket))) missing.push(bucket);
  }
  return missing;
}

export async function ensureStackBucketsReady(deps: BucketReadyDeps): Promise<void> {
  const absent = await missingBuckets(deps);
  if (absent.length === 0) return;
  await deps.runBucketSetup();
  const missing = await missingBuckets(deps);
  if (missing.length === 0) return;
  throw new Error(
    `ensure-stack: MinIO buckets ${missing.join(', ')} are still missing after minio-setup ran — ` +
      'storage is not ready. Check `docker compose logs minio-setup`.'
  );
}
