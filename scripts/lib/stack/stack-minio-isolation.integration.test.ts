import { randomUUID } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { describe, expect, it } from 'vitest';

import { STACK_MODES, type StackMode } from './port-plan.js';
import { mediaBucketFrom, mediaBucketName } from './stack-bucket.js';
import { stackModeFrom } from './stack-mode.js';

/**
 * That the stacks share no object storage, executed rather than reasoned about.
 *
 * Isolation is a property of the BUCKET: one MinIO serves the checkout, the
 * environment registry asks each stack's files for that stack's own bucket, and
 * every consumer — the Worker, the seed, the bring-up — writes to the bucket its
 * loaded environment names. So the chain this asserts, stack to bucket to
 * objects, is the whole of what keeps a `pnpm test` out of a running `pnpm dev`'s
 * media.
 *
 * It needs the local stack, which is what `pnpm test` brings up.
 */

function requireEndpoint(): string {
  const value = process.env['R2_S3_ENDPOINT'];
  if (value === undefined || value === '') {
    throw new Error(
      'R2_S3_ENDPOINT is required for the stack object-storage isolation test — run vitest through `tsx scripts/with-env.ts`, which is what loads the env files'
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

/**
 * Creates the stack's bucket when the object store lacks it, exactly as that
 * stack's own bring-up would. Buckets are never removed here: another run of
 * another stack is entitled to the one it owns, and this suite is a reader of
 * every stack but its own.
 */
async function ensureBucket(bucket: string): Promise<void> {
  const response = await client().fetch(`${ENDPOINT}/${bucket}`, { method: 'PUT' });
  if (response.ok) return;
  const body = await response.text();
  if (body.includes('BucketAlreadyOwnedByYou') || body.includes('BucketAlreadyExists')) return;
  throw new Error(`creating ${bucket} returned ${String(response.status)}`);
}

async function putObject(bucket: string, key: string, body: string): Promise<void> {
  const response = await client().fetch(`${ENDPOINT}/${bucket}/${key}`, { method: 'PUT', body });
  if (!response.ok) throw new Error(`put into ${bucket} returned ${String(response.status)}`);
}

async function readObject(bucket: string, key: string): Promise<string | null> {
  const response = await client().fetch(`${ENDPOINT}/${bucket}/${key}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`get from ${bucket} returned ${String(response.status)}`);
  return response.text();
}

async function deleteObject(bucket: string, key: string): Promise<void> {
  await client().fetch(`${ENDPOINT}/${bucket}/${key}`, { method: 'DELETE' });
}

describe('object-storage isolation between stacks', () => {
  it('reads the bucket belonging to the stack it is running as', () => {
    expect(mediaBucketFrom(process.env)).toBe(mediaBucketName(stackModeFrom(process.env)));
  });

  it.each([...STACK_MODES])(
    'hides an object written on the %s stack from every other stack',
    async (writer: StackMode) => {
      const key = `stack-isolation-probe-${randomUUID()}`;
      const bucket = mediaBucketName(writer);
      for (const stackMode of STACK_MODES) await ensureBucket(mediaBucketName(stackMode));

      await putObject(bucket, key, `written-on-${writer}`);
      try {
        await expect(readObject(bucket, key)).resolves.toBe(`written-on-${writer}`);
        for (const reader of STACK_MODES.filter((stackMode) => stackMode !== writer)) {
          await expect(readObject(mediaBucketName(reader), key)).resolves.toBeNull();
        }
      } finally {
        await deleteObject(bucket, key);
      }
    }
  );
});
