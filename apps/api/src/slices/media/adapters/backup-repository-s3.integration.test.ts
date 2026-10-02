import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_TOKEN_VARIABLE, mintScratchBucketId, scratchBucketName } from '@hushbox/db/test-db';
import { BACKUP_LIFECYCLE_NONCURRENT_DAYS } from '@hushbox/shared';
import { backupRepositoryPrefix, backupSnapshotsPrefix } from '../ports/index.js';
import { createBackupRepositoryReader } from './backup-repository-s3.js';
import { parseListObjectVersionsResponse } from './backup-versions-xml.js';
import type { BackupRepositoryReader, BackupVersionPage } from '../ports/index.js';
import type { BackupRepositoryConfig } from './backup-repository-s3.js';

/**
 * The real backup-repository reader against the local object store.
 *
 * The scheduled auditor binds a fake outside production, so nothing else in the
 * suite ever issues these requests for real. What only a live store can
 * settle is whether they are addressed and signed correctly: the snapshot
 * listing is an ordinary prefixed `ListObjectsV2`, but the lifecycle read is a
 * bare `?lifecycle` query with no value, which a signer can get wrong in a way
 * no stub would notice, and its empty answer arrives as a 404 carrying a code
 * rather than as an empty document. The versions listing is the same shape of
 * bare query and is exercised here for the same reason, against an unversioned
 * bucket: such a bucket still answers the query with an entry per object it
 * holds, and still truncates and names a continuation, so the request, the
 * parse and the paging are all reachable without versioning. Turning
 * versioning on is what must not happen here — it leaves a bucket the
 * harness's reclaim sweep cannot delete, because the sweep removes objects
 * rather than versions, and a run killed between the hooks would then block
 * every later test run in this checkout, in every package, since that sweep
 * runs from the shared vitest global setup.
 *
 * What no local store can settle is whether
 * Backblaze B2 answers the S3 form at all from its own native rules; that is a
 * vendor capability question, and the founder's first production run is what
 * answers it.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for backup repository integration tests`);
  }
  return value;
}

const ENDPOINT = requireEnv('BACKUP_B2_S3_ENDPOINT').replace(/\/+$/, '');
const REGION = requireEnv('BACKUP_B2_REGION');
const REPOSITORY_ROOT = requireEnv('BACKUP_REPO_ROOT');
const KEY_ID = requireEnv('BACKUP_B2_AUDITOR_KEY_ID');
const KEY = requireEnv('BACKUP_B2_AUDITOR_KEY');

/**
 * A bucket of this test's own rather than the stack's backup bucket: this suite
 * writes a lifecycle rule and a snapshot object, and a real repository is not a
 * place to leave either. Named through the harness's scratch-bucket scheme, so
 * the name carries the run that owns it and a run killed between the hooks
 * below leaves a bucket the reclaim sweep can attribute and remove.
 */
let bucket = '';
let reader: BackupRepositoryReader;

const scratch = new AwsClient({
  accessKeyId: KEY_ID,
  secretAccessKey: KEY,
  service: 's3',
  region: REGION,
});

function bucketUrl(query = ''): string {
  return `${ENDPOINT}/${encodeURIComponent(bucket)}${query}`;
}

/**
 * MinIO refuses a lifecycle write that carries no `Content-MD5`, which is the
 * S3 contract for that call; nothing else here sends a body worth hashing, so
 * the header rides along with every one that does.
 */
async function send(method: string, url: string, body?: string): Promise<Response> {
  const response = await scratch.fetch(
    url,
    body === undefined
      ? { method }
      : {
          method,
          body,
          headers: {
            // eslint-disable-next-line sonarjs/hashing -- S3 fixes MD5 as this header's integrity check; it authenticates nothing
            'Content-MD5': createHash('md5').update(body).digest('base64'),
          },
        }
  );
  if (!response.ok && response.status !== 204) {
    throw new Error(`scratch bucket ${method} returned ${String(response.status)}`);
  }
  return response;
}

function readerFor(): BackupRepositoryReader {
  const config: BackupRepositoryConfig = {
    endpoint: ENDPOINT,
    region: REGION,
    bucket,
    repositoryRoot: REPOSITORY_ROOT,
    accessKeyId: KEY_ID,
    secretAccessKey: KEY,
  };
  return createBackupRepositoryReader(config);
}

const REPOSITORY_PREFIX = backupRepositoryPrefix(REPOSITORY_ROOT);
const FIRST_KEY = `${REPOSITORY_PREFIX}data/first`;
const SECOND_KEY = `${REPOSITORY_PREFIX}data/second`;

async function putTwoObjects(): Promise<void> {
  await send('PUT', `${bucketUrl()}/${FIRST_KEY}`, 'first');
  await send('PUT', `${bucketUrl()}/${SECOND_KEY}`, 'second');
}

/**
 * The first page of the versions listing bounded to a single key, read
 * straight off the store: the reader draws a thousand keys a page, which no
 * test-sized repository can fill, so the cursor it resumes from has to come
 * from a request this test sizes itself. The parse is the shipped one, so the
 * cursor under test is the cursor the reader would have been handed.
 */
