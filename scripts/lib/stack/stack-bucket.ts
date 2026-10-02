import { STACK_BUCKET_MARKER } from '@hushbox/shared/env.config';
import { DEFAULT_STACK_MODE } from './stack-mode.js';
import type { StackMode } from './port-plan.js';

/**
 * Which object-storage bucket each stack owns, and how a registry value asks
 * for one.
 *
 * The environment registry spells no bucket of its own, for the reason it
 * spells no port and no database: a name written there would be a second
 * spelling of the stack's identity with nothing to catch the two disagreeing.
 * It writes {@link STACK_BUCKET_MARKER} and the generator substitutes the
 * bucket of the stack whose files it is writing, so a stack added to the plan
 * gets a bucket of its own that nobody has to remember to give it. The compose
 * file creates whatever the resulting `R2_BUCKET_MEDIA` names, which is why
 * that name reaches the scripts env file as well as the backend one.
 */

/** The stem every stack's bucket is built on, and the only place one is spelled. */
const BASE_BUCKET = 'hushbox-media';

/**
 * The bucket a stack's media objects live in. The default stack keeps the name
 * its MinIO volume already holds, so a checkout that never heard of the stack
 * split reaches the objects it already had — the same rule its generated env
 * files and its Postgres database follow.
 */
export function mediaBucketName(stackMode: StackMode): string {
  return stackMode === DEFAULT_STACK_MODE ? `${BASE_BUCKET}-dev` : `${BASE_BUCKET}-${stackMode}`;
}

/** Substitute each {@link STACK_BUCKET_MARKER} in a resolved env value. */
export function applyStackBucket(value: string, stackMode: StackMode): string {
  return value.replaceAll(STACK_BUCKET_MARKER, mediaBucketName(stackMode));
}

/**
 * The media bucket an already-loaded environment names.
 *
 * Read from the environment rather than derived from the stack mode for the
 * reason the bring-up names its database from the connection string it will
 * use: what has to exist is the bucket everything downstream writes to.
 */
export function mediaBucketFrom(env: NodeJS.ProcessEnv): string {
  return bucketFrom(env, 'R2_BUCKET_MEDIA');
}

function bucketFrom(env: NodeJS.ProcessEnv, variable: string): string {
  const bucket = env[variable];
  if (bucket === undefined || bucket === '') {
    throw new Error(
      `stack-bucket: ${variable} names no bucket — the stack env is not loaded. Run pnpm generate:env and invoke through pnpm.`
    );
  }
  return bucket;
}

/**
 * Every bucket the object store must hold for a stack to work, named by the
 * variable each arrives in, and the only place that set is declared.
 *
 * Nothing can import a TypeScript module into a compose entrypoint, so the
 * compose file does not restate the set: `scripts/generate-env.ts` resolves
 * this list against the stack being written and hands the names over in
 * {@link STACK_BUCKET_LIST_VARIABLE}, which the object-store setup service
 * loops over. A bucket added here therefore reaches both the readiness gate and
 * the bring-up that creates it, with nothing to keep in step.
 */
export const STACK_BUCKET_VARIABLES = [
  'R2_BUCKET_MEDIA',
  'HB_ESCROW_BUCKET',
  'BACKUP_B2_BUCKET',
  'BACKUP_SOURCE_BUCKET_APP_BUILDS',
  'BACKUP_SOURCE_BUCKET_MODEL_WEIGHTS',
] as const;

/** The buckets an already-loaded environment names, in one list. */
export function stackBucketsFrom(env: NodeJS.ProcessEnv): readonly string[] {
  return STACK_BUCKET_VARIABLES.map((variable) => bucketFrom(env, variable));
}

/**
 * The variable the compose file reads the whole bucket list out of.
 *
 * The separator is the space the container's shell word-splits the list on, and
 * no bucket name may hold one — S3 and MinIO both refuse it — so a name cannot
 * split into two.
 */
export const STACK_BUCKET_LIST_VARIABLE = 'HB_STACK_BUCKETS';

/** The value {@link STACK_BUCKET_LIST_VARIABLE} carries for a stack's environment. */
export function stackBucketList(env: NodeJS.ProcessEnv): string {
  return stackBucketsFrom(env).join(' ');
}
