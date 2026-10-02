import { randomInt } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AwsClient } from 'aws4fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RUN_TOKEN_VARIABLE,
  carriesReadableCreationStamp,
  commentDatabaseSql,
  createdComment,
  dropDatabaseSql,
  mintScratchBucketId,
  scratchBucketName,
  slotDatabaseName,
  withDatabaseName,
} from '@hushbox/db/test-db';
import { TEST_DAY_START } from '@hushbox/shared/test-time';

import {
  objectStoreEndpointFrom,
  requireScratchBucketStore,
} from '../test-run/scratch-bucket-reclaim.js';
import {
  createTestDbExecutor,
  ensureDatabaseExists,
  withMaintenanceExecutor,
} from '../test-run/test-db-provision.js';
import { liveDataPlaneLegs, resetDataPlane } from './data-plane-reset.js';

/**
 * That the data-plane reset empties exactly the stores it is handed, executed
 * against the live cluster and object store rather than reasoned about.
 *
 * Every store here is one this test makes and removes: a uniquely named scratch
 * database and bucket per role, named the way the per-run provisioning names
 * its own so that a run killed mid-case leaves them to the reclaim that already
 * sweeps those, and a temporary directory standing in for the persist root. No
 * stack's live store is written, dropped or emptied. The Redis leg is the one
 * left recording rather than live: a Redis logical database belongs to a whole
 * stack, so flushing one here would empty a store another run is using. Which
 * command it sends through which token is the unit suite's to pin.
 *
 * It needs the local stack, which is what `pnpm test` brings up.
 */

function requireVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required for the data-plane reset test — run vitest through \`tsx scripts/with-env.ts\`, which is what loads the env files`
    );
  }
  return value;
}

const DATABASE_URL = requireVariable('DATABASE_URL');
const OBJECT_STORE = objectStoreEndpointFrom(process.env);

/** Unique within the run's token, in the one field of the shape that is free. */
function mintScratchDatabaseName(): string {
  return slotDatabaseName(
    requireVariable(RUN_TOKEN_VARIABLE),
    String(randomInt(10 ** 12, 10 ** 13))
  );
}

function mintBucketName(): string {
  return scratchBucketName(requireVariable(RUN_TOKEN_VARIABLE), mintScratchBucketId());
}

