/**
 * That the compose file's object-store setup service creates the buckets the
 * environment's list names, and stops at the first it cannot.
 *
 * Executed rather than read: the entrypoint is a shell loop, and what a loop
 * does is not something a second reading of its grammar establishes — nor is
 * whether compose's `$$` reaches the container as the one dollar the loop
 * variable needs. It is handed a list of its own so the stack's real buckets are
 * neither created nor removed here, and it removes what it made.
 *
 * It needs the local stack, which is what `pnpm test` brings up.
 */
import { randomBytes } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { CHECKOUT_DIRECTORY, composeArguments } from '../../compose.js';
import { STACK_BUCKET_LIST_VARIABLE } from './stack-bucket.js';

/**
 * `docker`'s argv for one run of the setup service. The project directory is
 * named rather than left to the working directory a process inherited, for the
 * reason `scripts/compose.ts` carries.
 */
const SETUP_SERVICE_ARGUMENTS = composeArguments(CHECKOUT_DIRECTORY, [
  'run',
  '--rm',
  'minio-setup',
]);

function requireEndpoint(): string {
  const value = process.env['R2_S3_ENDPOINT'];
  if (value === undefined || value === '') {
    throw new Error(
      'R2_S3_ENDPOINT is required for the bucket-setup test — run vitest through `tsx scripts/with-env.ts`, which is what loads the env files'
    );
  }
  return value.replace(/\/+$/, '');
}

const ENDPOINT = requireEndpoint();

function client(): AwsClient {
  return new AwsClient({
    accessKeyId: process.env['R2_ACCESS_KEY_ID'] ?? '',
    secretAccessKey: process.env['R2_SECRET_ACCESS_KEY'] ?? '',
    service: 's3',
    region: 'auto',
  });
}

/** A name no concurrent run holds, so two stacks cannot collide on one probe. */
function probeBucket(): string {
  return `hushbox-probe-${randomBytes(6).toString('hex')}`;
}

/** Runs the real service over `buckets`, and answers with how it ended. */
async function createBuckets(buckets: readonly string[]): Promise<number> {
  const result = await execa('docker', SETUP_SERVICE_ARGUMENTS, {
    cwd: CHECKOUT_DIRECTORY,
    env: { ...process.env, [STACK_BUCKET_LIST_VARIABLE]: buckets.join(' ') },
    reject: false,
  });
  return result.exitCode ?? 1;
}

async function exists(bucket: string): Promise<boolean> {
  const response = await client().fetch(`${ENDPOINT}/${bucket}`, { method: 'HEAD' });
  return response.ok;
}

async function remove(bucket: string): Promise<void> {
  await client().fetch(`${ENDPOINT}/${bucket}`, { method: 'DELETE' });
}

/**
 * What a case here may spend, far above the runner's default.
 *
 * Plainly a larger budget rather than a cleverer instrument: every case runs the
 * real setup service, and nothing observable shortens starting a container. On a
 * quiet host a case finishes inside 1.4 seconds, of which the one-off
 * container's own life is under half a second. Driven again under this
 * package's whole suite, one case took 7 seconds and the other lost the
 * runner's default — the daemon recorded the container that case was waiting
 * for being created 45 seconds after the previous one had been destroyed, so
 * the budget ran out before the thing it was waiting for existed. The default
 * is sized for cases that start nothing, so it is the first bound to lose when
 * the host is busy, and the loss reads as a broken setup service rather than a
 * busy machine. This is roughly three times the worst measured.
 *
 * A bound on waiting and nothing else: what a case decides from is the
 * service's own exit status and the store's answer, never a clock.
 */
const COLD_CONTAINER_BUDGET_MS = 150_000;

describe('the run the setup service is reached by', () => {
  it('names the checkout rather than leaving compose to read one from the environment', () => {
    expect(SETUP_SERVICE_ARGUMENTS).toEqual([
      'compose',
      '--project-directory',
      CHECKOUT_DIRECTORY,
      'run',
      '--rm',
      'minio-setup',
    ]);
  });
});

describe('the buckets the compose file creates', { timeout: COLD_CONTAINER_BUDGET_MS }, () => {
  it('creates every bucket the list it is handed names', async () => {
    const wanted = [probeBucket(), probeBucket()];
    try {
      const exitCode = await createBuckets(wanted);

      expect(exitCode).toBe(0);
      await expect(exists(wanted[0] ?? '')).resolves.toBe(true);
      await expect(exists(wanted[1] ?? '')).resolves.toBe(true);
    } finally {
      for (const bucket of wanted) await remove(bucket);
    }
  });

  it('stops at the first bucket it cannot create', async () => {
    // Underscores and capitals are outside what S3 admits, so the store refuses
    // the middle name and nothing but the loop's own guard ends the run there.
    const wanted = [probeBucket(), 'Refused_Name', probeBucket()];
    try {
      const exitCode = await createBuckets(wanted);

      expect(exitCode).not.toBe(0);
      await expect(exists(wanted[0] ?? '')).resolves.toBe(true);
      await expect(exists(wanted[2] ?? '')).resolves.toBe(false);
    } finally {
      for (const bucket of [wanted[0] ?? '', wanted[2] ?? '']) await remove(bucket);
    }
  });
});