async function firstVersionsPage(): Promise<BackupVersionPage> {
  const query = new URLSearchParams({ prefix: REPOSITORY_PREFIX, 'max-keys': '1' });
  const response = await scratch.fetch(bucketUrl(`?versions&${query.toString()}`));
  return parseListObjectVersionsResponse(await response.text());
}

const LIFECYCLE_RULE = `<LifecycleConfiguration><Rule><ID>backup-retention</ID><Filter><Prefix>${REPOSITORY_ROOT}/</Prefix></Filter><Status>Enabled</Status><NoncurrentVersionExpiration><NoncurrentDays>${String(BACKUP_LIFECYCLE_NONCURRENT_DAYS)}</NoncurrentDays></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>`;

beforeEach(async () => {
  bucket = scratchBucketName(requireEnv(RUN_TOKEN_VARIABLE), mintScratchBucketId());
  await send('PUT', bucketUrl());
  reader = readerFor();
});

afterEach(async () => {
  const listed = await scratch.fetch(`${bucketUrl()}?list-type=2`);
  const xml = await listed.text();
  for (const [, key] of xml.matchAll(/<Key>([\S\s]*?)<\/Key>/g)) {
    await send('DELETE', `${bucketUrl()}/${key ?? ''}`);
  }
  await send('DELETE', bucketUrl());
});

describe('createBackupRepositoryReader against a live object store', () => {
  it('reads no snapshot out of a repository that holds none', async () => {
    const newest = await reader.newestSnapshotAt();

    expect(newest._unsafeUnwrap()).toBeNull();
  });

  it('takes the newest instant from the snapshot objects the store holds', async () => {
    const prefix = backupSnapshotsPrefix(REPOSITORY_ROOT);
    await send('PUT', `${bucketUrl()}/${prefix}older`, 'older');
    await send('PUT', `${bucketUrl()}/${prefix}newer`, 'newer');
    const listed = await scratch.fetch(`${bucketUrl()}?list-type=2`);
    const xml = await listed.text();
    const stamps = [...xml.matchAll(/<LastModified>([\S\s]*?)<\/LastModified>/g)];

    const newest = await reader.newestSnapshotAt();

    expect(newest._unsafeUnwrap()).toEqual(
      new Date(Math.max(...stamps.map(([, stamp]) => Date.parse(stamp ?? ''))))
    );
  });

  it('counts an object outside the snapshots prefix as no snapshot at all', async () => {
    await send('PUT', `${bucketUrl()}/${REPOSITORY_ROOT}/config`, 'not a snapshot');

    const newest = await reader.newestSnapshotAt();

    expect(newest._unsafeUnwrap()).toBeNull();
  });

  it('reads no rule out of a bucket carrying no lifecycle configuration', async () => {
    const rules = await reader.lifecycleRules();

    expect(rules._unsafeUnwrap()).toEqual([]);
  });

  it('reads the rule the bucket carries, prefix and expiry alike', async () => {
    await send('PUT', bucketUrl('?lifecycle'), LIFECYCLE_RULE);

    const rules = await reader.lifecycleRules();

    expect(rules._unsafeUnwrap()).toEqual([
      { prefix: `${REPOSITORY_ROOT}/`, noncurrentDays: BACKUP_LIFECYCLE_NONCURRENT_DAYS },
    ]);
  });

  it('reads no version out of a repository that holds none', async () => {
    const page = await reader.listObjectVersions();

    expect(page._unsafeUnwrap().versions).toEqual([]);
  });

  it('reads an entry per object the repository holds, in the order the store lists them', async () => {
    await putTwoObjects();

    const page = await reader.listObjectVersions();

    expect(page._unsafeUnwrap().versions.map((entry) => entry.key)).toEqual([
      FIRST_KEY,
      SECOND_KEY,
    ]);
  });

  it('takes a continuation whose version-id marker is the empty one the store emits', async () => {
    await putTwoObjects();

    const page = await firstVersionsPage();

    // Both halves of the shape are the store's, not this suite's invention:
    // the key marker is an opaque token (this store appends its own state to
    // the key), which is why the cursor travels back verbatim rather than
    // being rebuilt from a key; and the version-id marker arrives as an empty
    // element on every truncated page, so the reader resumes with
    // `version-id-marker=` rather than without the parameter.
    expect(page.nextCursor).toEqual({ keyMarker: expect.any(String), versionIdMarker: '' });
  });

  it('resumes after the cursor rather than at the start of the listing', async () => {
    await putTwoObjects();
    const { nextCursor } = await firstVersionsPage();

    const resumed = await reader.listObjectVersions(nextCursor);

    expect(resumed._unsafeUnwrap().versions.map((entry) => entry.key)).toEqual([SECOND_KEY]);
  });

  it('fails rather than reporting an empty repository when the bucket is gone', async () => {
    const absent = createBackupRepositoryReader({
      endpoint: ENDPOINT,
      region: REGION,
      bucket: `hushbox-backup-absent-${crypto.randomUUID()}`,
      repositoryRoot: REPOSITORY_ROOT,
      accessKeyId: KEY_ID,
      secretAccessKey: KEY,
    });

    const newest = await absent.newestSnapshotAt();

    expect(newest.isErr()).toBe(true);
  });
});