function client(): AwsClient {
  return new AwsClient({
    accessKeyId: OBJECT_STORE.accessKeyId,
    secretAccessKey: OBJECT_STORE.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
}

function objectUrl(bucket: string, key?: string): string {
  const bucketUrl = `${OBJECT_STORE.endpoint.replace(/\/+$/, '')}/${bucket}`;
  return key === undefined ? bucketUrl : `${bucketUrl}/${key}`;
}

async function createBucket(bucket: string): Promise<void> {
  const response = await client().fetch(objectUrl(bucket), { method: 'PUT' });
  if (!response.ok) throw new Error(`create ${bucket} returned ${String(response.status)}`);
}

async function putSentinel(bucket: string): Promise<void> {
  const response = await client().fetch(objectUrl(bucket, 'sentinel/object.bin'), {
    method: 'PUT',
    body: 'left by an earlier run',
  });
  if (!response.ok) throw new Error(`put into ${bucket} returned ${String(response.status)}`);
}

async function sentinelObjectPresent(bucket: string): Promise<boolean> {
  const response = await client().fetch(objectUrl(bucket, 'sentinel/object.bin'));
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`get from ${bucket} returned ${String(response.status)}`);
  return true;
}

async function bucketStanding(bucket: string): Promise<boolean> {
  const response = await client().fetch(`${objectUrl(bucket)}?list-type=2`);
  return response.ok;
}

/**
 * Creates the database carrying the creation stamp per-run provisioning writes:
 * a reclaim running in another suite drops an unstamped database whose run no
 * claim it reads accounts for, and names it while doing so. A fixed instant is
 * safe because the name carries this run's token, and a reclaim drops by age
 * only a database no live run owns.
 */
async function createScratchDatabase(name: string): Promise<void> {
  await withMaintenanceExecutor(DATABASE_URL, async (maintenance) => {
    await ensureDatabaseExists(maintenance, name);
    await maintenance.exec(commentDatabaseSql(name, createdComment(new Date(TEST_DAY_START))));
  });
}

/** Creates the database and plants a sentinel row in it. */
async function plantDatabase(name: string): Promise<void> {
  await createScratchDatabase(name);
  const executor = createTestDbExecutor(withDatabaseName(DATABASE_URL, name));
  try {
    await executor.exec('CREATE TABLE sentinel (note text)');
    await executor.exec("INSERT INTO sentinel VALUES ('left by an earlier run')");
  } finally {
    await executor.close();
  }
}

async function databaseExists(name: string): Promise<boolean> {
  return withMaintenanceExecutor(DATABASE_URL, async (maintenance) => {
    const rows = await maintenance.query<{ found: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${name}') AS found`
    );
    return rows[0]?.found === true;
  });
}

async function creationStampReadable(name: string): Promise<boolean> {
  return withMaintenanceExecutor(DATABASE_URL, async (maintenance) => {
    const rows = await maintenance.query<{ comment: string | null }>(
      `SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = '${name}'`
    );
    return carriesReadableCreationStamp(rows[0]?.comment ?? null);
  });
}

async function userTableCount(name: string): Promise<number> {
  const executor = createTestDbExecutor(withDatabaseName(DATABASE_URL, name));
  try {
    const rows = await executor.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'"
    );
    return rows[0]?.count ?? 0;
  } finally {
    await executor.close();
  }
}

async function dropDatabase(name: string): Promise<void> {
  await withMaintenanceExecutor(DATABASE_URL, (maintenance) =>
    maintenance.exec(dropDatabaseSql(name))
  );
}

interface Stores {
  readonly database: string;
  readonly bucket: string;
  readonly persistRoot: string;
  readonly browserTmp: string;
}

/**
 * Named before anything is created, so teardown can remove whichever of them a
 * failed setup left behind.
 */
function mintStores(scratchRoot: string, role: string): Stores {
  return {
    database: mintScratchDatabaseName(),
    bucket: mintBucketName(),
    persistRoot: path.join(scratchRoot, role),
    browserTmp: path.join(scratchRoot, `${role}-browser-tmp`),
  };
}

async function plantStores(stores: Stores): Promise<void> {
  await plantDatabase(stores.database);
  await createBucket(stores.bucket);
  await putSentinel(stores.bucket);
  await mkdir(path.join(stores.persistRoot, 'v3', 'do'), { recursive: true });
  await writeFile(path.join(stores.persistRoot, 'v3', 'do', 'sentinel.sqlite'), 'state');
  await mkdir(path.join(stores.browserTmp, 'playwright_firefoxdev_profile-leaked'), {
    recursive: true,
  });
}

/**
 * Removes whatever of the stores exists, and attempts every removal before
 * raising on the first that failed: the drop is `IF EXISTS` and the bucket destroy
 * reads an absent bucket as done, so a store setup never reached is no error.
 */
async function removeStores(stores: readonly Stores[]): Promise<void> {
  const removals = await Promise.allSettled(
    stores.flatMap((each) => [
      dropDatabase(each.database),
      requireScratchBucketStore(process.env).destroy(each.bucket),
    ])
  );
  const failed = removals.find((removal) => removal.status === 'rejected');
  if (failed !== undefined) {
    throw new Error('removing the scratch stores failed', { cause: failed.reason });
  }
}

/**
 * Planting two databases and two buckets, resetting and recreating is several
 * cluster round trips that each copy a template database, which is well past
 * one case's budget on a busy cluster; the hooks carry it instead, so each
 * case below asserts one store.
 */
const SETUP_BUDGET_MS = 120_000;

describe('recreating a data plane against the live stores', () => {
  const flushed: string[] = [];
  let scratchRoot = '';
  let target: Stores | undefined;
  let bystander: Stores | undefined;

  function planted(stores: Stores | undefined): Stores {
    if (stores === undefined) throw new Error('the stores were never planted');
    return stores;
  }

  beforeAll(async () => {
    scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'hb-data-plane-reset-'));
    target = mintStores(scratchRoot, 'target');
    bystander = mintStores(scratchRoot, 'bystander');
    await plantStores(target);
    await plantStores(bystander);

    await resetDataPlane(
      {
        databaseName: target.database,
        redisToken: 'the-target-token',
        bucket: target.bucket,
        persistRoot: target.persistRoot,
        browserTmp: target.browserTmp,
      },
      {
        ...liveDataPlaneLegs({
          databaseUrl: DATABASE_URL,
          redisUrl: 'http://redis-leg-is-recorded.invalid',
          objectStore: OBJECT_STORE,
        }),
        flushRedis: (token) => {
          flushed.push(token);
          return Promise.resolve();
        },
      }
    );
    // What the bring-up does next with the database the reset dropped, stamped
    // as every scratch database here is.
    await createScratchDatabase(target.database);
  }, SETUP_BUDGET_MS);

  afterAll(async () => {
    try {
      await removeStores([target, bystander].filter((stores) => stores !== undefined));
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  }, SETUP_BUDGET_MS);

  it('leaves the recreated database empty', async () => {
    await expect(userTableCount(planted(target).database)).resolves.toBe(0);
  });

  it('empties the bucket it is handed', async () => {
    await expect(sentinelObjectPresent(planted(target).bucket)).resolves.toBe(false);
  });

  it('keeps the emptied bucket standing', async () => {
    await expect(bucketStanding(planted(target).bucket)).resolves.toBe(true);
  });

  it('empties the persist root it is handed', async () => {
    await expect(readdir(planted(target).persistRoot)).resolves.toEqual([]);
  });

  it('empties the browser temporary directory it is handed', async () => {
    await expect(readdir(planted(target).browserTmp)).resolves.toEqual([]);
  });

  it('flushes through the token it is handed', () => {
    expect(flushed).toEqual(['the-target-token']);
  });

  it("stamps the recreated database, so a reclaim reads it as a run's rather than as debris", async () => {
    await expect(creationStampReadable(planted(target).database)).resolves.toBe(true);
  });

  it("stamps a database it is not handed, so a reclaim reads it as a run's rather than as debris", async () => {
    await expect(creationStampReadable(planted(bystander).database)).resolves.toBe(true);
  });

  it('leaves a database it is not handed with its sentinel', async () => {
    await expect(userTableCount(planted(bystander).database)).resolves.toBe(1);
  });

  it('leaves a bucket it is not handed with its sentinel', async () => {
    await expect(sentinelObjectPresent(planted(bystander).bucket)).resolves.toBe(true);
  });

  it('leaves a persist root it is not handed with its sentinel', async () => {
    await expect(readdir(planted(bystander).persistRoot)).resolves.toEqual(['v3']);
  });

  it('leaves a browser temporary directory it is not handed with what it holds', async () => {
    await expect(readdir(planted(bystander).browserTmp)).resolves.toEqual([
      'playwright_firefoxdev_profile-leaked',
    ]);
  });
});

describe('the live database leg', () => {
  const database = mintScratchDatabaseName();

  beforeAll(() => plantDatabase(database), SETUP_BUDGET_MS);
  afterAll(() => dropDatabase(database), SETUP_BUDGET_MS);

  it('drops the database it is handed rather than leaving it standing empty', async () => {
    await liveDataPlaneLegs({
      databaseUrl: DATABASE_URL,
      redisUrl: 'http://redis-leg-is-recorded.invalid',
      objectStore: OBJECT_STORE,
    }).dropDatabase(database);

    await expect(databaseExists(database)).resolves.toBe(false);
  });
});
